import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentIdError,
  Attestor,
  BatchRejectedError,
  DarBuilder,
  NamespaceMismatchError,
  Spool,
  TransportError,
  canonicalDar,
  hashJson,
  leafHash,
  type DarCore,
  type SendResult,
  type Transport,
} from "../src/index.js";

const NS = "ns_0123456789ab";
const OTHER = "ns_ba9876543210";

/** Answers each send with `reply(records, callIndex)`; an Error is thrown. */
class ScriptTransport implements Transport {
  calls: DarCore[][] = [];
  constructor(private readonly reply: (records: DarCore[], i: number) => SendResult | Error) {}
  async send(records: DarCore[]): Promise<SendResult> {
    const i = this.calls.push(records.slice()) - 1;
    const r = this.reply(records, i);
    if (r instanceof Error) throw r;
    return r;
  }
  get batches(): DarCore[][] {
    return this.calls.filter((c) => c.length > 0);
  }
  get handshakes(): number {
    return this.calls.filter((c) => c.length === 0).length;
  }
}

const ok = (ns: string | null = NS) => (records: DarCore[]): SendResult => ({
  namespace: ns,
  accepted: records.map((r) => r.decisionId),
  rejected: [],
});

const nsUnavailable = () =>
  new TransportError("tiered-attest POST failed: 403 NAMESPACE_UNAVAILABLE", {
    status: 403,
    code: "NAMESPACE_UNAVAILABLE",
    namespace: null,
  });

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let spoolPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-ns-"));
  spoolPath = join(dir, "attest.spool");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (n: number, agentId = "loan-bot") => ({ agentId, schema: { type: "object" }, input: { n }, output: { ok: true } });

describe("explicit namespace: agentId is prefixed before the DAR is built", () => {
  it("sends <namespace>/<name>, and the leaf hash covers the prefix", async () => {
    const t = new ScriptTransport(ok());
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, now: () => Date.UTC(2026, 8, 25), onError: () => {} });
    const id = a.attest(rec(1));
    await a.drain();
    const dar = t.batches[0]![0]!;
    expect(dar.decisionId).toBe(id);
    expect(dar.agentId).toBe(`${NS}/loan-bot`);
    // The prefix is inside the hashed core: the leaf hash is over the prefixed id…
    expect(canonicalDar(dar)).toContain(`"agentId":"${NS}/loan-bot"`);
    expect(leafHash(dar)).toBe(hashJson({ ...dar }));
    // …and differs from the same record built without it.
    expect(leafHash(dar)).not.toBe(leafHash({ ...dar, agentId: "loan-bot" }));
    // A builder given the prefixed id directly produces the identical record.
    const same = new DarBuilder({ now: () => Date.UTC(2026, 8, 25) }).build(
      { ...rec(1), agentId: `${NS}/loan-bot` },
      { decisionId: id!, prev: null },
    );
    expect(leafHash(same)).toBe(leafHash(dar));
    await a.close();
  });

  it("keeps an agentId that already carries the configured prefix, and refuses another namespace", async () => {
    const t = new ScriptTransport(ok());
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, onError: () => {} });
    a.attest(rec(1, `${NS}/loan-bot`));
    expect(() => a.attest(rec(2, `${OTHER}/loan-bot`))).toThrow(AgentIdError);
    await a.drain();
    expect(t.batches.flat().map((d) => d.agentId)).toEqual([`${NS}/loan-bot`]);
    await a.close();
  });

  it("chains per prefixed agentId", async () => {
    const t = new ScriptTransport(ok());
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, onError: () => {} });
    const first = a.attest(rec(1));
    a.attest(rec(2));
    await a.drain();
    const [d1, d2] = t.batches.flat();
    expect(d1!.prev).toBeNull();
    expect(d2!.prev).toBe(first);
    await a.close();
  });

  it("rejects a malformed namespace option at construction", () => {
    const t = new ScriptTransport(ok());
    expect(() => new Attestor({ transport: t, spoolPath, namespace: "acme" })).toThrow(/ns_<12 hex>/);
    expect(() => new Attestor({ transport: t, spoolPath, namespace: "ns_0123456789AB" })).toThrow();
  });

  it("without a namespace, agentIds are sent as given (1.1.0 behaviour)", async () => {
    const t = new ScriptTransport(ok(null));
    const a = new Attestor({ transport: t, spoolPath, onError: () => {} });
    a.attest(rec(1, "agent://jev/pricing-v3"));
    await a.drain();
    expect(t.batches[0]![0]!.agentId).toBe("agent://jev/pricing-v3");
    await a.close();
  });
});

