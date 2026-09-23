/**
 * Chain-head stores: shared per-agent `prev` heads (spec/dar-0.1.md §2.1).
 *
 * Without a store, each Attestor keeps its chain heads in memory, so several
 * processes attesting for one `agentId` (pm2 workers, restarts) each grow their
 * own chain. A `ChainHeadStore` makes the head shared: the Attestor runs every
 * record's chain step inside `advance()`, which gives it exclusive access to
 * that agent's head across processes. Each step reads the head, builds a record
 * whose `prev` is that head, spools it, and the store then persists the new
 * head. Because the read, the build and the head write are serialized per
 * agent, no two records can name the same `prev`, so the chain stays linear.
 *
 * `FileChainHeadStore` is the one-host implementation: a directory holding one
 * `<sha3(agentId)>.head` file and a transient `<sha3(agentId)>.lock` file per
 * agent. It is meant for low-traffic routes; every attest pays a lock, a small
 * read, and (by default) an fsync'd head write.
 */
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha3_256Hex } from "./hash.js";

/**
 * A shared, per-agent chain-head store. Implementations must be synchronous
 * (attest() is synchronous) and must serialize `advance()` calls for the same
 * `agentId` across every process that shares the store.
 */
export interface ChainHeadStore {
  /**
   * Run one chain step for `agentId` with exclusive access to its head.
   *
   * `step` receives the stored head (`null` when the store has no head for this
   * agent yet) and returns the head to persist, or `null` to leave it unchanged.
   * If `step` throws, nothing is persisted and the error propagates.
   *
   * Throws `ChainHeadStoreError` when exclusive access can't be had in time
   * (`code: "lock-timeout"`) or when the head can't be read or written
   * (`code: "io"`). The Attestor turns either into a skipped record.
   */
  advance(agentId: string, step: (head: string | null) => string | null): void;
}

export type ChainHeadStoreErrorCode = "lock-timeout" | "io";

export class ChainHeadStoreError extends Error {
  readonly code: ChainHeadStoreErrorCode;
  constructor(code: ChainHeadStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainHeadStoreError";
    this.code = code;
  }
}

export interface FileChainHeadStoreOptions {
  /** Directory holding the per-agent `.head` and `.lock` files. Created if missing. */
  dir: string;
  /** Give up acquiring an agent's lock after this long. Default 250 ms. */
  lockTimeoutMs?: number;
  /**
   * A lock older than this is presumed abandoned and broken. A lock whose
   * holder pid (on this host) no longer exists is broken immediately.
   * Default 10000 ms; it must comfortably exceed the longest real critical
   * section (a hash of one decision plus a spool append and a head write).
   */
  staleLockMs?: number;
  /** fsync the head file and directory on every write. Default true. */
  fsync?: boolean;
}

interface HeadFile {
  v: 1;
  agentId: string;
  head: string;
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  at: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 250;
const DEFAULT_STALE_LOCK_MS = 10_000;
const HOST = hostname();

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
/** Synchronous sleep; attest() can't await. */
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === "EPERM"; // exists, owned by another user
  }
}

function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/**
 * One-host, multi-process chain-head store backed by a directory of files.
 *
 * Locking: `<key>.lock` is taken with an exclusive create (O_CREAT|O_EXCL),
 * which is atomic on a local filesystem. A lock whose holder is dead, or which
 * is older than `staleLockMs`, is broken by renaming it aside and confirming the
 * renamed file is the one judged stale (same inode); a lock that was replaced in
 * between is put back. The holder re-checks that it still owns the lock just
 * before writing the head, so a holder whose lock was broken never commits.
 *
 * Head writes go to a temp file that is fsync'd and renamed over `<key>.head`,
 * so a reader sees either the old head or the new one, never a torn file.
 */
export class FileChainHeadStore implements ChainHeadStore {
  private readonly dir: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly fsync: boolean;

