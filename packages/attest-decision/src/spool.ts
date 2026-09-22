/**
 * Durable append-only spool (tasks/P1.md).
 *
 * Durability model: `attest()` must add <1 ms to the caller, so we CANNOT fsync
 * on the append path. Instead each record is appended with a single `writeSync`.
 * A `writeSync` hands the bytes to the kernel, so they survive process death
 * (`kill -9`) — only a machine/OS crash could lose them, and that is what the
 * background `fsync()` (called off the caller path, before each network flush)
 * defends against. On restart, `pending()` replays everything not yet acked, so
 * zero spooled records are lost.
 *
 * Format: one JSON line per record, `{"seq":N,"dar":{...}}\n`. Acknowledgement
 * is a monotonic high-water mark `ackedThrough` persisted in a `<path>.ack`
 * sidecar; records are FIFO so a single watermark suffices. When the file
 * exceeds `maxBytes` it is compacted (acked records dropped; then oldest pending
 * dropped — "drop-oldest" — until under cap).
 */
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DarCore } from "./constants.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB (tasks/P1.md)

export interface SpoolRecord {
  seq: number;
  dar: DarCore;
}

export interface SpoolOptions {
  maxBytes?: number;
  /** Called when the drop-oldest cap policy discards records (data loss). */
  onDrop?: (count: number) => void;
}

/** Write an entire buffer, looping over short writes (write(2) may be partial). */
function writeFully(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}

/** Durably write a small file (write + fsync). */
function writeFileDurable(path: string, contents: string): void {
  const fd = openSync(path, "w");
  try {
    writeFully(fd, Buffer.from(contents, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** fsync a directory so a rename/create within it is durable. */
function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class Spool {
  private readonly path: string;
  private readonly dir: string;
  private readonly ackPath: string;
  private readonly maxBytes: number;
  private readonly onDrop?: (count: number) => void;

  private fd: number;
  private seq = 0;
  private ackedThrough = 0;
  private bytes = 0;
  private droppedForCap = 0;
  private compactionPending = false;
  private pendingRecords: SpoolRecord[] = [];

  constructor(path: string, options: SpoolOptions = {}) {
    this.path = path;
    this.dir = dirname(path);
    this.ackPath = `${path}.ack`;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onDrop = options.onDrop;
    // Create the spool directory if missing so a documented path like
    // /var/lib/rubric/attest.spool works without a separate mkdir.
    mkdirSync(this.dir, { recursive: true });
    this.ackedThrough = this.readAck();
    this.recover();
    // Open the append fd after recovery has read the current contents.
    this.fd = openSync(this.path, "a");
    this.bytes = fstatSync(this.fd).size;
  }

  /** Records written but not yet acknowledged, in FIFO order. */
  pending(): SpoolRecord[] {
    return this.pendingRecords.slice();
  }

  /** Count of records dropped by the drop-oldest cap policy so far. */
  droppedCount(): number {
    return this.droppedForCap;
  }

  currentSeq(): number {
    return this.seq;
  }

  /**
   * Append a record durably (single `writeSync`, no fsync). Returns its seq.
   * Never compacts inline — that would put a multi-MB `writeFileSync`+`fsync` on
   * the caller's `attest()` path. Crossing the cap only flags compaction, which
   * `compactIfNeeded()` performs off the caller path (see the Attestor flush).
   */
  append(dar: DarCore): number {
    const seq = ++this.seq;
    const record: SpoolRecord = { seq, dar };
    const line = JSON.stringify(record) + "\n";
    const buf = Buffer.from(line, "utf8");
    writeFully(this.fd, buf); // loop over short writes so a line is never torn
    this.bytes += buf.byteLength;
    this.pendingRecords.push(record);
    if (this.bytes > this.maxBytes) this.compactionPending = true;
    return seq;
  }

  /** Whether the file has grown past the cap and awaits compaction. */
  needsCompaction(): boolean {
    return this.compactionPending;
  }

  /** Reclaim acked space and enforce the cap (drop-oldest). Off the caller path. */
  compactIfNeeded(): void {
    if (!this.compactionPending) return;
    this.compact();
    this.compactionPending = false;
  }

  /**
   * Acknowledge every record with seq <= `throughSeq` (they were delivered).
   * Advances the durable watermark; truncates the file once fully drained.
   */
  ack(throughSeq: number): void {
    if (throughSeq <= this.ackedThrough) return;
    this.ackedThrough = throughSeq;
    this.pendingRecords = this.pendingRecords.filter((r) => r.seq > throughSeq);
    this.writeAck();
    if (this.pendingRecords.length === 0) {
      // Steady state: everything delivered. Reclaim the file entirely.
      ftruncateSync(this.fd, 0);
      this.bytes = 0;
    }
  }

  /** Flush OS buffers to disk. Called off the caller path, before network I/O. */
  fsync(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }

  // --- internals ---

  private recover(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // no spool file yet
    }
    let maxSeq = 0;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      let record: SpoolRecord;
      try {
        record = JSON.parse(line) as SpoolRecord;
      } catch {
        continue; // tolerate a torn trailing line from a crash mid-write
      }
      if (typeof record.seq !== "number") continue;
      if (record.seq > maxSeq) maxSeq = record.seq;
      if (record.seq > this.ackedThrough) this.pendingRecords.push(record);
    }
    this.pendingRecords.sort((a, b) => a.seq - b.seq);
    this.seq = maxSeq;
  }

  private compact(): void {
    // Drop oldest pending until the surviving set fits under the cap.
    const kept = this.pendingRecords.slice();
    let size = kept.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r) + "\n"), 0);
    let droppedNow = 0;
    while (size > this.maxBytes && kept.length > 0) {
      const dropped = kept.shift()!;
      size -= Buffer.byteLength(JSON.stringify(dropped) + "\n");
      this.droppedForCap++;
      droppedNow++;
    }

    const tmp = `${this.path}.compact`;
    const body = kept.map((r) => JSON.stringify(r) + "\n").join("");
    writeFileDurable(tmp, body);
    closeSync(this.fd);
    renameSync(tmp, this.path);
    fsyncDir(this.dir); // make the rename durable across a power loss
    this.fd = openSync(this.path, "a");
    this.bytes = fstatSync(this.fd).size;
    this.pendingRecords = kept;

    // Surface the drop-oldest data loss rather than discarding silently.
    if (droppedNow > 0) this.onDrop?.(droppedNow);
  }

  private readAck(): number {
    try {
      const n = Number.parseInt(readFileSync(this.ackPath, "utf8").trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private writeAck(): void {
    // fsync the watermark so a crash cannot resurrect already-acked records
    // (bounding duplicate re-delivery on recovery).
    writeFileDurable(this.ackPath, String(this.ackedThrough));
  }
}

export { DEFAULT_MAX_BYTES };
