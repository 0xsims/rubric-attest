import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DarBuilder, leafHash, canonicalDar, type DarCore } from "../src/index.js";

interface GoldenStep {
  agentId: string;
  decisionId: string;
  decision: Record<string, unknown>;
  expect: { dar: DarCore; canonical: string; leaf: string };
}
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/golden-dars.json", import.meta.url)), "utf8"),
) as { clockMs: number; schema: Record<string, unknown>; sequence: GoldenStep[] };

function goldenBuilder(): DarBuilder {
  const ids = golden.sequence.map((s) => s.decisionId);
  let i = 0;
  return new DarBuilder({
    newDecisionId: () => ids[i++]!,
    now: () => golden.clockMs,
  });
}

describe("DAR builder — golden records", () => {
  it("reproduces every golden DAR, its canonical form, and leaf hash", () => {
    const builder = goldenBuilder();
    for (const step of golden.sequence) {
      const dar = builder.build({
        agentId: step.agentId,
        schema: golden.schema,
        decision: step.decision,
      });
      expect(dar).toEqual(step.expect.dar);
      expect(canonicalDar(dar)).toBe(step.expect.canonical);
      expect(leafHash(dar)).toBe(step.expect.leaf);
    }
  });

  it("reuses one schemaHash across records built from the same schema object", () => {
    const builder = goldenBuilder();
    const hashes = golden.sequence.map(
      (s) => builder.build({ agentId: s.agentId, schema: golden.schema, decision: s.decision }).schemaHash,
    );
    expect(new Set(hashes).size).toBe(1);
  });
});

describe("DAR builder — prev chaining per agentId", () => {
  it("chains within an agent and starts fresh per agent", () => {
    const builder = new DarBuilder();
    const schema = { type: "object" };
    const a1 = builder.build({ agentId: "A", schema, decision: { n: 1 } });
    const a2 = builder.build({ agentId: "A", schema, decision: { n: 2 } });
    const b1 = builder.build({ agentId: "B", schema, decision: { n: 1 } });
    const a3 = builder.build({ agentId: "A", schema, decision: { n: 3 } });

    expect(a1.prev).toBeNull();
    expect(a2.prev).toBe(a1.decisionId);
    expect(a3.prev).toBe(a2.decisionId);
    expect(b1.prev).toBeNull(); // independent chain
    expect(builder.getHead("A")).toBe(a3.decisionId);
  });

  it("continues a chain from a seeded head (post-recovery)", () => {
    const builder = new DarBuilder();
    builder.seedHead("A", "PRIOR_HEAD");
    const next = builder.build({ agentId: "A", schema: { type: "object" }, decision: { n: 1 } });
    expect(next.prev).toBe("PRIOR_HEAD");
  });
});

describe("DAR builder — validation and hashing", () => {
  it("accepts a precomputed schemaHash", () => {
    const builder = new DarBuilder();
    const dar = builder.build({
      agentId: "A",
      schemaHash: "sha3-256:0000000000000000000000000000000000000000000000000000000000000000",
      decision: { n: 1 },
    });
    expect(dar.schemaHash).toMatch(/^sha3-256:/);
  });

  it("rejects bad inputs", () => {
    const builder = new DarBuilder();
    expect(() => builder.build({ agentId: "", schema: {}, decision: { n: 1 } })).toThrow();
    // @ts-expect-error decision must be an object
    expect(() => builder.build({ agentId: "A", schema: {}, decision: 5 })).toThrow();
    expect(() => builder.build({ agentId: "A", decision: { n: 1 } })).toThrow(/schema/);
  });
});
