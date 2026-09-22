import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attestor, hashJson, type DarCore, type Transport } from "@0xsims/attest-decision";
import { StubJevClient, toDecision } from "../src/index.js";

class MockTransport implements Transport {
  batches: DarCore[][] = [];
  async send(records: DarCore[]): Promise<void> {
    this.batches.push(records.slice());
  }
  get sent(): DarCore[] {
    return this.batches.flat();
  }
}

let dir: string;
let spoolPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-jev-"));
  spoolPath = join(dir, "attest.spool");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("jev adapter end-to-end through the P1 batcher", () => {
  it("produces valid DARs against a mock transport", async () => {
    const t = new MockTransport();
    const a = new Attestor({ transport: t, spoolPath, maxWaitMs: 60_000 });
    const jev = new StubJevClient({
      agentId: "agent://jev/pricing",
      policyId: "pricing/v3",
      policyRevision: 3,
    });

    const in1 = toDecision(jev.decide({ amountUsd: 500 }, 1_758_499_800_000));
    const in2 = toDecision(jev.decide({ amountUsd: 5000 }, 1_758_499_801_000));
    const id1 = a.attest(in1);
    const id2 = a.attest(in2);
    await a.drain();

    expect(t.batches.length).toBe(1); // one POST per flush
    const [r1, r2] = t.sent;

    // Valid DAR/0.1 envelope.
    expect(r1!.v).toBe("DAR/0.1");
    expect(r1!.agentId).toBe("agent://jev/pricing");
    expect(r1!.decisionId).toBe(id1);
    expect(r1!.leafType).toBe("decision");
    expect(r1!.prev).toBeNull();
    expect(r2!.decisionId).toBe(id2);
    expect(r2!.prev).toBe(id1); // per-agent chaining

    // Hashes independently recomputable from the mapped inputs (JCS + SHA3-256).
    expect(r1!.decisionHash).toBe(hashJson(in1.decision));
    expect(r1!.schemaHash).toBe(hashJson(in1.schema));
    expect(r2!.schemaHash).toBe(r1!.schemaHash); // same policy -> same schemaHash

    // Mapped decision content.
    expect(r1!.decision.action).toBe("approve");
    expect(r2!.decision.action).toBe("deny");
    expect(r2!.decision.reasons).toEqual(["amount_over_limit"]);

    await a.close();
  });
});
