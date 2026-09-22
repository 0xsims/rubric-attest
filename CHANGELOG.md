# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> The **DAR record format** is versioned independently of the packages. It is
> currently `DAR/0.1` (frozen); additive changes bump its minor, breaking changes
> its major. The package versions below do not track the record format version.

## [Unreleased]

### Added

- Tag-triggered npm release workflow (`.github/workflows/release.yml`): on a
  `v*` tag it verifies the tag matches the package version, runs lint + typecheck
  + test + build, and publishes `@0xsims/*` with npm provenance, using an
  `NPM_TOKEN` repository secret.

## [1.0.0] - 2026-09-22

First stable release, published under the `@0xsims/*` scope. Each package builds
to a consumable `dist/` (ES modules + `.d.ts`); a `prepublishOnly` hook rebuilds
`dist` on publish.

### Added

- **`@0xsims/attest-decision`** — core SDK: JCS (RFC 8785) canonicalization,
  SHA3-256 hashing, monotonic-ULID DAR/0.1 builder with per-agent `prev`
  chaining, fire-and-forget `attest()` (sub-millisecond, never throws into app
  code), batcher (64 records / 5000 ms, one POST per flush to
  `/v1/tiered-attest`), and a durable append-only spool (drain on recovery,
  50 MB drop-oldest cap).
- **`@0xsims/attest-index`** — SQLite day-shard index (WAL): idempotent
  backfill over a bundle store and a query lib (`byDecisionId`, `byAgentRange`,
  `byAgentSchema`, `chainHead`); `rubric-index-backfill` CLI.
- **`@0xsims/jev`** — Jev decision-shape adapter; all shape knowledge confined
  to one mapping file.
- **`@0xsims/schema`** — raw JSON Schema / Zod (via `zod-to-json-schema`)
  adapter producing DAR inputs.
- **`@0xsims/verify`** — `gate()`-fronted `/v1/x402/decision-verify` route:
  Merkle inclusion-proof verification, HCS anchor reference, signature result,
  drift flag, and chain-check continuity (forks rendered as branches).
- **`@0xsims/evidence`** — `rubric-evidence export` CLI: offline evidence
  bundles (DARs, proofs, anchor refs, continuity report, schema-change log) plus
  a plain-text summary, read directly from the index shards and bundle store.
- Cross-validation: JCS canonicalization and the full hash pipeline are verified
  byte-for-byte against an independent RFC 8785 implementation.

### Security & hardening

- JCS rejects integers beyond `Number.MAX_SAFE_INTEGER` (spec §3.3) and unpaired
  UTF-16 surrogates.
- Verifier enforces DAR versioning (spec §5.1: unknown major rejected, newer
  minor → `needs-upgrade`, no strip-and-rehash) and reports `consistencyVerified`
  — internal consistency only, **not** proof of on-chain anchoring or key trust.
- HTTP transport gained a request timeout and refuses a non-HTTPS `baseUrl`
  unless `allowInsecure` is set.
- Spool: full-write loop (no torn lines from short writes), directory `fsync`
  after compaction rename, durable ack watermark, and drop-oldest surfaced via
  `onError`.
- Attestor: bounded in-memory queue (`maxQueue`) and a decision-size cap
  (`maxDecisionBytes`) to keep `attest()` latency bounded.
- Evidence store reader contains reads within the store directory (path-traversal
  fix).
- Dependency tree has 0 known advisories.

### Notes & limitations

- Delivery is **at-least-once**; consumers must de-duplicate by `decisionId`.
- `prev` chaining is per producer process; multiple producers for one `agentId`
  form independent branches with no global sequencing.
- On-chain (HCS) anchoring and signature issuance are provided by a separate,
  out-of-scope service. This repository provides the client SDK, formats, index,
  adapters, an internal-consistency verifier, and the offline evidence CLI.

[Unreleased]: https://github.com/0xsims/rubric-attest/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/0xsims/rubric-attest/releases/tag/v1.0.0
