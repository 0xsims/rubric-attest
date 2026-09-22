import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Attestor, type DarCore, type Transport } from "../src/index.js";

// Transport that resolves instantly; flushes are deferred (setImmediate) so they
// do not run during the tight synchronous measurement loop.
const noopTransport: Transport = {
  async send(_records: DarCore[]): Promise<void> {},
};

let dir: string;
let spoolPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-perf-"));
  spoolPath = join(dir, "attest.spool");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("attest() latency", () => {
  it("adds well under 1 ms to the caller (median)", async () => {
    const a = new Attestor({ transport: noopTransport, spoolPath, maxWaitMs: 60_000 });
    const input = (n: number) => ({ agentId: "A", schema: { type: "object" }, decision: { n } });

    // Warm up JIT and the schema-hash cache.
    for (let i = 0; i < 500; i++) a.attest(input(i));

    const N = 3000;
    const samples = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      const start = process.hrtime.bigint();
      a.attest(input(i));
      const end = process.hrtime.bigint();
      samples[i] = Number(end - start) / 1e6; // ms
    }

    samples.sort((x, y) => x - y);
    const p = (q: number) => samples[Math.min(N - 1, Math.floor(N * q))]!;
    const median = p(0.5);
    const p90 = p(0.9);
    const p99 = p(0.99);
    console.log(
      `attest() latency ms: p50=${median.toFixed(4)} p90=${p90.toFixed(4)} p99=${p99.toFixed(4)} max=${samples[N - 1]!.toFixed(4)}`,
    );

    expect(median).toBeLessThan(1);
    expect(p90).toBeLessThan(1);

    await a.close();
  });
});
