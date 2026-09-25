import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentIdError, DarBuilder, leafHash, canonicalDar, decisionHashOf, validateAgentId, type DarCore, type DarMeta } from "../src/index.js";

interface GoldenStep {
  agentId: string;
  decisionId: string;
  input: unknown;
  output: unknown;
  expect: { dar: DarCore; canonical: string; leaf: string };
}
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/golden-dars.json", import.meta.url)), "utf8"),
) as { clockMs: number; schema: Record<string, unknown>; meta: DarMeta; sequence: GoldenStep[] };

function goldenBuilder(): DarBuilder {
  const ids = golden.sequence.map((s) => s.decisionId);
  let i = 0;
  return new DarBuilder({
    newDecisionId: () => ids[i++]!,
    now: () => golden.clockMs,
  });
}

describe("DAR builder — golden records (hashes-only core)", () => {
  it("reproduces every golden DAR, its canonical form, and leaf hash", () => {
    const builder = goldenBuilder();
    for (const step of golden.sequence) {
      const dar = builder.build({
        agentId: step.agentId,
        schema: golden.schema,
        input: step.input,
        output: step.output,
        meta: golden.meta,
      });
      expect(dar).toEqual(step.expect.dar);
      expect(canonicalDar(dar)).toBe(step.expect.canonical);
      expect(leafHash(dar)).toBe(step.expect.leaf);
      // Core is hashes-only.
      expect("decision" in dar).toBe(false);
      expect(dar.decisionHash).toBe(decisionHashOf(dar.schemaHash, dar.inputHash, dar.outputHash));
    }
  });

  it("reuses one schemaHash across records built from the same schema object", () => {
    const builder = goldenBuilder();
    const hashes = golden.sequence.map(
      (s) =>
        builder.build({ agentId: s.agentId, schema: golden.schema, input: s.input, output: s.output, meta: golden.meta })
          .schemaHash,
    );
    expect(new Set(hashes).size).toBe(1);
  });
});

describe("DAR builder — prev chaining per agentId", () => {
  const io = (n: number) => ({ input: { n }, output: { ok: true }, schema: { type: "object" } });
  it("chains within an agent and starts fresh per agent", () => {
    const builder = new DarBuilder();
    const a1 = builder.build({ agentId: "A", ...io(1) });
    const a2 = builder.build({ agentId: "A", ...io(2) });
    const b1 = builder.build({ agentId: "B", ...io(1) });
    const a3 = builder.build({ agentId: "A", ...io(3) });

    expect(a1.prev).toBeNull();
    expect(a2.prev).toBe(a1.decisionId);
    expect(a3.prev).toBe(a2.decisionId);
    expect(b1.prev).toBeNull(); // independent chain
    expect(builder.getHead("A")).toBe(a3.decisionId);
  });

  it("continues a chain from a seeded head (post-recovery)", () => {
    const builder = new DarBuilder();
    builder.seedHead("A", "PRIOR_HEAD");
    const next = builder.build({ agentId: "A", ...io(1) });
    expect(next.prev).toBe("PRIOR_HEAD");
  });
});

describe("DAR builder — validation and hashing", () => {
  const io = { input: { a: 1 }, output: { b: 2 } };

  it("accepts a precomputed schemaHash and carries optional schemaRef/adapter", () => {
    const builder = new DarBuilder();
    const dar = builder.build({
      agentId: "A",
      schemaHash: `sha3-256:${"0".repeat(64)}`,
      ...io,
      meta: { schemaRef: "urn:s", adapter: { name: "x", version: "1.0.0" } },
    });
    expect(dar.schemaHash).toMatch(/^sha3-256:/);
    expect(dar.schemaRef).toBe("urn:s");
    expect(dar.adapter).toEqual({ name: "x", version: "1.0.0" });
  });

  it("rejects bad inputs", () => {
    const builder = new DarBuilder();
    expect(() => builder.build({ agentId: "", schema: {}, ...io })).toThrow();
    expect(() => builder.build({ agentId: "A", ...io })).toThrow(/schema/); // no schema/schemaHash
    // non-JSON input is rejected by canonicalization
    expect(() => builder.build({ agentId: "A", schema: {}, input: 1n, output: {} })).toThrow();
  });

  it("rejects an unknown leafType", () => {
    const builder = new DarBuilder();
    expect(() =>
      // @ts-expect-error leafType must be a LeafType
      builder.build({ agentId: "A", schema: {}, ...io, meta: { leafType: "bogus" } }),
    ).toThrow(/leafType/);
  });

  it("rejects a malformed precomputed schemaHash", () => {
    const builder = new DarBuilder();
    // @ts-expect-error schemaHash must match sha3-256:<hex>
    expect(() => builder.build({ agentId: "A", schemaHash: "not-a-hash", ...io })).toThrow(/schemaHash/);
  });

  it("rejects input+output larger than maxDecisionBytes", () => {
    const builder = new DarBuilder({ maxDecisionBytes: 100 });
    expect(() =>
      builder.build({ agentId: "A", schema: {}, input: { blob: "x".repeat(1000) }, output: {} }),
    ).toThrow(/maxDecisionBytes/);
  });
});

describe("DAR builder — agentId validation (server batch-ingest rules)", () => {
  const io = { schema: {}, input: {}, output: {} };

  it("throws AgentIdError for ids outside ^[A-Za-z0-9._:/@-]{1,200}$", () => {
    const b = new DarBuilder();
    for (const bad of ["", "a b", "é", "a‮b", "x".repeat(201), "a#b"]) {
      expect(() => b.build({ agentId: bad, ...io })).toThrow(AgentIdError);
    }
    expect(b.build({ agentId: "x".repeat(200), ...io }).agentId).toHaveLength(200);
    expect(b.build({ agentId: "ns_0123456789ab/loan-bot", ...io }).agentId).toBe("ns_0123456789ab/loan-bot");
  });

  it("refuses Rubric's reserved ids unless allowReservedAgentIds", () => {
    for (const id of ["rubric", "RUBRIC", "rubric://x402/decision-review", "rubric-bot", "rubric.x", "rubric@x", "rubric_x", "rubric:x"]) {
      expect(() => new DarBuilder().build({ agentId: id, ...io })).toThrow(/reserved/);
      expect(new DarBuilder({ allowReservedAgentIds: true }).build({ agentId: id, ...io }).agentId).toBe(id);
    }
    expect(new DarBuilder().build({ agentId: "rubrical.io/bot", ...io }).agentId).toBe("rubrical.io/bot");
  });

  it("validateAgentId is exported for callers that check ahead of time", () => {
    expect(() => validateAgentId("ok-bot")).not.toThrow();
    expect(() => validateAgentId("rubric-x", { allowReserved: true })).not.toThrow();
    expect(() => validateAgentId(42)).toThrow(AgentIdError);
  });

  it("uses an explicit decisionId and time when given", () => {
    const dar = new DarBuilder().build({ agentId: "A", ...io }, { decisionId: "01J0000000000000000000000A", at: Date.UTC(2026, 0, 1) });
    expect(dar.decisionId).toBe("01J0000000000000000000000A");
    expect(dar.ts).toBe("2026-01-01T00:00:00.000Z");
  });
});
