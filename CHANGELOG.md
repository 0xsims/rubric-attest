# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> The **DAR record format** is versioned independently of the packages. It is
> currently `DAR/0.1` (frozen); additive changes bump its minor, breaking changes
> its major. The package versions below do not track the record format version.

## [Unreleased]

## [1.2.0] - 2026-09-25

Namespace-aware batch ingest. Batch ingest (`POST /v1/tiered-attest` with
`{ records }`) now requires every `agentId` to be `<namespace>/<name>`, where the
namespace (`ns_<12 hex>`) is a random public id the server mints onto the API key,
and answers **426 Upgrade Required** to SDKs before 1.2.0.

### Added

- **`@rubric-protocol/attest-decision`: `AttestorOptions.namespace`.** An explicit
  `ns_<12 hex>` (recommended) makes `attest()` prefix each `agentId` with
  `<namespace>/` **before** the DAR is built, so the prefix is inside the hashed
  core. An `agentId` already carrying that prefix is kept; one carrying another
  namespace throws. Built or spooled DARs are never rewritten.
- **The configured namespace is authoritative; responses only check it.** When a
  response's `namespace` differs, or the server answers `403
  NAMESPACE_UNAVAILABLE`, the Attestor stops building and sending, keeps every
  record, reports a `NamespaceMismatchError`, and retries the same batch with
  doubling backoff (`namespaceRetries`, default 5; `namespaceRetryMs`, default
  20 s, about 10 min in all). If the node still disagrees the error is `fatal` and
  the Attestor stays stopped. It never drops, re-prefixes, or adopts the other
  value. A later agreeing answer resumes it. Records passed to `attest()` while
  paused are held in memory (bounded by `maxQueue`), keep the `decisionId` and
  time of the `attest()` call, and are built on resume.
- **Opt-in `namespace: "discover"`.** Sends free empty-batch handshakes until
  three consecutive answers agree (`DISCOVERY_AGREEMENT`), then uses the value and
  persists it at `namespacePath` (default `${spoolPath}.namespace`), so a restart
  does not rediscover. `attest()` calls are held in memory meanwhile; `ready()`
  resolves when the namespace is known.
- **`x-rubric-sdk: attest-decision/<version>`** on every batch POST
  (`SDK_NAME`, `SDK_VERSION`, `SDK_VERSION_HEADER`).
- **Responses are parsed.** `Transport.send()` may now resolve a `SendResult`
  (`namespace`, `accepted`, `rejected`); returning nothing is still valid for
  custom transports. A non-2xx rejects with a `TransportError` (`status`, `code`,
  `namespace`, `retryAfterMs`) whose message is the server's own `error` and
  `hint` (for 426, also the minimum version). `425 Retry-After` is honoured.
- **Rejected records are reported.** Records a `200` lists in `rejected` are
  final and go to `onError` as a `BatchRejectedError` with each `reason`; an
  `agentId_namespace` reject names the namespace to configure.
- `validateAgentId`, `AgentIdError`, `DarBuilder.build(input, { decisionId, at })`,
  `Attestor.getNamespace()`, `Attestor.ready()`.

### Changed

- **`attest()` throws `AgentIdError`** when the full `agentId` (prefix included)
  is outside the server's rules: `^[A-Za-z0-9._:/@-]{1,200}$`, and not Rubric's
  reserved `rubric` / `rubric` + `:` `/` `_` `.` `@` `-`. Such records used to be
  rejected under a 200 and lost; now the mistake fails where it is made.
  `DarBuilder.build` enforces the same rules. Every other failure still goes to
  `onError`, and `attest()` still never throws for them.
- **Rubric's internal emitters must set `allowReservedAgentIds: true`** (on the
  `Attestor` or `DarBuilder`) to keep using `rubric://…` agentIds.
- **Without `onError`, failures go to `console.warn`**, never silently.
- `pendingCount()` includes records held in memory.
- All six packages bumped to 1.2.0.

### Upgrading

- Pass your key's `namespace`. Records spooled by 1.1.0 were built without the
  prefix and cannot be repaired: the server rejects them (`agentId_namespace`) and
  1.2.0 reports them through `onError`.
- Verify customer DARs by the `decisionId` that `attest()` returns. Lookup by
  `decisionHash` covers only DARs from Rubric's own decision-review service.

## [1.1.0] - 2026-09-23

### Added

- **`@rubric-protocol/attest-decision`: shared chain-head store (`chainStore`).**
  New optional `AttestorOptions.chainStore` takes a `ChainHeadStore`. With a store
  configured, the Attestor reads each record's `prev` from the store and writes
  the new head back, under a per-agent lock held across build, spool and head
  write. Several processes (pm2 workers) and restarts then extend **one linear
  chain per `agentId`**, rather than one chain per process and a new genesis on
  each restart. `prev` semantics are unchanged (spec/dar-0.1.md §2).
