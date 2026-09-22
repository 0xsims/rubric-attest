import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Attestor, hashJson, type DarCore, type Transport } from "@rubric/attest-decision";
import { toDecision, toDecisionFromZod, zodToSchema } from "../src/index.js";

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
  dir = mkdtempSync(join(tmpdir(), "rubric-schema-"));
  spoolPath = join(dir, "attest.spool");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema adapter end-to-end through the P1 batcher", () => {
  it("produces a valid DAR from a Zod schema against a mock transport", async () => {
    const t = new MockTransport();
    const a = new Attestor({ transport: t, spoolPath, maxWaitMs: 60_000 });

    const Pricing = z.object({ action: z.enum(["approve", "deny"]), limitUsd: z.string() });
    const decision = { action: "approve", limitUsd: "250.00" };
    const input = toDecisionFromZod({ agentId: "agent://schema/x", decision, zod: Pricing, name: "Pricing" });
    const id = a.attest(input);
    await a.drain();

    const [r] = t.sent;
    expect(r!.v).toBe("DAR/0.1");
    expect(r!.decisionId).toBe(id);
    expect(r!.agentId).toBe("agent://schema/x");
    expect(r!.decisionHash).toBe(hashJson(decision));
    expect(r!.schemaHash).toBe(hashJson(zodToSchema(Pricing, "Pricing")));
    await a.close();
  });

  it("produces a valid DAR from a raw JSON Schema", async () => {
    const t = new MockTransport();
    const a = new Attestor({ transport: t, spoolPath, maxWaitMs: 60_000 });

    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    };
    const decision = { action: "deny" };
    const input = toDecision({ agentId: "agent://schema/raw", decision, schema });
    const id = a.attest(input);
    await a.drain();

    const [r] = t.sent;
    expect(r!.decisionId).toBe(id);
    expect(r!.schemaHash).toBe(hashJson(schema));
    expect(r!.decision.action).toBe("deny");
    await a.close();
  });
});
