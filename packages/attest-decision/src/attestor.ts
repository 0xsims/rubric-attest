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
 *
 * Namespaces (1.2.0). Batch ingest requires every agentId to be
 * `<namespace>/<name>`, where the namespace (`ns_<12 hex>`) is minted by the
 * server onto the API key. `agentId` is inside the hashed core, so attest()
 * prefixes it BEFORE building; a built or spooled DAR is never rewritten. The
 * configured namespace is authoritative: each response's `namespace` is only
 * checked against it. On a mismatch (or 403 NAMESPACE_UNAVAILABLE) the Attestor
 * stops building and sending, keeps everything, retries the same batch a bounded
 * number of times with backoff, and then reports a fatal NamespaceMismatchError
 * and stays stopped. It never drops, re-prefixes, or adopts the other value.
 * `namespace: "discover"` instead learns it from empty-batch handshakes (three
 * consecutive agreeing answers) and persists it beside the spool.
 */
import { renameSync, readFileSync, writeFileSync } from "node:fs";
import type { ChainHeadStore } from "./chain-store.js";
import { NAMESPACE_RE, SDK_NAME, type DarCore, type PayloadRecord, type TransmitMode } from "./constants.js";
import { AgentIdError, DarBuilder, toPayload, validateAgentId, type DarBuildInput } from "./dar.js";
import { Spool, type SpoolRecord } from "./spool.js";
import type { RejectedRecord, SendResult, Transport } from "./transport.js";
import { ulid as defaultUlid } from "./ulid.js";

/** Consecutive agreeing handshakes `namespace: "discover"` needs before it trusts a namespace. */
export const DISCOVERY_AGREEMENT = 3;

/**
 * A response's namespace differs from the configured one (or the node has none:
 * 403 NAMESPACE_UNAVAILABLE). Nothing is dropped. While `fatal` is false the
 * Attestor retries the same batch; once `fatal`, it stays stopped until the
 * node or the configured namespace is fixed and the process restarted.
 */
export class NamespaceMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly got: string | null,
    /** Retries of the batch made so far (0 on the first mismatch). */
    readonly retries: number,
    readonly maxRetries: number,
    readonly fatal: boolean,
  ) {
    super(
      `namespace mismatch: configured '${expected}', server answered ${got === null ? "no namespace (NAMESPACE_UNAVAILABLE)" : `'${got}'`}; ` +
        (fatal
          ? `still different after ${retries} retries. Sending is stopped and every record is kept; ` +
            `fix the server node's namespace or the configured one, then restart.`
          : `sending is paused and every record is kept (retry ${retries + 1} of ${maxRetries} pending).`),
    );
    this.name = "NamespaceMismatchError";
  }
}

/** Records the server refused under a 200. They are final: resending cannot store them. */
export class BatchRejectedError extends Error {
  constructor(
    readonly rejected: RejectedRecord[],
    readonly namespace: string | null | undefined,
    hint?: string,
  ) {
    const shown = rejected
      .slice(0, 5)
      .map((r) => `${r.decisionId ?? "?"}: ${r.reason}`)
      .join("; ");
    const more = rejected.length > 5 ? `; and ${rejected.length - 5} more` : "";
    super(
      `${rejected.length} record(s) permanently rejected by the server: ${shown}${more}` + (hint ? `. ${hint}` : ""),
    );
    this.name = "BatchRejectedError";
  }
}

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
  /**
   * Where failures are reported: transport errors (including 426 and 403),
   * records the server rejected, namespace mismatches, spool drops. Default:
   * `console.warn`. attest() itself only throws for an invalid agentId.
   */
  onError?: (err: unknown) => void;
  /**
   * Your batch-ingest namespace, `ns_<12 hex>`, from the dashboard or the
   * operator who enabled your key (recommended). Every agentId passed to
   * attest() is prefixed `<namespace>/` before the DAR is built. Responses are
   * checked against it, never allowed to change it.
   *
   * `"discover"` learns it from the server instead (three consecutive agreeing
   * empty-batch handshakes, then persisted at `namespacePath`); attest() calls
   * are held in memory until then. Prefer the explicit value: a misconfigured
   * server node could otherwise be pinned, and a DAR built with the wrong
   * prefix can never be repaired.
   *
   * Omitted: agentIds are used as given (1.1.0 behaviour; internal keys only).
   */
  namespace?: string;
  /** Where a discovered namespace is persisted. Default `${spoolPath}.namespace`. */
  namespacePath?: string;
  /** Retries of the same batch after a namespace mismatch before it is fatal. Default 5. */
  namespaceRetries?: number;
  /** First backoff after a namespace mismatch, doubled per retry. Default 20000 (5 retries ≈ 10 min). */
  namespaceRetryMs?: number;
  /** Permit Rubric's reserved agentIds (`rubric://…` etc.). Rubric's internal emitters only. Default false. */
  allowReservedAgentIds?: boolean;
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

