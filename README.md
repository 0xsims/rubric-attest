# Rubric Decision Attestation

**Attesting an AI agent's decisions is free. Verifying one costs $0.10.**

Every audit-trail product prices the write, so teams attest selectively - and a
trail with gaps proves nothing. This inverts it: attestation writes cost nothing,
forever, and what costs money is doubt. Anyone can verify any record for $0.10,
machine-to-machine over [x402](https://www.x402.org/), no account.

What a record is: hash commitments only (SHA3-256 over JCS) - the decision
payload never leaves your client by default. Records chain per agent, carry
Merkle proofs, are signed by a threshold of ML-DSA-65 (post-quantum) keys across
regions, and are anchored to Hedera mainnet minutes after the decision. Once
anchored, nobody can backdate or revise a record. Including us.

Live verify endpoint (returns its price and shape to a plain GET):
`curl https://rubric-protocol.com/v1/x402/decision-verify`

Honest limits, current state: the signing federation is three regions today, all
operated by Rubric - independent operators are the roadmap, so today the
threshold protects against key compromise, not against the operator as an
institution. The verify response covers internal consistency plus the on-ledger
anchor ref; linking the anchor to a specific record is a documented hash-bridge
walk. Details in [`spec/dar-0.1.md`](./spec/dar-0.1.md).

---

[![CI](https://github.com/0xsims/rubric-attest/actions/workflows/ci.yml/badge.svg)](https://github.com/0xsims/rubric-attest/actions/workflows/ci.yml)

Monorepo for the Rubric Decision Attestation system.

## Quickstart

```bash
npm install @rubric-protocol/attest-decision
export RUBRIC_API_KEY=your-key
```

Free API key: https://rubric-protocol.com/get-started. Code example under [SDK usage](#sdk-usage-rubric-protocolattest-decision).

## Layout

| Path | What |
|------|------|
| [`spec/dar-0.1.md`](./spec/dar-0.1.md) | DAR/0.1 record format: field table, JCS + SHA3-256 rules, versioning rules. **Frozen.** |
| `packages/attest-decision` | Core SDK — DAR builder, JCS canonicalization, SHA3-256, fire-and-forget `attest()`, batcher, durable spool (P1). |
| `packages/attest-index` | Attestation index — SQLite day-shard writer (WAL), backfill, and query lib (`byDecisionId`, `byAgentRange`, `byAgentSchema`, `chainHead`) (P2). |
| `packages/jev` | Adapter — Jev decision shape → DAR inputs; all Jev knowledge confined here (P3). |
| `packages/schema` | Adapter — JSON Schema / Zod → DAR inputs (P3). |
| `packages/verify` | x402-gated `/v1/x402/decision-verify` route — Merkle proof, HCS anchor ref, signature, drift flag; chain-check continuity (P4). |
| `packages/evidence` | `rubric-evidence export` CLI — offline evidence bundles (DARs, proofs, anchors, continuity, schema-change log) from index shards + store (P5). |
| `.github/workflows/ci.yml` | Install + lint + typecheck + build + test, on every PR. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release history (Keep a Changelog). |

## Invariants

- **Hashing** SHA3-256 everywhere. **Canonicalization** JCS (RFC 8785).
  Canonicalize, then hash.
- **Record format** DAR/0.1 per `spec/dar-0.1.md`. Field set frozen; additive
  changes bump the minor.
- The SDK reads exactly one credential env var: `RUBRIC_API_KEY`.
- `attest()` never blocks the caller and never throws into app code; failures
  spool.

## SDK usage (`@rubric-protocol/attest-decision`)

```ts
import { Attestor, HttpTransport } from "@rubric-protocol/attest-decision";

const attestor = new Attestor({
  transport: new HttpTransport({ baseUrl: "https://rubric-protocol.com" }), // reads RUBRIC_API_KEY
  spoolPath: "/var/lib/rubric/attest.spool",
  // mode: "payload",  // optional — also ship raw content in the transport envelope; default is "hash-only"
});

// Fire-and-forget: returns immediately (<1 ms), never throws into app code.
// The DAR core is hashes-only: schema/input/output are hashed, never carried raw.
attestor.attest({
  agentId: "agent://jev/pricing-v3",
  schema: pricingSchema,                                // hashed to schemaHash
  input: { requestId: "req-1" },                        // hashed to inputHash
  output: { action: "approve", limitUsd: "2500.00" },   // hashed to outputHash
});
```

Records are appended to a durable spool (its parent directory is created if
missing) and flushed in batches (64 records or 5000 ms) with one POST per flush
to `/v1/tiered-attest`. A `kill -9` at any point loses zero spooled records — the
next process drains the spool on startup.

### Guarantees and limits

- **Hashes-only core.** The DAR core never carries raw content — only
  `schemaHash`/`inputHash`/`outputHash` and a `decisionHash` over the three.
  Raw content is transmitted only in `mode: "payload"`, in the transport
  envelope, never in a core; the default is hash-only.
- **`attest()` latency** is sub-millisecond for typical payloads; decisions
  larger than `maxDecisionBytes` (default 256 KiB) are rejected rather than
  block the caller.
- **Durability:** `writeSync` (no fsync) makes a record survive process death
  (`kill -9`); a background `fsync` before each flush, plus a directory fsync
  after spool compaction, defend against power loss. A write failure (disk full)
  surfaces via `onError` — the record is not spooled.
- **Delivery is at-least-once.** A lost response or a crash can re-send a batch;
  consumers must de-duplicate by `decisionId`.
- **Back-pressure:** under a sustained transport outage the spool caps at 50 MB
  (drop-oldest, reported via `onError`) and the in-memory queue caps at
  `maxQueue`; the HTTP transport times out (`timeoutMs`, default 30 s) and
  refuses a non-HTTPS `baseUrl` unless `allowInsecure` is set.
- **`prev` chaining is per producer process.** Multiple producers writing the
  same `agentId` form independent branches; there is no global sequencing.
- **`chainHead` (index) returns the latest `decisionId`** — an approximation of
  the chain tip; use the verify package's `chainCheck` for true continuity.
- **Verification scope:** the verify route checks a bundle's *internal*
  consistency (hashes, Merkle proof folds to the bundle's root, signature) and
  the DAR version. It does **not** confirm the root was anchored on HCS or that
  the signing key is trusted — that is the (separate) attestation service.

## Development

Requires Node.js >= 20.

```sh
npm install       # install workspace deps
npm run lint      # eslint
npm run typecheck # tsc --noEmit across all packages
npm run build     # emit dist JS + .d.ts for each package (consumable output)
npm run test      # vitest run (resolves @rubric-protocol/* to source via the dev condition)
npm run check     # lint + typecheck + test
```

This is an npm-workspaces monorepo; `npm install` at the root wires the packages
together. Each package publishes its built `dist/` (`exports` map with a
`development` condition that points tools at `src/` in this workspace); run
`npm run build` before publishing.
