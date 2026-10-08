# Attestation index, replay verifier, and anchor drift check

Status: **draft** (design only, no code). Covers phases P6, P7 and P8; task
files are `tasks/P6-index.md`, `tasks/P7-replay.md`, `tasks/P7a-anchor-payers.md`,
`tasks/P8-drift-check.md`.

This spec records three closed decisions (§1) and the design details needed to
build them against the code as it exists today. §2 lists facts about the current
code that shape the design; every one has a file reference so it can be
re-checked. Paths starting `rubric-protocol/` are in the server repo; other
paths are in this repo (`rubric-attest`).

---

## 1. Closed decisions

| # | Decision |
|---|---|
| D1 | **Extend `packages/attest-index`; do not replace it.** Day-shard SQLite stays. Add a write-time hook on the rubric-protocol bundle write path so every bundle (not only DAR records) gets an index row. Extend the existing backfill CLI to cover all bundle types. |
| D2 | **Replay verifier is a standalone package with zero calls to our API.** It checks the ML-DSA-65 bundle signature against `https://rubric-protocol.com/.well-known/rubric-keys.json`, folds leaf → `aggregateRoot` using the `alg` block in the anchor message, then fetches the `RUBRIC_TIER2_ANCHOR` message for topic `0.0.10416909` from `mainnet-public.mirrornode.hedera.com` and matches `anchorId` and `aggregateRoot`. |
| D3 | **The drift check is a standalone script in this repo, not in rubric-assert.** It walks topic messages via the `prevAnchorId` chain. It flags chain gaps, anchors missing from the index, and index anchors missing from the mirror node. It ignores anchors younger than 10 minutes and exits nonzero on drift. A human wires it into rubric-assert. |
| D4 | **Anchor origin is decided by a pinned payer list (closes §6 O6).** Topic `0.0.10416909` has `submit_key: null` and `admin_key: null` on the mirror node, so it is immutable and a submit key can never be added. The replay verifier accepts only `RUBRIC_TIER2_ANCHOR` messages whose `payer_account_id` is in the pinned anchor-payer list, currently `0.0.3923341`. The list is published as `anchorPayers` in `https://rubric-protocol.com/.well-known/rubric-keys.json` (§2.6), and the verifier ships a hardcoded fallback. Messages from any other payer are ignored for verification. The drift check flags any message from an unpinned payer and any break in the `prevAnchorId` chain. |

Anything below that looks like it conflicts with D1–D3 is a refinement of how to
build them, not a change to them. Items that would need a format change are
listed in §6 as open decisions and are **not** decided here.

---

## 2. Current-state facts that shape the design

### 2.1 There is no single bundle write function

Each bundle type is written in a different place:

| Bundle type | Written at | Indexed today by |
|---|---|---|
| Tiered (default `/v1/tiered-attest`) | `rubric-protocol/src/verify/tiered-aggregator.ts` stubs `:321`, signed batch bundle `:404`, warm record per item `:424-455` | `appendIndexEntry` via `onTier1Flush` (`src/aggregator/index.ts:297-331`) — a Redis/legacy index, not attest-index |
| Tier-2 anchor bundle `<anchorId>.json` | `tiered-aggregator.ts:503-509` (`seqNum: null`) | none |
| Direct (`/v1/attest`) | `src/verify/attestation-publisher.ts:270` | `server.ts` `indexEntry()` `:307`, called `:692` |
| Threshold multisig | `src/api/threshold-endpoint.ts:494` | `appendIndexEntry` `:500` |
| DAR | `src/api/dar-emit.ts` `TieredDarTransport.store()` `:501` (pending), `Enricher.enrichOne` `:957-983` (completed) | attest-index, via offline backfill only (`deploy-bundle/run-backfill.mjs`) |

Anchoring runs in the separate `rubric-aggregator` process
(`ecosystem.config.cjs:84-118`, `src/aggregator/index.ts`), not in `server.ts`.
The anchor writer at `server.ts:2073-2117` is unreachable because `start()`
swaps in a Redis-stream shim (`server.ts:2249-2298`). **So the index has at
least two writer processes.**

### 2.2 The current index schema is DAR-only

`packages/attest-index/src/schema.ts`: `decisionId`, `agentId`, `schemaHash`
and `decisionHash` are `NOT NULL`. `decisionId` has a global unique index.
`rowFromBundle` reads `bundle.dar`, and the shard day comes from `dar.ts`. The
`IndexRow` type is imported by `packages/verify/src/ports.ts`,
`packages/evidence/src/adapters.ts`, and `chain-fix/chain-report.mjs`.

