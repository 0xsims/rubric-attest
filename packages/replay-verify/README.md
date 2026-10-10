# @rubric-protocol/replay-verify

`rubric-replay` checks a Rubric attestation from its files and a public Hedera
mirror node. It makes **no calls to the Rubric API**. It works with a tiered
warm record or a completed DAR bundle, together with the tier-2 anchor bundle
that covers it. Spec: `docs/specs/attestation-index-and-replay.md` §4.

> Status: 0.1.0, unreleased.

**When to use which.** Use `rubric-replay` when you want to check a record
yourself, offline from our service, from the files plus the public ledger.
`@rubric-protocol/decision-verify` is our paid API route, which answers the same
question for a DAR `decisionId` from our index and store.

## What it proves

If every step is `PASS` (exit 0), then:

1. **Signature.** A key that the keys file publishes for the record's region
   signed the batch with ML-DSA-65 (FIPS 204, pure, empty context).
   * For a tiered record, that is the signed batch envelope.
   * For a DAR bundle, it is either that envelope, or at least
     `max(3, quorum.required)` federation signatures from distinct regions and
     distinct keys over the tier-2 aggregate.
2. **Leaf.** The record's leaf message hashes to the leaf the proof starts
   from. For a DAR bundle, the DAR core is a valid `DAR/0.1` core
   (`spec/dar-0.1.md`: exactly the §2 fields, `sha3-256:` hashes, a
   recomputed `decisionHash`, a known `leafType`), it hashes to `L`, and `L`
   is bound through the anchor data and the payload hash to that tier-1 leaf.
   A core with another `v` is `UNSUPPORTED` (`DAR_VERSION_UNSUPPORTED`); any
   other violation is `FAIL` (`DAR_CORE_INVALID`).
3. **Batch.** The leaf folds to the signed `batch_root`. Exactly one flush in
   the anchor bundle carries that root, with the signed flush id and size.
4. **Aggregate.** The anchor bundle's flush roots rebuild the `aggregateRoot`
   (`makeLeafV2` → `buildTreeV3` → wrap).
5. **Anchor.** A `RUBRIC_TIER2_ANCHOR` message on topic `0.0.10416909` from a
   pinned payer carries this `anchorId` and that same `aggregateRoot`. The
   report gives its mirror `consensus_timestamp`, `sequence_number` and
   payer. A topic named by the record (`anchors.hcs.topic_id`,
   `anchorRef.topicId`) must be the topic searched (`TOPIC_MISMATCH`).

## What it does not prove

* **That the content is true.** It proves only what was attested and when it
  was anchored.
* **Which payload was attested, when the payload is salted.** A DAR whose leaf
  carries a salted `payload_commitment` is `UNSUPPORTED` in v1.
* **Timing beyond the ledger.** Time comes from the anchor's consensus
  timestamp. `issued_at` is the signer's own claim.
* **Duplicates outside the search window.** It searches 15 min before to
  60 min after the bundle's `anchoredAt`, plus ±19 sequences around any stored
  sequence number. A retry published outside that window is not seen.
* **Old anchors.** Anchors from before August 2026 carry the old flat `alg`
  block. They are `UNSUPPORTED` in v1 (`ALG_LEGACY_FLAT`). So is any `alg` block
  that is not exactly the current one (`ALG_UNSUPPORTED`).

## Trust model

Read this before relying on a `PASS`.

* **The keys come from rubric-protocol.com over TLS.** By default the verifier
  fetches `https://rubric-protocol.com/.well-known/rubric-keys.json`, so trust
  in the keys reduces to TLS and the rubric-protocol.com host. `--keys <file>`
  pins a keys file and makes **zero** requests to rubric-protocol.com.
  However, a pinned file is only an independent trust root if it came over
  some channel other than that host.
* **Unlisted keys are unsupported.** If the keys file does not list the
  record's key for its region, the result is `UNSUPPORTED` (`KEY_NOT_PUBLISHED`).
  This happens after a rotation the file does not list, and also for a
  self-signed forgery.
* **Retired keys are unsupported after rotation.** A key marked
  `status: "retired"` counts only if the anchor's consensus timestamp is before
  its `rotatedAt`. Otherwise the result is `UNSUPPORTED` (`KEY_RETIRED`), or
  `UNAVAILABLE` if the anchor time is unknown because the mirror was
  unreachable.
* **Both cases stay unsupported until spec §6 O2 is decided.** O2 is about an
  append-only key history and an on-chain hash of each key set.
* **Anyone can post to the anchor topic.** Topic `0.0.10416909` has no submit
  key and never can have one. A message on it is genuine **only because its
  payer** is in the verifier's built-in payer list, `["0.0.3923341"]`, or in
  the `anchorPayers` of a file pinned with `--keys`.
  * The origin check runs per chunk, before reassembly.
  * Messages from any other payer are ignored. They cannot match, cannot count
    as duplicates, and cannot cause a `FAIL`.
* **`anchorPayers` is unattested.** The keys file's own attestation covers
  `signers` only. So:
  * A **fetched** `anchorPayers` never widens or shrinks the built-in list. It
    can only add warnings or an `UNSUPPORTED` result.
  * A `--keys` file's `anchorPayers` replaces the built-in list. The report
    then says `source: "keys-file"`, `attested: false`.
* **One mirror, no cross-check.** It reads one mirror node (default
  `https://mainnet-public.mirrornode.hedera.com`) and believes it.
  `mainnet.mirrornode.hedera.com` is never used. A `--mirror` other than the
  default is called out with a `NOTE` in the verdict detail (text and
  `--json`), and a retired key that counts only because of that mirror's
  consensus time is `UNSUPPORTED` (`KEY_RETIRED_UNTRUSTED_MIRROR`).