describe("invalid agentId throws from attest()", () => {
  const bad = ["", "loan bot", "lóan-bot", "loan​bot", "x".repeat(201), "rubric", "rubric://x402/decision-review", "Rubric-bot", "rubric.io"];

  it.each(bad)("without a namespace: %j", async (agentId) => {
    const a = new Attestor({ transport: new ScriptTransport(ok()), spoolPath, onError: () => {} });
    expect(() => a.attest(rec(1, agentId))).toThrow(AgentIdError);
    expect(a.pendingCount()).toBe(0);
    await a.close();
  });

  it("with a namespace, the full id (prefix included) must fit 200 characters", async () => {
    const a = new Attestor({ transport: new ScriptTransport(ok()), spoolPath, namespace: NS, onError: () => {} });
    expect(() => a.attest(rec(1, "x".repeat(200 - NS.length - 1)))).not.toThrow();
    expect(() => a.attest(rec(1, "x".repeat(200 - NS.length)))).toThrow(AgentIdError);
    expect(() => a.attest(rec(1, "loan bot"))).toThrow(AgentIdError);
    expect(() => a.attest(rec(1, ""))).toThrow(AgentIdError);
    await a.close();
  });

  it("accepts ids the server accepts (rubrical.io/bot; rubric-bot under a namespace)", async () => {
    const plain = new Attestor({ transport: new ScriptTransport(ok()), spoolPath, onError: () => {} });
    expect(plain.attest(rec(1, "rubrical.io/bot"))).toEqual(expect.any(String));
    const namespaced = new Attestor({ transport: new ScriptTransport(ok()), spoolPath: join(dir, "b.spool"), namespace: NS, onError: () => {} });
    expect(namespaced.attest(rec(1, "rubric-bot"))).toEqual(expect.any(String));
    await plain.close();
    await namespaced.close();
  });

  it("allowReservedAgentIds admits Rubric's own agentIds (internal emitters)", async () => {
    const a = new Attestor({ transport: new ScriptTransport(ok(null)), spoolPath, allowReservedAgentIds: true, onError: () => {} });
    expect(a.attest(rec(1, "rubric://x402/decision-review"))).toEqual(expect.any(String));
    await a.close();
  });

  it("other build failures still go to onError, not the caller", async () => {
    const errors: unknown[] = [];
    const a = new Attestor({ transport: new ScriptTransport(ok()), spoolPath, maxDecisionBytes: 10, onError: (e) => errors.push(e) });
    expect(a.attest({ ...rec(1), input: { big: "x".repeat(100) } })).toBeNull();
    expect(String(errors[0])).toMatch(/maxDecisionBytes/);
    await a.close();
  });
});

