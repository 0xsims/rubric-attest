# Attestation index, replay verifier, and anchor drift check

Status: **draft**. P6 is built (rubric-protocol anchor links and mirror
backfill behind a default-off flag; attest-index 1.3.0 ingest). P7 is built
as `packages/replay-verify`, package `@tenprint/verify` (unreleased; §4.5 and
O8 settled by P7 step 1).
The decision-verify step and P8 are design only. Covers phases P6, P7 and P8; task
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
| D1 | *Superseded by D5.* It was: extend `packages/attest-index` with a write-time hook so every bundle gets an index row. |
| D2 | **Replay verifier is a standalone package with zero calls to our API.** It checks the ML-DSA-65 bundle signature against `https://rubric-protocol.com/.well-known/rubric-keys.json`, folds leaf → `aggregateRoot` using the `alg` block in the anchor message, then fetches the `RUBRIC_TIER2_ANCHOR` message for topic `0.0.10416909` from `mainnet-public.mirrornode.hedera.com` and matches `anchorId` and `aggregateRoot`. |
| D3 | **The drift check is a standalone script in this repo, not in rubric-assert.** It walks topic messages via the `prevAnchorId` chain. It flags chain gaps, anchors missing from the index, and index anchors missing from the mirror node. It ignores anchors younger than 10 minutes and exits nonzero on drift. A human wires it into rubric-assert. |
| D4 | **Anchor origin is decided by a pinned payer list (closes §6 O6).** Topic `0.0.10416909` has `submit_key: null` and `admin_key: null` on the mirror node, so it is immutable and a submit key can never be added. The replay verifier accepts only `RUBRIC_TIER2_ANCHOR` messages whose `payer_account_id` is in the pinned anchor-payer list, currently `0.0.3923341`. The list is published as `anchorPayers` in `https://rubric-protocol.com/.well-known/rubric-keys.json` (§2.6), and the verifier ships a built-in list, which is the trust root: the published field never widens or shrinks it unless the user pins a keys file with `--keys` (§4.3 step 5). Messages from any other payer are ignored for verification. The drift check flags any message from an unpinned payer and any break in the `prevAnchorId` chain. |
| D5 | **The canonical write-time index is the existing `attestation-index.jsonl`**, written by `rubric-protocol/src/api/index-writer.ts` (about 105k rows, read by the auditor, export, telemetry, credentials and reputation endpoints). Do not add a new write hook and do not create a third index. When the anchor job anchors, it appends an anchor-link record to the same jsonl (`id`, `anchorId`, `aggregateRoot`, HCS sequence, consensus timestamp). Anchor-link lines are append-only: nothing rewrites or removes them. Attestation lines are not strictly append-only today, because `reconcile-rt.py` rewrites their `rt` field (§3.1, O7). Historical anchors get anchor-links backfilled from the mirror node. `packages/attest-index` ingests from the jsonl, so decision-verify reads the same data. See §3. |

Anything below that looks like it conflicts with D2–D5 is a refinement of how to
build them, not a change to them. Items that would need a format change are
listed in §6 as open decisions and are **not** decided here.

---

## 2. Current-state facts that shape the design

### 2.1 There is no single bundle write function

Each bundle type is written in a different place:

| Bundle type | Written at | Indexed today by |
|---|---|---|
| Tiered (default `/v1/tiered-attest`) | `rubric-protocol/src/verify/tiered-aggregator.ts` stubs file `stubs-<flushId>.json` `:347-348`, batch envelope signed `:400-409`, signed batch bundle `:412-431`, warm record per item `:457-519` | the jsonl (§3.1), via `appendIndexEntry` in `onTier1Flush` (`src/aggregator/index.ts:139-159`) |
| Tier-2 anchor bundle `<anchorId>.json` | `tiered-aggregator.ts:563-569` (`seqNum: null`; federation block patched in later, `:620-623`) | none (P6 adds anchor-link lines to the jsonl) |
| Direct (`/v1/attest`) | `src/verify/attestation-publisher.ts:270` | the jsonl, via `server.ts` `indexEntry()` `:307`, called `:692` |
| Threshold multisig | `src/api/threshold-endpoint.ts:494` | the jsonl, via `appendIndexEntry` `:500` |
| DAR | `src/api/dar-emit.ts` `TieredDarTransport.store()` `:501` (pending), `Enricher.enrichOne` `:957-983` (completed) | the jsonl as its tiered stub; attest-index via offline backfill only (`deploy-bundle/run-backfill.mjs`) |

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
| `anchorId`, `aggregateRoot` | next tier-2 flush | `tiered-aggregator.ts:549-561` |
| HCS sequence | after submit | Redis `rubric:tier2:seq:*` (30-day TTL), tier-2 bundle `seqNum`, warm-record backfill (`aggregator/index.ts:68-82, 233-266`) |
| HCS consensus timestamp | **never recorded for tier-2** | `publishTier2Anchor` calls `getReceipt()`, not `getRecord()` (`attestation-publisher.ts:448-449`). `anchorConfirmedAt` is the local wall clock. Direct attestations do record it (`:254-267`). |

### 2.4 The anchor message

Built in `AttestationPublisher.publishTier2Anchor`
(`rubric-protocol/src/verify/attestation-publisher.ts:388-454`; the `alg`
block is `:397-414`). The serialized message is `JSON.stringify` of the object
below in this key order (not JCS); verifiers parse it and never re-serialize it.
`anchoredAt` here is `new Date()` at publish time (`:427`), so it is later than
the tier-2 bundle's `anchoredAt` (flush time, `tiered-aggregator.ts:550`), by
minutes for a retry:

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
  bundle's `tier1Flushes[].forestRoot` (`tiered-aggregator.ts:567`).
* `prevAnchorId` is emitted only when `prevFederationSigHash` is set
  (`:426`). That only happens when federation quorum was met, and the value is
  held in memory, so it resets on restart (`tiered-aggregator.ts:122-123,
  624`). The retry drainer drops both `prev*` fields (`aggregator/index.ts:217-231`).
* Messages of 1024 bytes or more are chunked (`setMaxChunks(20)`), and chunks
  can arrive out of order. `TopicMessageSubmitTransaction.execute()` returns
  `executeAll()[0]`, so the receipt's `topicSequenceNumber` (what the anchor
  job records) is **chunk 1's** sequence number (`@hashgraph/sdk`
  `lib/topic/TopicMessageSubmitTransaction.js`).
* **The `alg` block on the mirror is not always the one above** (checked
  2026-10-09 against the public mirror, P6 step 1). Messages up to about
  2026-08-11T11:00Z (for example sequences 286821–286823) carry
  `schemaVersion: "rubric-anchor/2"`, `treeVersion: 3` and a flat block
  `{leaf, node, aggregate, zk, canonicalization, domainSeparation: "RFC6962",
  merkleOdd: "duplicate"}` with no `levels`. That label does not describe the
  code (neither `buildTreeV2` nor `buildTreeV3` duplicates an odd node); it is
  most likely a stale label over V3, but that is unconfirmed. P6 step 1 also
  reported later messages (from sequence 286834) whose levels carry
  descriptive keys (`leaf`, `node`, `leafPre`, `rule`) beyond `{hash,
  domainSeparation, merkleOdd}`. rubric-protocol `main` (54afb5a1) does **not**
  emit that variant: it emits exactly the block above
  (`attestation-publisher.ts:397-414`), and the latest message checked (seq
  309191, 2026-10-10) appears to carry it too. The descriptive-keys variant is
  unconfirmed. **O8 is closed (P7 step 1):** v1 of the replay verifier accepts
  only the block above, compared as a whole (§4.3 step 5, Format); the flat
  block is `UNSUPPORTED` (`ALG_LEGACY_FLAT`) and every other shape is
  `UNSUPPORTED` (`ALG_UNSUPPORTED`). A variant is added only with a real
  fixture whose root it recomputes. P6 does not read `alg`.

### 2.5 Merkle code in rubric-protocol (the reference implementation for P7)

Byte constructions. `‖` is byte concatenation and `hex()` is lowercase,
unprefixed hex.