### 2.3 Some fields are only known after write time

| Field | Known when | Source |
|---|---|---|
| `attestationId` | write | `stub.attestationId` |
| `leafType` | write, nullable | `stub.leafType`. Free-form, ≤128 chars (`server.ts:2924`), **not signed**. DAR items carry none (`server.ts:2716`). DAR core has `decision`, `schema-change` or `checkpoint`. |
| `agentId` | write, nullable | `stub.complianceMeta.agentId` or `stub.sourceId`, DAR core `agentId` |
| namespace | write | Not a field anywhere. It only exists as the `ns_<12 hex>/` prefix on DAR agentIds (`src/billing/dar-namespace.ts:15`). |
| `decisionId` | write, DAR only | DAR bundle and `dar-ids/` binding (`dar-emit.ts:403, 519`). The tiered stub only carries `payload_commitment`. |
| `leafHash` | write | Tiered batch leaf `SHA-256(0x00 ‖ JCS(leafMessage))` (`tier1-worker.ts:142`). The DAR leaf is `sha3-256:` over JCS(core), per `spec/dar-0.1.md` §4.3. |
| `anchorId`, `aggregateRoot` | next tier-2 flush | `tiered-aggregator.ts:489-501` |
| HCS sequence | after submit | Redis `rubric:tier2:seq:*` (30-day TTL), tier-2 bundle `seqNum`, warm-record backfill (`aggregator/index.ts:68-82, 233-266`) |
| HCS consensus timestamp | **never recorded for tier-2** | `publishTier2Anchor` calls `getReceipt()`, not `getRecord()` (`attestation-publisher.ts:441-442`). `anchorConfirmedAt` is the local wall clock. Direct attestations do record it (`:254-267`). |

### 2.4 The anchor message

Built in `AttestationPublisher.publishTier2Anchor`
(`rubric-protocol/src/verify/attestation-publisher.ts:380-446`):

```ts
{ type: "RUBRIC_TIER2_ANCHOR", schemaVersion: "rubric-anchor/2", treeVersion: 3,
  alg: { canonicalization: "JCS/RFC8785", zk: "Poseidon2-BN254",
    levels: {
      batch:     { hash: "SHA-256",  domainSeparation: "RFC6962", merkleOdd: "promote" },
      aggregate: { hash: "SHA3-256", domainSeparation: "RFC6962", merkleOdd: "promote" },
      wrap:      { hash: "SHA3-256", domainSeparation: "none",    merkleOdd: "self-pair" } } },
  anchorId, aggregateRoot,
  zkAggregateRoot?, zkPayloadAggregateRoot?,
  tier1Count, totalItems,
  prevFederationSigHash?, prevAnchorId?,   // present together, or both absent
  anchoredAt }
```

* Batch roots are **not** on-chain. They exist only in the tier-2 anchor
  bundle's `tier1Flushes[].forestRoot` (`tiered-aggregator.ts:507`).
* `prevAnchorId` is emitted only when `prevFederationSigHash` is set
  (`:418`). That only happens when federation quorum was met, and the value is
  held in memory, so it resets on restart (`tiered-aggregator.ts:563`). The
  retry drainer drops both `prev*` fields (`aggregator/index.ts:370-383`).
* Messages of 1024 bytes or more are chunked (`setMaxChunks(20)`), and chunks
  can arrive out of order.

### 2.5 Merkle code in rubric-protocol (the reference implementation for P7)

Byte constructions. `‖` is byte concatenation and `hex()` is lowercase,
unprefixed hex.

