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

## Walkthrough: a real mainnet record against the public mirror

`test/fixtures/mainnet/tiered/` holds one real mainnet record. It is an internal
canary attestation whose payload is a commitment hash only:

| | |
|---|---|
| Record | tiered warm record `02d03bdf-e810-4dfd-a3a0-926b5ad48684`, region `us`, issued 2026-10-10T06:35:13.293Z |
| Anchor bundle | `d59658dd-e087-4363-922c-becb76e51494`, 1 tier-1 flush of 2 items |
| On-chain | topic `0.0.10416909`, sequence `309269`, payer `0.0.3923341`, consensus `1791614183.102338104` (2026-10-10T06:36:23.102Z) |

### Verify it live

From a checkout of this repo:

```
npm ci && npm run build
```

Then this one command checks the record against the public Hedera mirror:

```
node packages/replay-verify/dist/bin.js \
  --record packages/replay-verify/test/fixtures/mainnet/tiered/record.json \
  --anchor-bundle packages/replay-verify/test/fixtures/mainnet/tiered/anchor-bundle.json
```

It makes exactly two kinds of request: the keys file from
`https://rubric-protocol.com/.well-known/rubric-keys.json`, and the topic
messages from `https://mainnet-public.mirrornode.hedera.com`. To make zero
requests to rubric-protocol.com, add
`--keys packages/replay-verify/test/fixtures/mainnet/tiered/rubric-keys.json`.
That is a recorded copy of the keys file.

### Output

This is the real output for that record. It was run offline from the committed
fixtures by `scripts/replay-fixture.mjs`, which runs the same CLI and the same
network guard, but serves the recorded mirror message and keys file instead of
the network:

```
$ F=packages/replay-verify/test/fixtures/mainnet/tiered
$ node packages/replay-verify/scripts/replay-fixture.mjs \
    $F/record.json $F/anchor-bundle.json $F/mirror-messages.json $F/rubric-keys.json
rubric-replay: PASS (exit 0) — tiered record
  all five steps PASS

  [PASS       ] signature ML-DSA-65 over JCS(batch envelope) verifies under the published us key 1ffb9f4a-3ee9-4885-873e-3ba062149eaf
  [PASS       ] leaf      leaf T = SHA-256(0x00 ‖ JCS(leafMessage)) = 615e7760dc3c6dbc10792408ff75c4d2984d6a3ae784fa89b8ac452d00bb0fea
  [PASS       ] batch     leaf folds through 1 step(s) to the signed batch_root bd4243d80f95309356097f9ed988ab0834243e45d44ec5f979fcac31766f6f61; flush e0567078-9fa7-4cd2-a979-58e36a42eefa is in the anchor bundle
  [PASS       ] aggregate aggregateRoot f0abe630454a1f5140c687dbc6ac4a05420eac8e67f41d910451d2aa69262cb2 recomputed from 1 tier-1 flush(es) (makeLeafV2 → buildTreeV3 → wrap)
  [PASS       ] anchor    genuine anchor from 0.0.3923341 at seq 309269, consensus 1791614183.102338104; aggregateRoot matches

  topic 0.0.10416909 via https://mainnet-public.mirrornode.hedera.com
  anchorId d59658dd-e087-4363-922c-becb76e51494
  anchor seq 309269, consensus 1791614183.102338104, payer 0.0.3923341, aggregateRoot f0abe630454a1f5140c687dbc6ac4a05420eac8e67f41d910451d2aa69262cb2
  searched: sequences [309250-309288], time 2026-10-10T06:21:12.393Z .. 2026-10-10T07:36:12.393Z
  anchor payers (built-in): 0.0.3923341
```

How the recorded case differs from a live run:

* **Mirror window.** `mirror-messages.json` holds only the anchor message
  (sequence 309269), fetched from the public mirror by the operator. A live run
  reads every message in the window above, so its verdict can also reflect
  other genuine messages there (for example, a retry of the same anchor).
* **Keys file.** `rubric-keys.json` is rubric-web `main` at 0fa4b87, which has
  no `anchorPayers` field yet. A live run fetches whatever is published at the
  time. Once a fetched file lists `anchorPayers`, a list that omits
  `0.0.3923341` adds a warning. Per §4.3 step 5, a fetched list never changes
  which payers count.

### Your own records

Use any tiered warm record or completed DAR bundle you hold, plus its tier-2
anchor bundle. For a warm record, the anchor bundle is the `<anchorId>.json`
whose `tier1Flushes[]` contains the record's `stub.tier1FlushId`; once
backfilled, the record's `anchors.hcs.anchor_id` names it. For a DAR bundle it
is `extensions.rubricDar.bridge.hop2.anchorId`. Pass them as `--record` and
`--anchor-bundle` as above.

## Real mainnet fixtures (the end-to-end test)

`test/mainnet.test.ts` replays every case under `test/fixtures/mainnet/`
offline under the network guard. Each case must reach exit 0, both with the
fetched keys file and with `--keys`. The test also checks that a one-character
change to the real record gives `FAIL`.

* **`tiered/`** is present: the canary record above.
* **`dar/`** is still to do. A real completed DAR bundle has not been exported
  yet, so DAR is covered only by the synthetic golden vectors in
  `test/vectors/`.

To add a case, create one directory, for example `test/fixtures/mainnet/dar/`,
holding:

| File | Where it comes from |
|---|---|
| `record.json` | **tiered:** the warm record `<attestationId>.json` from `warm/` (or `cold/`) under `/mnt/tempus-attestation-store` (spec §3.4); a JSON array with exactly one tiered record is also fine. **dar:** the completed bundle `decisions/<YYYY-MM-DD>/<decisionId>.json` from the bundles directory. |
| `anchor-bundle.json` | The tier-2 anchor bundle `<anchorId>.json`. Look it up in the hot store (`bundles/`), then `warm/`, then `cold/`; `retention.py` moves it after 2 h and 7 days, and to S3 after 90 days. |
| `rubric-keys.json` | `https://rubric-protocol.com/.well-known/rubric-keys.json` as served when you record (or rubric-web's `.well-known/rubric-keys.json`). |
| `mirror-messages.json` | The mirror messages for the anchor, recorded with the command below. |

Record the mirror messages (this contacts only the public mirror):

```
node packages/replay-verify/scripts/record-mirror-window.mjs \
  test/fixtures/mainnet/dar/record.json \
  test/fixtures/mainnet/dar/anchor-bundle.json \
  > test/fixtures/mainnet/dar/mirror-messages.json
```

Then run `npm test`. A single raw mirror message, wrapped in a one-element
array, also works, as in `tiered/`.

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
