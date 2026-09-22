import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attestor, decisionHashOf, hashJson, type DarCore, type Transport } from "@0xsims/attest-decision";
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
    expect(r1!.schemaHash).toBe(hashJson(in1.schema));
    expect(r1!.inputHash).toBe(hashJson(in1.input));
    expect(r1!.outputHash).toBe(hashJson(in1.output));
    expect(r1!.decisionHash).toBe(decisionHashOf(r1!.schemaHash, r1!.inputHash, r1!.outputHash));
    expect(r2!.schemaHash).toBe(r1!.schemaHash); // same policy -> same schemaHash

    // The core carries only hashes — no raw content.
    expect("decision" in r1!).toBe(false);
    expect("input" in r1!).toBe(false);
    expect("output" in r1!).toBe(false);

    // Mapped output content (via the adapter, not in the core).
    expect((in1.output as { action: string }).action).toBe("approve");
    expect((in2.output as { action: string }).action).toBe("deny");
    expect((in2.output as { reasons?: string[] }).reasons).toEqual(["amount_over_limit"]);

    await a.close();
  });
});
