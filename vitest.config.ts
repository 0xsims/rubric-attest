import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  // Resolve @rubric/* workspace deps to their TS source during tests, not dist.
  resolve: { conditions: ["development"] },
  test: {
    // Fast suite: unit + integration. Heavy perf tests (*.perf.test.ts) run
    // separately via vitest.perf.config.ts so the main PR check stays quick.
    include: ["packages/*/test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.perf.test.ts"],
    environment: "node",
  },
});
