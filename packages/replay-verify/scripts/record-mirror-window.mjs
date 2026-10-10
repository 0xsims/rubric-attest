#!/usr/bin/env node
// Record the mirror messages tenprint-verify would read for one anchor, so a real
// mainnet case can be replayed offline by test/mainnet.test.ts.
//
//   node packages/replay-verify/scripts/record-mirror-window.mjs \
//     <record.json> <anchor-bundle.json> > mirror-messages.json
//
// Contacts only the public mirror (mainnet-public.mirrornode.hedera.com), with
// the same queries as the verifier: hinted sequence ranges (±19) and the time
// window [anchoredAt − 15 min, anchoredAt + 60 min], following links.next.
// Dev tool only: not part of the published package.
import { readFileSync } from "node:fs";

const MIRROR = "https://mainnet-public.mirrornode.hedera.com";
const TOPIC = "0.0.10416909";
const [recPath, bundlePath] = process.argv.slice(2);
if (!recPath || !bundlePath) {
  process.stderr.write("usage: record-mirror-window.mjs <record.json> <anchor-bundle.json> > mirror-messages.json\n");
  process.exit(2);
}
const rec = JSON.parse(readFileSync(recPath, "utf8"));
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));

const hints = new Set();
const add = (v) => { const n = typeof v === "number" ? v : typeof v === "string" && /^[1-9][0-9]*$/.test(v) ? Number(v) : NaN; if (Number.isSafeInteger(n) && n > 0) hints.add(n); };
add(rec?.anchors?.hcs?.sequence_number);
add(rec?.anchorRef?.sequenceNumber);
add(rec?.extensions?.rubricDar?.bridge?.hop2?.seqNum);
add(bundle?.seqNum);

const ts = (ms) => { const s = Math.floor(ms / 1000); return `${s}.${String((ms % 1000) * 1e6).padStart(9, "0")}`; };
const at = Date.parse(bundle.anchoredAt);
if (!Number.isFinite(at)) { process.stderr.write("anchor bundle has no valid anchoredAt\n"); process.exit(2); }
const base = `${MIRROR}/api/v1/topics/${TOPIC}/messages`;
const urls = [
  ...[...hints].map((h) => `${base}?sequencenumber=gte:${Math.max(1, h - 19)}&sequencenumber=lte:${h + 19}&order=asc&limit=100`),
  `${base}?timestamp=gte:${ts(at - 15 * 60_000)}&timestamp=lte:${ts(at + 60 * 60_000)}&order=asc&limit=100`,
];

const bySeq = new Map();
for (let url of urls) {
  while (url) {
    const u = new URL(url);
    if (u.origin !== MIRROR || u.pathname !== `/api/v1/topics/${TOPIC}/messages`) throw new Error(`refusing ${url}`);
    let res;
    for (let i = 0; i <= 5; i++) {
      res = await fetch(url, { redirect: "error", headers: { accept: "application/json" } });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const page = await res.json();
    for (const m of page.messages ?? []) bySeq.set(m.sequence_number, m);
    url = page.links?.next ? new URL(page.links.next, MIRROR).href : null;
  }
}
process.stdout.write(JSON.stringify([...bySeq.values()].sort((a, b) => a.sequence_number - b.sequence_number), null, 2) + "\n");
