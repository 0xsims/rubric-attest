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
    schemaHash: "sha3-256:0000000000000000000000000000000000000000000000000000000000000000",
    decisionHash: "sha3-256:1111111111111111111111111111111111111111111111111111111111111111",
    decision: { n },
  };
}

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
    expect(pending.map((r) => r.dar.decision.n)).toEqual([1, 2]);
    s.close();
  });

  it("recovers un-acked records in a fresh instance", () => {
    const s1 = new Spool(path);
    s1.append(dar(1));
    s1.append(dar(2));
    s1.append(dar(3));
    s1.close(); // no fsync, no ack — like a process that just went away

    const s2 = new Spool(path);
    expect(s2.pending().map((r) => r.dar.decision.n)).toEqual([1, 2, 3]);
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
    // Tiny cap so a few records trip the cap.
    const s = new Spool(path, { maxBytes: 400 });
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
    const ns = pending.map((r) => r.dar.decision.n as number);
    expect(ns[ns.length - 1]).toBe(50);
    expect(Math.min(...ns)).toBeGreaterThan(1);
    s.close();

    // Dropped records are gone after recovery too.
    const s2 = new Spool(path);
    expect(s2.pending().length).toBe(pending.length);
    s2.close();
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