/** An attest() accepted while the namespace is unknown or in doubt; built later. */
interface HeldItem {
  input: DarBuildInput;
  decisionId: string;
  at: number;
}

interface Halt {
  got: string | null;
  retries: number;
  fatal: boolean;
}

/** `ns_<12 hex>/…`: an agentId that already carries a namespace. */
const QUALIFIED_RE = /^ns_[0-9a-f]{12}\//;
/** Stand-in prefix for validating a name before the discovered namespace is known. */
const PLACEHOLDER_NS = "ns_000000000000";

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
  private readonly onError: (err: unknown) => void;
  private readonly chainStore?: ChainHeadStore;
  private readonly newDecisionId: () => string;
  private readonly now: () => number;
  private readonly allowReservedAgentIds: boolean;
  private readonly namespacePath: string;
  private readonly namespaceRetries: number;
  private readonly namespaceRetryMs: number;

  /** The namespace agentIds are prefixed with; null when none is configured (or not yet discovered). */
  private namespace: string | null = null;
  private discovering = false;
  private discovered: Promise<void> = Promise.resolve();
  private held: HeldItem[] = [];
  private halt: Halt | null = null;

  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private closed = false;

  constructor(options: AttestorOptions) {
    const ns = options.namespace;
    if (ns !== undefined && ns !== "discover" && !NAMESPACE_RE.test(ns)) {
      throw new Error(`Attestor: namespace must be 'ns_<12 hex>' or "discover", got '${ns}'`);
    }
    this.transport = options.transport;
    this.onError = options.onError ?? defaultOnError;
    this.spool = new Spool(options.spoolPath, {
      maxBytes: options.maxSpoolBytes,
      onDrop: (n) => this.reportError(new Error(`spool dropped ${n} oldest record(s) at the size cap`)),
    });
    this.newDecisionId = options.newDecisionId ?? defaultUlid;
    this.now = options.now ?? Date.now;
    this.allowReservedAgentIds = options.allowReservedAgentIds ?? false;
    this.builder = new DarBuilder({
      newDecisionId: this.newDecisionId,
      now: this.now,
      maxDecisionBytes: options.maxDecisionBytes,
      allowReservedAgentIds: this.allowReservedAgentIds,
    });
    this.maxBatch = options.maxBatch ?? 64;
    this.maxWaitMs = options.maxWaitMs ?? 5000;
    this.retryMs = options.retryMs ?? 1000;
    this.closeRetries = options.closeRetries ?? 3;
    this.maxQueue = options.maxQueue ?? 100_000;
    this.mode = options.mode ?? "hash-only";
    this.chainStore = options.chainStore;
    this.namespacePath = options.namespacePath ?? `${options.spoolPath}.namespace`;
    this.namespaceRetries = options.namespaceRetries ?? 5;
    this.namespaceRetryMs = options.namespaceRetryMs ?? 20_000;

    if (ns === "discover") {
      this.namespace = this.loadNamespace();
      if (this.namespace === null) {
        this.discovering = true;
        this.discovered = this.discover();
      }
    } else if (ns !== undefined) {
      this.namespace = ns;
    }

    if (options.autoRecover !== false) this.recover();
  }

  /**
   * Fire-and-forget. Returns the `decisionId`, or `null` if the record could not
   * be built/spooled (the reason goes to `onError`). Adds <1 ms to the caller.
   *
   * With a namespace, `agentId` is the name and is prefixed `<namespace>/`
   * before the DAR is built (an agentId already carrying that prefix is kept).
   * Throws AgentIdError — and only that — if the resulting agentId is outside
   * the server's rules, so the mistake shows where it is made.
   *
   * While the namespace is being discovered, or sending is paused by a
   * namespace mismatch, the record is held in memory and built later with the
   * returned `decisionId` and this call's time; it is not yet in the spool.
   */
  attest(input: DarBuildInput): string | null {
    if (this.closed) return null;
    this.checkAgentId(input.agentId);
    if (this.discovering || this.halt || this.held.length > 0) return this.hold(input);
    return this.buildAndEnqueue(input, this.newDecisionId(), this.now());
  }

  /** Resolves once a `"discover"` namespace is known (at once otherwise). */
  ready(): Promise<void> {
    return this.discovered;
  }

  /** The namespace agentIds are prefixed with, or null (none configured, or not discovered yet). */
  getNamespace(): string | null {
    return this.namespace;
  }

  /** Flush at most one batch. Safe to call directly; concurrency-guarded. */
  async flush(): Promise<void> {
    return this.flushBatch(false);
  }

  /** Flush repeatedly until the queue is empty (used by tests and shutdown). */
  async drain(): Promise<void> {
    for (;;) {
      while (this.flushing) await sleep0();
      // Paused (discovery, namespace mismatch): nothing can be sent now.
      if (this.queue.length === 0 || this.closed || this.discovering || this.halt) return;
      await this.flush();
    }
  }

  /** Number of records not yet acknowledged: queued, plus held in memory. */
  pendingCount(): number {
    return this.queue.length + this.held.length;
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
    if (this.held.length > 0) {
      // Never built (namespace unknown or in doubt), so not in the spool.
      this.reportError(
        new Error(
          `attest: ${this.held.length} record(s) held in memory while the namespace was ` +
            `${this.discovering ? "being discovered" : "in doubt"} were not built or spooled before close()`,
        ),
      );
      this.held = [];
    }
    this.spool.compactIfNeeded();
    // A paused Attestor sends nothing more: its batches stay spooled for the next run.
    while (this.queue.length > 0 && !this.discovering && !this.halt) {
      const batch = this.queue.splice(0, this.maxBatch);
      let delivered = false;
      for (let attempt = 0; attempt <= this.closeRetries; attempt++) {
        let result: SendResult | void;
        try {
          this.spool.fsync();
          result = await this.transport.send(batch.map((b) => b.dar), this.payloadsOf(batch));
        } catch (err) {
          this.reportError(err);
          if (this.isMismatch(namespaceOfError(err), codeOf(err))) break;
          if (attempt < this.closeRetries) await delay(this.retryMs);
          continue;
        }
        if (this.isMismatch(result?.namespace, undefined)) {
          this.reportError(new NamespaceMismatchError(this.namespace!, result?.namespace ?? null, 0, 0, true));
          break;
        }
        this.spool.ack(batch[batch.length - 1]!.seq);
        this.reportRejected(result);
        delivered = true;
        break;
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

  /** Throw AgentIdError if `agentId` (once prefixed) is outside the server's rules. */
  private checkAgentId(agentId: unknown): void {
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new AgentIdError("DAR: agentId must be a non-empty string", agentId);
    }
    if (this.discovering) {
      if (QUALIFIED_RE.test(agentId)) {
        throw new AgentIdError(
          `DAR: agentId '${agentId.slice(0, 64)}' already carries a namespace; with namespace "discover", pass the name only`,
          agentId,
        );
      }
      validateAgentId(`${PLACEHOLDER_NS}/${agentId}`);
      return;
    }
    validateAgentId(this.qualify(agentId), { allowReserved: this.allowReservedAgentIds });
  }

  /** `<namespace>/<name>`. Never applied to a built DAR: agentId is inside the hashed core. */
  private qualify(agentId: string): string {
    const ns = this.namespace;
    if (ns === null) return agentId;
    if (agentId.startsWith(`${ns}/`)) return agentId;
    if (QUALIFIED_RE.test(agentId)) {
      throw new AgentIdError(
        `DAR: agentId '${agentId.slice(0, 64)}' is in another namespace; this Attestor is configured for '${ns}'`,
        agentId,
      );
    }
    return `${ns}/${agentId}`;
  }

  private hold(input: DarBuildInput): string {
    const item: HeldItem = { input, decisionId: this.newDecisionId(), at: this.now() };
    this.held.push(item);
    while (this.held.length > this.maxQueue) {
      const dropped = this.held.shift()!;
      this.reportError(new Error(`attest hold cap exceeded; dropped held record ${dropped.decisionId}`));
    }
    return item.decisionId;
  }

  /** Build every held record, in attest() order, now that the namespace is known and trusted. */
  private releaseHeld(): void {
    const held = this.held;
    this.held = [];
    for (const h of held) {
      try {
        this.checkAgentId(h.input.agentId);
      } catch (err) {
        this.reportError(err);
        continue;
      }
      this.buildAndEnqueue(h.input, h.decisionId, h.at);
    }
  }

  private buildAndEnqueue(input: DarBuildInput, decisionId: string, at: number): string | null {
    const qualified = { ...input, agentId: this.qualify(input.agentId) };
    if (this.chainStore) return this.attestChained(this.chainStore, qualified, decisionId, at);
    try {
      const dar = this.builder.build(qualified, { decisionId, at });
      this.enqueue(dar, qualified);
      return dar.decisionId;
    } catch (err) {
      this.reportError(err);
      return null;
    }
  }

  private async flushBatch(haltRetry: boolean): Promise<void> {
    if (this.flushing || this.closed || this.discovering) return;
    if (this.halt && (!haltRetry || this.halt.fatal)) return;
    if (this.queue.length === 0) return;
    this.flushing = true;
    this.clearTimer();
    const batch = this.queue.splice(0, this.maxBatch);
    let result: SendResult | void = undefined;
    let error: unknown = undefined;
    let failed = false;
    try {
      this.spool.compactIfNeeded(); // enforce the 50 MB cap off the caller path
      this.spool.fsync();
      result = await this.transport.send(batch.map((b) => b.dar), this.payloadsOf(batch));
    } catch (err) {
      error = err;
      failed = true;
    }
    const seen = failed ? namespaceOfError(error) : result?.namespace;

    if (this.isMismatch(seen, failed ? codeOf(error) : undefined)) {
      // Keep the batch (not acked), stop, and retry this same batch later.
      this.queue.unshift(...batch);
      this.flushing = false;
      this.onMismatch(seen ?? null);
      return;
    }
    if (this.halt) {
      if (seen === this.namespace) {
        // The mismatch was one bad node; this answer agrees again. Resume.
        this.halt = null;
        this.releaseHeld();
      } else {
        // No namespace in the answer (network failure): still in doubt.
        this.queue.unshift(...batch);
        this.flushing = false;
        if (failed) this.reportError(error);
        this.onMismatch(this.halt.got);
        return;
      }
    }
    if (failed) {
      // Retain: return the batch to the front (order preserved) and retry.
      this.queue.unshift(...batch);
      this.flushing = false;
      this.reportError(error);
      this.scheduleRetry(retryAfterOf(error));
      return;
    }
    this.spool.ack(batch[batch.length - 1]!.seq);
    this.flushing = false;
    this.reportRejected(result);
    this.scheduleNext();
  }

  /** A response namespace that contradicts the configured one (null + NAMESPACE_UNAVAILABLE counts). */
  private isMismatch(seen: string | null | undefined, code: string | undefined): boolean {
    if (this.namespace === null) return false;
    if (code === "NAMESPACE_UNAVAILABLE") return true;
    return typeof seen === "string" && seen !== this.namespace;
  }

  private onMismatch(got: string | null): void {
    if (!this.halt) {
      this.halt = { got, retries: 0, fatal: false };
    } else {
      this.halt.got = got;
      this.halt.retries++;
    }
    const h = this.halt;
    h.fatal = h.retries >= this.namespaceRetries;
    this.reportError(new NamespaceMismatchError(this.namespace!, got, h.retries, this.namespaceRetries, h.fatal));
    if (h.fatal) {
      this.clearTimer();
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushBatch(true);
    }, this.namespaceRetryMs * 2 ** h.retries);
    this.timer.unref?.();
  }

  /** A 200's `rejected` are permanent: report them, never silently. */
  private reportRejected(result: SendResult | void): void {
    const rejected = result?.rejected;
    if (!rejected || rejected.length === 0) return;
    const ns = result?.namespace;
    let hint: string | undefined;
    if (rejected.some((r) => r.reason.startsWith("agentId_namespace"))) {
      hint =
        this.namespace === null && typeof ns === "string"
          ? `This key's namespace is '${ns}': configure new Attestor({ namespace: "${ns}" }) so agentIds are prefixed before hashing`
          : "These DARs were built with another namespace prefix; the prefix is inside the hash, so they cannot be repaired";
    }
    this.reportError(new BatchRejectedError(rejected, ns, hint));
  }

  /**
   * `namespace: "discover"`: send empty batches until DISCOVERY_AGREEMENT
   * consecutive answers carry the same namespace, then persist and use it.
   */
  private async discover(): Promise<void> {
    let last: string | null = null;
    let streak = 0;
    let wait = this.retryMs;
    while (!this.closed) {
      let ns: string | null | undefined;
      try {
        ns = (await this.transport.send([]))?.namespace;
      } catch (err) {
        this.reportError(err);
        ns = undefined;
      }
      if (this.closed) return;
      if (typeof ns === "string" && NAMESPACE_RE.test(ns)) {
        streak = ns === last ? streak + 1 : 1;
        last = ns;
        if (streak >= DISCOVERY_AGREEMENT) {
          this.namespace = ns;
          this.saveNamespace(ns);
          this.discovering = false;
          this.releaseHeld();
          this.scheduleNext();
          return;
        }
        continue;
      }
      if (ns !== undefined) {
        this.reportError(new Error(`namespace discovery: server answered namespace ${JSON.stringify(ns)}`));
      }
      streak = 0;
      last = null;
      await delay(wait);
      wait = Math.min(wait * 2, 60_000);
    }
  }

  private loadNamespace(): string | null {
    let raw: string;
    try {
      raw = readFileSync(this.namespacePath, "utf8");
    } catch {
      return null; // not discovered yet
    }
    try {
      const ns = (JSON.parse(raw) as { namespace?: unknown }).namespace;
      if (typeof ns === "string" && NAMESPACE_RE.test(ns)) return ns;
    } catch {
      // fall through
    }
    this.reportError(new Error(`namespace file ${this.namespacePath} is unreadable; rediscovering`));
    return null;
  }

  private saveNamespace(ns: string): void {
    const tmp = `${this.namespacePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ namespace: ns }) + "\n");
      renameSync(tmp, this.namespacePath);
    } catch (err) {
      this.reportError(err);
    }
  }

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
  private attestChained(store: ChainHeadStore, input: DarBuildInput, decisionId: string, at: number): string | null {
    let accepted: string | null = null;
    try {
      const { agentId } = input;
      store.advance(agentId, (head) => {
        const prev = head ?? this.builder.getHead(agentId) ?? null;
        const dar = this.builder.build(input, { prev, decisionId, at });
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
    if (this.discovering || this.halt) return;
    if (this.queue.length >= this.maxBatch) this.scheduleFlush();
    else if (this.queue.length > 0) this.armTimer();
  }

  private armTimer(): void {
    if (this.timer || this.flushing || this.closed || this.discovering || this.halt) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleFlush();
    }, this.maxWaitMs);
    this.timer.unref?.();
  }

  private scheduleRetry(retryAfterMs?: number): void {
    if (this.timer || this.flushing || this.closed || this.halt) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleFlush();
    }, Math.max(this.retryMs, retryAfterMs ?? 0));
    this.timer.unref?.();
  }

  private scheduleFlush(): void {
    if (this.halt) return; // its retry timer is the only thing that may send
    this.clearTimer();
    if (this.flushing || this.closed || this.discovering) return;
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
      this.onError(err);
    } catch {
      // An onError that throws must not escape attest().
    }
  }
}

/** Without an onError, failures are still visible: never silent. */
function defaultOnError(err: unknown): void {
  console.warn(`[${SDK_NAME}]`, err instanceof Error ? `${err.name}: ${err.message}` : err);
}

function namespaceOfError(err: unknown): string | null | undefined {
  if (typeof err !== "object" || err === null || !("namespace" in err)) return undefined;
  const ns = (err as { namespace: unknown }).namespace;
  return typeof ns === "string" || ns === null ? ns : undefined;
}

function codeOf(err: unknown): string | undefined {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

function retryAfterOf(err: unknown): number | undefined {
  const ms = typeof err === "object" && err !== null ? (err as { retryAfterMs?: unknown }).retryAfterMs : undefined;
  return typeof ms === "number" ? ms : undefined;
}