| Level | Construction | Reference |
|---|---|---|
| batch leaf | `SHA-256(0x00 ‖ utf8(JCS(leafMessage)))` | `buildTieredLeafMessage` `spec-merkle.ts:52`, `leafHash()` `:73` |
| batch node | `SHA-256(0x01 ‖ L ‖ R)` over raw 32-byte digests. A lone node is promoted and adds **no** proof step. | `nodeHash()` `:80`, `buildSpecTree()` `:95`, `proofForLeaf()` `:114`, `verifyProof()` `:131` |
| batch root | The `buildSpecTree` root, as bare hex. It is the signed `envelope.batch_root`, and it is stored as `forestRoot` (`tier1-worker.ts:126-136`). | |
| aggregate leaf | `"sha3-256:" + hex(SHA3-256(utf8(JCS({__leafType:"DOCUMENT_HASH", forestRoot, itemCount}))))` | `makeLeafV2` `merkle.ts:74`, `hashData` `:52`; called at `tiered-aggregator.ts:494` |
| aggregate tree | Leaf tag: strip the `sha3-256:` prefix, then `SHA3-256(0x00 ‖ rawbytes)`. Node: `SHA3-256(0x01 ‖ L ‖ R)`. Odd node: promote. | `buildTreeV3()` `merkle.ts:207`. `buildTreeV2` (`:134`) is kept only for pre-RUBRIC-SEC-2026-001 anchors. |
| wrap | `aggregateRoot = hex(SHA3-256(utf8(hexRoot ‖ hexRoot)))`, which hashes the **128-character hex string**, not 64 raw bytes | `buildForest()` `merkle.ts:284` with one tree, `rawHash` `:58`; called at `tiered-aggregator.ts:500` |
| JCS | RFC 8785 | `canonicalize()` `src/verify/canonical.ts:33` |

The tier-1 batch bundle is signed with ML-DSA-65 over JCS of the **batch
envelope** `{rubric_version, attestation_type, batch_root, batch_size,
flush_id, issuer_node_region, issued_at}` (`tiered-aggregator.ts:372-382`,
`signCanonical`). The signature and the signer's `publicKey` (base64) are
copied onto every stub. Records do **not** carry a `keyId`.

Warm records store the leaf → batch-root proof as two arrays: sibling hashes in
`merkle_proof` and the `L`/`R` side of each step in `merkle_proof_directions`
(`tiered-aggregator.ts:436-437`). They also store the full `leafMessage`. **The
batch-root → aggregate path is not stored per record.**
`anchor-check.ts:107-125` rebuilds it from the tier-2 anchor bundle.

Retries can publish the same `anchorId` more than once: the retry drainer
re-publishes (`aggregator/index.ts:370-383`). rubric-protocol code never sets a
`submitKey` on the topic. The mirror node shows topic `0.0.10416909` with
`submit_key: null` and `admin_key: null`: the topic is immutable, a submit key
can never be added, and **anyone can post a message on it**. Origin is
therefore decided only by `payer_account_id` against the pinned anchor-payer
list (D4).

`packages/verify/src/merkle.ts` in this repo uses a different construction
(`rubric-merkle-node/1` domain, self-pair odd). **It is not `rubric-anchor/2`
and P7 must not reuse it.**

### 2.6 The keys file

Served as a static file by nginx (`ops/nginx-rubric-protocol.conf:487-492`) and
generated by `scripts/gen-rubric-keys.sh`. Shape:
`{format:"rubric-keys/1", updatedAt, signers:[{region, oracleId, keyId,
algorithm:"ML-DSA-65", publicKey, createdAt, rotatedAt}] ×5, attestation:{…,
verify}}`. It holds **one current key per region with no history**, and its own
`attestation.verify` points at our API.

D4 adds a top-level field `anchorPayers: ["0.0.3923341"]`: the Hedera account
IDs whose `RUBRIC_TIER2_ANCHOR` messages on topic `0.0.10416909` are genuine.
It is additive, so `format` stays `rubric-keys/1`. It is not live yet; adding
it is task `tasks/P7a-anchor-payers.md`. Until it is, consumers use their
hardcoded fallback (§4.3 step 5).

### 2.7 Mirror node usage today

Pagination is ad hoc. Only `server.ts:1580-1629` follows `links.next`, and
`anchor-check.ts` uses `mainnet.mirrornode.hedera.com`, not `-public`. There is
no shared client.

---

## 3. P6: Index for every bundle type

### 3.1 Schema v2

Bump the shard schema to version 2, tracked with `PRAGMA user_version`. Keep
the existing `attestations` table name, so readers that use the four existing
queries keep working.

