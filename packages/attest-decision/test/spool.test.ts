import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spool, type DarCore } from "../src/index.js";

function dar(n: number): DarCore {
  return {
    v: "DAR/0.1",
    decisionId: `ID${String(n).padStart(24, "0")}`,
    agentId: "agent://test",
    ts: "2025-09-22T00:10:00.000Z",
    prev: null,
    leafType: "decision",
    schemaHash: `sha3-256:${"0".repeat(64)}`,
    inputHash: `sha3-256:${"1".repeat(64)}`,
    outputHash: `sha3-256:${"2".repeat(64)}`,
    decisionHash: `sha3-256:${"3".repeat(64)}`,
  };
}

/** Recover the record's ordinal from its decisionId (hashes-only core has no payload). */
const nOf = (d: DarCore): number => Number(d.decisionId.slice(2));

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-spool-"));
  path = join(dir, "attest.spool");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Spool", () => {
  it("appends records and lists them as pending in order", () => {
    const s = new Spool(path);
    s.append(dar(1));
    s.append(dar(2));
    const pending = s.pending();
    expect(pending.map((r) => r.seq)).toEqual([1, 2]);
    expect(pending.map((r) => nOf(r.dar))).toEqual([1, 2]);
    s.close();
  });

  it("recovers un-acked records in a fresh instance", () => {
    const s1 = new Spool(path);
    s1.append(dar(1));
    s1.append(dar(2));
    s1.append(dar(3));
    s1.close(); // no fsync, no ack — like a process that just went away

    const s2 = new Spool(path);
    expect(s2.pending().map((r) => nOf(r.dar))).toEqual([1, 2, 3]);
    expect(s2.currentSeq()).toBe(3);
    s2.close();
  });

  it("ack drops delivered records and persists the watermark", () => {
    const s1 = new Spool(path);
    s1.append(dar(1));
    s1.append(dar(2));
    s1.append(dar(3));
    s1.ack(2);
    expect(s1.pending().map((r) => r.seq)).toEqual([3]);
    s1.close();

    // Watermark survives restart: only seq 3 replays.
    const s2 = new Spool(path);
    expect(s2.pending().map((r) => r.seq)).toEqual([3]);
    s2.close();
  });

  it("truncates the file once everything is acked", () => {
    const s = new Spool(path);
    s.append(dar(1));
    s.append(dar(2));
    expect(statSync(path).size).toBeGreaterThan(0);
    s.ack(2);
    expect(statSync(path).size).toBe(0);
    expect(s.pending()).toEqual([]);
    s.close();
  });

  it("enforces the byte cap by dropping oldest (compaction is deferred off the append path)", () => {
    // Small cap so only the newest few records survive after compaction.
    const s = new Spool(path, { maxBytes: 2000 });
    for (let i = 1; i <= 50; i++) s.append(dar(i));
    // append() only flags; nothing is dropped until compactIfNeeded() runs.
    expect(s.needsCompaction()).toBe(true);
    expect(s.pending().length).toBe(50);
    s.compactIfNeeded();
    const pending = s.pending();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(50);
    expect(s.droppedCount()).toBe(50 - pending.length);
    // Survivors are the newest records (drop-oldest).
    const ns = pending.map((r) => nOf(r.dar));
    expect(ns[ns.length - 1]).toBe(50);
    expect(Math.min(...ns)).toBeGreaterThan(1);
    s.close();

    // Dropped records are gone after recovery too.
    const s2 = new Spool(path);
    expect(s2.pending().length).toBe(pending.length);
    s2.close();
  });

  it("surfaces cap drops via the onDrop callback", () => {
    let dropped = 0;
    const s = new Spool(path, { maxBytes: 400, onDrop: (n) => (dropped += n) });
    for (let i = 1; i <= 30; i++) s.append(dar(i));
    s.compactIfNeeded();
    expect(dropped).toBe(s.droppedCount());
    expect(dropped).toBeGreaterThan(0);
    s.close();
  });

  it("creates the spool parent directory if it does not exist", () => {
    const nested = join(dir, "a", "b", "c", "attest.spool");
    const s = new Spool(nested);
    s.append(dar(1));
    expect(s.pending().length).toBe(1);
    s.close();
  });

  it("creates an ack sidecar and no leftover temp files", () => {
    const s = new Spool(path);
    s.append(dar(1));
    s.ack(1);
    expect(existsSync(`${path}.ack`)).toBe(true);
    expect(existsSync(`${path}.compact`)).toBe(false);
    s.close();
  });
});