| Level | Construction | Reference |
|---|---|---|
| batch leaf | `SHA-256(0x00 ‖ utf8(JCS(leafMessage)))` | `buildTieredLeafMessage` `spec-merkle.ts:52-67`, `leafHash()` `:73-77`; computed `tier1-worker.ts:98-119` |
| batch node | `SHA-256(0x01 ‖ L ‖ R)` over raw 32-byte digests. A lone node is promoted (`:103`) and adds **no** proof step (`:122`). A direction names the **sibling's** side: `"L"` → `H(0x01 ‖ sib ‖ acc)`, `"R"` → `H(0x01 ‖ acc ‖ sib)`. | `nodeHash()` `:80`, `buildSpecTree()` `:95`, `proofForLeaf()` `:114`, `verifyProof()` `:131` |
| batch root | The `buildSpecTree` root, as bare hex. It is the signed `envelope.batch_root`, and it is stored as `forestRoot` (`tier1-worker.ts:126-136`). | |
| aggregate leaf | `"sha3-256:" + hex(SHA3-256(utf8('{"__leafType":"DOCUMENT_HASH","forestRoot":"<hex>","itemCount":<int>}')))`, i.e. JCS of `{__leafType, forestRoot, itemCount}`. `flushId` is the leaf label only and is **not** hashed. | `makeLeafV2` `merkle.ts:74-76`, `hashData` `:52-55`; called at `tiered-aggregator.ts:553-555` |
| aggregate tree | Leaf tag: strip up to the last `:` (`:214`), then `SHA3-256(0x00 ‖ 32 raw bytes)` (`:218`). Node: `SHA3-256(0x01 ‖ L ‖ R)` (`:221`). Odd node: promote (`:236`). With one flush the root is the **tagged** leaf. | `buildTreeV3()` `merkle.ts:207`; called at `tiered-aggregator.ts:559`. `buildTreeV2` (`:134`) is kept only for pre-RUBRIC-SEC-2026-001 anchors. |
| wrap | `aggregateRoot = hex(SHA3-256(utf8(hexRoot ‖ hexRoot)))`, which hashes the **128-character hex string**, not 64 raw bytes. Always applied (one tree is padded to `[r, r]`, `:286`). | `buildForest()` `merkle.ts:284-291` with one tree, `rawHash` `:58-60`; called at `tiered-aggregator.ts:560-561` |
| JCS | RFC 8785: keys sorted by UTF-16 code units, numbers `String(n)`, only `"`, `\` and U+0000–U+001F escaped | `canonicalize()` `src/verify/canonical.ts:33` |

The tier-1 batch bundle is signed with ML-DSA-65 over JCS of the **batch
envelope** `{rubric_version, attestation_type, batch_root, batch_size,
flush_id, issuer_node_region, issued_at}` (`tiered-aggregator.ts:400-409`,
`signCanonical`). The signature and the signer's `publicKey` (base64) are
copied onto every stub (`:435-438`). Records do **not** carry a `keyId`. The
exact bytes are in §4.5.

Warm records store the leaf → batch-root proof as two arrays: sibling hashes in
`merkle_proof` and the `L`/`R` side of each step in `merkle_proof_directions`
(`tiered-aggregator.ts:477-478`). They also store the full `leafMessage`. **The
batch-root → aggregate path is not stored per record.**
`src/api/anchor-check.ts:107-125` rebuilds it from the tier-2 anchor bundle.

Retries can publish the same `anchorId` more than once: the retry drainer
re-publishes (`aggregator/index.ts:217-231`). rubric-protocol code never sets a
`submitKey` on the topic. The mirror node shows topic `0.0.10416909` with
`submit_key: null` and `admin_key: null`: the topic is immutable, a submit key
can never be added, and **anyone can post a message on it**. Origin is
therefore decided only by `payer_account_id` against the pinned anchor-payer
list (D4).

`packages/verify/src/merkle.ts` in this repo uses a different construction
(`rubric-merkle-node/1` domain, self-pair odd). **It is not `rubric-anchor/2`
and P7 must not reuse it.**

### 2.6 The keys file

Served as a static file by nginx (`ops/nginx-rubric-protocol.conf:485-490`).
**The source of truth is `.well-known/rubric-keys.json` in the rubric-web
repo**, which `deploy-site.sh` rsyncs to `/var/www/rubric` with `--delete`.
`rubric-protocol/scripts/gen-rubric-keys.sh` predates that, produces a
different file, and is disabled (P7a board ruling, 2026-10-10). Shape:
`{version, format:"rubric-keys/1", updatedAt, note, signers:[{region,
oracleId, keyId, algorithm:"ML-DSA-65", standard, securityLevel, publicKey,
createdAt, rotatedAt, status?}], attestation:{attestationId, payloadSha3,
covers:"signers", verify}}`.

* **It keeps some key history.** Since rubric-web `0fa4b87` (2026-10-08) it
  lists one current key per region plus a retired `legacy-shared-2026h1` entry
  per region (`status: "retired"`, `rotatedAt: "2026-06-15T00:00:00.000Z"`),
  so a region can have more than one signer. §4.3 step 1 must handle that.
  There is no general history mechanism or on-chain hash of each key set yet
  (O2).
* **The attestation covers `signers` only.** `payloadSha3` is SHA3-256 of the
  compact JSON `signers` array. Every other field, `anchorPayers` included, is
  unattested and is trusted only through TLS on rubric-protocol.com.
* Its own `attestation.verify` points at our API.

D4 adds a top-level field `anchorPayers: ["0.0.3923341"]`: the Hedera account
IDs whose `RUBRIC_TIER2_ANCHOR` messages on topic `0.0.10416909` are genuine.
It is additive, so `format` stays `rubric-keys/1`. Adding it is task
`tasks/P7a-anchor-payers.md`; it is not live until a human deploys rubric-web.

* **Append-only.** Payers are only ever added, never removed or reordered.
  Removing one would leave its historical anchors unverifiable.
* A plain string carries no validity window, so responding to a compromised
  payer needs a format change (`rubric-keys/2` with time bounds), which goes to
  the board.
* The list must change together in three places: the rubric-web file, the P7
  built-in list (§4.3 step 5), and the P8 `--anchor-payer` default (§5.1).
* **It does not replace the built-in list.** The verifier's built-in list is
  the trust root, and the fetched field can only produce warnings or
  `UNSUPPORTED` (§4.3 step 5). Otherwise a compromise of the web host could
  swap both the signer keys and the payer and still get a `PASS`.

### 2.7 Mirror node usage today

Pagination is ad hoc. Only `server.ts:1580-1629` follows `links.next`, and
`anchor-check.ts` uses `mainnet.mirrornode.hedera.com`, not `-public`. There is
no shared client.

---

## 3. P6: One index, the attestation jsonl

D5 replaces the design that used to be here (schema v2 for every bundle kind,
an `IndexSink` write hook with six call sites, and an `anchors` table). None of
that is built. P6 adds anchor links to the existing jsonl, backfills them from
the mirror, and makes attest-index ingest the jsonl.

### 3.1 The jsonl as it is today

* **Path:** `/mnt/tempus-attestation-store/bundles/attestation-index.jsonl`.
  It has about 105k lines, one JSON object per line, in the `MinimalIndexEntry`
  shape (`rubric-protocol/src/api/index-writer.ts:9-35`):
  `id, ts, src, pip, fr, ph, rt, seq, batch, n, leafTypes, sig, algo`, the
  compliance-meta fields, and `agentId`. **It has no `attestation_type`, no
  DAR fields (`decisionId`, `decisionHash`, `prev`), and no anchor fields.**
  Tiered lines are written at tier-1 time with `seq: null` and `fr: ''`.
* **Writers:**

  | Writer | Path | How |
  |---|---|---|
  | `appendIndexEntry` (`index-writer.ts:43-96`) | tiered stubs per tier-1 flush (`aggregator/index.ts:297-311`, rubric-aggregator process); threshold (`threshold-endpoint.ts:500`) | `appendFileSync`, one line per call |
  | `indexEntry` → `saveQueryIndex` (`server.ts:307`, `:287-305`) | direct (`server.ts:692`); tiered stubs on the server path (`server.ts:2207`) | buffered, up to 500 lines per async `fs.appendFile` (`:261-284`) |

  So **at least two processes append to the file**. `attest-worker.ts:90-103`
  appends to a different file (`attestation-store/attestation-index.jsonl`
  relative to the build). That file is not the canonical index and P6 does
  not touch it.
* **Readers** (all in `rubric-protocol/src/api/`): `auditor-endpoint.ts:94`,
  `export-endpoint.ts:28`, `telemetry-endpoint.ts:23`,
  `credentials-endpoint.ts:72`, `reputation-route.ts:486`,
  `incident-endpoint.ts:39`, `filing-endpoint.ts:32`,
  `board-report-endpoint.ts:20`, `jurisdiction-endpoint.ts:96`,
  `regulatory-monitoring-endpoint.ts:187`, `server.ts:201-211` (tail of 5000
  lines). Plus `retention.py` (never deletes the file, `:11`) and
  `reconcile-rt.py`. **None of them filters by record type.** Every parsed line
  is treated as an attestation. `export-endpoint.ts:37-38` even keeps a line
  whose `ts` does not parse, because `NaN` comparisons are false.
* **Not strictly append-only today.** `reconcile-rt.py:39-63` rewrites the
  `rt` field of earlier lines, writes a temp file, and `os.replace`s the
  index. Its flock (`:18-21`) is not taken by the writers. So a line appended
  between the tail read (`:60-61`) and the replace (`:63`) is lost. See §6 O7.

### 3.2 The anchor-link record

One line per covered attestation per anchor message:

```json
{"kind":"anchor-link","v":1,"id":"<attestationId>","anchorId":"<anchorId>",
 "aggregateRoot":"<hex>","topic":"0.0.10416909","hcsSequence":"<n>",
 "hcsConsensusTs":null,"source":"anchor-job","writtenAt":"<wall clock>"}