```sql
CREATE TABLE attestations (
  attestationId   TEXT PRIMARY KEY,
  bundleKind      TEXT NOT NULL,     -- 'tiered' | 'direct' | 'threshold' | 'dar'
  leafType        TEXT,              -- as written; NULL if the bundle has none
  agentId         TEXT,              -- NULL if unknown
  namespace       TEXT,              -- 'ns_<12hex>' parsed from agentId, else NULL
  decisionId      TEXT,              -- DAR only
  schemaHash      TEXT,              -- DAR only
  decisionHash    TEXT,              -- DAR only
  prev            TEXT,              -- DAR only
  leafHash        TEXT NOT NULL,     -- leaf of the anchored batch tree, alg-prefixed
  darLeafHash     TEXT,              -- DAR core leaf (sha3-256:…), DAR only
  anchorId        TEXT,              -- NULL until the tier-2 flush
  aggregateRoot   TEXT,              -- NULL until the tier-2 flush
  hcsSequence     INTEGER,           -- NULL until known
  hcsConsensusTs  TEXT,              -- NULL until known; never wall clock
  ts              TEXT NOT NULL,     -- shard key, see 3.3
  bundlePath      TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_decisionId ON attestations(decisionId) WHERE decisionId IS NOT NULL;
-- existing ix_agent_ts, ix_agent_schema, ix_agent_decisionId, ix_agent_prev unchanged
CREATE INDEX ix_anchor    ON attestations(anchorId);
CREATE INDEX ix_ns_ts     ON attestations(namespace, ts);
CREATE INDEX ix_pending   ON attestations(ts) WHERE anchorId IS NULL OR hcsSequence IS NULL;

CREATE TABLE anchors (              -- one row per tier-2 anchor bundle
  anchorId        TEXT PRIMARY KEY,
  aggregateRoot   TEXT NOT NULL,
  prevAnchorId    TEXT,
  tier1Count      INTEGER,
  totalItems      INTEGER,
  anchoredAt      TEXT NOT NULL,     -- as in the message; shard key
  hcsSequence     INTEGER,
  hcsConsensusTs  TEXT,
  bundlePath      TEXT NOT NULL
);
```

Rules:

* **`leafHash` is always alg-prefixed** (`sha256:` for tiered batch leaves,
  `sha3-256:` where applicable). The two leaf constructions must never be
  compared unprefixed.
* **`hcsConsensusTs` only takes a consensus timestamp**: from `getRecord()` or
  from the mirror node. `anchorConfirmedAt` and other wall-clock values must
  not be written there.
* **Late fields can only be filled, never changed.** Upserts use
  `COALESCE(existing, new)` for `anchorId`, `aggregateRoot`, `hcsSequence` and
  `hcsConsensusTs`. If an incoming non-null value differs from a stored
  non-null value, the row is not changed and the write is reported as a
  conflict (drift evidence).
* **A DAR is also a tiered item.** If the DAR bundle and the tiered stub share
  an `attestationId`, they merge into one row: DAR columns come from the DAR
  bundle, anchor columns from whichever source has them. P6 step 1 confirms
  whether the IDs are shared. If they are not, the DAR row stores the tiered
  `attestationId` it was bridged into, in a new nullable `bridgedTo` column.

### 3.2 Migration and the TypeScript surface

* SQLite cannot drop `NOT NULL` in place. v1 → v2 is therefore a
  per-shard table rebuild inside one transaction: create
  `attestations_v2`, copy, drop, rename, then set `user_version = 2`.
  Existing v1 rows become `bundleKind = 'dar'`, with `leafHash` recomputed
  from the bundle by backfill (§3.5). Until then they hold the sentinel
  `'unknown'`.
* A shard opened read-only at v1 is still readable. A writer that finds v1
  migrates the shard, and a writer that finds a version above 2 refuses to
  write.
* **`IndexRow` keeps its current shape.** It stays the DAR row returned by
  `byDecisionId`, `byAgentRange`, `byAgentSchema` and `chainHead`, and those
  queries add `WHERE decisionId IS NOT NULL`. New types `AttestationRow` and
  `AnchorRow` cover the full columns. Downstream packages (`verify`,
  `evidence`, `chain-fix`) therefore compile unchanged, and the release is a
  minor bump.
* New queries: `byAttestationId`, `byAnchorId`, `anchorsInRange(from, to)`,
  `pending(olderThan)`.

### 3.3 Shard key per bundle type

| Bundle kind | `ts` (shard key) |
|---|---|
| dar | `dar.ts` (unchanged) |
| tiered | `leafMessage.issued_at` |
| direct | the attestation's issued time, as signed |
| threshold | the record's issued time, as signed |
| anchors table | `anchoredAt` from the anchor message |

The shard key is always a signed or anchored timestamp, never the time the
index row was written. The late-field updates in §3.4 find their row through
`byAttestationId` / `byAnchorId` across shards. Queries that start from an
anchor search shards from `anchoredAt − 1 day` to `anchoredAt`. Items are
anchored after their issue time, and the tier-2 flush interval is far below a
day.

