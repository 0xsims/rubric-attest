# Rubric Decision Attestation

[![CI](https://github.com/0xsims/rubric-attest/actions/workflows/ci.yml/badge.svg)](https://github.com/0xsims/rubric-attest/actions/workflows/ci.yml)

Monorepo for the Rubric Decision Attestation system. See [`CLAUDE.md`](./CLAUDE.md)
for the build constitution (invariants) and [`tasks/`](./tasks) for the phased
plan.

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
| `tasks/` | Phase definitions `P0`–`P5`. |
| `.github/workflows/ci.yml` | Install + lint + typecheck + build + test, on every PR. |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release history (Keep a Changelog). |

## Invariants (see `CLAUDE.md`)

- **Hashing** SHA3-256 everywhere. **Canonicalization** JCS (RFC 8785).
  Canonicalize, then hash.
- **Record format** DAR/0.1 per `spec/dar-0.1.md`. Field set frozen; additive
  changes bump the minor.
- The SDK reads exactly one credential env var: `RUBRIC_API_KEY`.
- `attest()` never blocks the caller and never throws into app code; failures
  spool.

## SDK usage (`@0xsims/attest-decision`)

```ts
import { Attestor, HttpTransport } from "@0xsims/attest-decision";

const attestor = new Attestor({
  transport: new HttpTransport({ baseUrl: "https://attest.example" }), // reads RUBRIC_API_KEY
  spoolPath: "/var/lib/rubric/attest.spool",
});

// Fire-and-forget: returns immediately (<1 ms), never throws into app code.
attestor.attest({
  agentId: "agent://jev/pricing-v3",
  schema: pricingSchema, // hashed to schemaHash
  decision: { action: "approve", limitUsd: "2500.00" },
});
```

Records are appended to a durable spool (its parent directory is created if
missing) and flushed in batches (64 records or 5000 ms) with one POST per flush
to `/v1/tiered-attest`. A `kill -9` at any point loses zero spooled records — the
next process drains the spool on startup.

### Guarantees and limits

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
npm run test      # vitest run (resolves @0xsims/* to source via the dev condition)
npm run check     # lint + typecheck + test
```

This is an npm-workspaces monorepo; `npm install` at the root wires the packages
together. Each package publishes its built `dist/` (`exports` map with a
`development` condition that points tools at `src/` in this workspace); run
`npm run build` before publishing.
