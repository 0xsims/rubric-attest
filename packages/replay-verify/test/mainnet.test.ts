/**
 * Real mainnet fixtures, end to end, under the §4.2 network guard.
 *
 * The fixtures are NOT in this repo yet: they exist only on the production
 * store and must be exported by a human (see the package README, "Real mainnet
 * fixtures"). Each case directory under test/fixtures/mainnet/ holds:
 *
 *   record.json          the warm record <attestationId>.json, or the completed DAR bundle
 *   anchor-bundle.json   the tier-2 anchor bundle <anchorId>.json
 *   mirror-messages.json the recorded mirror messages (scripts/record-mirror-window.mjs)
 *   rubric-keys.json     the keys file as served at recording time
 *
 * The recorded mirror and keys file are replayed through the injected fetch;
 * every request still passes the guard, so a request outside §4.2 fails the test.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { verify } from "../src/verify.js";
import { fakeNet, noSleep, type Json } from "./helpers.js";

const dir = new URL("./fixtures/mainnet/", import.meta.url);
const cases = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/record.json`, dir))).map((d) => d.name) : [];
const read = (c: string, f: string): Json => JSON.parse(readFileSync(new URL(`${c}/${f}`, dir), "utf8"));

describe.skipIf(cases.length === 0)("real mainnet fixtures (test/fixtures/mainnet/)", () => {
  for (const c of cases) {
    it(`${c}: verifies with exit 0 under the network guard`, async () => {
      const net = fakeNet({ messages: read(c, "mirror-messages.json"), keys: read(c, "rubric-keys.json") });
      const report = await verify({ record: read(c, "record.json"), anchorBundle: read(c, "anchor-bundle.json"), fetch: net.fetch, sleep: noSleep });
      expect(report.steps.map((s) => [s.name, s.status, s.reason])).toEqual([
        ["signature", "PASS", null],
        ["leaf", "PASS", null],
        ["batch", "PASS", null],
        ["aggregate", "PASS", null],
        ["anchor", "PASS", null],
      ]);
      expect(report.exitCode).toBe(0);
    });
  }
  it("covers both a tiered record and a DAR bundle", async () => {
    const kinds = new Set<string>();
    for (const c of cases) kinds.add(read(c, "record.json").dar ? "dar" : "tiered");
    expect([...kinds].sort()).toEqual(["dar", "tiered"]);
  });
});

describe.runIf(cases.length === 0)("real mainnet fixtures", () => {
  it.skip("SKIPPED: test/fixtures/mainnet/ is empty. Export a real tiered record and a real DAR bundle with their tier-2 anchor bundles (package README, 'Real mainnet fixtures') to run the end-to-end mainnet test.", () => {});
});
