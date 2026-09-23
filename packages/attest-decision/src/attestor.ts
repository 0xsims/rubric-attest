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
 *
 * Chain heads are per process unless `chainStore` is set. With a store, each
 * record's `prev` is read from, and its decisionId written back to, the shared
 * store under a per-agent lock (see chain-store.ts), so several processes and
 * restarts extend one linear chain per agent. If the store can't be used (lock
 * timeout, I/O error), the record is skipped: attest() returns null and the
 * error goes to `onError`. Skipping, rather than falling back to the local head,
 * is deliberate: a local fallback would fork the chain.
 */
import type { ChainHeadStore } from "./chain-store.js";
import type { DarCore, PayloadRecord, TransmitMode } from "./constants.js";
import { DarBuilder, toPayload, type DarBuildInput } from "./dar.js";
import { Spool, type SpoolRecord } from "./spool.js";
import type { Transport } from "./transport.js";

export interface AttestorOptions {
  transport: Transport;
  spoolPath: string;
  maxBatch?: number;
  maxWaitMs?: number;
  maxSpoolBytes?: number;
  retryMs?: number;
  /** Max re-send attempts per batch during close() before leaving it spooled. */
  closeRetries?: number;
  /** Cap on in-memory queued (un-acked) records; oldest are dropped past it. Default 100000. */
  maxQueue?: number;
  /** Reject a decision whose canonical form exceeds this many bytes. Default 256 KiB. */
  maxDecisionBytes?: number;
  /** `hash-only` (default) sends DAR cores only; `payload` also carries raw content in the envelope. */
  mode?: TransmitMode;
  now?: () => number;
  newDecisionId?: () => string;
  onError?: (err: unknown) => void;
  /** Replay leftover spool records on construction. Default true. */
  autoRecover?: boolean;
  /**
   * Shared per-agent chain-head store. When set, `prev` comes from the store
   * rather than this process's memory, and attest() takes a per-agent lock (so
   * it costs a lock plus a head write, not <1 ms). A record the store can't
   * serve is skipped (attest() returns null). Default: none, in-memory heads.
   */
  chainStore?: ChainHeadStore;
}

interface QueueItem {
  seq: number;
  dar: DarCore;
  payload?: PayloadRecord;
}

