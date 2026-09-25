import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { HttpTransport, SDK_VERSION, SDK_VERSION_HEADER, TransportError } from "../src/index.js";

const pkgVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** A fetch that records each request and answers with `status` and a JSON `body`. */
function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof fetch;
  return { impl, requests };
}

const transport = (f: typeof fetch) => new HttpTransport({ baseUrl: "https://x", apiKey: () => "k", fetchImpl: f });

describe("HttpTransport", () => {
  it("refuses a non-HTTPS baseUrl by default (protects the bearer key)", () => {
    expect(() => new HttpTransport({ baseUrl: "http://attest.example" })).toThrow(/non-HTTPS/);
  });

  it("allows http for localhost / loopback", () => {
    expect(() => new HttpTransport({ baseUrl: "http://localhost:8080" })).not.toThrow();
    expect(() => new HttpTransport({ baseUrl: "http://127.0.0.1:8080" })).not.toThrow();
  });

  it("allows non-HTTPS when allowInsecure is set", () => {
    expect(
      () => new HttpTransport({ baseUrl: "http://attest.example", allowInsecure: true }),
    ).not.toThrow();
  });

  it("requires RUBRIC_API_KEY", async () => {
    const t = new HttpTransport({ baseUrl: "https://x", apiKey: () => undefined });
    await expect(t.send([])).rejects.toThrow(/RUBRIC_API_KEY/);
  });

  it("aborts a hung request after timeoutMs", async () => {
    const hangingFetch = ((_url: unknown, opts: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const t = new HttpTransport({
      baseUrl: "https://x",
      apiKey: () => "k",
      fetchImpl: hangingFetch,
      timeoutMs: 20,
    });
    await expect(t.send([])).rejects.toThrow();
  });

  it("sends x-rubric-sdk: attest-decision/<package.json version> on every POST", async () => {
    expect(SDK_VERSION).toBe(pkgVersion);
    const f = fakeFetch(200, { accepted: [], rejected: [], namespace: "ns_0123456789ab" });
    await transport(f.impl).send([]);
    const headers = f.requests[0]!.init.headers as Record<string, string>;
    expect(SDK_VERSION_HEADER).toBe("x-rubric-sdk");
    expect(headers["x-rubric-sdk"]).toBe(`attest-decision/${pkgVersion}`);
    expect(f.requests[0]!.url).toBe("https://x/v1/tiered-attest");
  });

  it("returns a 200's namespace, accepted and rejected", async () => {
    const f = fakeFetch(200, {
      accepted: ["01A"],
      rejected: [{ decisionId: "01B", reason: "bad-agentId" }, { decisionId: null, reason: "not-an-object" }],
      namespace: "ns_0123456789ab",
    });
    await expect(transport(f.impl).send([])).resolves.toEqual({
      namespace: "ns_0123456789ab",
      accepted: ["01A"],
      rejected: [
        { decisionId: "01B", reason: "bad-agentId" },
        { decisionId: null, reason: "not-an-object" },
      ],
    });
  });

  it("426: rejects with the server's message and the minimum version", async () => {
    const f = fakeFetch(426, {
      error: "Batch ingest requires @rubric-protocol/attest-decision 1.2.0 or later.",
      code: "SDK_UPGRADE_REQUIRED",
      minimum: "attest-decision/1.2.0",
      got: null,
      namespace: "ns_0123456789ab",
    });
    const err = await transport(f.impl).send([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    const e = err as TransportError;
    expect(e.status).toBe(426);
    expect(e.code).toBe("SDK_UPGRADE_REQUIRED");
    expect(e.namespace).toBe("ns_0123456789ab");
    expect(e.message).toContain("426 SDK_UPGRADE_REQUIRED: Batch ingest requires @rubric-protocol/attest-decision 1.2.0 or later.");
    expect(e.message).toContain("minimum attest-decision/1.2.0");
  });

  it("403 BATCH_INGEST_NOT_ENABLED: rejects with the server's error and hint", async () => {
    const f = fakeFetch(403, {
      error: "Batch ingest is not enabled for this API key.",
      code: "BATCH_INGEST_NOT_ENABLED",
      hint: "Batch ingest is in limited rollout.",
      namespace: null,
    });
    const e = (await transport(f.impl).send([]).catch((x: unknown) => x)) as TransportError;
    expect(e.code).toBe("BATCH_INGEST_NOT_ENABLED");
    expect(e.namespace).toBeNull();
    expect(e.message).toBe(
      "tiered-attest POST failed: 403 BATCH_INGEST_NOT_ENABLED: Batch ingest is not enabled for this API key. Batch ingest is in limited rollout.",
    );
  });

  it("403 NAMESPACE_UNAVAILABLE carries code and namespace null", async () => {
    const f = fakeFetch(403, { error: "no namespace", code: "NAMESPACE_UNAVAILABLE", namespace: null });
    const e = (await transport(f.impl).send([]).catch((x: unknown) => x)) as TransportError;
    expect(e.code).toBe("NAMESPACE_UNAVAILABLE");
    expect(e.namespace).toBeNull();
  });

  it("425: reads Retry-After", async () => {
    const f = fakeFetch(425, { error: "too early", retryable: true, namespace: "ns_0123456789ab" }, { "retry-after": "7" });
    const e = (await transport(f.impl).send([]).catch((x: unknown) => x)) as TransportError;
    expect(e.retryAfterMs).toBe(7000);
  });

  it("tolerates a non-JSON body", async () => {
    const f = fakeFetch(502, "<html>bad gateway</html>");
    const e = (await transport(f.impl).send([]).catch((x: unknown) => x)) as TransportError;
    expect(e.status).toBe(502);
    expect(e.namespace).toBeUndefined();
    const ok = fakeFetch(200, "");
    await expect(transport(ok.impl).send([])).resolves.toEqual({ accepted: [], rejected: [] });
  });
});