### 3.4 Write-time hook

The hook is a port in attest-index, so the rubric-protocol side stays thin:

```ts
export interface IndexSink {
  bundleWritten(e: BundleWrittenEvent): void;         // fire-and-forget
  anchorWritten(e: AnchorWrittenEvent): void;         // tier-2 bundle written
  anchorConfirmed(e: { anchorId: string; hcsSequence: number; hcsConsensusTs?: string }): void;
}
export function createIndexSink(indexDir: string, opts?: { onError?(err: unknown, e: unknown): void }): IndexSink;
```

Call sites in rubric-protocol. Each one goes **after** the bundle file has been
durably written, and adds one call:

| Event | Call site |
|---|---|
| tiered `bundleWritten` | `onTier1Flush`, `src/aggregator/index.ts:297` (the full stub is available there) |
| threshold `bundleWritten` | `threshold-endpoint.ts:500`, next to `appendIndexEntry` |
| direct `bundleWritten` | `server.ts:692`, next to `indexEntry()` |
| dar `bundleWritten` | `dar-emit.ts:501` (pending) and `:957-983` (enriched) |
| `anchorWritten` | `tiered-aggregator.ts:503-509`, which also fills `anchorId` / `aggregateRoot` on that anchor's rows |
| `anchorConfirmed` | `aggregator/index.ts:233-266`, where the sequence number is learned |

Failure behaviour (normative):

1. **An index failure never fails, delays, or changes a bundle write or a
   signature.** The hook runs after the write, catches everything, and calls
   `onError`, which logs and increments a counter. It never rethrows.
2. The sink holds no lock across signing. SQLite busy time is bounded with
   `busy_timeout = 250 ms`. If it times out, the event is dropped and logged,
   and backfill repairs it.
3. Two processes write (§2.1). This relies on WAL plus `busy_timeout`, with
   no in-process cache of shard state that assumes a single writer
   (`Index.dayCache` must re-read the directory when a shard is missing).
4. **Recording the consensus timestamp at submit time is out of scope.**
   `publishTier2Anchor` stays on `getReceipt()`. Backfill fills
   `hcsConsensusTs` from the mirror (§3.5).

### 3.5 Backfill CLI

`rubric-index-backfill <bundle-store-dir> <index-dir> [--kinds dar,tiered,direct,threshold,anchor] [--mirror <base-url>] [--since <iso>]`

* It walks the store and recognises each bundle kind by shape. The recogniser
  is one function per kind, each with fixture tests. Files that are not
  bundles are counted as `skipped`, as today.
* Re-running is idempotent and follows the merge rules in §3.1. The result
  JSON adds `byKind: {kind: {files, written, failed, skipped}}` and
  `conflicts`.
* `--mirror` is an optional second pass. It fills `hcsSequence` and
  `hcsConsensusTs` for rows and anchors still missing them, from mirror-node
  topic messages matched on `anchorId`. Without `--mirror`, backfill makes no
  network calls.
* Backfill migrates v1 shards (§3.2) and replaces `leafHash = 'unknown'`.

---

## 4. P7: Replay verifier

### 4.1 Package and inputs

New package `packages/replay-verify`, published as
`@rubric-protocol/replay-verify`, with a `rubric-replay` bin. Its only runtime
dependencies are an ML-DSA-65 implementation (FIPS 204, the same library the
service signs with, or `@noble/post-quantum`, to be picked in P7 step 1 with
crypto review), a SHA-2/SHA-3 implementation, and a JCS implementation.
**It does not depend on any other `@rubric-protocol/*` package.** Verification
must not be able to pick up service code by accident.

```
rubric-replay --record <warm-record.json | dar-bundle.json>
              --anchor-bundle <anchorId>.json
              [--keys <rubric-keys.json>]     # offline / pinned keys; skips the fetch
              [--mirror <base-url>]           # default https://mainnet-public.mirrornode.hedera.com
              [--topic 0.0.10416909]
              [--json]
```

The verifier needs **two input files**, because the batch → aggregate path is
not stored per record (§2.5). Both files are supplied by the user; the verifier
never fetches them. Embedding that path in the record would be a format change;
see §6 O1.

### 4.2 Network allowlist (the "zero calls to our API" rule)

The verifier may make exactly these requests:

1. `GET https://rubric-protocol.com/.well-known/rubric-keys.json`, skipped
   when `--keys` is given. This is a static file, not the API.
2. `GET <mirror>/api/v1/topics/<topic>/messages…`, following `links.next`.