const sleep0 = (): Promise<void> => new Promise((r) => setImmediate(r));
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Attestor {
  private readonly builder: DarBuilder;
  private readonly spool: Spool;
  private readonly transport: Transport;
  private readonly maxBatch: number;
  private readonly maxWaitMs: number;
  private readonly retryMs: number;
  private readonly closeRetries: number;
  private readonly maxQueue: number;
  private readonly mode: TransmitMode;
  private readonly onError?: (err: unknown) => void;
  private readonly chainStore?: ChainHeadStore;

  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private closed = false;

  constructor(options: AttestorOptions) {
    this.transport = options.transport;
    this.onError = options.onError;
    this.spool = new Spool(options.spoolPath, {
      maxBytes: options.maxSpoolBytes,
      onDrop: (n) => this.reportError(new Error(`spool dropped ${n} oldest record(s) at the size cap`)),
    });
    this.builder = new DarBuilder({
      newDecisionId: options.newDecisionId,
      now: options.now,
      maxDecisionBytes: options.maxDecisionBytes,
    });
    this.maxBatch = options.maxBatch ?? 64;
    this.maxWaitMs = options.maxWaitMs ?? 5000;
    this.retryMs = options.retryMs ?? 1000;
    this.closeRetries = options.closeRetries ?? 3;
    this.maxQueue = options.maxQueue ?? 100_000;
    this.mode = options.mode ?? "hash-only";
    this.chainStore = options.chainStore;

    if (options.autoRecover !== false) this.recover();
  }

  /**
   * Fire-and-forget. Returns the minted `decisionId`, or `null` if the record
   * could not be built/spooled (never throws). Adds <1 ms to the caller.
   */
  attest(input: DarBuildInput): string | null {
    if (this.closed) return null;
    if (this.chainStore) return this.attestChained(this.chainStore, input);
    try {
      const dar = this.builder.build(input);
      this.enqueue(dar, input);
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
      this.spool.compactIfNeeded(); // enforce the 50 MB cap off the caller path
      this.spool.fsync();
      await this.transport.send(batch.map((b) => b.dar), this.payloadsOf(batch));
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

  /**
   * Stop accepting records, drain the queue (retrying each batch up to
   * `closeRetries` times), and close the spool. Anything still undelivered after
   * the retries remains durably spooled for the next run's recovery.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    while (this.flushing) await sleep0();
    this.spool.compactIfNeeded();
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatch);
      let delivered = false;
      for (let attempt = 0; attempt <= this.closeRetries; attempt++) {
        try {
          this.spool.fsync();
          await this.transport.send(batch.map((b) => b.dar), this.payloadsOf(batch));
          this.spool.ack(batch[batch.length - 1]!.seq);
          delivered = true;
          break;
        } catch (err) {
          this.reportError(err);
          if (attempt < this.closeRetries) await delay(this.retryMs);
        }
      }
      if (!delivered) {
        // Give up: leave this batch (and the rest) durably spooled for recovery.
        this.queue.unshift(...batch);
        break;
      }
    }
    this.spool.close();
  }

  // --- internals ---

  /** Spool and queue a built record, then arm the batcher. Throws if the spool append fails. */
  private enqueue(dar: DarCore, input: DarBuildInput): void {
    const payload = this.mode === "payload" ? toPayload(dar.decisionId, input) : undefined;
    const seq = this.spool.append(dar, payload);
    this.queue.push({ seq, dar, payload });
    // Bound in-memory growth under sustained transport failure: drop oldest
    // queued records past the cap (they are surfaced, not silently lost).
    while (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.reportError(new Error("attest queue cap exceeded; dropped oldest queued record"));
    }
    if (this.queue.length >= this.maxBatch) this.scheduleFlush();
    else this.armTimer();
  }

  /**
   * attest() with a shared chain-head store: build, spool and advance the head
   * as one per-agent critical section. `prev` is the stored head; only when the
   * store has no head for the agent yet does it fall back to this process's own
   * head (from spool recovery or an earlier record), else genesis.
   */
  private attestChained(store: ChainHeadStore, input: DarBuildInput): string | null {
    let accepted: string | null = null;
    try {
      const { agentId } = input;
      if (typeof agentId !== "string" || agentId.length === 0) {
        throw new Error("DAR: agentId must be a non-empty string");
      }
      store.advance(agentId, (head) => {
        const prev = head ?? this.builder.getHead(agentId) ?? null;
        const dar = this.builder.build(input, { prev });
        this.enqueue(dar, input);
        accepted = dar.decisionId;
        return dar.decisionId;
      });
    } catch (err) {
      // If the record was already spooled (the head write failed after it), it
      // is still delivered, so its id is still returned.
      this.reportError(err);
    }
    return accepted;
  }

  /**
   * After a crash between a record's spool append and its head write, the store
   * still points at that record's `prev`. Re-point it at the record, per agent,
   * using the last recovered record, but only if nothing has extended the head
   * since (or the store has no head yet).
   */
  private repairHeads(store: ChainHeadStore, pending: SpoolRecord[]): void {
    const last = new Map<string, DarCore>();
    for (const { dar } of pending) last.set(dar.agentId, dar);
    for (const dar of last.values()) {
      try {
        store.advance(dar.agentId, (head) => (head === null || head === dar.prev ? dar.decisionId : null));
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  /** Raw payloads for a batch — only in `payload` mode; ride in the envelope. */
  private payloadsOf(batch: QueueItem[]): PayloadRecord[] | undefined {
    if (this.mode !== "payload") return undefined;
    const payloads = batch
      .map((b) => b.payload)
      .filter((p): p is PayloadRecord => p !== undefined);
    return payloads.length > 0 ? payloads : undefined;
  }

  private recover(): void {
    const pending = this.spool.pending();
    for (const { dar } of pending) this.builder.seedHead(dar.agentId, dar.decisionId);
    if (this.chainStore) this.repairHeads(this.chainStore, pending);
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
