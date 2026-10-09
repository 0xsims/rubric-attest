# Task P8: Anchor drift check

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (§2.4, §3.2, §5, D4, D5). Decision D3 is closed: a standalone script in this repo, not in rubric-assert. A human wires it into rubric-assert; do not edit rubric-assert or any crontab. Depends on P6. The index side is the anchor-link lines in `attestation-index.jsonl` (D5), read directly. Not attest-index, and no other index.

## Steps

1. Run the strategy subagent on this task.
2. Resolve spec §6 O3 (are there several publishers on topic 0.0.10416909?) by sampling the last 500 `RUBRIC_TIER2_ANCHOR` messages from the mirror. Record the answer in the spec. From the same sample, record every `payer_account_id` seen. If any anchor that looks genuine was paid by an account other than 0.0.3923341, stop and report to the owner before implementing, because D4 would mark it `FOREIGN_PAYER`. Until it is resolved, `CHAIN_FORK` is a warning.
3. Implement `tools/drift-check/drift-check.mjs` per §5:
   * `--index` is the jsonl path. It opens the jsonl read-only once and reads it to EOF.
   * It reads only `kind: "anchor-link"` lines, merged by the §3.2 rule.
   * It makes no writes except `--state`, and no calls to our API.
   * It has no dependency on `@rubric-protocol/attest-index`.
4. Add a `tools/drift-check/README.md` with the exact command and exit codes, for the human wiring it into rubric-assert.
5. Run safety-reviewer before commit, then commit on PASS. Open a PR. Do not merge.

## Accept criteria

- [ ] Each finding code in spec §5.3 has a recorded-fixture test (mirror responses plus a jsonl fixture with mixed attestation and anchor-link lines) that produces exactly that finding:
  - `CHAIN_GAP`
  - `CHAIN_FORK`
  - `SEGMENT_START`
  - `MISSING_FROM_INDEX`
  - `MISSING_FROM_MIRROR`
  - `ROOT_MISMATCH`
  - `SEQ_MISMATCH`
  - `LINK_CONFLICT`
  - `INDEX_PENDING`
  - `DUPLICATE_ANCHOR`
  - `DUPLICATE_ANCHOR_CONFLICT`
  - `FOREIGN_PAYER`
- [ ] Anchor origin follows spec D4. The topic has no submit key, so there is no submit-key path in the code.
- [ ] Every message or chunk from an unpinned payer is `FOREIGN_PAYER` and exits 1, whatever its type, including a non-anchor message. The origin check runs per chunk before reassembly, as in P7.
- [ ] A genuine chunked anchor plus a forged chunk that claims its `initial_transaction_id` gives exactly one `FOREIGN_PAYER` finding. The genuine anchor still links in the chain and matches the index, with no `MISSING_FROM_MIRROR` or `CHAIN_GAP`.
- [ ] A `FOREIGN_PAYER` message never satisfies a chain link, an index match, a `MISSING_FROM_MIRROR` check, or a duplicate check. A forged message with a genuine `anchorId` and a different `aggregateRoot` gives `FOREIGN_PAYER`, not `DUPLICATE_ANCHOR_CONFLICT` or `ROOT_MISMATCH`.
- [ ] Any break in the `prevAnchorId` chain is `CHAIN_GAP`, including a `prevAnchorId` that only matches a `FOREIGN_PAYER` message.
- [ ] Pinned payers: with no `--anchor-payer` the list is `["0.0.3923341"]`, and a test asserts it equals the P7 verifier's fallback. `--anchor-payer <acct>` (repeatable) replaces the default, and a value not matching `^0\.0\.[0-9]+$` exits 2. The keys file is not fetched.
- [ ] A healthy fixture exits 0. It includes segment starts from a restart, a missed quorum, and a retry-drainer anchor with no `prev*` fields.
- [ ] Drift exits 1 and the JSON lists every finding with `anchorId`, `sequence_number` and code.
- [ ] Anchor-link merging follows spec §3.2:
  - Groups are keyed by `(id, anchorId, hcsSequence)`. Only `aggregateRoot`, `topic` and `hcsConsensusTs` are merged (first non-null wins). `v`, `source` and `writtenAt` never conflict.
  - A retry group with a different `hcsSequence` is not a conflict, as long as each sequence matches a genuine mirror message. This holds in either order: S2 linked before S1, or S1 before S2.
  - A genuine mirror sequence for a linked `anchorId` that has no group yet is `INDEX_PENDING`, not drift.
  - Attestation lines (no `kind`) and unknown `kind`s are ignored.
- [ ] Anchors younger than `--min-age` (default 600 s) are ignored on both sides, using mirror `consensus_timestamp` and the earliest anchor-link `writtenAt` for the `anchorId`. A retry link written hours after the original bundle is still aged by its own `writtenAt`. Tests use a fixed clock at 599 s and 601 s.
- [ ] Window scoping (spec §5.2 step 4):
  - A jsonl with backfilled links for months of historical anchors, run with the default 24 h window, gives no `MISSING_FROM_MIRROR`, `SEQ_MISMATCH` or `INDEX_PENDING` for those anchors.
  - An anchor-job link with a recent `writtenAt`, whose mirror message is only outside the window, is found by the by-sequence lookup (including a chunked message) and is not reported.
  - A link whose by-sequence lookup returns nothing genuine is `MISSING_FROM_MIRROR`.
  - A second run resumed with `--state`, with no new messages or links, reports no findings and does not re-check anchors already checked.
  - An anchor that crosses `cut` between two runs is checked in exactly one of them.
- [ ] Exit 3, not 1, when the mirror is unreachable, a by-sequence lookup fails past retries, a page returns 429/5xx past 5 retries, or pagination stops before the window is covered.
- [ ] Chunked anchor messages delivered out of order are reassembled. Messages of other types from pinned payers are ignored.
- [ ] `--state` resumes from the last fully processed sequence number, and a second run with no new messages makes one mirror request per page in the overlap window only.
- [ ] The jsonl is never written, renamed or locked. A test checks its size, mtime and inode are unchanged after a run.
- [ ] A trailing line with no newline (an append in progress) is ignored, not reported. Lines appended during the run are not read.
- [ ] If the jsonl is replaced (`reconcile-rt.py`'s `os.replace`) mid-run, the run reads only the original file to EOF. Tested with a replace between two reads.
- [ ] A 105k-line jsonl is processed in a stream. Per-anchor state is one summary per `anchorId`. The only per-attestation state is the `id → first anchorId` map, and full lines are never kept.
- [ ] Network guard: only the configured mirror host is contacted.
- [ ] One live read-only run against mainnet over the last 24 h is pasted into the PR description, with its finding counts by code.
- [ ] safety-reviewer PASS recorded.
