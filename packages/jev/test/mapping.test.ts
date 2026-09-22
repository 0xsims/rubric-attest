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
    const input = toDecision(jev);
    expect(input.agentId).toBe("agent://jev/x");
    expect(input.leafType).toBe("decision");
    expect(input.decision).toEqual({ action: "approve", subject: { amountUsd: 10 }, score: 90 });
    expect(input.schema).toEqual({
      source: "jev",
      schema: "jev.decision/1",
      policyId: "p1",
      policyRevision: 2,
    });
  });

  it("omits absent optional fields so the payload is strict-JCS clean", () => {
    const jev: JevDecision = {
      jevSchema: "jev.decision/1",
      agent: { id: "a" },
      policy: { id: "p", revision: 1 },
      outcome: { action: "approve" }, // no score, no reasons
      subject: {},
      emittedAt: "2025-09-22T00:00:00.000Z",
    };
    const input = toDecision(jev);
    expect("score" in input.decision).toBe(false);
    expect("reasons" in input.decision).toBe(false);
    expect(() => canonicalize(input.decision)).not.toThrow();
  });

  it("stub client emits approve/deny by limit", () => {
    const c = new StubJevClient({ limitUsd: 1000 });
    expect(c.decide({ amountUsd: 500 }, 0).outcome.action).toBe("approve");
    const deny = c.decide({ amountUsd: 5000 }, 0);
    expect(deny.outcome.action).toBe("deny");
    expect(deny.outcome.reasons).toEqual(["amount_over_limit"]);
  });
});