describe("namespace mismatch: stop, bounded retries of the same batch, then fatal", () => {
  it("never adopts, re-prefixes or drops; retries the same batch; goes fatal", async () => {
    const errors: unknown[] = [];
    const t = new ScriptTransport(ok(OTHER));
    const a = new Attestor({
      transport: t,
      spoolPath,
      namespace: NS,
      namespaceRetries: 3,
      namespaceRetryMs: 5,
      onError: (e) => errors.push(e),
    });
    const ids = [a.attest(rec(1)), a.attest(rec(2))];
    await a.flush();
    expect(t.batches.length).toBe(1);

    // Paused: new records are held, not built or sent.
    const heldId = a.attest(rec(3));
    expect(heldId).toEqual(expect.any(String));
    expect(a.pendingCount()).toBe(3);

    await waitFor(() => errors.filter((e) => e instanceof NamespaceMismatchError && e.fatal).length === 1);
    await sleep(60); // no further sends once fatal
    expect(t.batches.length).toBe(1 + 3);

    // Every attempt was the same batch, with the configured prefix (never the other one).
    for (const b of t.batches) {
      expect(b.map((d) => d.decisionId)).toEqual(ids);
      expect(b.every((d) => d.agentId === `${NS}/loan-bot`)).toBe(true);
    }
    expect(a.getNamespace()).toBe(NS);

    const mismatches = errors.filter((e): e is NamespaceMismatchError => e instanceof NamespaceMismatchError);
    expect(mismatches.map((e) => [e.retries, e.fatal])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(mismatches[3]!.expected).toBe(NS);
    expect(mismatches[3]!.got).toBe(OTHER);
    expect(mismatches[3]!.message).toMatch(/fix the server node's namespace or the configured one/);

    // drain() returns (nothing can be sent); close() sends nothing and leaves the spool intact.
    await a.drain();
    await a.close();
    expect(t.batches.length).toBe(4);
    const spooled = new Spool(spoolPath).pending().map((r) => r.dar);
    expect(spooled.map((d) => d.decisionId)).toEqual(ids);
    expect(spooled.every((d) => d.agentId === `${NS}/loan-bot`)).toBe(true);
    // The held record was never built, and close() says so.
    expect(errors.some((e) => /held in memory/.test(String(e)))).toBe(true);
  });

  it("backs off, doubling from namespaceRetryMs", async () => {
    const times: number[] = [];
    const t = new ScriptTransport(() => {
      times.push(Date.now());
      return { namespace: OTHER, accepted: [], rejected: [] };
    });
    const errors: unknown[] = [];
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, namespaceRetries: 3, namespaceRetryMs: 20, onError: (e) => errors.push(e) });
    a.attest(rec(1));
    await a.flush();
    await waitFor(() => errors.some((e) => e instanceof NamespaceMismatchError && e.fatal));
    const gaps = times.slice(1).map((x, i) => x - times[i]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(18);
    expect(gaps[1]).toBeGreaterThanOrEqual(38);
    expect(gaps[2]).toBeGreaterThanOrEqual(78);
    await a.close();
  });

  it("defaults to 5 retries starting at 20 s (about 10 minutes in all)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const errors: unknown[] = [];
      const t = new ScriptTransport(ok(OTHER));
      const a = new Attestor({ transport: t, spoolPath, namespace: NS, onError: (e) => errors.push(e) });
      a.attest(rec(1));
      await a.flush();
      let elapsed = 0;
      for (const step of [20_000, 40_000, 80_000, 160_000, 320_000]) {
        await vi.advanceTimersByTimeAsync(step);
        elapsed += step;
      }
      const m = errors.filter((e): e is NamespaceMismatchError => e instanceof NamespaceMismatchError);
      expect(m.length).toBe(6);
      expect(m[5]!.fatal).toBe(true);
      expect(m[5]!.retries).toBe(5);
      expect(elapsed).toBe(620_000);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(t.batches.length).toBe(6);
      await a.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes when a retry reaches a node that agrees; held records are built with the configured prefix", async () => {
    const errors: unknown[] = [];
    const t = new ScriptTransport((records, i) => (i === 0 ? { namespace: OTHER, accepted: [], rejected: [] } : ok()(records)));
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, namespaceRetryMs: 5, onError: (e) => errors.push(e) });
    const first = a.attest(rec(1));
    await a.flush();
    const held = a.attest(rec(2));
    await waitFor(() => t.batches.length === 2); // the retry, answered by an agreeing node
    await a.drain();
    const sent = t.batches.flat();
    expect(sent.map((d) => d.decisionId)).toEqual([first, first, held]);
    expect(sent.every((d) => d.agentId === `${NS}/loan-bot`)).toBe(true);
    expect(sent[2]!.prev).toBe(first); // held record chained after the first
    expect(errors.filter((e) => e instanceof NamespaceMismatchError).length).toBe(1);
    await a.close();
    expect(new Spool(spoolPath).pending()).toEqual([]);
  });

  it("treats 403 NAMESPACE_UNAVAILABLE (namespace null) as a mismatch", async () => {
    const errors: unknown[] = [];
    const t = new ScriptTransport(() => nsUnavailable());
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, namespaceRetries: 1, namespaceRetryMs: 5, onError: (e) => errors.push(e) });
    a.attest(rec(1));
    await a.flush();
    await waitFor(() => errors.some((e) => e instanceof NamespaceMismatchError && e.fatal));
    const m = errors.find((e): e is NamespaceMismatchError => e instanceof NamespaceMismatchError)!;
    expect(m.got).toBeNull();
    expect(m.message).toMatch(/NAMESPACE_UNAVAILABLE/);
    await a.close();
    expect(new Spool(spoolPath).pending().length).toBe(1);
  });

  it("a 200 with a different namespace is not acked", async () => {
    const t = new ScriptTransport(ok(OTHER));
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, namespaceRetries: 0, onError: () => {} });
    a.attest(rec(1));
    await a.flush();
    await a.close();
    expect(new Spool(spoolPath).pending().length).toBe(1);
  });
});