It must make no other requests. It does not read the topic's `submit_key`:
the topic is immutable with no key (D4). In particular it does not call `/v1/*`, does
not follow the keys file's `attestation.verify` link, and does not fall back to
`mainnet.mirrornode.hedera.com`. The allowlist is enforced in code: one
`fetch` wrapper rejects any other URL.

### 4.3 Steps

Each step yields `PASS`, `FAIL`, `UNSUPPORTED` or `UNAVAILABLE`, and the report
lists all of them. A step that cannot run is never reported as `PASS`.

The steps form one chain of bindings. Each value is checked against the one
before it, and **no step accepts a value only because it came from an input
file**. The signed envelope is the root of trust for everything below it, and
the anchor message is the root of trust for everything above it.

1. **Signature.**
   * The verification key comes **only** from the keys file. Select the
     signer whose `region` equals the signed `envelope.issuer_node_region`.
   * The record's embedded `publicKey` must be byte-identical to that signer's
     `publicKey`. If no signer matches, the step is `UNSUPPORTED` with reason
     `KEY_NOT_PUBLISHED`. This is expected after a rotation (§2.6), and it is
     not `FAIL`.
   * **The embedded `publicKey` is never used to verify on its own.**
     Otherwise any self-signed forgery would pass.
   * Verify ML-DSA-65 over the signed bytes for the bundle kind (§4.5).
2. **Leaf.**
   * Tiered: recompute `SHA-256(0x00 ‖ utf8(JCS(leafMessage)))` and compare it
     to the record's leaf.
   * DAR: recompute `sha3-256:` over JCS(core) (`spec/dar-0.1.md` §4.3), then
     follow the bridge hops (`dar-emit.ts:960-976`) to the tiered leaf.
3. **Leaf → signed batch root.**
   * Fold the leaf using `merkle_proof` (sibling hashes) and
     `merkle_proof_directions` (`L`/`R`). The node rule is the `batch` level
     (§2.5). If the two arrays differ in length, the step is `FAIL`.
   * The result MUST equal the signature-verified `envelope.batch_root`.
     Comparing it to a root from any other source is not enough.
   * Exactly one `anchorBundle.tier1Flushes[]` entry MUST have
     `flushId === envelope.flush_id`, `forestRoot === envelope.batch_root` and
     `itemCount === envelope.batch_size`. Anything else is `FAIL`.
4. **Batch roots → aggregateRoot.**
   * Rebuild the aggregate tree from `tier1Flushes[]` in bundle order, using
     the `aggregate` level with leaves built exactly as `makeLeafV2` (§2.5).
   * Apply `wrap` (§2.5).
   * The result is the computed `aggregateRoot`. `anchorBundle.aggregateRoot`
     is only a hint and is not trusted; step 5 checks the computed value.
5. **Anchor message.**
   * **Message origin.** The topic has no submit key and never can (D4), so
     origin rests on the payer alone. The check runs **per chunk, before
     reassembly**: a chunk counts only if its `payer_account_id` is in the
     pinned anchor-payer list and, when `chunk_info` is present, equals the
     account in `chunk_info.initial_transaction_id`. A single-part message
     with no `chunk_info` needs only the pinned-payer check. Every other chunk
     is discarded first, and
     messages are rebuilt from the remaining chunks only. A forged chunk
     that claims a genuine message's `initial_transaction_id` is therefore
     dropped and cannot spoil the genuine message. Messages from any other
     payer are ignored for verification: they are not matched, not counted
     as duplicates, and cannot cause a `FAIL`. If no message is left, the
     step is `UNSUPPORTED` with reason `ANCHOR_ORIGIN_UNVERIFIED`, never
     `PASS`.
   * **The pinned list.** Taken from the keys file's `anchorPayers` (§2.6),
     from the fetched file or from `--keys`. Only a **missing** key means
     the verifier uses its hardcoded fallback, currently `["0.0.3923341"]`.
     Any other value must be an array of strings, each matching
     `^0\.0\.[0-9]+$`. Otherwise (`null`, a string, numbers, a checksum
     suffix) step 5 is `UNSUPPORTED` with reason `ANCHOR_PAYERS_INVALID`,
     with no fallback. A valid array is used as-is and the fallback is not
     merged in; an empty array leaves no genuine payer. Matching against
     `payer_account_id` is exact string equality. The report states which
     source was used.
   * **Locating the message.**
     * Find every `RUBRIC_TIER2_ANCHOR` message whose `anchorId` matches. Use
       the record's `anchors.hcs.sequence_number` as a starting point if
       present, and search `anchoredAt ± 15 min` regardless, so that
       duplicates are seen.
     * Reassemble chunks that passed the origin check by
       `initial_transaction_id` and chunk number.
     * Only messages rebuilt that way count. A message that still lacks any
       chunk `1..total` after foreign chunks are dropped does not count.
   * **Duplicates.** Retries can produce several messages with the same
     `anchorId` (§2.5). All of them MUST carry the same `aggregateRoot`;
     conflicting roots are `FAIL` (`DUPLICATE_ANCHOR_CONFLICT`). Report the
     earliest `consensus_timestamp`.
   * **Format.** Require `schemaVersion = "rubric-anchor/2"`,
     `treeVersion = 3`, and an `alg.levels` block deep-equal to §2.4. Anything
     else is `UNSUPPORTED`; the verifier does not guess an older construction.
   * **Match.** The message's `anchorId` must equal the anchor bundle's, and
     its `aggregateRoot` must equal the value computed in step 4.
   * **Report.** Return `consensus_timestamp`, `sequence_number` and
     `payer_account_id` from the mirror.

