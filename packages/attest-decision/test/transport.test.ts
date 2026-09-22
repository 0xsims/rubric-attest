import { describe, it, expect } from "vitest";
import { HttpTransport } from "../src/index.js";

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
});
