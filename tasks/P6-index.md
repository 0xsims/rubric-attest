# Task P6: Anchor links in the attestation jsonl

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (§3, D5). Decision D5 is closed. The canonical write-time index is the existing append-only `/mnt/tempus-attestation-store/bundles/attestation-index.jsonl`, written by `rubric-protocol/src/api/index-writer.ts`. Do not add a new write hook, and do not create a third index. D1's schema-v2-for-every-kind, `IndexSink` and `anchors` table are dropped.

The work spans two repos:
* `rubric-protocol`:
  * the reader filter;
  * the `reconcile-rt.py` passthrough;
  * `appendAnchorLinks` and the anchor-job call;
  * `scripts/anchor-links-backfill.mjs`;
  * the decision-verify route.
* `rubric-attest`: `packages/attest-index` (additive schema v2, `rubric-index-ingest`).

## Steps

1. Run the strategy subagent on this task before starting. Then confirm the following and record the answers in spec §3:
   * Whether a DAR bundle and the tiered stub it was bridged into share an `attestationId` (§3.5: join rule, or a `bridgedTo` column).
   * The filesystem type of `/mnt/tempus-attestation-store`, and that concurrent `O_APPEND` writes of ≤ 64 KiB from the server and aggregator processes do not interleave on it. If they can, stop and report.
   * Every reader and writer of the jsonl, checked against the §3.1 lists. Include scripts, cron jobs and anything outside `src/`.
   * Where the warm-record anchor pointer names its `flushId`, for the §3.4 fallback.
   * How many genuine historical anchors on the mirror have an `anchorId`, or a bundle `flushId`, that is not a lowercase UUID. They would be `badId` in the backfill and `MISSING_FROM_INDEX` in P8. Report a non-zero count to the owner.
   * That no production jsonl line has a `kind` key. A human runs a read-only count, and it must be 0.
   * The latency of the three whole-file readers (`auditor-endpoint.ts:95`, `credentials-endpoint.ts:73`, `reputation-route.ts:486`), measured on a synthetic file 3× the production size. Record it in the PR.
2. Reader compatibility in rubric-protocol (§3.2). This ships first and alone:
   * Add `isAttestationLine(rec)` and call it in every reader from step 1.
   * Make `reconcile-rt.py` pass any line with a `kind` field through byte-identical.
   * Open the PR. It is deployed before any link line is written.
3. Anchor-job links (§3.3):
   * Add `appendAnchorLinks` in `index-writer.ts`, with the same `INDEX_PATH`, ≤ 64 KiB whole-line appends, and non-fatal behaviour.
   * Call it from the `backfillWarmAnchors` loop in `tier2HCSWriter`, and from the retry drainer.
   * Add a `linksSkippedNoStub` counter.
   * It stays behind an env flag that defaults off. A human turns it on after board review.
4. Mirror backfill (§3.4): add `scripts/anchor-links-backfill.mjs`. It is a dry run by default. `--apply` appends, and it never rewrites.
5. attest-index (rubric-attest, §3.5):
   * Add the additive schema v2 (`ALTER TABLE … ADD COLUMN`, `user_version = 2`) and the `AnchoredRow` type.
   * Add `rubric-index-ingest`.
   * `IndexRow` and the four existing queries keep their signatures.
6. decision-verify route (rubric-protocol, §3.5):
   * Read the anchor columns before `gate()`.
   * If `anchorRef.sequenceNumber` is not in `hcsSequences`, or `anchorConflict = 1`, return `503 "anchor record conflict"`, with `note: "payment not settled"`.
   * The success response shape is unchanged.
7. Reviews:
   * crypto on the anchor-link placement and the backfill's root check.
   * spec-guardian on the DAR join and the decision-verify change.
   * safety-reviewer on each repo's staged diff. Commit on PASS.
   * One PR for the reader filter, then one per repo for the rest. Do not merge.
8. Before production: run the board subagent before the env flag is turned on, and before the first `--apply` run. Anchor-link lines can never be removed. A human runs both. Do not run `--apply` against production, and do not turn the flag on.

## Accept criteria

**The jsonl stays one index**
- [ ] No new index file, table or write hook anywhere. A grep in the PR shows `INDEX_PATH` is the only file `appendAnchorLinks` writes, and no `IndexSink` or `anchors` table exists.
- [ ] Tier-1, direct and threshold lines are byte-identical to a run without P6, tested against the compiled build.

**Readers**
- [ ] Each reader from step 1 has a test on a jsonl fixture with interleaved anchor-link lines. Its output equals the output on the same fixture with the link lines removed. This covers counts, CSV export rows, auditor results, credentials lookup by `id`, and reputation's latest-id sample.
- [ ] `reconcile-rt.py` on a fixture with link lines leaves every link line byte-identical, and still fixes `rt` on attestation lines.