The tree code is driven by the `alg` block: a level spec selects the
hash/domain/odd-handling implementation. It is not hard-coded to the current
values, but only the three level specs in §2.4 are implemented.

### 4.4 Output and exit codes

| Exit | Meaning |
|---|---|
| 0 | every step `PASS` |
| 1 | at least one `FAIL` (tamper or mismatch) |
| 2 | usage / unreadable input |
| 3 | no `FAIL`, at least one `UNSUPPORTED` |
| 4 | no `FAIL`, at least one `UNAVAILABLE` (keys or mirror unreachable) |

`--json` prints `{ verdict, steps: [{name, status, detail}], anchor: {anchorId,
aggregateRoot, sequenceNumber, consensusTimestamp, payerAccountId, topic,
mirror}, anchorPayers: {source: "keys-file" | "fallback", accounts} }`. The report always includes the topic ID. If `--topic` is not
`0.0.10416909`, the verdict detail says so in every output mode.

### 4.5 Signed message per bundle kind

* **Tiered:** ML-DSA-65 over `utf8(JCS(envelope))` with the envelope from
  §2.5, the signature hex-encoded and `publicKey` base64-encoded
  (`tiered-aggregator.ts:372-394`). P7 step 1 confirms the exact bytes
  `signCanonical` signs (any context string or prehash) and records them here.
* **DAR, direct, threshold:** *to be filled in by P7 step 1*, with references
  to the rubric-protocol signing code. Only `tiered` and `dar` are in scope for
  P7.

---

## 5. P8: Drift check

### 5.1 Location and interface

`tools/drift-check/drift-check.mjs` in this repo. It depends on
`@rubric-protocol/attest-index` (workspace) for read-only index access and on
nothing else from the service.

```
drift-check --index <index-dir>
            [--mirror <base-url>] [--topic 0.0.10416909]
            [--since <iso> | --state <file>]   # resume point; default: last 24 h
            [--min-age 600]                    # seconds; anchors younger are ignored
            [--anchor-payer <account-id>]...   # pinned anchor payers (D4); default: the P7 fallback list
            [--json]
```

It opens the index with `{ readonly: true }`. It makes no writes, except the
`--state` file, and no calls to our API. It does not fetch the keys file:
without `--anchor-payer` it uses the same hardcoded list as the P7 fallback,
currently `0.0.3923341`. If `--anchor-payer` is given, it replaces the default.
Each value must match `^0\.0\.[0-9]+$`, or the run exits 2.

### 5.2 Walk

1. Enumerate all messages on the topic from the resume point, ordered by
   `sequence_number`, following `links.next`.
2. Apply the P7 origin check per chunk, before reassembly (§4.3 step 5).
   Report each failing chunk on its own as `FOREIGN_PAYER`, whatever its
   type, and drop it. Then reassemble messages from the remaining chunks only,
   so a forged chunk never removes a genuine message. Keep only
   `RUBRIC_TIER2_ANCHOR` messages; other types from pinned payers are ignored.
3. Drop anchors whose mirror `consensus_timestamp` is under `--min-age` old.
4. Walk backward via `prevAnchorId` from each anchor that has one. Because of
   §2.4, an anchor without `prevAnchorId` is a **segment start**, not a gap.
   The walk resumes from the next-older anchor by sequence.

