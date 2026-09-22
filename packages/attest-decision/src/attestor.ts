/**
 * Attestor — the fire-and-forget façade (tasks/P1.md).
 *
 * `attest()` builds a DAR, appends it durably to the spool, enqueues it, and
 * returns immediately (adds <1 ms to the caller). It NEVER throws into app code;
 * any failure is reported to the optional `onError` sink and swallowed.
 *
 * The batcher flushes when the queue reaches `maxBatch` (64) or `maxWaitMs`
 * (5000 ms) elapses, whichever comes first — one POST per flush. A delivered
 * batch is acked in the spool; a failed batch is returned to the front of the
 * queue and retried, so it is never lost. On construction the spool is drained:
 * anything left by a previous run is re-queued and per-agent chain heads reseeded.
 */
import type { DarCore } from "./constants.js";
import { DarBuilder, type DarBuildInput } from "./dar.js";
import { Spool } from "./spool.js";
import type { Transport } from "./transport.js";

export interface AttestorOptions {
  transport: Transport;
  spoolPath: string;
  maxBatch?: number;
  maxWaitMs?: number;
  maxSpoolBytes?: number;
  retryMs?: number;
  now?: () => number;
  newDecisionId?: () => string;
  onError?: (err: unknown) => void;
  /** Replay leftover spool records on construction. Default true. */
  autoRecover?: boolean;
}

interface QueueItem {
  seq: number;
  dar: DarCore;
}

const sleep0 = (): Promise<void> => new Promise((r) => setImmediate(r));

export class Attestor {
  private readonly builder: DarBuilder;
  private readonly spool: Spool;
  private readonly transport: Transport;
  private readonly maxBatch: number;
  private readonly maxWaitMs: number;
  private readonly retryMs: number;
  private readonly onError?: (err: unknown) => void;

  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private closed = false;

  constructor(options: AttestorOptions) {
    this.transport = options.transport;
    this.spool = new Spool(options.spoolPath, { maxBytes: options.maxSpoolBytes });
    this.builder = new DarBuilder({
      newDecisionId: options.newDecisionId,
      now: options.now,
    });
    this.maxBatch = options.maxBatch ?? 64;
    this.maxWaitMs = options.maxWaitMs ?? 5000;
    this.retryMs = options.retryMs ?? 1000;
    this.onError = options.onError;

    if (options.autoRecover !== false) this.recover();
  }

  /**
   * Fire-and-forget. Returns the minted `decisionId`, or `null` if the record
   * could not be built/spooled (never throws). Adds <1 ms to the caller.
   */
  attest(input: DarBuildInput): string | null {
    if (this.closed) return null;
    try {
      const dar = this.builder.build(input);
      const seq = this.spool.append(dar);
      this.queue.push({ seq, dar });
      if (this.queue.length >= this.maxBatch) this.scheduleFlush();
      else this.armTimer();
      return dar.decisionId;
    } catch (err) {
      this.reportError(err);
      return null;
    }
  }

  /** Flush at most one batch. Safe to call directly; concurrency-guarded. */
  async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    if (this.queue.length === 0) return;
    this.flushing = true;
    this.clearTimer();
    const batch = this.queue.splice(0, this.maxBatch);
    try {
      this.spool.fsync();
      await this.transport.send(batch.map((b) => b.dar));
      this.spool.ack(batch[batch.length - 1]!.seq);
      this.flushing = false;
      this.scheduleNext();
    } catch (err) {
      // Retain: return the batch to the front (order preserved) and retry.
      this.queue.unshift(...batch);
      this.flushing = false;
      this.reportError(err);
      this.scheduleRetry();
    }
  }

  /** Flush repeatedly until the queue is empty (used by tests and shutdown). */
  async drain(): Promise<void> {
    for (;;) {
      while (this.flushing) await sleep0();
      if (this.queue.length === 0 || this.closed) return;
      await this.flush();
    }
  }

  /** Number of records still queued (not yet acknowledged). */
  pendingCount(): number {
    return this.queue.length;
  }

  /** Stop accepting records, best-effort drain, and close the spool. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    try {
      while (this.flushing) await sleep0();
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.maxBatch);
        this.spool.fsync();
        await this.transport.send(batch.map((b) => b.dar));
        this.spool.ack(batch[batch.length - 1]!.seq);
      }
    } catch (err) {
      // Undrained records remain durably spooled for the next run's recovery.
      this.reportError(err);
    }
    this.spool.close();
  }

  // --- internals ---

  private recover(): void {
    const pending = this.spool.pending();
    for (const { dar } of pending) this.builder.seedHead(dar.agentId, dar.decisionId);
    for (const item of pending) this.queue.push(item);
    if (this.queue.length > 0) this.scheduleFlush();
  }

  private scheduleNext(): void {
    if (this.queue.length >= this.maxBatch) this.scheduleFlush();
    else if (this.queue.length > 0) this.armTimer();
  }

  private armTimer(): void {
    if (this.timer || this.flushing || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleFlush();
    }, this.maxWaitMs);
    this.timer.unref?.();
  }

  private scheduleRetry(): void {
    if (this.timer || this.flushing || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleFlush();
    }, this.retryMs);
    this.timer.unref?.();
  }

  private scheduleFlush(): void {
    this.clearTimer();
    if (this.flushing || this.closed) return;
    setImmediate(() => {
      void this.flush();
    });
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private reportError(err: unknown): void {
    try {
      this.onError?.(err);
    } catch {
      // An onError that throws must not escape attest().
    }
  }
}
