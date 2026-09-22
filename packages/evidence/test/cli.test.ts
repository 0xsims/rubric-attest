import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoreFixture, goldenDars, type StoreFixture } from "./helpers/store-fixture.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/golden-evidence.json", import.meta.url)), "utf8"),
);
const goldenSummary = readFileSync(
  fileURLToPath(new URL("./fixtures/golden-summary.txt", import.meta.url)),
  "utf8",
);

function run(args: string[]) {
  // --conditions=development resolves @rubric-protocol/* workspace deps to TS source
  // (matches the dev export condition) so the CLI runs without a prior build.
  return spawnSync(
    process.execPath,
    ["--conditions=development", "--import", "tsx", cliPath, ...args],
    { encoding: "utf8" },
  );
}

let fx: StoreFixture | undefined;
afterEach(() => fx?.cleanup());

describe("rubric-evidence CLI", () => {
  it("exports a bundle + summary offline that matches the golden", () => {
    fx = buildStoreFixture(goldenDars());
    const outJson = join(fx.dir, "evidence.json");
    const outTxt = join(fx.dir, "summary.txt");

    const res = run([
      "export",
      "--agent", "agent://jev/pricing",
      "--index", fx.indexDir,
      "--store", fx.storeDir,
      "--from", "2025-09-22T00:00:00.000Z",
      "--to", "2025-09-22T23:59:59.999Z",
      "--generated-at", "2025-09-22T12:00:00.000Z",
      "--out", outJson,
      "--summary", outTxt,
    ]);

    expect(res.status).toBe(0);
    expect(JSON.parse(readFileSync(outJson, "utf8"))).toEqual(golden);
    expect(readFileSync(outTxt, "utf8")).toBe(goldenSummary);
  }, 30_000);

  it("exits non-zero when required flags are missing", () => {
    const res = run(["export", "--agent", "x"]);
    expect(res.status).toBe(2);
  });
});
