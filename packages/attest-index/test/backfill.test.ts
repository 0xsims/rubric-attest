import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HashString } from "@rubric/attest-decision";
import { backfill, Index, type AttestationBundle } from "../src/index.js";

function bundle(
  id: string,
  agentId: string,
  ts: string,
  schemaHash: HashString,
  prev: string | null,
): AttestationBundle {
  return {
    attestationId: `att-${id}`,
    dar: {
      v: "DAR/0.1",
      decisionId: id,
      agentId,
      ts,
      prev,
      leafType: "decision",
      schemaHash,
      decisionHash: `sha3-256:${id}`,
      decision: { id },
    },
  };
}

let store: string;
let indexDir: string;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "rubric-bf-"));
  store = join(base, "store");
  indexDir = join(base, "index");
  mkdirSync(store, { recursive: true });
  mkdirSync(join(store, "nested"), { recursive: true });
});
afterEach(() => {
  rmSync(join(store, ".."), { recursive: true, force: true });
});

function seedStore(): void {
  // Two days -> two shards. One bundle nested in a subdir. One junk file skipped.
  writeFileSync(join(store, "a1.json"), JSON.stringify(bundle("A1", "agent://A", "2025-09-22T00:00:01.000Z", "sha3-256:s1", null)));
  writeFileSync(join(store, "a2.json"), JSON.stringify(bundle("A2", "agent://A", "2025-09-22T00:00:02.000Z", "sha3-256:s1", "A1")));
  writeFileSync(join(store, "nested", "a3.json"), JSON.stringify(bundle("A3", "agent://A", "2025-09-23T00:00:00.000Z", "sha3-256:s2", "A2")));
  writeFileSync(join(store, "b1.json"), JSON.stringify(bundle("B1", "agent://B", "2025-09-22T00:00:05.000Z", "sha3-256:s1", null)));
  writeFileSync(join(store, "notabundle.json"), JSON.stringify({ hello: "world" }));
  writeFileSync(join(store, "broken.json"), "{ not json");
}

describe("backfill", () => {
  beforeEach(seedStore);

  it("indexes every valid bundle, skips junk, and shards by day", () => {
    const r = backfill(store, indexDir);
    expect(r.bundleFiles).toBe(6);
    expect(r.rowsWritten).toBe(4);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(2);
    expect(r.days).toEqual(["2025-09-22", "2025-09-23"]);

    const shardFiles = readdirSync(indexDir).filter((f) => f.endsWith(".sqlite"));
    expect(shardFiles.sort()).toEqual(["attest-2025-09-22.sqlite", "attest-2025-09-23.sqlite"]);
  });

  it("stores bundlePath relative to the store root", () => {
    backfill(store, indexDir);
    const index = new Index(indexDir, { readonly: true });
    expect(index.byDecisionId("A3")?.bundlePath).toBe(join("nested", "a3.json"));
    index.close();
  });

  it("answers all four queries across shards", () => {
    backfill(store, indexDir);
    const index = new Index(indexDir, { readonly: true });
    expect(index.count()).toBe(4);
    expect(index.byDecisionId("B1")?.agentId).toBe("agent://B");
    // Range spans both days.
    expect(
      index.byAgentRange("agent://A", "2025-09-22T00:00:00.000Z", "2025-09-23T23:59:59.999Z").map((r) => r.decisionId),
    ).toEqual(["A1", "A2", "A3"]);
    expect(index.byAgentSchema("agent://A", "sha3-256:s1").map((r) => r.decisionId)).toEqual(["A1", "A2"]);
    // chainHead picks the global max decisionId across shards (A3, on day 2).
    expect(index.chainHead("agent://A")?.decisionId).toBe("A3");
    index.close();
  });

  it("is idempotent: re-running does not duplicate rows", () => {
    backfill(store, indexDir);
    const second = backfill(store, indexDir);
    expect(second.rowsWritten).toBe(4);
    const index = new Index(indexDir, { readonly: true });
    expect(index.count()).toBe(4);
    index.close();
  });

  it("is fully rebuildable from bundles alone", () => {
    backfill(store, indexDir);
    // Nuke the index; rebuild only from the bundle store.
    rmSync(indexDir, { recursive: true, force: true });
    const rebuilt = backfill(store, indexDir);
    expect(rebuilt.rowsWritten).toBe(4);
    expect(rebuilt.failed).toBe(0);
    const index = new Index(indexDir, { readonly: true });
    expect(index.count()).toBe(4);
    expect(index.byDecisionId("A2")?.prev).toBe("A1");
    index.close();
  });

  it("skips a malformed bundle (missing NOT NULL fields) without aborting the backfill", () => {
    // Missing schemaHash/decisionHash/leafType — would throw NOT NULL mid-insert
    // under a single-transaction batch. isBundle now rejects it up front.
    writeFileSync(
      join(store, "bad.json"),
      JSON.stringify({
        attestationId: "att-BAD",
        dar: { v: "DAR/0.1", decisionId: "BAD", agentId: "agent://A", ts: "2025-09-22T00:00:09.000Z", prev: null, decision: {} },
      }),
    );
    const r = backfill(store, indexDir);
    expect(r.rowsWritten).toBe(4); // the 4 good bundles still land
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(3); // notabundle, broken, bad
    const index = new Index(indexDir, { readonly: true });
    expect(index.count()).toBe(4);
    expect(index.byDecisionId("BAD")).toBeUndefined();
    index.close();
  });

  it("skips a bundle with an unparseable ts without aborting the backfill", () => {
    writeFileSync(
      join(store, "badts.json"),
      JSON.stringify({
        attestationId: "att-BADTS",
        dar: { v: "DAR/0.1", decisionId: "BADTS", agentId: "agent://A", ts: "not-a-date", prev: null, leafType: "decision", schemaHash: "sha3-256:s1", decisionHash: "sha3-256:z", decision: {} },
      }),
    );
    const r = backfill(store, indexDir);
    expect(r.rowsWritten).toBe(4);
    expect(r.skipped).toBe(3);
    const index = new Index(indexDir, { readonly: true });
    expect(index.byDecisionId("BADTS")).toBeUndefined();
    index.close();
  });

  it("isolates a conflicting duplicate decisionId: good rows land, the dup is counted as failed", () => {
    // A different attestation claims an existing decisionId (A1) on the same day
    // -> UNIQUE(decisionId) violation. Must not roll back the whole shard.
    writeFileSync(
      join(store, "dup.json"),
      JSON.stringify({
        attestationId: "att-DUP",
        dar: { v: "DAR/0.1", decisionId: "A1", agentId: "agent://A", ts: "2025-09-22T00:00:01.000Z", prev: null, leafType: "decision", schemaHash: "sha3-256:s1", decisionHash: "sha3-256:other", decision: {} },
      }),
    );
    const r = backfill(store, indexDir);
    expect(r.rowsWritten).toBe(4);
    expect(r.failed).toBe(1);
    const index = new Index(indexDir, { readonly: true });
    expect(index.count()).toBe(4);
    index.close();
  });
});