* **The anchor bundle comes from the Rubric Protocol store, and it is checked,
  never trusted.** `<anchorId>.json` is written by the operator's Rubric
  Protocol store, because batch roots are not on-chain. You supply it; the
  verifier never fetches it, and it does not trust it:
  * every root is recomputed;
  * the result must match the signed envelope and the on-chain `aggregateRoot`.

## Network

Exactly two kinds of request are allowed (spec §4.2), and one guarded `fetch`
throws on anything else:

1. `GET https://rubric-protocol.com/.well-known/rubric-keys.json`. This is
   skipped with `--keys`.
2. `GET <mirror>/api/v1/topics/<topic>/messages?…`, including `links.next`.

It never calls `rubric-protocol.com/v1/*`, the keys file's `attestation.verify`
URL, the topic-info endpoint, or `/messages/<seq>`. Redirects are refused. A
429, 5xx or network error is retried with backoff, at most 5 times per page;
after that the result is `UNAVAILABLE`.

## Usage

```
rubric-replay --record <warm-record.json | dar-bundle.json>
              --anchor-bundle <anchorId>.json
              [--keys <rubric-keys.json>]
              [--mirror https://mainnet-public.mirrornode.hedera.com]
              [--topic 0.0.10416909]
              [--json]
```

| Exit | Meaning |
|---|---|
| 0 | every step `PASS` |
| 1 | at least one `FAIL` (tamper or mismatch) |
| 2 | usage error, or unreadable or unrecognized input |
| 3 | no `FAIL`, at least one `UNSUPPORTED` (also when `UNAVAILABLE` occurs too) |
| 4 | no `FAIL`, at least one `UNAVAILABLE` (keys or mirror unreachable) |

The report always lists all five steps: `signature`, `leaf`, `batch`,
`aggregate`, `anchor`. Each step has a `status`, a `reason` code and a
`detail`. A step that did not run is never `PASS`. `--json` prints:

```
{ verdict, verdictDetail, exitCode, recordKind, steps: [{name, status, reason, detail}],
  anchor: {anchorId, aggregateRoot, sequenceNumber, consensusTimestamp, payerAccountId,
           topic, mirror, genuineMessages, searched},
  anchorPayers: {source: "keys-file" | "built-in", accounts, attested?: false, warnings},
  warnings }
```

## Walkthrough: a mainnet bundle against the public mirror

Use any tiered warm record or completed DAR bundle you hold, plus its tier-2
anchor bundle. For a warm record, the anchor bundle is the `<anchorId>.json`
whose `tier1Flushes[]` contains the record's `stub.tier1FlushId`; the record's
`anchors.hcs.anchor_id` names it once backfilled. For a DAR bundle it is
`extensions.rubricDar.bridge.hop2.anchorId`.

```
npm ci
npm run build
# keys fetched from rubric-protocol.com over TLS:
node packages/replay-verify/dist/bin.js \
  --record ./<attestationId>.json \
  --anchor-bundle ./<anchorId>.json
# or with a pinned keys file obtained over another channel:
node packages/replay-verify/dist/bin.js \
  --record ./<attestationId>.json \
  --anchor-bundle ./<anchorId>.json \
  --keys ./rubric-keys.json --json
```

Expected output: **pending: run against the exported fixture.** Nothing has
been run against a real mainnet record yet; see the next section.

## Real mainnet fixtures (needed for the end-to-end test)

`test/mainnet.test.ts` replays real cases offline under the network guard.
Each case must reach exit 0. The test is **skipped** while
`test/fixtures/mainnet/` is empty. The fixtures exist only on the production
store, so a human must export them.

Create one directory per case, `test/fixtures/mainnet/tiered/` and
`test/fixtures/mainnet/dar/`, each holding:

| File | Where it comes from |
|---|---|
| `record.json` | **tiered:** the warm record `<attestationId>.json` from `warm/` (or `cold/`) under `/mnt/tempus-attestation-store` (spec §3.4); a JSON array with exactly one tiered record is also fine. **dar:** the completed bundle `decisions/<YYYY-MM-DD>/<decisionId>.json` from the bundles directory. |
| `anchor-bundle.json` | The tier-2 anchor bundle `<anchorId>.json`. Look it up in the hot store (`bundles/`), then `warm/`, then `cold/`; `retention.py` moves it after 2 h and 7 days, and to S3 after 90 days. |
| `rubric-keys.json` | `https://rubric-protocol.com/.well-known/rubric-keys.json` as served when you record (or rubric-web's `.well-known/rubric-keys.json`). |
| `mirror-messages.json` | The mirror messages for the anchor, recorded with the command below. |

Record the mirror messages (this contacts only the public mirror):

```
node packages/replay-verify/scripts/record-mirror-window.mjs \
  test/fixtures/mainnet/tiered/record.json \
  test/fixtures/mainnet/tiered/anchor-bundle.json \
  > test/fixtures/mainnet/tiered/mirror-messages.json
```

Run the same command for `dar/`, then `npm test`.

**Choose recent anchors** emitted by current rubric-protocol `main`. An anchor
from before about 2026-08-11 has the flat `alg` block and is `UNSUPPORTED` by
design. If a recent real message carries a different `alg` shape (spec §2.4,
O8), the test fails with `ALG_UNSUPPORTED`; that is a finding to take to crypto
review. Do not loosen the check to make it pass.

The record's signing key must be listed in the keys file for its region (or be
retired after the anchor). Before committing, check that the record holds no
customer data that may not be published. Tiered leaves carry only a payload
hash or commitment, but `compliance_ref`, `model_ref` and the DAR `agentId` are
plaintext.

## License

Apache-2.0