- `FileChainHeadStore`: a one-host, multi-process implementation using a directory
  with one `<sha3-256(agentId)>.head` file per agent (atomic tmp+fsync+rename) and
  an O_EXCL `.lock` file. A lock whose pid is dead, or that is older than
  `staleLockMs` (10 s), is broken.
- `DarBuilder.build(input, { prev })`: an optional explicit `prev`.

### Behavior with a store

- **Fallback on contention or store failure: skip, never fork.** If the lock isn't
  acquired within `lockTimeoutMs` (250 ms), or the head file can't be read or
  written, `attest()` returns `null`, spools nothing, and reports a
  `ChainHeadStoreError` (`code: "lock-timeout" | "io"`) to `onError`. It still
  never throws. A corrupt head file fails closed the same way; it never restarts
  the chain at a new genesis.
- An empty store is seeded from this process's own head (its spool-recovered or
  earlier record) and otherwise starts at genesis.
- On recovery, if the store head still equals the last spooled record's `prev`
  (a crash between spool append and head write), the head is moved forward to
  that record.
- `attest()` costs a lock plus an fsync'd head write, so it is no longer under
  1 ms. This is intended for low-traffic routes.
- Known limit: if a lock holder stalls inside its critical section for longer than
  `staleLockMs`, its lock can be broken and a fork is possible.

### Unchanged

- With no `chainStore`, output is byte-identical to 1.0.1 (tested against
  `DarBuilder` directly).
- All six packages bumped to 1.1.0 for a uniform `--workspaces` publish.

## [1.0.1] - 2026-09-23

### Fixed / release

- **1.0.0 was a partial release.** The `v1.0.0` tag published five packages
  (`attest-decision`, `attest-index`, `jev`, `schema`, `evidence`), but
  `@rubric-protocol/verify` collided with a pre-existing, unrelated npm package
  (a different `2.3.1` lineage), so this repo's verify package did not publish and
  `evidence@1.0.0` shipped with an unsatisfiable `verify` dependency.
- **Renamed** this repo's verify package to `@rubric-protocol/decision-verify`
  (the `@rubric-protocol/verify` name is taken). Imports, inter-dep ranges, and
  docs updated.
- **Bumped all six packages to 1.0.1** for a clean, uniform republish (the 1.0.0
  versions are burned on npm). `evidence@1.0.1` depends on
  `@rubric-protocol/decision-verify@^1.0.1`.

### Changed (DAR/0.1 preimage)

- **Hashes-only DAR core.** Removed `decision` from the core; added required
  `inputHash` and `outputHash`; `decisionHash` is now `SHA3-256(JCS({ schemaHash,
  inputHash, outputHash }))`. Added optional core fields `schemaRef` and
  `adapter`. Adapters' `toDecision()` now returns `{ schema, input, output, meta }`.
  Raw content is transmitted only in `mode: "payload"` (transport envelope) —
  default is hash-only, and the core never carries content. `ts` is documented
  as client-claimed (trusted time is the HCS consensus timestamp). Tag stays
  `DAR/0.1` because nothing was published under the old preimage.

### Added

- Tag-triggered npm release workflow (`.github/workflows/release.yml`): on a
  `v*` tag it verifies the tag matches the package version, runs lint + typecheck
  + test + build, and publishes `@rubric-protocol/*` with npm provenance, using an
  `NPM_TOKEN` repository secret.

## [1.0.0] - 2026-09-22

First stable release, published under the `@rubric-protocol/*` scope. Each package builds
to a consumable `dist/` (ES modules + `.d.ts`); a `prepublishOnly` hook rebuilds
`dist` on publish.

### Added

- **`@rubric-protocol/attest-decision`** — core SDK: JCS (RFC 8785) canonicalization,
  SHA3-256 hashing, monotonic-ULID DAR/0.1 builder with per-agent `prev`
  chaining, fire-and-forget `attest()` (sub-millisecond, never throws into app
  code), batcher (64 records / 5000 ms, one POST per flush to
  `/v1/tiered-attest`), and a durable append-only spool (drain on recovery,
  50 MB drop-oldest cap).
- **`@rubric-protocol/attest-index`** — SQLite day-shard index (WAL): idempotent
  backfill over a bundle store and a query lib (`byDecisionId`, `byAgentRange`,
  `byAgentSchema`, `chainHead`); `rubric-index-backfill` CLI.
- **`@rubric-protocol/jev`** — Jev decision-shape adapter; all shape knowledge confined
  to one mapping file.
- **`@rubric-protocol/schema`** — raw JSON Schema / Zod (via `zod-to-json-schema`)
  adapter producing DAR inputs.
- **`@rubric-protocol/decision-verify`** — `gate()`-fronted `/v1/x402/decision-verify` route:
  Merkle inclusion-proof verification, HCS anchor reference, signature result,
  drift flag, and chain-check continuity (forks rendered as branches).
- **`@rubric-protocol/evidence`** — `rubric-evidence export` CLI: offline evidence
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
