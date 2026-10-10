/**
 * Real mainnet fixtures, end to end, under the §4.2 network guard.
 *
 * Each case directory under test/fixtures/mainnet/ holds:
 *
 *   record.json          the warm record <attestationId>.json, or the completed DAR bundle
 *   anchor-bundle.json   the tier-2 anchor bundle <anchorId>.json
 *   mirror-messages.json the mirror message(s) for the anchor, as returned by the public mirror
 *   rubric-keys.json     the keys file as published at recording time
 *
 * The recorded mirror and keys file are replayed through the injected fetch;
 * every request still passes the guard, so a request outside §4.2 fails the test.
 *
 * tiered/ is a real canary record (02d03bdf-…, payload is a commitment hash only)
 * anchored at topic 0.0.10416909 seq 309269. Its mirror message was fetched from
 * mainnet-public.mirrornode.hedera.com by the operator; the keys file is
 * rubric-web main 0fa4b87. A real DAR case is still to be exported (see README).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { KEYS_URL } from "../src/constants.js";
import { verify } from "../src/verify.js";
import { fakeNet, noSleep, MIRROR, TOPIC, type Json } from "./helpers.js";

const dir = new URL("./fixtures/mainnet/", import.meta.url);
const cases = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/record.json`, dir))).map((d) => d.name) : [];
const read = (c: string, f: string): Json => JSON.parse(readFileSync(new URL(`${c}/${f}`, dir), "utf8"));
const ALL_PASS = [
  ["signature", "PASS", null],
  ["leaf", "PASS", null],
  ["batch", "PASS", null],
  ["aggregate", "PASS", null],
  ["anchor", "PASS", null],
];

describe.skipIf(cases.length === 0)("real mainnet fixtures (test/fixtures/mainnet/)", () => {
  for (const c of cases) {
    it(`${c}: verifies with exit 0 under the network guard`, async () => {
      const net = fakeNet({ messages: read(c, "mirror-messages.json"), keys: read(c, "rubric-keys.json") });
      const report = await verify({ record: read(c, "record.json"), anchorBundle: read(c, "anchor-bundle.json"), fetch: net.fetch, sleep: noSleep });
      expect(report.steps.map((s) => [s.name, s.status, s.reason])).toEqual(ALL_PASS);
      expect(report.exitCode).toBe(0);
      // Only the two §4.2 request kinds were made.
      for (const u of net.requests) {
        expect(u === KEYS_URL || u.startsWith(`${MIRROR}/api/v1/topics/${TOPIC}/messages?`)).toBe(true);
      }
    });

    it(`${c}: with --keys, verifies with exit 0 and makes zero requests to rubric-protocol.com`, async () => {
      const net = fakeNet({ messages: read(c, "mirror-messages.json"), keys: null });
      const report = await verify({ record: read(c, "record.json"), anchorBundle: read(c, "anchor-bundle.json"), keys: read(c, "rubric-keys.json"), fetch: net.fetch, sleep: noSleep });
      expect(report.exitCode).toBe(0);
      expect(net.requests.filter((u) => new URL(u).hostname.endsWith("rubric-protocol.com"))).toEqual([]);
    });
  }

  it.runIf(cases.includes("tiered"))("tiered: reports the real anchor (seq 309269, payer 0.0.3923341, built-in payer list)", async () => {
    const net = fakeNet({ messages: read("tiered", "mirror-messages.json"), keys: read("tiered", "rubric-keys.json") });
    const report = await verify({ record: read("tiered", "record.json"), anchorBundle: read("tiered", "anchor-bundle.json"), fetch: net.fetch, sleep: noSleep });
    expect(report.recordKind).toBe("tiered");
    expect(report.anchor).toMatchObject({
      anchorId: "d59658dd-e087-4363-922c-becb76e51494",
      aggregateRoot: "f0abe630454a1f5140c687dbc6ac4a05420eac8e67f41d910451d2aa69262cb2",
      sequenceNumber: 309269,
      consensusTimestamp: "1791614183.102338104",
      payerAccountId: "0.0.3923341",
      topic: TOPIC,
      mirror: MIRROR,
    });
    expect(report.anchorPayers.source).toBe("built-in");
    expect(report.anchorPayers.accounts).toEqual(["0.0.3923341"]);
  });

  it.runIf(cases.includes("tiered"))("tiered: a one-character change to the real leaf payload commitment is FAIL", async () => {
    const record = read("tiered", "record.json");
    const pc: string = record.stub.leafMessage.payload.payload_commitment;
    record.stub.leafMessage.payload.payload_commitment = (pc[0] === "a" ? "b" : "a") + pc.slice(1);
    const net = fakeNet({ messages: read("tiered", "mirror-messages.json"), keys: read("tiered", "rubric-keys.json") });
    const report = await verify({ record, anchorBundle: read("tiered", "anchor-bundle.json"), fetch: net.fetch, sleep: noSleep });
    expect(report.exitCode).toBe(1);
    expect(report.verdict).toBe("FAIL");
  });

  it.todo("dar: a real completed DAR bundle (not yet exported; see README, 'Real mainnet fixtures')");
});

describe.runIf(cases.length === 0)("real mainnet fixtures", () => {
  it.skip("SKIPPED: test/fixtures/mainnet/ is empty. Export a real record with its tier-2 anchor bundle (package README, 'Real mainnet fixtures') to run the end-to-end mainnet test.", () => {});
});