  constructor(options: FileChainHeadStoreOptions) {
    this.dir = options.dir;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.fsync = options.fsync !== false;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Path of the head file for an agent (SHA3-256 of the agentId, so any agentId is a safe name). */
  headPath(agentId: string): string {
    return join(this.dir, `${this.keyOf(agentId)}.head`);
  }

  /** Read an agent's head without locking. `null` if none. Throws on a corrupt file. */
  readHead(agentId: string): string | null {
    let raw: string;
    try {
      raw = readFileSync(this.headPath(agentId), "utf8");
    } catch (e) {
      if (errCode(e) === "ENOENT") return null;
      throw new ChainHeadStoreError("io", `chain head read failed for '${agentId}': ${String(e)}`, { cause: e });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new ChainHeadStoreError("io", `chain head file for '${agentId}' is not JSON`, { cause: e });
    }
    const h = parsed as Partial<HeadFile> | null;
    if (!h || h.v !== 1 || h.agentId !== agentId || typeof h.head !== "string" || h.head.length === 0) {
      throw new ChainHeadStoreError("io", `chain head file for '${agentId}' is malformed`);
    }
    return h.head;
  }

  advance(agentId: string, step: (head: string | null) => string | null): void {
    const key = this.keyOf(agentId);
    const lockPath = join(this.dir, `${key}.lock`);
    const owner = this.acquire(lockPath, agentId);
    try {
      const head = this.readHead(agentId);
      const next = step(head);
      if (next === null || next === head) return;
      if (typeof next !== "string" || next.length === 0) {
        throw new Error("chain step returned an invalid head");
      }
      if (!this.stillOwned(lockPath, owner)) {
        throw new ChainHeadStoreError("lock-timeout", `chain lock for '${agentId}' was broken while held`);
      }
      this.writeHead(key, { v: 1, agentId, head: next });
    } finally {
      this.release(lockPath, owner);
    }
  }

  // --- internals ---

  private keyOf(agentId: string): string {
    return sha3_256Hex(agentId);
  }

  private acquire(lockPath: string, agentId: string): LockOwner {
    const owner: LockOwner = { pid: process.pid, host: HOST, token: randomBytes(12).toString("hex"), at: Date.now() };
    const deadline = Date.now() + this.lockTimeoutMs;
    let wait = 1;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx");
        try {
          writeAll(fd, JSON.stringify({ ...owner, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        return owner;
      } catch (e) {
        if (errCode(e) !== "EEXIST") {
          throw new ChainHeadStoreError("io", `chain lock create failed for '${agentId}': ${String(e)}`, { cause: e });
        }
      }
      if (this.breakIfStale(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new ChainHeadStoreError("lock-timeout", `chain lock for '${agentId}' not acquired within ${this.lockTimeoutMs} ms`);
      }
      sleepSync(wait + Math.floor(Math.random() * wait));
      wait = Math.min(wait * 2, 16);
    }
  }

  /** Break an abandoned lock. Returns true if the caller should retry the create immediately. */
  private breakIfStale(lockPath: string): boolean {
    let ino: number;
    let mtimeMs: number;
    let holder: Partial<LockOwner> | null = null;
    try {
      const st = statSync(lockPath);
      ino = st.ino;
      mtimeMs = st.mtimeMs;
      holder = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    } catch (e) {
      if (errCode(e) === "ENOENT") return true; // released meanwhile
      // Unparseable: possibly mid-write by its creator. Judge by age alone.
      try {
        const st = statSync(lockPath);
        ino = st.ino;
        mtimeMs = st.mtimeMs;
      } catch {
        return true;
      }
    }
    const age = Date.now() - mtimeMs;
    const deadHolder =
      holder !== null && holder.host === HOST && typeof holder.pid === "number" && holder.pid !== process.pid && !pidAlive(holder.pid);
    if (!deadHolder && age < this.staleLockMs) return false;

    const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.broken`;
    try {
      renameSync(lockPath, aside);
    } catch (e) {
      return errCode(e) === "ENOENT";
    }
    try {
      if (statSync(aside).ino !== ino) {
        // We moved a fresh lock taken after our check: put it back if the slot is free.
        try {
          linkSync(aside, lockPath);
        } catch {
          // Someone else holds the slot now; the displaced holder will see it lost
          // ownership in stillOwned() and not commit.
        }
      }
    } finally {
      try {
        unlinkSync(aside);
      } catch {
        // best effort
      }
    }
    return true;
  }

  private stillOwned(lockPath: string, owner: LockOwner): boolean {
    try {
      const cur = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
      return cur.token === owner.token;
    } catch {
      return false;
    }
  }

  private release(lockPath: string, owner: LockOwner): void {
    if (!this.stillOwned(lockPath, owner)) return; // broken by another process; not ours to delete
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone. A leftover lock is broken by the next caller once stale.
    }
  }

  private writeHead(key: string, contents: HeadFile): void {
    const final = join(this.dir, `${key}.head`);
    const tmp = `${final}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      const fd = openSync(tmp, "w");
      try {
        writeAll(fd, JSON.stringify(contents));
        if (this.fsync) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, final);
      if (this.fsync) {
        const dfd = openSync(this.dir, "r");
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      }
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp may not exist
      }
      throw new ChainHeadStoreError("io", `chain head write failed for '${contents.agentId}': ${String(e)}`, { cause: e });
    }
  }
}