**Anchor-job writes**
- [ ] One link line per covered attestation, with `kind: "anchor-link"`, `v: 1`, `id`, `anchorId`, `aggregateRoot`, `topic`, `hcsSequence` (decimal string), `hcsConsensusTs: null`, `source: "anchor-job"` and `writtenAt`. There is no `anchoredAt`.
- [ ] Merge: an anchor-job line plus a backfill line for the same group (different `source` and `writtenAt`) gives no conflict. Only `aggregateRoot`, `topic` and `hcsConsensusTs` can conflict.
- [ ] Earlier lines are never rewritten. A test checks that, after the anchor job and a backfill run, the file's earlier bytes (up to the old length) are unchanged.
- [ ] A retry re-anchor writes a second group with its own `hcsSequence`. The anchor is the set of both groups, and it is not a conflict.
- [ ] Out-of-order retry: the retry links S2 first, then the backfill appends the lower S1. After ingest, `hcsSequences` is `["S1","S2"]`, there is no conflict, and decision-verify passes for a DAR whose `anchorRef.sequenceNumber` is S2 and for one whose value is S1.
- [ ] With the jsonl read-only or the append throwing:
  - the anchor message, the anchor bundle, the warm-record pointers and the signatures are identical to a run with links disabled;
  - the error is counted.
- [ ] A missing `stubs-<flushId>.json` increments `linksSkippedNoStub` and writes nothing for that flush.
- [ ] No code path writes wall-clock time into `hcsConsensusTs`. Proven by a grep and a test.
- [ ] Two processes appending concurrently (≥ 10k lines each, with mixed attestation and link lines) produce no torn or interleaved lines.

**Mirror backfill**
- [ ] Against a recorded mirror fixture:
  - a dry run writes nothing and prints the same counts as `--apply`;
  - a second `--apply` appends zero lines.
- [ ] An anchor whose tier-2 bundle `aggregateRoot` differs from the mirror message counts as `rootMismatch`, and gets no links.
- [ ] Messages from unpinned payers (D4) are never linked.
- [ ] Path safety: these each count as `badId`, cause no file reads under, or writes to, any path built from the value, and append nothing:
  - an `anchorId` or `flushId` that is not a lowercase UUID, including `../x`, an absolute path, an embedded `/` or NUL, uppercase, or an extra suffix;
  - a resolved path outside the hot, warm or cold root.
  A test checks this with a filesystem spy.
- [ ] Ids are resolved from the stub file, or from warm records when the stub file is gone. Unresolvable ids are counted and never guessed.
- [ ] An anchor-job line with `hcsConsensusTs: null` gets a backfill line whose merged result has the mirror `consensus_timestamp`.
- [ ] A network guard shows only the mirror host is contacted.

**attest-index ingest**
- [ ] v1 → v2 is `ADD COLUMN` only. Every row survives (the count and the `attestationId` set are unchanged). A read-only v1 shard is still queryable. A writer refuses `user_version` > 2.
- [ ] `packages/verify`, `packages/evidence` and `chain-fix/chain-report.mjs` compile and pass with no source changes. The release is a minor bump.
- [ ] On a fixture, after ingest, a DAR row's anchor columns equal what the merged anchor-link set for its tiered id says: `anchorId`, `aggregateRoot`, the ascending `hcsSequences`, and the lowest group's `hcsConsensusTs`.
- [ ] Anchor columns are derived. They are recomputed from the full link set whenever it changes, so the index never disagrees with the jsonl. A §3.2 conflict sets `anchorConflict = 1` and is reported.
- [ ] Ingest never opens the jsonl for writing. Re-running ingest gives byte-identical query results. A cursor whose line no longer has the recorded `id` triggers a full, idempotent re-ingest.
- [ ] Ingest makes zero network requests.

**decision-verify**
- [ ] If `anchorRef.sequenceNumber` is not in a non-null `hcsSequences`, or `anchorConflict = 1`, the result is `503 {error: "anchor record conflict", decisionId, note: "payment not settled"}` before `gate()`. `gate()` and `__settle()` are never called (a spy checks). Tested against the compiled build.
- [ ] With `hcsSequences` NULL, the route's behaviour is identical to today's.
- [ ] Membership compares canonical decimal strings. An `anchorRef.sequenceNumber` given as the number `123` matches `"123"`. A non-integer value gives the conflict 503.
- [ ] `anchorRef.root` (the DAR leaf) is never compared with the index `aggregateRoot`.

**Reviews**
- [ ] Board review recorded before the flag is turned on and before the first production `--apply`.
- [ ] safety-reviewer PASS recorded for every PR.
