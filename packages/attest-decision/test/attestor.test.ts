import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attestor, type DarCore, type Transport } from "../src/index.js";

class MockTransport implements Transport {
  batches: DarCore[][] = [];
  failuresLeft = 0;
  hang = false;
  async send(records: DarCore[]): Promise<void> {
    if (this.hang) return new Promise<void>(() => {}); // never resolves
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("transport down");
    }
    this.batches.push(records.slice());
  }
  get sent(): DarCore[] {
    return this.batches.flat();
  }
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let dir: string;
let spoolPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-att-"));
  spoolPath = join(dir, "attest.spool");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const input = (n: number) => ({ agentId: "A", schema: { type: "object" }, decision: { n } });

describe("attest() — fire and forget, never throws", () => {
  it("returns a decisionId and never throws on bad input", async () => {
    const t = new MockTransport();
    const errors: unknown[] = [];
    const a = new Attestor({ transport: t, spoolPath, onError: (e) => errors.push(e) });

    const id = a.attest(input(1));
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Bad decision -> null, no throw, onError notified.
    // @ts-expect-error decision must be an object
    expect(a.attest({ agentId: "A", schema: {}, decision: 5 })).toBeNull();
    expect(errors.length).toBe(1);

    await a.close();
  });

  it("chains prev per agent across attest calls", async () => {
    const t = new MockTransport();
    const a = new Attestor({ transport: t, spoolPath });
    a.attest(input(1));
    a.attest(input(2));
    await a.drain();
    const [d1, d2] = t.sent;
    expect(d1!.prev).toBeNull();
    expect(d2!.prev).toBe(d1!.decisionId);
    await a.close();
  });
});

describe("batcher — flush triggers", () => {
  it("flushes exactly one batch of 64 as soon as the count is reached", async () => {
    const t = new MockTransport();
    // Large wait so a flush within the test can only be the count trigger.
    const a = new Attestor({ transport: t, spoolPath, maxWaitMs: 60_000 });
    for (let i = 0; i < 64; i++) a.attest(input(i));
    await waitFor(() => t.sent.length === 64);
    expect(t.batches.length).toBe(1); // one POST per flush
    expect(t.batches[0]!.length).toBe(64);
    expect(a.pendingCount()).toBe(0);
    await a.close();
  });

  it("flushes a partial batch after maxWaitMs elapses", async () => {
    const t = new MockTransport();
    const a = new Attestor({ transport: t, spoolPath, maxWaitMs: 40, maxBatch: 64 });
    a.attest(input(1));
    expect(t.sent.length).toBe(0); // not yet — below the count trigger
    await waitFor(() => t.sent.length === 1);
    expect(t.batches.length).toBe(1);
    await a.close();
  });
});

describe("durability — retry and recovery", () => {
  it("retains a failed batch and delivers it on retry", async () => {
    const t = new MockTransport();
    t.failuresLeft = 1;
    const a = new Attestor({ transport: t, spoolPath, retryMs: 10 });
    a.attest(input(1));
    a.attest(input(2));
    await a.drain(); // first attempt throws, drain retries and succeeds
    expect(t.sent.map((d) => d.decision.n)).toEqual([1, 2]);
    expect(a.pendingCount()).toBe(0);
    await a.close();
  });

  it("close() retries a transiently failing final flush", async () => {
    const t = new MockTransport();
    t.failuresLeft = 2; // first two send attempts throw, third succeeds
    const a = new Attestor({ transport: t, spoolPath, retryMs: 5, closeRetries: 3 });
    a.attest(input(1));
    await a.close();
    expect(t.sent.map((d) => d.decision.n)).toEqual([1]);
  });

  it("close() leaves records durably spooled when all retries fail; a later run delivers them", async () => {
    const failing = new MockTransport();
    failing.failuresLeft = 999;
    const a = new Attestor({ transport: failing, spoolPath, retryMs: 1, closeRetries: 1 });
    const id = a.attest(input(1));
    await a.close();
    expect(failing.sent.length).toBe(0);

    const t = new MockTransport();
    const a2 = new Attestor({ transport: t, spoolPath });
    await waitFor(() => t.sent.length === 1);
    expect(t.sent[0]!.decisionId).toBe(id);
    await a2.close();
  });

  it("drains records left in the spool by a previous run", async () => {
    // First run: transport hangs, so nothing is acked; records persist in spool.
    const hung = new MockTransport();
    hung.hang = true;
    const a1 = new Attestor({ transport: hung, spoolPath, maxWaitMs: 60_000 });
    const id1 = a1.attest(input(1));
    const id2 = a1.attest(input(2));
    // Do NOT close/drain — simulate abandonment. Spool has both records.

    // Second run: working transport recovers and delivers them.
    const t = new MockTransport();
    const a2 = new Attestor({ transport: t, spoolPath });
    await waitFor(() => t.sent.length === 2);
    expect(t.sent.map((d) => d.decisionId)).toEqual([id1, id2]);

    // Chain continues from the recovered head.
    const id3 = a2.attest(input(3));
    await a2.drain();
    const d3 = t.sent.find((d) => d.decisionId === id3)!;
    expect(d3.prev).toBe(id2);
    await a2.close();
  });
});
