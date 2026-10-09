import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfill, Index, ingest, type AttestationBundle } from "../src/index.js";

const require = createRequire(import.meta.url);
const ANCHOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROOT = "ab".repeat(32);
const TOPIC = "0.0.10416909";

function dar(decisionId: string, attestationId: string): AttestationBundle {
  return {
    attestationId,
    dar: {
      v: "DAR/0.1", decisionId, agentId: "ns_0123456789ab/agent", ts: "2026-09-01T00:00:00.000Z", prev: null,
      leafType: "decision", schemaHash: "sha3-256:s", inputHash: "sha3-256:i", outputHash: "sha3-256:o",
      decisionHash: `sha3-256:${decisionId}`,
    },
  };
}
const att = (id: string) => JSON.stringify({ id, ts: "2026-09-01T00:00:00.000Z", src: null, seq: null, sig: "x".repeat(16) });
const link = (id: string, seq: string, over: Record<string, unknown> = {}) => JSON.stringify({
  kind: "anchor-link", v: 1, id, anchorId: ANCHOR, aggregateRoot: ROOT, topic: TOPIC, hcsSequence: seq,
  hcsConsensusTs: null, source: "anchor-job", writtenAt: "2026-09-01T00:01:00.000Z", ...over });

let base: string, store: string, indexDir: string, jsonl: string;
const writeJsonl = (lines: string[]) => writeFileSync(jsonl, lines.map((l) => l + "\n").join(""));
const anchored = (decisionId: string) => {
  const idx = new Index(indexDir, { readonly: true });
  try { return idx.byDecisionIdAnchored(decisionId); } finally { idx.close(); }
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "rubric-ingest-"));
  store = join(base, "bundles");
  indexDir = join(base, "index");
  jsonl = join(store, "attestation-index.jsonl");
  mkdirSync(join(store, "decisions", "2026-09-01"), { recursive: true });
  for (const [d, a] of [["D1", "t1"], ["D2", "t2"], ["D3", "t3"], ["D4", "t4"]] as const)
    writeFileSync(join(store, "decisions", "2026-09-01", `${d}.json`), JSON.stringify(dar(d, a)));
});
afterEach(() => {
  try { chmodSync(jsonl, 0o644); } catch { /* absent */ }
  rmSync(base, { recursive: true, force: true });
});

