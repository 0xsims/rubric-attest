import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportEvidence, openIndexReader, openStoreReader } from "../src/index.js";
import { buildStoreFixture, goldenDars, type StoreFixture } from "./helpers/store-fixture.js";

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/golden-evidence.json", import.meta.url)), "utf8"),
);
const goldenSummary = readFileSync(
  fileURLToPath(new URL("./fixtures/golden-summary.txt", import.meta.url)),
  "utf8",
);

let fx: StoreFixture | undefined;
afterEach(() => fx?.cleanup());

describe("evidence export — golden bundle", () => {
  it("matches the golden bundle + summary, reading real index shards offline", () => {
    fx = buildStoreFixture(goldenDars());
    const index = openIndexReader(fx.indexDir);
    const { bundle, summary } = exportEvidence(index, openStoreReader(fx.storeDir), {
      agent: "agent://jev/pricing",
      from: "2025-09-22T00:00:00.000Z",
      to: "2025-09-22T23:59:59.999Z",
      generatedAt: "2025-09-22T12:00:00.000Z",
    });
    index.close?.();

    expect(bundle).toEqual(golden);
    expect(summary).toBe(goldenSummary);
    // Sanity: the bundle carries DARs + proofs + anchor refs.
    expect(bundle.decisions).toHaveLength(3);
    expect(bundle.decisions[0]!.merkleProof.root).toBe(bundle.decisions[0]!.anchorRef.root);
  });
});
