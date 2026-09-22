import { describe, it, expect } from "vitest";
import { canonicalize } from "@0xsims/attest-decision";
import { StubJevClient, toDecision, type JevDecision } from "../src/index.js";

describe("jev mapping", () => {
  it("maps agent/outcome/policy into DAR inputs", () => {
    const jev: JevDecision = {
      jevSchema: "jev.decision/1",
      agent: { id: "agent://jev/x" },
      policy: { id: "p1", revision: 2 },
      outcome: { action: "approve", score: 90 },
      subject: { amountUsd: 10 },
      emittedAt: "2025-09-22T00:00:00.000Z",
    };
    const d = toDecision(jev);
    expect(d.agentId).toBe("agent://jev/x");
    expect(d.meta?.leafType).toBe("decision");
    expect(d.meta?.adapter).toEqual({ name: "jev", version: "1.0.0" });
    expect(d.meta?.schemaRef).toBe("p1@2");
    expect(d.input).toEqual({ amountUsd: 10 }); // the subject
    expect(d.output).toEqual({ action: "approve", score: 90 }); // the outcome
    expect(d.schema).toEqual({
      source: "jev",
      schema: "jev.decision/1",
      policyId: "p1",
      policyRevision: 2,
    });
  });

  it("omits absent optional outcome fields so the output stays strict-JCS clean", () => {
    const jev: JevDecision = {
      jevSchema: "jev.decision/1",
      agent: { id: "a" },
      policy: { id: "p", revision: 1 },
      outcome: { action: "approve" }, // no score, no reasons
      subject: {},
      emittedAt: "2025-09-22T00:00:00.000Z",
    };
    const d = toDecision(jev);
    expect(d.output).toEqual({ action: "approve" });
    expect(() => canonicalize(d.output)).not.toThrow();
  });

  it("stub client emits approve/deny by limit", () => {
    const c = new StubJevClient({ limitUsd: 1000 });
    expect(c.decide({ amountUsd: 500 }, 0).outcome.action).toBe("approve");
    const deny = c.decide({ amountUsd: 5000 }, 0);
    expect(deny.outcome.action).toBe("deny");
    expect(deny.outcome.reasons).toEqual(["amount_over_limit"]);
  });
});
