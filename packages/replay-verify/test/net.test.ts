/** The §4.2 allowlist, enforced by the one fetch wrapper. */
import { describe, expect, it, vi } from "vitest";
import { KEYS_FALLBACK_URL, KEYS_URL, DEFAULT_MIRROR, DEFAULT_TOPIC } from "../src/constants.js";
import { NetworkGuardError, UsageError, checkAllowed, createGuardedFetch, getJson, validateMirror } from "../src/net.js";
import { keysFile } from "./helpers.js";

const MIRROR = DEFAULT_MIRROR;
const TOPIC = DEFAULT_TOPIC;
const fetched = { mirror: MIRROR, topic: TOPIC, allowKeysUrl: true };
const pinned = { mirror: MIRROR, topic: TOPIC, allowKeysUrl: false };
const verifyUrl = keysFile().attestation.verify as string;

describe("checkAllowed", () => {
  const allowed = [
    KEYS_URL,
    KEYS_FALLBACK_URL,
    `${MIRROR}/api/v1/topics/${TOPIC}/messages?timestamp=gte:1.000000000&timestamp=lte:2.000000000&order=asc&limit=100`,
    `${MIRROR}/api/v1/topics/${TOPIC}/messages?sequencenumber=gte:1&sequencenumber=lte:39&order=asc&limit=100`,
    `${MIRROR}/api/v1/topics/${TOPIC}/messages?limit=100&order=asc&timestamp=lte:2.0&timestamp=gt:1.5`,
  ];
  for (const u of allowed) it(`allows ${u.slice(0, 90)}`, () => expect(() => checkAllowed(u, fetched)).not.toThrow());

  const refused: [string, string][] = [
    ["rubric-protocol.com /v1/*", "https://rubric-protocol.com/v1/verify/abc"],
    ["the keys file's attestation.verify URL", verifyUrl],
    ["any rubric-protocol.com /v1 path", "https://rubric-protocol.com/v1/tiered-attest"],
    ["a regional rubric-protocol.com host", "https://us.rubric-protocol.com/.well-known/rubric-keys.json"],
    ["tenprint.ai /v1/*", "https://tenprint.ai/v1/verify/abc"],
    ["another tenprint.ai path", "https://tenprint.ai/.well-known/x402.json"],
    ["a tenprint.ai subdomain", "https://www.tenprint.ai/.well-known/rubric-keys.json"],
    ["the keys URL with a query", `${KEYS_URL}?x=1`],
    ["the fallback keys URL with a query", `${KEYS_FALLBACK_URL}?x=1`],
    ["the keys file over http", "http://tenprint.ai/.well-known/rubric-keys.json"],
    ["the keys file on a trailing-dot host", "https://tenprint.ai./.well-known/rubric-keys.json"],
    ["mainnet.mirrornode.hedera.com", `https://mainnet.mirrornode.hedera.com/api/v1/topics/${TOPIC}/messages?limit=1`],
    ["the topic-info endpoint /api/v1/topics/<topic>", `${MIRROR}/api/v1/topics/${TOPIC}`],
    ["a by-sequence lookup /messages/<seq>", `${MIRROR}/api/v1/topics/${TOPIC}/messages/123`],
    ["another topic", `${MIRROR}/api/v1/topics/0.0.1/messages?limit=1`],
    ["another mirror path", `${MIRROR}/api/v1/transactions?limit=1`],
    ["plain http", `http://mainnet-public.mirrornode.hedera.com/api/v1/topics/${TOPIC}/messages`],
    ["another host", "https://example.com/api/v1/topics/0.0.10416909/messages"],
    ["credentials", `https://u:p@mainnet-public.mirrornode.hedera.com/api/v1/topics/${TOPIC}/messages`],
  ];
  for (const [label, u] of refused) {
    it(`refuses ${label}`, () => expect(() => checkAllowed(u, fetched)).toThrow(NetworkGuardError));
  }

  it("with --keys, even the keys URLs are refused (zero requests to TenPrint hosts)", () => {
    expect(() => checkAllowed(KEYS_URL, pinned)).toThrow(NetworkGuardError);
    expect(() => checkAllowed(KEYS_FALLBACK_URL, pinned)).toThrow(NetworkGuardError);
  });

  it("the default keys URL is on tenprint.ai, the fallback on rubric-protocol.com, same legacy filename", () => {
    expect(KEYS_URL).toBe("https://tenprint.ai/.well-known/rubric-keys.json");
    expect(KEYS_FALLBACK_URL).toBe("https://rubric-protocol.com/.well-known/rubric-keys.json");
  });
});

describe("createGuardedFetch", () => {
  it("throws before calling the underlying fetch for a refused URL", async () => {
    const impl = vi.fn(async () => new Response("{}"));
    const gf = createGuardedFetch({ fetch: impl, ...fetched });
    await expect(gf("https://rubric-protocol.com/v1/verify/x")).rejects.toThrow(NetworkGuardError);
    await expect(gf("https://mainnet.mirrornode.hedera.com/api/v1/topics/0.0.10416909/messages")).rejects.toThrow(NetworkGuardError);
    await expect(gf(verifyUrl)).rejects.toThrow(NetworkGuardError);
    expect(impl).not.toHaveBeenCalled();
  });

  it("passes GET with redirect: error for an allowed URL", async () => {
    const impl = vi.fn(async (_u: string, _i?: RequestInit) => new Response("{}"));
    const gf = createGuardedFetch({ fetch: impl, ...fetched });
    await gf(KEYS_URL);
    expect(impl).toHaveBeenCalledTimes(1);
    const init = impl.mock.calls[0]![1]!;
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
  });
});

describe("validateMirror", () => {
  it("accepts the public mirror", () => expect(validateMirror(MIRROR)).toBe(MIRROR));
  for (const bad of ["https://mainnet.mirrornode.hedera.com", "https://rubric-protocol.com", "https://api.rubric-protocol.com", "https://tenprint.ai", "https://api.tenprint.ai", "https://tenprint.ai.", "https://rubric-protocol.com.", "http://mainnet-public.mirrornode.hedera.com", "https://x.example/prefix", "not a url"]) {
    it(`refuses ${bad}`, () => expect(() => validateMirror(bad)).toThrow(UsageError));
  }
});

describe("getJson retries", () => {
  it("retries 429/5xx at most 5 times per page, then RETRIES_EXHAUSTED", async () => {
    const impl = vi.fn(async () => new Response("busy", { status: 503 }));
    const gf = createGuardedFetch({ fetch: impl, ...fetched });
    const sleeps: number[] = [];
    const r = await getJson(gf, KEYS_URL, async (ms) => { sleeps.push(ms); });
    expect(r).toMatchObject({ ok: false, reason: "RETRIES_EXHAUSTED" });
    expect(impl).toHaveBeenCalledTimes(6);
    expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("recovers after a transient failure", async () => {
    let n = 0;
    const impl = vi.fn(async () => (++n < 3 ? new Response("x", { status: 429 }) : Response.json({ ok: 1 })));
    const gf = createGuardedFetch({ fetch: impl, ...fetched });
    const r = await getJson(gf, KEYS_URL, async () => {});
    expect(r).toEqual({ ok: true, json: { ok: 1 } });
  });

  it("does not retry a guard refusal", async () => {
    const impl = vi.fn(async () => new Response("{}"));
    const gf = createGuardedFetch({ fetch: impl, ...fetched });
    await expect(getJson(gf, "https://rubric-protocol.com/v1/x", async () => {})).rejects.toThrow(NetworkGuardError);
    expect(impl).not.toHaveBeenCalled();
  });
});
