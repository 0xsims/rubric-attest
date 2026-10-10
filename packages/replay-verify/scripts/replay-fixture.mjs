#!/usr/bin/env node
// Run rubric-replay offline against a recorded case: the real CLI and the real
// §4.2 network guard, with the mirror and keys responses served from files.
//
//   npm run build
//   node packages/replay-verify/scripts/replay-fixture.mjs \
//     <record.json> <anchor-bundle.json> <mirror-messages.json> <rubric-keys.json> [--json]
//
// mirror-messages.json is an array of mirror message objects (as written by
// record-mirror-window.mjs); a single message object is also accepted. The keys
// file is served at the default keys URL, so this exercises the same path as a
// live run without --keys. Makes no network requests.
// Dev tool only: not part of the published package.
import { readFileSync } from "node:fs";
import { main } from "../dist/cli.js";
import { KEYS_URL } from "../dist/constants.js";

const [recPath, bundlePath, msgsPath, keysPath, ...rest] = process.argv.slice(2);
if (!recPath || !bundlePath || !msgsPath || !keysPath) {
  process.stderr.write("usage: replay-fixture.mjs <record.json> <anchor-bundle.json> <mirror-messages.json> <rubric-keys.json> [--json]\n");
  process.exit(2);
}
const loaded = JSON.parse(readFileSync(msgsPath, "utf8"));
const messages = (Array.isArray(loaded) ? loaded : [loaded]).sort((a, b) => a.sequence_number - b.sequence_number);
const keys = JSON.parse(readFileSync(keysPath, "utf8"));

const toNs = (s) => { const [x, y = "0"] = String(s).split("."); return BigInt(x) * 1_000_000_000n + BigInt(y.padEnd(9, "0")); };
const cmp = (field, a, b) => {
  if (field === "sequencenumber") return Number(a) - Number(b);
  const d = toNs(a) - toNs(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};

// Serves the recorded messages for /api/v1/topics/<topic>/messages, honouring the
// sequencenumber/timestamp filters and limit the verifier sends. One page only:
// a recorded case is far smaller than the verifier's page size.
const fetch = async (url) => {
  if (url === KEYS_URL) return Response.json(keys);
  const u = new URL(url);
  const filters = [];
  for (const field of ["sequencenumber", "timestamp"]) {
    for (const v of u.searchParams.getAll(field)) {
      const i = v.indexOf(":");
      filters.push(i < 0 ? { field, op: "eq", value: v } : { field, op: v.slice(0, i), value: v.slice(i + 1) });
    }
  }
  const rows = messages.filter((m) => filters.every((f) => {
    const c = cmp(f.field, f.field === "sequencenumber" ? m.sequence_number : m.consensus_timestamp, f.value);
    return f.op === "gte" ? c >= 0 : f.op === "lte" ? c <= 0 : f.op === "gt" ? c > 0 : f.op === "lt" ? c < 0 : c === 0;
  }));
  const limit = Number(u.searchParams.get("limit") ?? 25);
  if (rows.length > limit) throw new Error(`recorded case has more than ${limit} matching messages; paging is not simulated`);
  return Response.json({ messages: rows, links: { next: null } });
};

const code = await main(["--record", recPath, "--anchor-bundle", bundlePath, ...rest], {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  fetch,
  sleep: async () => {},
});
process.exitCode = code;