describe("ingest: anchor columns from the jsonl", () => {
  it("a DAR row's columns equal the merged link set for its tiered id", () => {
    writeJsonl([att("t1"), att("t2"), att("plain-1"), att("plain-2"),
      link("t1", "100"), link("t1", "100", { hcsConsensusTs: "1759000000.000000100", source: "backfill-mirror", writtenAt: "2026-09-02T00:00:00.000Z" })]);
    const r = ingest(jsonl, store, indexDir);
    expect(anchored("D1")).toMatchObject({ attestationId: "t1", anchorId: ANCHOR, aggregateRoot: ROOT,
      hcsSequences: ["100"], hcsConsensusTs: "1759000000.000000100", anchorConflict: 0 });
    expect(anchored("D2")).toMatchObject({ anchorId: null, hcsSequences: null, anchorConflict: null });
    expect(r).toMatchObject({ lines: 6, attestationLines: 4, nonDarAttestationLines: 2, linkLines: 2, darRows: 4,
      anchoredRows: 1, conflicts: 0, fullReingest: true });
  });

  it("out-of-order retry: S2 linked first, then the lower S1 -> ascending sequences, no conflict", () => {
    writeJsonl([att("t1"), link("t1", "100")]); // retry S2 = 100, receipt-only
    ingest(jsonl, store, indexDir);
    expect(anchored("D1")).toMatchObject({ hcsSequences: ["100"], hcsConsensusTs: null, anchorConflict: 0 });
    appendFileSync(jsonl, link("t1", "99", { hcsConsensusTs: "1759000000.000000099", source: "backfill-mirror" }) + "\n");
    const r = ingest(jsonl, store, indexDir);
    expect(anchored("D1")).toMatchObject({ hcsSequences: ["99", "100"], hcsConsensusTs: "1759000000.000000099", anchorConflict: 0 });
    expect(r).toMatchObject({ fullReingest: false, newLines: 1, anchorRowsUpdated: 1 });
  });

  it("columns are derived: a new group extends them, a conflict sets anchorConflict and is reported", () => {
    writeJsonl([link("t1", "5"), link("t2", "5"), link("t3", "5")]);
    ingest(jsonl, store, indexDir);
    appendFileSync(jsonl, [
      link("t1", "9"),                                   // retry: not a conflict
      link("t2", "5", { aggregateRoot: "cd".repeat(32) }), // field conflict in one group
      link("t3", "6", { anchorId: OTHER }),              // one id, two anchorIds
    ].join("\n") + "\n");
    const r = ingest(jsonl, store, indexDir);
    expect(anchored("D1")).toMatchObject({ hcsSequences: ["5", "9"], anchorConflict: 0 });
    // On a conflict the columns hold the first-written values.
    expect(anchored("D2")).toMatchObject({ aggregateRoot: ROOT, hcsSequences: ["5"], anchorConflict: 1 });
    expect(anchored("D3")).toMatchObject({ anchorId: ANCHOR, hcsSequences: ["5"], anchorConflict: 1 });
    expect(r.conflicts).toBe(2);
    expect(r.conflictIds).toEqual(["t2", "t3"]);
  });

  it("source and writtenAt never conflict; groups of one anchorId with different roots do", () => {
    writeJsonl([link("t1", "5"), link("t1", "5", { source: "backfill-mirror", writtenAt: "2027-01-01T00:00:00.000Z" }),
      link("t2", "5"), link("t2", "6", { aggregateRoot: "cd".repeat(32) })]);
    ingest(jsonl, store, indexDir);
    expect(anchored("D1")?.anchorConflict).toBe(0);
    expect(anchored("D2")?.anchorConflict).toBe(1);
  });

  it("a malformed link line for an id fails closed (anchorConflict = 1)", () => {
    writeJsonl([link("t1", "100"), link("t1", "0100"), link("t2", "7", { anchorId: 42 })]);
    const r = ingest(jsonl, store, indexDir);
    expect(anchored("D1")).toMatchObject({ hcsSequences: ["100"], anchorConflict: 1 });
    expect(anchored("D2")).toMatchObject({ anchorId: null, hcsSequences: null, anchorConflict: 1 });
    expect(r).toMatchObject({ malformedLines: 2, conflicts: 2 });
  });

  it("re-running gives byte-identical query results and writes nothing", () => {
    writeJsonl([att("t1"), link("t1", "100"), link("t2", "7", { hcsConsensusTs: "1759000000.000000007" })]);
    ingest(jsonl, store, indexDir);
    const snap = () => JSON.stringify(["D1", "D2", "D3", "D4"].map(anchored));
    const before = snap();
    const r = ingest(jsonl, store, indexDir);
    expect(snap()).toBe(before);
    expect(r).toMatchObject({ anchorRowsUpdated: 0, newLines: 0, fullReingest: false });
  });

  it("a cursor whose line no longer has the recorded id triggers a full, idempotent re-ingest", () => {
    writeJsonl([att("t1"), link("t1", "100")]);
    ingest(jsonl, store, indexDir);
    const before = JSON.stringify(anchored("D1"));
    writeJsonl([link("t1", "100"), att("replaced")]); // same length, different id at the cursor line
    const r = ingest(jsonl, store, indexDir);
    expect(r.fullReingest).toBe(true);
    expect(r.newLines).toBe(2);
    expect(JSON.stringify(anchored("D1"))).toBe(before);

    writeJsonl([link("t1", "100")]); // shorter than the cursor
    expect(ingest(jsonl, store, indexDir).fullReingest).toBe(true);

    writeJsonl([]); // links gone: the columns follow the jsonl back to null
    ingest(jsonl, store, indexDir);
    expect(anchored("D1")).toMatchObject({ anchorId: null, hcsSequences: null, anchorConflict: null });
  });

  it("ignores a trailing partial line", () => {
    writeFileSync(jsonl, att("t1") + "\n" + link("t1", "100").slice(0, 40));
    const r = ingest(jsonl, store, indexDir);
    expect(r).toMatchObject({ lines: 1, partialTrailingLine: true, linkLines: 0 });
    expect(anchored("D1")?.hcsSequences).toBeNull();
  });

  it("never opens the jsonl for writing", () => {
    writeJsonl([att("t1"), link("t1", "100")]);
    const bytes = readFileSync(jsonl);
    const mtime = statSync(jsonl).mtimeMs;
    const fs = require("node:fs") as typeof import("node:fs");
    const names = ["openSync", "writeFileSync", "appendFileSync", "renameSync", "truncateSync", "createWriteStream"] as const;
    type Fn = (...a: unknown[]) => unknown;
    const mfs = fs as unknown as Record<string, Fn>;
    const orig = Object.fromEntries(names.map((n) => [n, mfs[n]!])) as Record<string, Fn>;
    const calls: [string, string, unknown][] = [];
    for (const n of names) mfs[n] = (p: unknown, ...rest: unknown[]) => { calls.push([n, String(p), rest[0]]); return orig[n]!(p, ...rest); };
    syncBuiltinESMExports();
    try { ingest(jsonl, store, indexDir); } finally { Object.assign(fs, orig); syncBuiltinESMExports(); }
    const onJsonl = calls.filter(([, p]) => p === jsonl);
    expect(onJsonl).toEqual([["openSync", jsonl, "r"]]);
    expect(readFileSync(jsonl)).toEqual(bytes);
    expect(statSync(jsonl).mtimeMs).toBe(mtime);

    chmodSync(jsonl, 0o444); // a read-only jsonl ingests fine
    expect(() => ingest(jsonl, store, indexDir)).not.toThrow();
  });

  it("makes zero network requests", () => {
    writeJsonl([link("t1", "100")]);
    const g = globalThis as { fetch?: unknown };
    const saved = g.fetch;
    let calls = 0;
    g.fetch = () => { calls++; throw new Error("network"); };
    try { ingest(jsonl, store, indexDir); } finally { g.fetch = saved; }
    expect(calls).toBe(0);
    const src = readFileSync(new URL("../src/ingest.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "node:(http|https|net|tls|dgram|dns)"|fetch\(/);
  });

  it("backfill never writes the anchor columns", () => {
    writeJsonl([link("t1", "100")]);
    ingest(jsonl, store, indexDir);
    backfill(store, indexDir);
    expect(anchored("D1")?.hcsSequences).toEqual(["100"]);
  });
});
