/**
 * --example: the bundled canary case, end to end through the CLI, under the §4.2 network guard.
 * The recorded mirror message is served through the injected fetch; the keys URLs fail, so a
 * request to a TenPrint host (or anywhere but the mirror) cannot go unnoticed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXAMPLE_FILES, main } from "../src/cli.js";
import { MIRROR, TOPIC, fakeNet, noSleep } from "./helpers.js";

const messages = JSON.parse(readFileSync(new URL("./fixtures/mainnet/tiered/mirror-messages.json", import.meta.url), "utf8"));

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const net = fakeNet({ messages, keys: null });
  const code = main(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s), fetch: net.fetch, sleep: noSleep });
  return { code, out, err, net };
}

describe("tenprint-verify --example", () => {
  it("verifies the bundled canary record: exit 0, all five steps PASS", async () => {
    const t = run(["--example"]);
    expect(await t.code).toBe(0);
    const text = t.out.join("");
    expect(text).toContain("tenprint-verify: PASS (exit 0) — tiered record");
    for (const step of ["signature", "leaf", "batch", "aggregate", "anchor"]) {
      expect(text).toMatch(new RegExp(`\\[PASS\\s*\\] ${step}`));
    }
    expect(text).toContain("anchorId d59658dd-e087-4363-922c-becb76e51494");
    expect(t.err.join("")).toContain("02d03bdf-e810-4dfd-a3a0-926b5ad48684");
  });

  it("makes zero requests to TenPrint (tenprint.ai or rubric-protocol.com): mirror topic messages only", async () => {
    const t = run(["--example"]);
    expect(await t.code).toBe(0);
    expect(t.net.requests.length).toBeGreaterThan(0);
    for (const u of t.net.requests) {
      expect(u.startsWith(`${MIRROR}/api/v1/topics/${TOPIC}/messages?`), u).toBe(true);
    }
  });

  it("--json reports the real anchor; stdout stays pure JSON", async () => {
    const t = run(["--example", "--json"]);
    expect(await t.code).toBe(0);
    const report = JSON.parse(t.out.join(""));
    expect(report.steps.map((s: { status: string }) => s.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(report.anchor).toMatchObject({ sequenceNumber: 309269, payerAccountId: "0.0.3923341", consensusTimestamp: "1791614183.102338104" });
    expect(report.anchorPayers.source).toBe("built-in");
  });

  it("exit 2 when combined with --record, --anchor-bundle, --keys or --topic", async () => {
    for (const extra of [["--record", "r.json"], ["--anchor-bundle", "a.json"], ["--keys", "k.json"], ["--topic", TOPIC]]) {
      const t = run(["--example", ...extra]);
      expect(await t.code).toBe(2);
      expect(t.err.join("")).toContain(`cannot be combined with ${extra[0]}`);
      expect(t.net.requests).toEqual([]);
    }
  });

  it("reads the files listed in package.json files", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const p of Object.values(EXAMPLE_FILES)) {
      const rel = p.slice(p.lastIndexOf("/test/") + 1);
      expect(pkg.files).toContain(rel);
    }
  });
});