describe("responses", () => {
  it("426 keeps the batch and reports the server's message", async () => {
    const errors: unknown[] = [];
    const upgrade = new TransportError(
      "tiered-attest POST failed: 426 SDK_UPGRADE_REQUIRED: Batch ingest requires @rubric-protocol/attest-decision 1.2.0 or later. (minimum attest-decision/1.2.0, this SDK sent attest-decision/1.2.0)",
      { status: 426, code: "SDK_UPGRADE_REQUIRED", namespace: NS },
    );
    const t = new ScriptTransport((records, i) => (i === 0 ? upgrade : ok()(records)));
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, retryMs: 5, onError: (e) => errors.push(e) });
    const id = a.attest(rec(1));
    await a.flush();
    expect(a.pendingCount()).toBe(1);
    expect(errors).toEqual([upgrade]);
    await a.drain();
    expect(t.batches.map((b) => b.map((d) => d.decisionId))).toEqual([[id], [id]]);
    await a.close();
  });

  it("waits at least Retry-After before resending (425)", async () => {
    const times: number[] = [];
    const early = new TransportError("425", { status: 425, namespace: NS, retryAfterMs: 60 });
    const t = new ScriptTransport((records, i) => {
      times.push(Date.now());
      return i === 0 ? early : ok()(records);
    });
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, retryMs: 1, onError: () => {} });
    a.attest(rec(1));
    await a.flush();
    await waitFor(() => t.calls.length === 2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(55);
    await a.close();
  });

  it("200 rejected reach onError, are final (not resent), with a repair hint", async () => {
    const errors: unknown[] = [];
    const t = new ScriptTransport((records) => ({
      namespace: NS,
      accepted: [],
      rejected: records.map((r) => ({ decisionId: r.decisionId, reason: `agentId_namespace: expected prefix "${NS}/"` })),
    }));
    const a = new Attestor({ transport: t, spoolPath, namespace: NS, onError: (e) => errors.push(e) });
    const id = a.attest(rec(1));
    await a.drain();
    const e = errors.find((x): x is BatchRejectedError => x instanceof BatchRejectedError)!;
    expect(e.rejected).toEqual([{ decisionId: id, reason: `agentId_namespace: expected prefix "${NS}/"` }]);
    expect(e.message).toMatch(/permanently rejected/);
    expect(e.message).toMatch(/cannot be repaired/);
    await sleep(20);
    expect(t.batches.length).toBe(1);
    await a.close();
    expect(new Spool(spoolPath).pending()).toEqual([]);
  });

  it("without a configured namespace, agentId_namespace rejects name the namespace to configure", async () => {
    const errors: unknown[] = [];
    const t = new ScriptTransport((records) => ({
      namespace: NS,
      accepted: [],
      rejected: records.map((r) => ({ decisionId: r.decisionId, reason: `agentId_namespace: expected prefix "${NS}/"` })),
    }));
    const a = new Attestor({ transport: t, spoolPath, onError: (e) => errors.push(e) });
    a.attest(rec(1));
    await a.drain();
    expect(String(errors[0])).toContain(`namespace: "${NS}"`);
    await a.close();
  });

  it("with no onError, failures go to console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = new ScriptTransport(() => new TransportError("tiered-attest POST failed: 403 BATCH_INGEST_NOT_ENABLED: Batch ingest is not enabled for this API key.", { status: 403, code: "BATCH_INGEST_NOT_ENABLED", namespace: NS }));
      const a = new Attestor({ transport: t, spoolPath, namespace: NS, retryMs: 60_000, closeRetries: 0 });
      a.attest(rec(1));
      await a.flush();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]!.join(" "))).toMatch(/BATCH_INGEST_NOT_ENABLED: Batch ingest is not enabled/);
      await a.close();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('namespace: "discover" (opt-in)', () => {
  it("needs three consecutive agreeing handshakes, holds attest() meanwhile, then persists", async () => {
    const answers = [NS, OTHER, OTHER, NS, NS, NS];
    const t = new ScriptTransport((records, i) =>
      records.length === 0 ? { namespace: answers[i] ?? NS, accepted: [], rejected: [] } : ok()(records),
    );
    const a = new Attestor({ transport: t, spoolPath, namespace: "discover", retryMs: 1, onError: () => {} });
    const id = a.attest(rec(1)); // held until discovery completes
    expect(id).toEqual(expect.any(String));
    expect(a.getNamespace()).toBeNull();
    await a.ready();
    expect(t.handshakes).toBe(6);
    expect(a.getNamespace()).toBe(NS);
    expect(JSON.parse(readFileSync(`${spoolPath}.namespace`, "utf8"))).toEqual({ namespace: NS });
    await a.drain();
    expect(t.batches[0]!.map((d) => [d.decisionId, d.agentId])).toEqual([[id, `${NS}/loan-bot`]]);
    await a.close();

    // A restart reads the persisted value and does not rediscover.
    const t2 = new ScriptTransport(ok());
    const b = new Attestor({ transport: t2, spoolPath, namespace: "discover", onError: () => {} });
    expect(b.getNamespace()).toBe(NS);
    b.attest(rec(2));
    await b.drain();
    expect(t2.handshakes).toBe(0);
    expect(t2.batches[0]![0]!.agentId).toBe(`${NS}/loan-bot`);
    await b.close();
  });

  it("an error or a null namespace breaks the streak", async () => {
    const seq: (string | null | Error)[] = [NS, NS, new Error("down"), NS, null, NS, NS, NS];
    const t = new ScriptTransport((_r, i) => {
      const x = i < seq.length ? seq[i]! : NS;
      return x instanceof Error ? x : { namespace: x, accepted: [], rejected: [] };
    });
    const a = new Attestor({ transport: t, spoolPath, namespace: "discover", retryMs: 1, onError: () => {} });
    await a.ready();
    expect(t.handshakes).toBe(8);
    await a.close();
  });

  it("the discovered value is then checked like an explicit one", async () => {
    writeFileSync(`${spoolPath}.namespace`, JSON.stringify({ namespace: NS }));
    const errors: unknown[] = [];
    const t = new ScriptTransport(ok(OTHER));
    const a = new Attestor({ transport: t, spoolPath, namespace: "discover", namespaceRetries: 0, onError: (e) => errors.push(e) });
    a.attest(rec(1));
    await a.flush();
    expect(errors.some((e) => e instanceof NamespaceMismatchError && e.fatal)).toBe(true);
    expect(a.getNamespace()).toBe(NS);
    await a.close();
  });

  it("validates the name at attest() even before the namespace is known", async () => {
    const t = new ScriptTransport(() => new Error("offline"));
    const a = new Attestor({ transport: t, spoolPath, namespace: "discover", retryMs: 60_000, onError: () => {} });
    expect(() => a.attest(rec(1, "loan bot"))).toThrow(AgentIdError);
    expect(() => a.attest(rec(1, `${NS}/loan-bot`))).toThrow(AgentIdError);
    await a.close();
  });

  it("an unreadable namespace file is reported and rediscovered", async () => {
    writeFileSync(`${spoolPath}.namespace`, "{nope");
    const errors: unknown[] = [];
    const t = new ScriptTransport(() => ({ namespace: NS, accepted: [], rejected: [] }));
    const a = new Attestor({ transport: t, spoolPath, namespace: "discover", onError: (e) => errors.push(e) });
    await a.ready();
    expect(String(errors[0])).toMatch(/unreadable/);
    expect(existsSync(`${spoolPath}.namespace`)).toBe(true);
    expect(a.getNamespace()).toBe(NS);
    await a.close();
  });
});
