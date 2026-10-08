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

> Batch ingest is in limited rollout. Request access: Scott@Rubric-Protocol.com

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
  spool. The one exception is an invalid `agentId` (`AgentIdError`), a mistake
  at the call site that no retry could fix.

## SDK usage (`@rubric-protocol/attest-decision`)

```ts
import { Attestor, HttpTransport } from "@rubric-protocol/attest-decision";

const attestor = new Attestor({
  transport: new HttpTransport({ baseUrl: "https://rubric-protocol.com" }), // reads RUBRIC_API_KEY
  spoolPath: "/var/lib/rubric/attest.spool",
  namespace: "ns_<12 hex>", // your key's namespace; see "Namespaces" below
  // mode: "payload",  // optional — also ship raw content in the transport envelope; default is "hash-only"
  onError: (err) => logger.warn(err), // optional; defaults to console.warn
});

// Fire-and-forget: returns immediately (<1 ms). The DAR core is hashes-only:
// schema, input and output are hashed, never carried raw.
const decisionId = attestor.attest({
  agentId: "loan-bot", // sent as "<namespace>/loan-bot", prefixed before hashing
  schema: {                                             // hashed to schemaHash
    type: "object",
    properties: { action: { enum: ["approve", "decline"] }, limitUsd: { type: "string" } },
    required: ["action"],
  },
  input: { applicantId: "app-1042", requestedUsd: "2500.00" }, // hashed to inputHash
  output: { action: "approve", limitUsd: "2500.00" },           // hashed to outputHash
});
// Keep decisionId with your own record of the decision: it is how you verify it.
```

Records are appended to a durable spool (its parent directory is created if
missing) and flushed in batches (64 records or 5000 ms) with one POST per flush
to `/v1/tiered-attest`. A `kill -9` at any point loses zero spooled records — the
next process drains the spool on startup.

### Namespaces

Batch ingest requires every `agentId` to live in your API key's **namespace**:
`ns_<12 hex>/<name>`. The namespace is a random public id Rubric assigns to your
key when batch ingest is enabled for it; get it from the dashboard or from the
operator who enabled the key, and pass it as `namespace`. The SDK then prefixes
each `agentId` you pass to `attest()` (`"loan-bot"` becomes
`"ns_…/loan-bot"`) **before** building the record, because `agentId` is inside
the hashed core: a record can never be re-prefixed afterwards. An `agentId` that
already carries your prefix is kept as is.

- **The configured value is authoritative.** Every server response carries the
  key's `namespace`, and the SDK only checks it. If a response disagrees (or the
  server answers `403 NAMESPACE_UNAVAILABLE`), that server node is
  misconfigured: the Attestor stops building and sending, keeps every record,
  reports a `NamespaceMismatchError` through `onError`, and retries the same
  batch with backoff (5 times over about 10 minutes by default:
  `namespaceRetries`, `namespaceRetryMs`). If it still disagrees, the error is
  `fatal` and the Attestor stays stopped until the node or your configuration
  is fixed and the process restarted. Nothing is dropped; records passed to
  `attest()` meanwhile are held in memory.
- **`namespace: "discover"`** is for when you don't have the value yet: before
  building anything, the SDK sends empty handshake batches (free) until three
  consecutive answers agree, then uses that value and persists it next to the
  spool (`namespacePath`). `attest()` calls are held in memory until then. The
  explicit option is the safe path: discovery could, in principle, pin a
  misconfigured node's value, and a record built with a wrong prefix can never
  be repaired.
- **`agentId` rules** are checked in `attest()`, which throws `AgentIdError` if
  the full id (prefix included) is outside `^[A-Za-z0-9._:/@-]{1,200}$` or is
  reserved for Rubric (`rubric`, `rubric:…`, `rubric/…`, `rubric-…`, …).
- **426 Upgrade Required.** The server requires SDK 1.2.0 or later (the SDK
  sends `x-rubric-sdk: attest-decision/<version>`). Older SDKs get `426`, keep
  their batches spooled, and report the minimum version through `onError`.
- **Rejected records.** A `200` can list records the server will never store
  (`rejected`, each with a `reason`); they are reported through `onError` as a
  `BatchRejectedError`, never dropped silently. Other responses (`403`, `425`,
  `426`, `429`, `503`, `507`, network errors) keep the batch and retry it, and
  are reported through `onError` with the server's message.
- **Upgrading from 1.1.0:** records already in a 1.1.0 spool were built
  without the prefix. They cannot be re-prefixed, so the server rejects them
  (`agentId_namespace`) and they are reported as rejected.

### Verifying a decision

Store the `decisionId` returned by `attest()` with your own record of the
decision, and verify with it:
`POST https://rubric-protocol.com/v1/x402/decision-verify` with `{ "decisionId": "…" }`.

Do not verify by `decisionHash`. A decision hash covers the schema, input and
output, not who made the decision, so many records can share one. Lookup by
`decisionHash` covers only records Rubric's own decision-review service issues,
and returns 404 for yours.

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