```

`id`, `anchorId`, `aggregateRoot`, `hcsSequence` and `hcsConsensusTs` are the
link. `kind` lets readers tell it apart from attestation lines. `source` is
`anchor-job` or `backfill-mirror`. `writtenAt` is the writer's wall clock when
the line was appended. It is used only as an age for P8's `--min-age` on the
index side, and it is never a consensus or anchored time. The link carries no
`anchoredAt`: the anchor job never learns the message's own `anchoredAt`
(`attestation-publisher.ts:419`, and `publishTier2Anchor` returns only the
sequence number).

Rules:

* **Append-only.** A link line is never rewritten or removed, by P6 code or
  by `reconcile-rt.py`. A value learned later is a new line, not an edit.
* **Merge rule for readers.** Group link lines by `(id, anchorId,
  hcsSequence)`. Only these fields are merged: `aggregateRoot`, `topic` and
  `hcsConsensusTs`. For each of them, the first non-null value in file order
  wins. A later non-null value that differs is a **conflict**. It is
  reported, it does not change the merged result, and it is drift evidence.
  `v`, `source` and `writtenAt` are per-line metadata. They are never merged
  and never conflict; a group's age is its earliest `writtenAt`.
* **Retries.** The retry drainer can publish one `anchorId` more than once
  (§2.5). A first submit can also reach consensus while its receipt fails, so
  the anchor job never links it, and only the retry is linked. One `(id,
  anchorId)` can therefore have several `hcsSequence` groups, and they can
  appear in any order (for example S2 from the retry, then S1 from the
  backfill). **The attestation's anchor is the set of all its groups.** No
  group is preferred, and a new group is never a conflict on its own. But
  the groups of one `(id, anchorId)` must agree on `aggregateRoot` and
  `topic`: retries re-publish the same anchor, so groups that disagree are a
  **conflict** (as `DUPLICATE_ANCHOR_CONFLICT` is on the mirror, §4.3).
  Where one value is needed for display, use the lowest sequence, computed
  fresh from the whole set every time.
* **Malformed link lines fail closed.** A `kind: "anchor-link"` line whose
  `anchorId` or `hcsSequence` is missing or malformed, but whose `id` is a
  string, is a conflict for that `id`, so a row is never read as cleanly
  anchored, or as unanchored, from a link set it could not fully read.
* **One anchor per attestation.** Links from one `id` to two different
  `anchorId`s are a conflict.
* **`hcsConsensusTs` is only a consensus timestamp**, from the mirror or
  `getRecord()`. It is never wall-clock time. The anchor job only has
  `getReceipt()` (§2.3), so it writes `null`, and the mirror backfill (§3.4)
  appends the value later. §6 O4 would let the anchor job write it directly.
* **`hcsSequence` is a decimal string**, as `index-writer.ts` stores `seq`.
* **Only genuine anchors.** Backfill links only messages that pass the D4
  origin rule (§4.3 step 5).

Reader compatibility (normative, and it **ships before the first link line is
written**):

* Every reader listed in §3.1 treats a line with no `kind` as an attestation.
  It skips any other `kind`. One helper does this
  (`isAttestationLine(rec) = rec.kind === undefined`) and every reader calls
  it.
* `reconcile-rt.py` passes every line that has a `kind` field through
  byte-identical, before it looks at `id`. Today it would add `rt` to a link
  line (`:42-47`), because the line's `id` matches a bundle file.
* `server.ts:216-221` loads the tail into `attestationQueryIndex` keyed by
  `id`. A link line there would replace the real entry, so this reader uses
  the filter too.
* The filter assumes that no line has a `kind` key today. P6 step 1 confirms
  this with a read-only count on production, run by a human. The count must
  be 0.
* **Growth.** About one extra line per tiered attestation per genuine
  sequence, plus one more from the backfill when the anchor-job line has
  `hcsConsensusTs: null`. So the file roughly triples for tiered traffic.
  `auditor-endpoint.ts:95`, `credentials-endpoint.ts:73` and
  `reputation-route.ts:486` `readFileSync` the whole file per request. P6
  step 1 measures their latency on a synthetic file 3× the production line
  count and size (no production data copied), and records it in the PR. P6 does not change those readers beyond the filter.
  (Separately from P6, rubric-protocol #58 later moved every reader onto the
  shared non-blocking `index-reader.ts`; see §3.6.)

### 3.3 Write at anchor time

The anchor job is `tier2HCSWriter` (`aggregator/index.ts:232-295`). Once
`publishTier2Anchor` has returned the sequence number (`:243`), the job
already loops over the anchor's `flushId`s (`:253-259`) and reads each
`WARM_STORE/bundles/stubs-<flushId>.json` in `backfillWarmAnchors`
(`:101-118`). That stub file is the only place in scope with the covered
attestation ids (`Tier2Anchor` has none, `tiered-aggregator.ts:71-82`).

* In that loop, append one anchor-link line per stub `attestationId`, with
  `source: "anchor-job"`. The retry drainer re-anchors through the same
  `backfillWarmAnchors` call (`aggregator/index.ts:389`), so it writes links
  the same way, with its own `hcsSequence`.
* Write each flush's lines with **one append call per ≤ 64 KiB of whole
  lines**, through a single new function `appendAnchorLinks` in
  `index-writer.ts`. It uses the same `INDEX_PATH` and no other file.
* **Non-fatal.** A failure is caught, logged and counted. It never fails,
  delays or changes the anchor message, the anchor bundle, the warm-record
  pointers or any signature. The HCS submit has already happened when the
  links are written.
* **A missing stub file** is counted (`linksSkippedNoStub`, next to the
  existing `skippedNoStub`, `:102-110`), and backfill repairs it from warm
  records (§3.4).
* No new write hook anywhere else, and no new file. Tier-1, direct and
  threshold lines keep their current writers and shapes.
* *As built:* the env flag is `RUBRIC_ANCHOR_LINKS_ENABLED`, on only when it
  is exactly `true`; the aggregator logs its state at start-up and the stats
  endpoint reports it with the counters (`linksAppended`,
  `linksSkippedNoStub`, `linksSkippedForeign`, `linkErrors`). A stub id
  whose warm record is another flush's, or whose stub names another flush or
  batch root, gets no link. `INDEX_PATH` has a test-only override,
  `RUBRIC_INDEX_WRITER_PATH_FOR_TESTS`, that is ignored when
  `NODE_ENV=production`; the aggregator logs the resolved path at start-up. `backfillWarmAnchors` moved to
  `src/aggregator/warm-backfill.ts` unchanged, so the compiled build can be
  tested (importing `aggregator/index.ts` starts the process). Links are
  written after the warm pointers. A receipt with no sequence (`"unknown"`)
  writes no link and counts an error. `appendAnchorLinks` does not check the
  flag, so the backfill script can use it.

### 3.4 Historical backfill from the mirror

`scripts/anchor-links-backfill.mjs` in rubric-protocol, next to the writer,
so it reuses `appendAnchorLinks`:

```
anchor-links-backfill --store /mnt/tempus-attestation-store
                      [--mirror https://mainnet-public.mirrornode.hedera.com]
                      [--topic 0.0.10416909] [--since <iso>]
                      [--anchor-payer <acct>]...   # default: the D4 list
                      [--apply]                    # default is a dry run
```

1. Page all topic messages (follow `links.next`, 429/5xx backoff, at most 5
   retries per page). Apply the D4 origin rule per chunk, reassemble, and
   keep `RUBRIC_TIER2_ANCHOR` messages.
2. **Validate before any path is built.** The message's `anchorId`, and
   later each `tier1Flushes[].flushId`, must match the lowercase UUID form
   `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`. Both are
   `randomUUID()` (`tiered-aggregator.ts:167, 489`). A value that does not
   match is counted as `badId`, and nothing is read or written for it. Every
   joined path is `resolve`d and must stay under the hot, warm or cold store
   root, as `loadBundle` does (`decision-verify-route.ts:84-85`). Then find
   `<anchorId>.json` (the tier-2 anchor bundle) in those stores. **Link only if the bundle's `aggregateRoot`
   equals the message's.** A mismatch is reported and nothing is written.
3. Get the covered attestation ids for each `tier1Flushes[].flushId`. Use
   `stubs-<flushId>.json` if it still exists. Otherwise use warm records
   whose anchor pointer names that `flushId`. Ids that cannot be resolved are
   counted per anchor and never guessed.
4. Append a link line with `source: "backfill-mirror"`, carrying the mirror's
   `sequence_number` and `consensus_timestamp`. **Idempotent:** skip it if
   the merged group `(id, anchorId, hcsSequence)` already has every field
   non-null and equal. If an anchor-job line exists with
   `hcsConsensusTs: null`, the backfill line is what fills it.
5. Print JSON counts: `anchors`, `linksAppended`, `alreadyPresent`,
   `unresolvedIds`, `noBundle`, `rootMismatch`, `badId`, `conflicts`.

Without `--apply`, it writes nothing and prints the same counts. It contacts
only the mirror host. It runs while the writers run, so it follows the same
append rules as §3.3.

As built (P6):

* A chunked message is linked under chunk 1's `sequence_number` and
  `consensus_timestamp`, matching the anchor job's receipt (§2.4). The
  message is only complete once its last chunk reaches consensus, so chunk
  1's time can be earlier than the full commitment; P7 and P8 must use the
  same chunk-1 rule. Today's anchors fit one chunk.
* **Binding before linking.** Beyond the root check: the message's
  `tier1Count` and `totalItems` must match the bundle's flush list and its
  `itemCount` sum (else `rootMismatch`). Each id is linked only if its stub
  names this flush (`tier1FlushId`) and its batch root (`batchRoot`, legacy
  `forestRoot`) equals the flush's `forestRoot`, and, when its warm record
  exists, that record is this flush's (`belongsToFlush`) and any
  `anchors.hcs.anchor_id` it carries is this anchor. In the warm-record
  fallback the record's signed `tier1.envelope` must name the flush and its
  `batch_root` must equal `forestRoot`. Ids that fail are counted in
  `notThisFlush` and never linked. The anchor job applies the same stub and
  warm-record rule (`linksSkippedForeign`). Verifying signatures and leaf
  proofs is left to P7.
* `retention.py` moves every file in `bundles/` (tier-2 bundles and
  `stubs-*.json` included) to `warm/` after 2 h, to `cold/` after 7 days,
  and archives it to S3 and removes it after 90 days. So `<anchorId>.json`
  and `stubs-<flushId>.json` are looked up in hot, warm and cold, in that
  order. The warm-record fallback scans `warm/` and `cold/` for tiered
  records whose `stub.tier1FlushId` (or `stub.flushId`) names the flush and
  whose file name is `<stub.attestationId>.json`. Anchors past 90 days are
  `noBundle` or `unresolvedIds` until an S3 path is added.
* `unresolvedIds` for a flush is its `itemCount` minus the ids resolved.
* A link that would conflict (the id already links to another `anchorId`,
  or the group holds a different non-null value) is counted in `conflicts`
  and **not appended**; `conflicts` also counts conflicts already in the
  file. The output lists each one.
* A mirror failure stops the run before anything is written (exit 3).
* `--apply` refuses a `--store` whose jsonl is not `INDEX_PATH`, because
  `appendAnchorLinks` writes only `INDEX_PATH`.

### 3.5 attest-index ingests the jsonl

attest-index stays the day-shard SQLite cache that decision-verify queries
(`decision-verify-route.ts:25, 126-143`). It stops being a separate source of
anchor data. Its anchor columns come only from the jsonl.

* **Schema v2 is additive.** `ALTER TABLE attestations ADD COLUMN` for
  `anchorId`, `aggregateRoot`, `hcsSequences` (a JSON array of decimal
  strings, ascending, one per group in §3.2), `hcsConsensusTs` (that of the
  lowest sequence, or NULL) and `anchorConflict` (0/1), all nullable, with
  `PRAGMA user_version = 2`. There is no
  table rebuild and no new table. `IndexRow` keeps its shape, the four
  existing queries keep their signatures, and a new `AnchoredRow` type
  extends it. A writer refuses a shard whose `user_version` is above 2. A
  read-only v1 shard is still queryable.
* **`rubric-index-ingest <attestation-index.jsonl> <bundle-store> <index-dir>`.**
  * It streams the jsonl, opened once and read to EOF so that an `os.replace`
    mid-read cannot mix files. It ignores a trailing partial line.
  * DAR rows are still built by `rowFromBundle` from the DAR bundle, because
    the jsonl has no DAR fields. The anchor columns are filled from the
    merged anchor-link groups (§3.2) for that row's tiered attestation id.
  * Non-DAR attestation lines are counted, not stored. The jsonl is their
    index.
  * **Anchor columns are derived, not fill-only.** On every ingest they are
    recomputed from the whole merged anchor-link set for the row (§3.2), so
    they always equal what the jsonl says. A new retry group extends
    `hcsSequences`, and does not conflict. A §3.2 conflict (two `anchorId`s,
    or a field conflict) sets `anchorConflict = 1` and is reported. In that
    case the columns hold the first-written values and are not trusted.
    A row whose link set gained a line is recomputed in full.
  * It writes a resume cursor `{line, id}` after each run. If the line at
    the cursor no longer has that `id`, it re-ingests from the start, which
    is idempotent. Line numbers are stable across `reconcile-rt.py`, which
    keeps line count and order.
  * *As built:* every run reads the whole jsonl (one open, to EOF) and
    recomputes the anchor columns of every DAR row from the full link set,
    writing a row only when its columns change. So correctness never depends
    on the cursor; it records progress (`newLines`) and detects a replaced
    file (`fullReingest`). The cursor `id` is that of the last complete line.
    Groups of one `(id, anchorId)` that disagree on `aggregateRoot` or `topic`
    across sequences also set `anchorConflict = 1`. DAR rows are built from
    the bundles by the same walk as `rubric-index-backfill`.
  * It never writes the jsonl.
* **The DAR ↔ tiered id.** *Answered in P6 step 1: they share it, so there is
  no `bridgedTo` column and anchor links join on the row's `attestationId`.*
  `TieredDarTransport.store()` writes the pending bundle with
  `attestationId` set to the tiered id it POSTed (`dar-emit.ts:493-498`).
  `Enricher.enrichOne` refuses a bundle whose `attestationId` differs from
  `extensions.rubricDar.tiered.attestationId` (`:885`) and writes the
  completed bundle with `attestationId: tiered.attestationId` (`:958`).
* **Reattest is the exception, and the row does not follow it by itself.**
  An operator reattest (decision-review DARs only, `dar-emit.ts:1004`)
  rewrites the bundle's `attestationId` to a new tiered id with the same
  `decisionId` (`:1014`). Ingest and backfill upsert on `attestationId`, so
  the new row breaks the unique `decisionId` index, is counted in `failed`,
  and the old row stays, keyed on the old tiered id, with that id's anchor
  links. The operator must delete the old row first, as the reattest log
  line already says (`:1020-1021`, DEPLOY.md "stalled bundles"). **Before
  the decision-verify 503 ships**, either ingest replaces a row in place when
  the existing row for that `decisionId` has the same `bundlePath`, or the
  route treats a `failed` reattested row as unknown. Otherwise a reattested
  DAR whose old POST lands later gets a permanent false 503.
* **decision-verify reads the same data.** `decision-verify-route.ts` reads
  the row's anchor columns through a new `byDecisionIdAnchored` query, in
  the lookup block that runs before `gate()` (`:120-147`). Then:
  * Both sides are compared as canonical decimal strings: `anchorRef.sequenceNumber`
    may be a number (`dar-emit.ts:961`), and it is converted with
    `String(BigInt(x))`. A value that is not a non-negative integer counts as
    a mismatch.
  * If `hcsSequences` is set and the bundle's `anchorRef.sequenceNumber` is
    **not one of them**, or if `anchorConflict = 1`, the route returns
    `503 {error: "anchor record conflict", decisionId, note: "payment not
    settled"}` before `gate()`. That matches the existing pre-gate 503s
    (`:123`, `:141`), so it never charges (rubric-protocol CLAUDE.md, paid
    x402 routes).
  * A retry-anchored DAR whose `anchorRef` records any one of the
    sequences passes.
  * If `hcsSequences` is NULL (no links yet), the route behaves exactly as
    today.
  * `anchorRef.root` is the DAR leaf L, not the `aggregateRoot`
    (`dar-emit.ts:961-969`), so it is never compared with the index
    `aggregateRoot`.
  * The success response shape does not change.
* The existing `rubric-index-backfill` bin keeps working. It never writes
  the anchor columns.
* *As built:* the existing queries select the v1 columns explicitly, so their
  rows keep exactly the v1 keys on a v2 shard. A rubric-protocol still on
  attest-index 1.0.x uses `SELECT *` and sees the extra columns once ingest
  has run; its `chainCheck` output carries only ids and counts, so no
  response changes.

### 3.6 P6 step 1 answers (2026-10-09)

| Question | Answer |
|---|---|
| DAR ↔ tiered id | Shared `attestationId`; no `bridgedTo` (§3.5). |
| Filesystem of `/mnt/tempus-attestation-store`; `O_APPEND` ≤ 64 KiB interleave | **Open: needs a human on the host** (`findmnt -no FSTYPE /mnt/tempus-attestation-store`). Not in the repo. On a local filesystem, two processes appending 10k attestation lines and ≥10k link lines each produced no torn or interleaved line (rubric-protocol `tests/anchor-links/concurrent.test.mjs`). If the mount is NFS or another network filesystem, stop. |
| Readers and writers of the jsonl | In rubric-protocol, matches §3.1. Every reader in `src/api/` reads through `index-reader.ts` (rubric-protocol #58) or calls `isAttestationLine` (`server.ts:224`); `tests/index-readers/readers.test.mjs` fails the build for any new file that names the jsonl without one of them. Writers: `index-writer.ts` (`appendIndexEntry`, now `appendAnchorLinks`), `server.ts` `saveQueryIndex`, `reconcile-rt.py` (rewrite, passes link lines through). `retention.py` never touches it. `attest-worker.ts` writes a different file. Cron (`ops/crontab-us.txt`) runs `retention.py` and `reconcile-rt.py` from `/root/tempus`. **Not verifiable from the repo:** `/root/rubric-backup-v2.sh`, `/root/rubric-stats.py`, `/root/rubric-tracker/*`, `/root/rubric-assert/run.sh`, `/root/tempus/reconcile-anchors.mjs`, `/root/health-monitor.sh`. A human checks each for reads of the jsonl that do not skip `kind` lines. |
| Warm-record pointer to its flush | `stub.tier1FlushId` (`tier1-worker.ts:135`), with `stub.flushId` as the older fallback (`warm-anchor-guard.ts`). The record's own `anchors.hcs` holds `sequence_number` and `anchor_id`, not the flush. |
| Non-UUID `anchorId` on the mirror | **0** of 35,813 `RUBRIC_TIER2_ANCHOR` messages (35,800 distinct `anchorId`s, 13 retried once). Scanned all 309,001 messages (sequences 1–309,001) on `mainnet-public` on 2026-10-09. No chunk came from a payer other than `0.0.3923341`; 23 chunked messages are incomplete on the mirror (10-chunk messages, type unknown); 27,292 messages have no `type`; those sampled (sequences 10140–10164) are direct attestations (`attestation_type: "direct"`), an inference for the rest. `prevAnchorId`: 0 non-UUID. `flushId`s are not on-chain; counting them needs the store (the backfill dry run reports `badId`). |
| Lines with a `kind` key in production | **Open: a human runs the read-only count; it must be 0.** |
| Latency of the three whole-file readers at 3× size | Measured and recorded in rubric-protocol #55; those readers moved to the non-blocking `index-reader.ts` in #58. |

---

## 4. P7: Replay verifier

### 4.1 Package and inputs

New package `packages/replay-verify`, published as `@tenprint/verify` (name
decided by the operator, 2026-10-10; npm org `tenprint`), with a
`tenprint-verify` bin. Its only runtime
dependency is `@noble/post-quantum`, pinned to exactly `0.3.0`, the library and
version the service signs with (`rubric-protocol/package.json:25`,
`oracle.ts:177-192`; picked in P7 step 1 with crypto review). Verification
calls `ml_dsa65.verify(publicKey, msg, sig)` (that argument order in 0.3.0,
empty context), never `ml_dsa65.internal.verify`, and a throw counts as an
invalid signature. An upgrade is gated on a committed known-answer vector,
because later versions may change the argument order. SHA-256 and SHA3-256
come from `node:crypto`; JCS is a small in-package implementation with the
semantics of `canonical.ts`.
**It does not depend on any `@rubric-protocol/*` or other `@tenprint/*` package.** Verification
must not be able to pick up service code by accident.

`--record` is either a **tiered warm record** (`<attestationId>.json` from the
warm or cold store, §3.4; a file holding a JSON array is accepted only if
exactly one element is a tiered record, `warm-backfill.ts:104-112`) or a
**completed DAR bundle** (`decisions/<day>/<decisionId>.json`). Anything else,
or a file that is not JSON, exits 2.

```
tenprint-verify --record <warm-record.json | dar-bundle.json>
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
not follow the keys file's `attestation.verify` link, does not request the
topic itself (`/api/v1/topics/<topic>`), and does not fall back to
`mainnet.mirrornode.hedera.com`. The allowlist is enforced in code: one
`fetch` wrapper rejects any other URL.

*As built (P7):* request 2 is only the list form
`GET <mirror>/api/v1/topics/<topic>/messages?<query>` (a `sequencenumber`
range around a hint, or a `timestamp` window), and each `links.next`, which
is resolved against the mirror origin and checked again. The by-sequence
form `/messages/<seq>` is not used and is rejected. Requests are `GET` with
`redirect: "error"`, so a redirect cannot leave the allowlist. `--mirror` must
be `https`, and `mainnet.mirrornode.hedera.com` or any `rubric-protocol.com`
host is refused as a mirror (exit 2). A 429, 5xx or network error is retried
with exponential backoff, at most 5 retries per page; then the step is
`UNAVAILABLE`.

### 4.3 Steps

Each step yields `PASS`, `FAIL`, `UNSUPPORTED` or `UNAVAILABLE`, and the report
lists all of them. A step that cannot run is never reported as `PASS`.

The steps form one chain of bindings. Each value is checked against the one
before it, and **no step accepts a value only because it came from an input
file**. The signed envelope is the root of trust for everything below it, and
the anchor message is the root of trust for everything above it.

**Input rules (all steps).** These close the RUBRIC-SEC-2026-001 class of
defect, where `Buffer.from(s, "hex")` silently stops at the first bad
character:

* Roots, leaves and proof siblings must match `^[0-9a-f]{64}$` (lowercase,
  exactly 32 bytes). A DAR leaf `L` must match `^sha3-256:[0-9a-f]{64}$`.
* An ML-DSA-65 signature must match `^[0-9a-f]{6618}$` (3309 bytes).
* A `publicKey` must be canonical base64 (re-encoding the decoded bytes gives
  the same string) and decode to exactly 1952 bytes. Keys are compared as
  bytes.
* Proof directions must be exactly `"L"` or `"R"`. The server is looser
  (`spec-merkle.ts:135`, `dar-emit.ts:249` default a missing direction); the
  verifier is not.
* `batch_size`, `itemCount`, `tier1Count` and `totalItems` must be positive
  safe integers of JSON type number.
* A value that cannot be canonicalized (a lone UTF-16 surrogate, which
  `canonical.ts` would encode lossily) is `UNSUPPORTED` (`JCS_UNREPRESENTABLE`).
* A malformed field is `FAIL` (`MALFORMED`) in the step that reads it.
* **Duplicate fields must agree, else `FAIL`.** A record repeats several
  values; the verifier reads the source of truth named below and checks every
  copy that is present against it, so a value is never accepted from a copy
  the checks did not cover.

1. **Signature.**
   * The verification key comes **only** from the keys file. A region can
     have more than one signer (§2.6). The candidates are the signers whose
     `region` equals the signed `envelope.issuer_node_region`, and the key
     used is the candidate whose `publicKey` is byte-identical to the
     record's embedded `publicKey`. If none is, the step is `UNSUPPORTED` with
     reason `KEY_NOT_PUBLISHED`. This is expected after a rotation that the
     keys file does not list, and it is not `FAIL`.
   * **Retired keys.** A signer with `status: "retired"` counts only if the
     step 5 anchor's mirror `consensus_timestamp` is before its `rotatedAt`.
     Otherwise the step is `UNSUPPORTED` with reason `KEY_RETIRED`. The
     envelope's own `issued_at` is never used for this, because the signer
     controls it. So a step 1 that used a retired key is final only after
     step 5, and it is never `PASS` if step 5 did not find a genuine anchor.
     If step 5 found no anchor only because the mirror was unreachable
     (step 5 `UNAVAILABLE`), the step is `UNAVAILABLE` (`NOT_RUN`, exit 4)
     instead of `KEY_RETIRED`, for the tiered, `tier1-batch` and
     `tier2-federation` branches alike.
     (The retired `legacy-shared-2026h1` key is one key listed for all five
     regions, so selecting by region does not narrow it.)
   * **Retired keys and a non-default `--mirror`.** The consensus time that
     places a retired key before its `rotatedAt` comes from the mirror. A
     mirror other than the default `https://mainnet-public.mirrornode.hedera.com`
     is the user's choice and could report any time, so a retired key accepted
     on its time is `UNSUPPORTED` (`KEY_RETIRED_UNTRUSTED_MIRROR`, exit 3),
     never `PASS`. Under `tier2-federation` such an entry does not count; the
     step is `KEY_RETIRED_UNTRUSTED_MIRROR` only if the quorum is not met
     without it.
   * **The embedded `publicKey` is never used to verify on its own.**
     Otherwise any self-signed forgery would pass.
   * Verify ML-DSA-65 over the signed bytes for the bundle kind (§4.5).
   * **Tiered.** The envelope must have exactly the seven keys of §4.5, with
     `attestation_type: "tiered"` and `rubric_version: "1.0"` (the same key
     signs other message types with no context string, so the shape is the
     domain separation). The sources of truth are `tier1.envelope`,
     `tier1.signature` and `tier1.publicKey`; the top-level and
     `stub.signature`/`stub.publicKey` copies must equal them. A valid
     signature under a published key is `PASS`; an invalid one is `FAIL`.
   * **DAR.** A completed DAR bundle carries no embedded `publicKey` and no
     batch envelope. `signature.source` selects the branch (`dar-emit.ts:949-953`);
     `signature.over` is a label and is ignored. Any other `source` is
     `UNSUPPORTED` (`SIGNATURE_SOURCE_UNSUPPORTED`).
     * `"tier2-federation"` (used whenever the anchor bundle had a federation
       block): `signature.raw` is that block. `raw.signedFields` must have
       exactly the keys of §4.5 with `attestation_type:
       "threshold-multisig"`, `subject: "tier2-aggregate"`, `anchor_id ===
       anchorBundle.attestationId`, `aggregate_root ===` the step 4 computed
       root, `tier1_count === tier1Flushes.length`, `total_items ===` the sum
       of `itemCount`, and `anchored_at === anchorBundle.anchoredAt` (the
       bundle's, not the message's). Each `raw.signatures[]` entry
       `{region, publicKey, signature}` counts only if its `publicKey`
       byte-matches a keys-file signer of that `region` (retired rule above)
       and its signature verifies; an entry under a published key that does
       not verify is `FAIL`. `PASS` needs at least
       `max(3, signedFields.quorum.required)` entries that count, from
       distinct regions **and** distinct keys (the retired
       `legacy-shared-2026h1` key is one key for all five regions, so it
       counts once). The floor of 3 holds even if the signed `quorum.required`
       is lower; a higher `quorum.required` raises it. Fewer is `UNSUPPORTED`:
       `KEY_RETIRED` if an entry was dropped by the retired rule (or
       `UNAVAILABLE` as above), else `KEY_RETIRED_UNTRUSTED_MIRROR` if one was
       dropped by the mirror rule, else `KEY_NOT_PUBLISHED` if no entry's key
       is published, else `FEDERATION_QUORUM_UNVERIFIED`.
       `quorumMet`, `obtained` and the other counters are never trusted.
     * `"tier1-batch"`: `signature.signature` is the batch signature hex.
       The envelope is rebuilt (§4.5) from the leaf message and the one
       `tier1Flushes[]` entry whose `forestRoot` equals `hop1.batchRoot`.
       There is no embedded key, so every keys-file signer of
       `leafMessage.issuer_node_region` is tried (retired rule applies to the
       one that verifies). If none verifies, the step is `UNSUPPORTED`
       (`KEY_NOT_PUBLISHED`): an unlisted key cannot be told apart from a
       forgery, and neither is ever `PASS`. `signature.raw` is not compared
       with the hex (§4.5). Not yet confirmed on a real bundle.
2. **Leaf.**
   * Tiered: recompute `T = SHA-256(0x00 ‖ utf8(JCS(leafMessage)))` from
     `stub.leafMessage` and compare it to `stub.leafHash` (and `stub.treeRoot`
     when present). `SHA-256(utf8(JCS(leafMessage)))` must equal
     `stub.payloadHash` and the top-level `payload_hash` when present. The
     leaf message must have `rubric_version: "1.0"`, `attestation_type:
     "tiered"`, `attestation_id` equal to the record's `attestation_id` and
     `stub.attestationId`, and `issued_at` and `issuer_node_region` equal to
     the signed envelope's (`tier1-worker.ts:99-101`,
     `tiered-aggregator.ts:406-407`).
   * DAR: first enforce `spec/dar-0.1.md` on the core, then recompute
     `L = "sha3-256:" + hex(SHA3-256(utf8(JCS(dar))))`
     (`spec/dar-0.1.md` §4.3). The core checks, in order:
     * `v` must be exactly `"DAR/0.1"`. Any other `DAR/<major>.<minor>` tag
       (an unknown major, or a higher minor) is `UNSUPPORTED`
       (`DAR_VERSION_UNSUPPORTED`): dar-0.1 §5.1 forbids claiming leaf
       verification for it ("needs-upgrade"), and its unknown fields are not
       stripped. This is checked before the key set, since a higher minor may
       add fields.
     * Exactly the §2 field set: the required `agentId`, `decisionHash`,
       `decisionId`, `inputHash`, `leafType`, `outputHash`, `prev`,
       `schemaHash`, `ts`, `v`, and optionally `adapter` and `schemaRef`.
       Nothing else (a raw `input`, `output` or `decision` field is a
       violation).
     * `schemaHash`, `inputHash`, `outputHash` and `decisionHash` match
       `^sha3-256:[0-9a-f]{64}$` (§4.2: any other prefix is rejected).
     * `decisionHash` equals `"sha3-256:" + hex(SHA3-256(utf8(JCS({schemaHash,
       inputHash, outputHash}))))`, recomputed (§2.1).
     * `leafType` is one of `"decision"`, `"schema-change"`, `"checkpoint"`
       (§2; unknown values are a verify error).
     * The §2 JSON types: `agentId` a non-empty string, `decisionId` a ULID
       (26 Crockford base32 characters), `ts` a string, `prev` a string or
       `null`, `schemaRef` a string, `adapter` exactly `{name: string,
       version: string}`.

     Any violation other than the version is `FAIL` (`DAR_CORE_INVALID`).
     Then follow the bridge hops in §4.5
     (`dar-emit.ts:228-230, 240-273, 883-934, 957-982`) to the tiered leaf
     `T`. `leafMessage.payload` with `payload_commitment` (salted) instead of
     `payload_hash_unsalted` is `UNSUPPORTED` (`PAYLOAD_COMMITMENT`) in v1.
3. **Leaf → signed batch root.**
   * Fold the leaf using `merkle_proof` (sibling hashes) and
     `merkle_proof_directions` (`L`/`R`). The node rule is the `batch` level
     (§2.5). If the two arrays differ in length, the step is `FAIL`.
   * The result MUST equal the signature-verified `envelope.batch_root`.
     Comparing it to a root from any other source is not enough.
   * Exactly one `anchorBundle.tier1Flushes[]` entry MUST have
     `flushId === envelope.flush_id`, `forestRoot === envelope.batch_root` and
     `itemCount === envelope.batch_size`. Anything else is `FAIL`.
   * Tiered copies that must agree with the envelope: top-level `batch_root`,
     `batch_size`; `stub.batchRoot`, `stub.batchSize`, `stub.tier1FlushId`
     (or legacy `stub.flushId`), `stub.issuedAt`, `stub.issuerNodeRegion`
     (the server's own binding check, `tiered-verify.ts:95-101`); and
     `stub.merkleProof`/`stub.merkleProofDirections` against the top-level
     arrays. A record whose `anchors.hcs.anchor_id` is set must name the
     anchor bundle's `attestationId`.
   * DAR: fold `T` along `hop1.path` (`{sibling, siblingDirection}`, the same
     rule) to `hop1.batchRoot`. Exactly one `tier1Flushes[]` entry has
     `forestRoot === hop1.batchRoot`; its `flushId` must equal `hop2.flushId`
     when that is non-null. `hop2.tier1FlushRoots` must equal the bundle's
     roots in order, and `hop2.anchorId` must equal
     `anchorBundle.attestationId`. Under the `tier2-federation` branch the
     batch root is not signed by itself; it is bound by step 4 to the signed,
     anchored `aggregateRoot`.
4. **Batch roots → aggregateRoot.**
   * Rebuild the aggregate tree from `tier1Flushes[]` in bundle order, using
     the `aggregate` level with leaves built exactly as `makeLeafV2` (§2.5).
   * Apply `wrap` (§2.5).
   * The result is the computed `aggregateRoot`. `anchorBundle.aggregateRoot`
     is only a hint and is not trusted; step 5 checks the computed value.
     A hint (or DAR `hop2.aggregateRoot`) that differs from the computed value
     is `FAIL`, as is a bundle `totalItems` that is not the `itemCount` sum.
   * The bundle's id key is `attestationId` (`tiered-aggregator.ts:566`); there
     is no `anchorId` key. A bundle `treeVersion` other than 3 is `UNSUPPORTED`
     (`TREE_VERSION_UNSUPPORTED`). `flushId`, `zkPayloadRoot` and the message's
     `tier1Count`/`totalItems` and zk fields are not committed by
     `aggregateRoot`; they are consistency checks only.
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
   * **The pinned list.** The verifier ships a **built-in list**, currently
     `["0.0.3923341"]`. It is the trust root (P7a board ruling, 2026-10-10).
     The keys file's `anchorPayers` (§2.6) is read as follows:
     * **Validation, in every mode.** A missing key is allowed. Any other
       value must be an array of strings, each of which matches
       `0\.0\.(0|[1-9][0-9]*)` as a whole string (a full match: no leading
       zeros, and no trailing newline, which `$` alone allows in some regex
       engines).
       Otherwise (`null`, a string, numbers, a checksum suffix) step 5 is
       `UNSUPPORTED` with reason `ANCHOR_PAYERS_INVALID`, with no fallback.
     * **Missing key, in every mode:** the built-in list is used.
     * **Explicit `--keys` with a valid array:** the array is used as-is, and
       the built-in list is not merged in. The user chose to pin this file.
       An empty array leaves no genuine payer. If the array differs from the
       built-in list, the report carries a warning: a `--keys` file is only
       an independent trust root if it came over a channel other than the
       rubric-protocol.com host.
     * **Fetched file with a valid array:** the effective list is the
       built-in list, and the fetched array never widens or shrinks it.
       * A built-in payer missing from the fetched array is a warning in the
         step detail.
       * A payer only in the fetched array is not genuine. Like any other
         non-genuine payer, its messages cannot match, count as duplicates,
         or cause a `FAIL`.
       * For the reason code only, chunks from fetched-only payers are
         reassembled in a separate diagnostic pool, keyed by `(payer,
         initial_transaction_id)` and never merged with genuine chunks. If no
         genuine message with a matching `anchorId` remains and the pool has
         one, step 5 is `UNSUPPORTED` with reason `ANCHOR_PAYER_UNPINNED`.
         Otherwise the reason is `ANCHOR_ORIGIN_UNVERIFIED`. Neither is ever
         `PASS`.

     Matching against `payer_account_id` is exact string equality. The
     report states the source: `keys-file` (from `--keys`) or `built-in`.
     `anchorPayers` is not covered by the keys file's attestation (§2.6), so
     when the source is `keys-file` the report labels the list unattested.
   * **Topic.** When the record names a topic (tiered
     `anchors.hcs.topic_id`, DAR `anchorRef.topicId`; a missing, `null` or
     empty value is not compared), it must equal the topic being searched
     (`--topic`, default `0.0.10416909`). A mismatch is `FAIL`
     (`TOPIC_MISMATCH`).
   * **Locating the message.**
     * Find every `RUBRIC_TIER2_ANCHOR` message whose `anchorId` matches the
       anchor bundle's `attestationId`. Use the record's
       `anchors.hcs.sequence_number` (a JSON number, first anchor only,
       `warm-backfill.ts:141`), the DAR `anchorRef.sequenceNumber` or the
       bundle `seqNum` as a starting point if present, and search the time
       window regardless, so that duplicates are seen. A hint is only a hint:
       `anchors.hcs.tx_id` and `consensus_timestamp` are never filled and are
       never read.
     * *As built:* a hint `s` fetches sequences `s − 19 … s + 19` (enough for
       a 20-chunk message). The time window is centred on the bundle's
       `anchoredAt` (flush time): **15 min before, 60 min after**, because the
       message's own `anchoredAt` and consensus time are publish time, and a
       retry publishes at least a minute later (§2.4, `aggregator/index.ts:205-231`).
       A duplicate published outside the window is not seen; the report says
       which window was searched. Every page, including every
       `links.next`, must be fetched, or the step is `UNAVAILABLE`.
     * A genuine `RUBRIC_TIER2_ANCHOR` message at a hinted sequence whose
       `anchorId` is not the bundle's is `FAIL` (`ANCHOR_ID_MISMATCH`).
     * Reassemble chunks that passed the origin check by
       `initial_transaction_id` and chunk number. The group key is the full
       `initial_transaction_id` (`account_id`, `transaction_valid_start`,
       `nonce`, `scheduled`). Each chunk's `message` is strict base64,
       decoded on its own, and the bytes are concatenated in chunk order and
       then decoded as UTF-8 with `fatal: true`. A group with an inconsistent
       `total` or a repeated chunk number is dropped. The message's
       `sequence_number`, `consensus_timestamp` and `payer_account_id` are
       chunk 1's (the P6 chunk-1 rule, §3.4).
     * Only messages rebuilt that way count. A message that still lacks any
       chunk `1..total` after foreign chunks are dropped does not count.
   * **Duplicates.** Retries can produce several messages with the same
     `anchorId` (§2.5). All of them MUST carry the same `aggregateRoot`;
     conflicting roots are `FAIL` (`DUPLICATE_ANCHOR_CONFLICT`). Report the
     earliest `consensus_timestamp`.
   * **Format** (O8, closed). Require `schemaVersion = "rubric-anchor/2"`,
     `treeVersion = 3`, and an `alg` object deep-equal (same keys, same values,
     nothing extra) to the §2.4 block. An `alg` object with no `levels` key
     is a flat block and is `UNSUPPORTED` (`ALG_LEGACY_FLAT`), whatever its
     other keys (with or without `merkleOdd`); any other `alg`, schema or tree version
     is `UNSUPPORTED` (`ALG_UNSUPPORTED`); the verifier does not guess an
     older construction. Pre-August-2026 anchors therefore do not verify in v1.
   * **Match.** The message's `anchorId` must equal the anchor bundle's
     `attestationId`, and its `aggregateRoot` must equal the value computed in
     step 4. Its `tier1Count` and `totalItems` must equal the bundle's flush
     count and `itemCount` sum (consistency only, `FAIL` on a mismatch).
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
mirror}, anchorPayers: {source: "keys-file" | "built-in", accounts, attested?: false, warnings} }` (`attested: false` only when `source` is `keys-file`). The report always includes the topic ID. If `--topic` is not
`0.0.10416909`, the verdict detail says so in every output mode.

**Non-default `--mirror`.** If `--mirror` is not
`https://mainnet-public.mirrornode.hedera.com`, the verdict detail carries a
`NOTE` saying so in every output mode (text and `--json`), as for a
non-default topic, and the note is also in `warnings`. The anchor's payer and
consensus time then come from a mirror the user chose. That alone does not
stop a `PASS`, because every anchored value is still recomputed and compared,
but a retired key accepted only on that mirror's consensus time is
`UNSUPPORTED` (`KEY_RETIRED_UNTRUSTED_MIRROR`, exit 3; §4.3 step 1).

*As built (P7):* the five step names are `signature`, `leaf`, `batch`,
`aggregate` and `anchor`, always in that order. Each step also carries
`reason` (a code such as `KEY_NOT_PUBLISHED`, or `null` on `PASS`). The
report adds `verdictDetail`, `exitCode`, `recordKind` (`tiered` | `dar`),
`warnings`, `anchor.searched` (the hinted sequence range and time window), and
`anchor.genuineMessages`: the number of complete `RUBRIC_TIER2_ANCHOR`
messages from a pinned payer whose `anchorId` is the bundle's
`attestationId`, found in the searched ranges (more than 1 means retries,
which must agree; 0 when none was found or step 5 did not get that far).
When `UNSUPPORTED` and `UNAVAILABLE` both occur with no `FAIL`, the exit code
is 3: `UNSUPPORTED` would not change on a retry. A step that could not run
because a value it needs was not produced is `UNSUPPORTED` with reason
`NOT_RUN` (`UNAVAILABLE` if the cause was a network failure), never `PASS`.

### 4.5 Signed message per bundle kind

Filled in by P7 step 1 (crypto review, 2026-10-10). Line references are
rubric-protocol `main` 54afb5a1.

**The signer.** `RubricOracle.signCanonical(value)` (`src/verify/oracle.ts:177-192`)
computes `ml_dsa65.sign(secretKey, utf8(JCS(value)))` with `@noble/post-quantum`
0.3.0 (`package.json:25`). It is **pure ML-DSA-65** (FIPS 204, no HashML-DSA
prehash) with an **empty context string** (the library signs
`M' = 0x00 ‖ 0x00 ‖ msg`), and it is deterministic (no randomness is passed, so
the same key and message give the same signature). The signature is 3309 bytes,
stored as 6618 lowercase hex characters; the public key is 1952 bytes, stored
as base64. JCS is `canonicalize()` (`src/verify/canonical.ts:33`). The same key
signs several message types with no context string; the verifier relies on the
exact envelope shape for domain separation, and no remote caller can obtain a
signature over a caller-chosen tiered envelope (the legacy `attest()` path is
only in `src/index.ts` and tests; cosign requires a `threshold-multisig` shape
and an HMAC).

**(a) Tiered warm record.** Signed bytes are `utf8(JCS(tier1.envelope))`. The
envelope is built at `tiered-aggregator.ts:400-408` and signed at `:409`:

```
{"attestation_type":"tiered","batch_root":"<64 lc hex>","batch_size":<int>,"flush_id":"<uuid>","issued_at":"<ISO ms Z>","issuer_node_region":"<us|sg|jp|ca|eu>","rubric_version":"1.0"}
```

The signature hex is copied at `:419`, the `publicKey` base64 at `:420`. There
is no `keyId`. The warm record (`:465-496`; the anchor pointer is filled by
`aggregator/warm-backfill.ts:132-146`) is:

```
{ rubric_version, attestation_type: "tiered", attestation_id, publicKey, signature,
  issuer_node_region, issued_at, payload_hash, payload,
  merkle_proof: [hex], merkle_proof_directions: ["L"|"R"], batch_root, batch_size,
  anchors: { hcs: { topic_id, tx_id: "", consensus_timestamp: "",
                    sequence_number: null | <number>, anchor_id?: <uuid> }, base: {…} },
  stub: { attestationId, tier1FlushId, flushId?, forestRoot, treeRoot, leafHash,
          merkleProof, merkleProofDirections, batchRoot, batchSize, payloadHash,
          issuedAt, issuerNodeRegion, leafMessage, signature, publicKey, zk*, … },
  tier1: { envelope, signature, publicKey, batch_root, batch_size } }
```

Sources of truth: `tier1.envelope`, `tier1.signature`, `tier1.publicKey` for the
signature; `stub.leafMessage` for the leaf; `merkle_proof` and
`merkle_proof_directions` for the fold. Every other copy must agree (§4.3).

**(b) DAR completed bundle.** Written by `Enricher.enrichOne`
(`src/api/dar-emit.ts:957-982`):

```
{ attestationId, dar: {…core…}, merkleProof: { leaf: L, steps: [], root: L },
  anchorRef: { network: "hedera-mainnet", topicId, sequenceNumber: <number>, root: L },
  signature: { alg: "unknown", keyRef, signature, over, source, raw },
  extensions: { rubricDar: { state: "complete", emittedAt, receivedAt?, completedAt,
     tiered: { attestationId, agentId, data, payloadKey? }, supersededAttestationIds?, reattestedAt?,
     bridge: { hop0: { fn, data, leafMessage, tier1LeafFn, tier1LeafHash },
               hop1: { fn, path: [{ sibling, siblingDirection }], batchRoot },
               hop2: { anchorId, flushId | null, aggregateRoot, tier1FlushRoots,
                       algorithm, treeVersion, leafConstruction, seqNum, lateAnchor },
               checks, auditor } } } }
```

There is no `anchors.hcs`, no batch envelope and no `publicKey`. `signature`
is built by `toBatchSignature` (`:276-288`) from the first available of
(`:949-953`):

* `source: "tier2-federation"`, whenever the tier-2 bundle had a `federation`
  block (`tiered-aggregator.ts:620-623`). `signature.raw` is that block:
  `{required, obtained, available, margin, respondingRegions, silentRegions,
  signedFields, signatures: [{region, publicKey (base64), signature (hex)}],
  sigHash}`, and `signature.signature` is `JSON.stringify(raw)`. Each entry
  signs `utf8(JCS(raw.signedFields))` (`src/api/threshold-endpoint.ts:178-190`
  for this node, `:85-133` and `:569-594` for peers), where `signedFields` is

  ```
  {"aggregate_root":"<hex>","anchor_id":"<uuid>","anchored_at":"<bundle anchoredAt>",
   "attestation_type":"threshold-multisig","operator_keylist_aggregate_hash":"<hex>",
   "quorum":{"required":3,"signer_regions":[…],"total":5},"subject":"tier2-aggregate",
   "tier1_count":<int>,"total_items":<int>}
  ```

  (shown in JCS key order). At most 3 signatures are kept (`:204-205`).
* `source: "tier1-batch"`: `signature.signature` is the tier-1 batch
  signature hex (`:988-997`). Signed bytes are `utf8(JCS(E))` with `E` rebuilt
  as `{rubric_version: "1.0", attestation_type: "tiered", batch_root:
  hop1.batchRoot, batch_size: flush.itemCount, flush_id: flush.flushId,
  issuer_node_region: leafMessage.issuer_node_region, issued_at:
  leafMessage.issued_at}`, which is the tiered envelope of (a). Unconfirmed on
  a real bundle. `signature.raw` is **not** compared with
  `signature.signature`: `raw` is whatever `stubSignature()` returned
  (`dar-emit.ts:953`, `:989-996`), and that is the `/v1/proof` response's
  `signature` when present (`:990`), whose shape is not fixed. When it is a
  string, `toBatchSignature` sets `signature = raw` (`:278`); when it is an
  object, `signature` is a picked field or `JSON.stringify(raw)` (`:279-286`).
  So `raw` is not provably the hex, and only `signature.signature` is used.

`signature.over` labels are misleading and are ignored.

**Bridge hops** (`dar-emit.ts:228-230, 240-253, 256-273, 883-934`), checked in
this order:

1. The core is checked against `spec/dar-0.1.md` first (§4.3 step 2): `v`
   other than `"DAR/0.1"` is `UNSUPPORTED` (`DAR_VERSION_UNSUPPORTED`, no leaf
   is claimed); a field outside the §2 set, a missing required field, a hash
   not `sha3-256:<64 lc hex>`, a `decisionHash` that is not the §2.1
   recomputation, an unknown `leafType` or a wrong §2 type is `FAIL`
   (`DAR_CORE_INVALID`). Then
   `L = "sha3-256:" + hex(SHA3-256(utf8(JCS(dar))))`
   (`packages/attest-decision/src/dar.ts:211`, `hash.ts:25`). `L` must equal
   `merkleProof.leaf`, `merkleProof.root`, `anchorRef.root` and
   `tiered.data.leafHash`; `merkleProof.steps` must be `[]`.
2. `data = {schema: "rubric.dar-anchor.v1", v: dar.v, decisionId:
   dar.decisionId, agentId: dar.agentId, leafHash: L}` (`:228-230`) must be
   JCS-equal to `hop0.data` and to `tiered.data`.
3. `hop0.leafMessage.attestation_id === bundle.attestationId ===
   tiered.attestationId`; the leaf message has `attestation_type: "tiered"`
   and `rubric_version: "1.0"`.
4. Payload: `leafMessage.payload.payload_hash_unsalted` must equal
   `hex(SHA-256(utf8(JCS(data))))` (`tier1-worker.ts:97`, `dar-emit.ts:256-260`).
   `payload_commitment` is `UNSUPPORTED` (`PAYLOAD_COMMITMENT`) in v1; a
   payload with neither field is `FAIL` (`MALFORMED`).
5. `T = SHA-256(0x00 ‖ utf8(JCS(leafMessage)))` must equal `hop0.tier1LeafHash`.
6. Fold `T` along `hop1.path` with the batch rule (`siblingDirection: "L"`
   means the sibling is the left operand) to `hop1.batchRoot`.
7. Exactly one `tier1Flushes[]` entry has `forestRoot === hop1.batchRoot`; its
   `flushId` equals `hop2.flushId` when that is non-null;
   `hop2.tier1FlushRoots` equals the bundle's roots in order; `hop2.anchorId`
   equals `anchorBundle.attestationId`.
8. Then steps 4 and 5 of §4.3. `anchorRef.sequenceNumber` and `hop2.seqNum` are
   only hints.

**Direct and threshold** bundles are out of scope for P7.

The vectors in `packages/replay-verify/test/vectors/` were generated from
`canonical.ts`, `merkle.ts` and `spec-merkle.ts` at 54afb5a1 and pin all of the
above (their `README.md` says how).

---

## 5. P8: Drift check

### 5.1 Location and interface

`tools/drift-check/drift-check.mjs` in this repo. Its index side is the
anchor-link lines in `attestation-index.jsonl` (§3.2), read directly. It does
not depend on attest-index or on anything else from the service.

```
drift-check --index <attestation-index.jsonl>
            [--mirror <base-url>] [--topic 0.0.10416909]
            [--since <iso> | --state <file>]   # resume point; default: last 24 h
            [--min-age 600]                    # seconds; anchors younger are ignored
            [--anchor-payer <account-id>]...   # pinned anchor payers (D4); default: the P7 built-in list
            [--json]
```

It opens the jsonl read-only, once per run, and reads that file descriptor to
EOF, so a concurrent `reconcile-rt.py` replace cannot mix two files. It
ignores a trailing line with no newline (an append in progress). It never
writes, renames or locks the jsonl. It reads only `kind: "anchor-link"` lines
and merges them by the §3.2 rule. The drift checks need one summary per
`anchorId`: the `aggregateRoot` values, the set of `hcsSequence` groups with
their merged `hcsConsensusTs`, the earliest `writtenAt`, and a conflict flag.
The checks keep that summary, not per-attestation state. `LINK_CONFLICT` for
one `id` across two `anchorId`s needs an `id → first anchorId` map. That map
is the only per-attestation state, and full lines are never kept.

**Index-side time.** Each `anchorId` summary has an `anchorTime`: the earliest
merged `hcsConsensusTs` across its groups if any is non-null, otherwise its
earliest `writtenAt`. Backfilled historical anchors carry their mirror
consensus time, so they line up with mirror time. A recent anchor-job link
(`hcsConsensusTs: null`) is written just after its submit, so `writtenAt` is a
close upper bound.

It makes no writes except the `--state` file, and no calls to our API. It does not fetch the keys file:
without `--anchor-payer` it uses the same hardcoded list as the P7 built-in list,
currently `0.0.3923341`. If `--anchor-payer` is given, it replaces the default.
Each value must fully match `0\.0\.(0|[1-9][0-9]*)` (as in §4.3 step 5), or the run exits 2.

### 5.2 Walk

1. Enumerate all messages on the topic from the resume point, ordered by
   `sequence_number`, following `links.next`.
2. Apply the P7 origin check per chunk, before reassembly (§4.3 step 5).
   Report each failing chunk on its own as `FOREIGN_PAYER`, whatever its
   type, and drop it. Then reassemble messages from the remaining chunks only,
   so a forged chunk never removes a genuine message. Keep only
   `RUBRIC_TIER2_ANCHOR` messages; other types from pinned payers are ignored.
3. Drop anchors whose mirror `consensus_timestamp` is under `--min-age` old.
4. **Window.** The run checks the interval `(windowStart, cut]`, where `cut`
   is now minus `--min-age`, and `windowStart` is one of:
   * the `--state` file's `cut` from the previous run;
   * `--since`;
   * 24 h before now.

   * The mirror side is the genuine anchors with `consensus_timestamp` in
     the window.
   * The index side is the `anchorId` summaries with `anchorTime` in the
     window.
   * Anchors outside the window are not checked, on either side.
   * For an index-side `anchorId` that has no match in the window's mirror
     messages, each of its `hcsSequence` groups is fetched by sequence
     (`GET <mirror>/api/v1/topics/<topic>/messages/<sequence>`). For a chunk,
     the neighbouring sequences up to ±20 (`setMaxChunks(20)`) are fetched to
     reassemble it, and the D4 origin rule applies. Only then is a finding
     reported.
   * The same lookup applies to a mirror-side anchor whose link summary has
     an `anchorTime` just outside the window.
   * `--state` stores `{cut, lastSequence}`. The next run starts at that
     `cut`, so an anchor is checked in exactly one run once it is older than
     `--min-age`. A later run reports nothing for it again.
5. Walk backward via `prevAnchorId` from each anchor that has one. Because of
   §2.4, an anchor without `prevAnchorId` is a **segment start**, not a gap.
   The walk resumes from the next-older anchor by sequence.

### 5.3 Findings

| Code | Condition | Drift? |
|---|---|---|
| `CHAIN_GAP` | `prevAnchorId` names an anchorId with no pinned-payer message on the topic (searching back past the window as needed). A link to an anchorId found only in `FOREIGN_PAYER` messages is a gap. | **yes** |
| `CHAIN_FORK` | two anchors name the same `prevAnchorId` | **yes**, once O3 is resolved; a warning until then |
| `SEGMENT_START` | anchor has no `prevAnchorId` | no, counted and reported |
| `MISSING_FROM_INDEX` | genuine anchor on the mirror, with `consensus_timestamp` in the window, and no anchor-link line for its `anchorId` anywhere in the jsonl | **yes** |
| `MISSING_FROM_MIRROR` | an `anchorId` summary with `anchorTime` in the window, where neither the window's mirror messages nor the by-sequence lookup (§5.2 step 4) yields a genuine message matching it on `anchorId` and `aggregateRoot` | **yes** |
| `ROOT_MISMATCH` | same `anchorId`, different `aggregateRoot` (anchor-link vs mirror) | **yes** |
| `SEQ_MISMATCH` | for an `anchorId` in the window, an anchor-link group's `hcsSequence` is not, after the by-sequence lookup, the sequence of a genuine mirror message with that `anchorId` and `aggregateRoot`, or its merged non-null `hcsConsensusTs` differs from that message's. Checked per group. A genuine mirror sequence with no group is not `SEQ_MISMATCH`; the backfill adds it, and until then it is `INDEX_PENDING`. | **yes** |
| `LINK_CONFLICT` | the §3.2 merge rule finds a conflict: one `id` linked to two `anchorId`s, two different non-null values for one field in one group, groups of one `(id, anchorId)` that disagree on `aggregateRoot` or `topic`, or a malformed link line | **yes** |
| `DUPLICATE_ANCHOR` | several mirror messages share an `anchorId`, all with the same `aggregateRoot` (retry) | no, a warning |
| `DUPLICATE_ANCHOR_CONFLICT` | several mirror messages share an `anchorId` with different `aggregateRoot`s | **yes** |
| `FOREIGN_PAYER` | any message or chunk on the topic, of any type, whose `payer_account_id` is not in the pinned anchor-payer list (D4) or, when `chunk_info` is present, differs from the account in its `initial_transaction_id`. One finding per chunk. Excluded from all chain and index checks; it never removes a genuine message. | **yes** |
| `INDEX_PENDING` | an anchor-link group matched on the mirror, but its merged `hcsConsensusTs` is still null (the anchor job writes `null` until O4). Also, a genuine mirror sequence for a linked `anchorId` that has no group yet (an unlinked retry). | no, a warning (the §3.4 backfill fixes it) |

Messages are attributed to an `anchorId` by message content. For
`MISSING_FROM_MIRROR`, a mirror message (from the window or the by-sequence
lookup) must match on both `anchorId` and `aggregateRoot`. The by-sequence
lookups use the same host, backoff and retry limit as paging. If a lookup
fails, the run exits 3, never 1.

### 5.4 Exit codes

| Exit | Meaning |
|---|---|
| 0 | no drift findings |
| 1 | at least one drift finding |
| 2 | usage / jsonl unreadable |
| 3 | mirror unreachable or incomplete (pagination broke, 429 after retries); **not** reported as drift |

Mirror access uses exponential backoff on 429/5xx, at most 5 retries per page.

---

## 6. Open decisions (not decided here)

These need a decision before the phase that depends on them. Per CLAUDE.md,
O1 and O2 go to the board subagent, since they change published formats.

| # | Question | Blocks |
|---|---|---|
| O1 | Should records embed the batch → aggregate path and `anchorId`, so P7 can verify from one file? | P7 single-file mode only; P7 as specified works without it |
| O2 | Should the keys file get an append-only key history and an on-chain hash of each key set (the `trust-anchor.json` model)? Without it, bundles signed before a rotation report `KEY_NOT_PUBLISHED` (key no longer listed) or `KEY_RETIRED` (key listed as retired, with no anchor time before its `rotatedAt`), and trust in the keys file reduces to TLS on rubric-protocol.com. | P7 verifying rotated keys |
| O3 | Do several regional aggregators publish to topic `0.0.10416909`? If yes, what is the chain key (the anchor message carries no region)? | P8 `CHAIN_FORK` as drift |
| O4 | Should `publishTier2Anchor` move to `getRecord()` so the consensus timestamp is recorded at submit? (Today `/v1/verify` reports the wall-clock `anchorConfirmedAt` as `consensus_timestamp`, `server.ts:1332-1333`.) With it, the anchor job could write `hcsConsensusTs` in the anchor-link line itself. | nothing; without it, anchor-links get the consensus timestamp from the §3.4 backfill, and P8 reports `INDEX_PENDING` until then |
| O5 | Should the retry drainer keep `prevFederationSigHash`/`prevAnchorId` (`aggregator/index.ts:217-231`)? Today a retry creates a `SEGMENT_START`. | nothing; reduces P8 noise |
| O6 | **Closed, see D4.** The topic has `submit_key: null` and `admin_key: null` (immutable, no key ever). Origin is a pinned payer list, currently `0.0.3923341`, published as `anchorPayers` in the keys file, with a built-in list in the verifier that stays the trust root. Board review of the published field (P7a, 2026-10-10): approve the PR, hold the deploy until the §4.3 step 5 precedence rule is merged. | — |
| O7 | `reconcile-rt.py` rewrites the `rt` field of earlier jsonl lines and `os.replace`s the file (§3.1). So attestation lines are not append-only, which D5 records; only anchor-link lines are. Also, a line appended between its tail read and its replace is lost, because the writers don't take its lock. Should `rt` move out of the jsonl (for example, a sidecar keyed by `id`), or should the writers share its lock? P6 only makes it pass link lines through untouched. A lost link line is re-appended by the §3.4 backfill on its next run, and P8 reports `MISSING_FROM_INDEX` until then. | nothing in P6 as written; closes the lost-append window |
| O8 | **Closed (P7 step 1, crypto review, 2026-10-10).** v1 accepts `schemaVersion: "rubric-anchor/2"`, `treeVersion: 3` and an `alg` block deep-equal to exactly the block rubric-protocol `main` emits (§2.4, `attestation-publisher.ts:397-414`). The flat block is `UNSUPPORTED` (`ALG_LEGACY_FLAT`); any other shape, including the unconfirmed descriptive-keys variant, is `UNSUPPORTED` (`ALG_UNSUPPORTED`). A variant is added only with a real mainnet fixture that recomputes. V1/V2 trees are never implemented. | — |

---

## 7. Sequencing

* **P7 does not depend on P6** and can start first, or run in parallel.
* **P8 depends on P6**, because it needs anchor-link lines in the jsonl.
* Within P6, the order is fixed:
  1. the reader filter and the `reconcile-rt.py` passthrough are deployed;
  2. then the anchor job writes links;
  3. then the mirror backfill runs with `--apply`;
  4. then attest-index ingest and the decision-verify change ship.

  No anchor-link line may reach the production jsonl before step 1 is live.
* P6 changes rubric-protocol hot paths. Its rubric-protocol PR follows that
  repo's CLAUDE.md, including tests against the compiled build.

Anchor-link lines can never be removed from the production jsonl, so turning
on the anchor-job writer and the first `--apply` backfill against production
are hard to reverse. Each one goes to the board first and is run by a human.

Reviews per phase: `crypto` for P7 and for the P6 anchor-link placement,
`spec-guardian` for anything touching DAR, and `safety-reviewer` before every
commit.