### 5.3 Findings

| Code | Condition | Drift? |
|---|---|---|
| `CHAIN_GAP` | `prevAnchorId` names an anchorId with no pinned-payer message on the topic (searching back past the window as needed). A link to an anchorId found only in `FOREIGN_PAYER` messages is a gap. | **yes** |
| `CHAIN_FORK` | two anchors name the same `prevAnchorId` | **yes**, once O3 is resolved; a warning until then |
| `SEGMENT_START` | anchor has no `prevAnchorId` | no, counted and reported |
| `MISSING_FROM_INDEX` | anchor on the mirror (≥ min-age) with no `anchors` row | **yes** |
| `MISSING_FROM_MIRROR` | `anchors` row with `anchoredAt` ≥ min-age old and no matching mirror message | **yes** |
| `ROOT_MISMATCH` | same `anchorId`, different `aggregateRoot` (index vs mirror) | **yes** |
| `DUPLICATE_ANCHOR` | several mirror messages share an `anchorId`, all with the same `aggregateRoot` (retry) | no, a warning |
| `DUPLICATE_ANCHOR_CONFLICT` | several mirror messages share an `anchorId` with different `aggregateRoot`s | **yes** |
| `FOREIGN_PAYER` | any message or chunk on the topic, of any type, whose `payer_account_id` is not in the pinned anchor-payer list (D4) or, when `chunk_info` is present, differs from the account in its `initial_transaction_id`. One finding per chunk. Excluded from all chain and index checks; it never removes a genuine message. | **yes** |
| `INDEX_PENDING` | index anchor matched on the mirror but `hcsSequence` is NULL in the index | no, a warning (backfill `--mirror` fixes it) |

Messages are attributed to an `anchorId` by message content. For
`MISSING_FROM_MIRROR`, a mirror message within the window must match on both
`anchorId` and `aggregateRoot`.

### 5.4 Exit codes

| Exit | Meaning |
|---|---|
| 0 | no drift findings |
| 1 | at least one drift finding |
| 2 | usage / index unreadable |
| 3 | mirror unreachable or incomplete (pagination broke, 429 after retries); **not** reported as drift |

Mirror access uses exponential backoff on 429/5xx, at most 5 retries per page.

---

## 6. Open decisions (not decided here)

These need a decision before the phase that depends on them. Per CLAUDE.md,
O1 and O2 go to the board subagent, since they change published formats.

| # | Question | Blocks |
|---|---|---|
| O1 | Should records embed the batch → aggregate path and `anchorId`, so P7 can verify from one file? | P7 single-file mode only; P7 as specified works without it |
| O2 | Should the keys file get an append-only key history and an on-chain hash of each key set (the `trust-anchor.json` model)? Without it, bundles signed before a rotation report `KEY_NOT_PUBLISHED`, and trust in the keys file reduces to TLS on rubric-protocol.com. | P7 verifying rotated keys |
| O3 | Do several regional aggregators publish to topic `0.0.10416909`? If yes, what is the chain key (the anchor message carries no region)? | P8 `CHAIN_FORK` as drift |
| O4 | Should `publishTier2Anchor` move to `getRecord()` so the consensus timestamp is recorded at submit? (Today `/v1/verify` reports the wall-clock `anchorConfirmedAt` as `consensus_timestamp`, `server.ts:1332-1333`.) | nothing in P6–P8; tracked as a separate finding |
| O5 | Should the retry drainer keep `prevFederationSigHash`/`prevAnchorId` (`aggregator/index.ts:370-383`)? Today a retry creates a `SEGMENT_START`. | nothing; reduces P8 noise |
| O6 | **Closed, see D4.** The topic has `submit_key: null` and `admin_key: null` (immutable, no key ever). Origin is a pinned payer list, currently `0.0.3923341`, published as `anchorPayers` in the keys file, with a hardcoded fallback in the verifier. Board review of the published field is part of `tasks/P7a-anchor-payers.md`. | — |

---

## 7. Sequencing

* **P7 does not depend on P6** and can start first, or run in parallel.
* **P8 depends on P6**, because it needs the `anchors` table.
* P6 changes rubric-protocol hot paths. Its rubric-protocol PR follows that
  repo's CLAUDE.md, including tests against the compiled build.

Reviews per phase: `crypto` for P7 and for the P6 hook placement,
`spec-guardian` for anything touching DAR, and `safety-reviewer` before every
commit.
