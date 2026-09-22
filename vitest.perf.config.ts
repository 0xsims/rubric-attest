import { defineConfig } from "vitest/config";

// Performance-acceptance suite (tasks P1/P2): builds large fixtures and asserts
// wall-clock latency budgets (attest() <1 ms; index queries <10 ms on 1M rows).
// Kept out of the default `test` run — see vitest.config.ts — and run as its own
// CI job so a slow shared runner cannot flake the main check.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.perf.test.ts"],
    environment: "node",
    testTimeout: 200_000,
    hookTimeout: 200_000,
  },
});
