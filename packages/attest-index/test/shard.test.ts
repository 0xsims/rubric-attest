import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Shard, type IndexRow } from "../src/index.js";

function row(over: Partial<IndexRow>): IndexRow {
  return {
    attestationId: "att-" + (over.decisionId ?? "x"),
    decisionId: "0000",
    agentId: "agent://A",
    schemaHash: "sha3-256:aaaa",
    decisionHash: "sha3-256:dddd",
    prev: null,
    ts: "2025-09-22T00:00:00.000Z",
    leafType: "decision",
    bundlePath: "bundles/x.json",
    ...over,
  };
}

let dir: string;
let path: string;
let shard: Shard;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-shard-"));
  path = join(dir, "attest-2025-09-22.sqlite");
  shard = new Shard(path);
});
afterEach(() => {
  shard.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Shard queries", () => {
  beforeEach(() => {
    shard.insertBatch([
      row({ decisionId: "A1", agentId: "agent://A", schemaHash: "sha3-256:s1", prev: null, ts: "2025-09-22T00:00:01.000Z" }),
      row({ decisionId: "A2", agentId: "agent://A", schemaHash: "sha3-256:s1", prev: "A1", ts: "2025-09-22T00:00:02.000Z" }),
      row({ decisionId: "A3", agentId: "agent://A", schemaHash: "sha3-256:s2", prev: "A2", ts: "2025-09-22T00:00:03.000Z" }),
      row({ decisionId: "B1", agentId: "agent://B", schemaHash: "sha3-256:s1", prev: null, ts: "2025-09-22T00:00:01.500Z" }),
    ]);
  });

  it("byDecisionId returns the exact row", () => {
    expect(shard.byDecisionId("A2")?.prev).toBe("A1");
    expect(shard.byDecisionId("nope")).toBeUndefined();
  });

  it("byAgentRange filters by agent and ts window, ordered", () => {
    const rows = shard.byAgentRange("agent://A", "2025-09-22T00:00:02.000Z", "2025-09-22T00:00:03.000Z");
    expect(rows.map((r) => r.decisionId)).toEqual(["A2", "A3"]);
    // B is excluded even though its ts falls inside the window.
    const all = shard.byAgentRange("agent://A", "2025-09-22T00:00:00.000Z", "2025-09-22T23:59:59.999Z");
    expect(all.every((r) => r.agentId === "agent://A")).toBe(true);
  });

  it("byAgentSchema filters by agent and schemaHash", () => {
    expect(shard.byAgentSchema("agent://A", "sha3-256:s1").map((r) => r.decisionId)).toEqual(["A1", "A2"]);
    expect(shard.byAgentSchema("agent://A", "sha3-256:s2").map((r) => r.decisionId)).toEqual(["A3"]);
  });

  it("chainHead returns the latest decisionId for an agent", () => {
    expect(shard.chainHead("agent://A")?.decisionId).toBe("A3");
    expect(shard.chainHead("agent://B")?.decisionId).toBe("B1");
    expect(shard.chainHead("agent://Z")).toBeUndefined();
  });
});

describe("Shard idempotency", () => {
  it("upserts on attestationId: re-inserting does not duplicate", () => {
    const r = row({ attestationId: "att-1", decisionId: "A1", bundlePath: "bundles/a.json" });
    shard.insert(r);
    shard.insert(r);
    expect(shard.count()).toBe(1);
  });

  it("updates mutable fields (e.g. bundlePath) on re-insert", () => {
    shard.insert(row({ attestationId: "att-1", decisionId: "A1", bundlePath: "old/a.json" }));
    shard.insert(row({ attestationId: "att-1", decisionId: "A1", bundlePath: "new/a.json" }));
    expect(shard.count()).toBe(1);
    expect(shard.byDecisionId("A1")?.bundlePath).toBe("new/a.json");
  });
});
