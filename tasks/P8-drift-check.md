# Task P8: Anchor drift check

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (§2.4, §5). Decision D3 is closed: a standalone script in this repo, not in rubric-assert. A human wires it into rubric-assert; do not edit rubric-assert or any crontab. Depends on P6 (the `anchors` table).

## Steps

1. Run the strategy subagent on this task.
2. Resolve spec §6 O3 (are there several publishers on topic 0.0.10416909?) by sampling the last 500 `RUBRIC_TIER2_ANCHOR` messages from the mirror. Record the answer in the spec. Until it is resolved, `CHAIN_FORK` is a warning.
3. Implement `tools/drift-check/drift-check.mjs` per §5. It opens the index read-only, makes no writes except `--state`, and makes no calls to our API.
4. Add a `tools/drift-check/README.md` with the exact command and exit codes, for the human wiring it into rubric-assert.
5. Run safety-reviewer before commit, then commit on PASS. Open a PR. Do not merge.

## Accept criteria

- [ ] Each finding code in spec §5.3 has a recorded-fixture test (mirror responses plus an index fixture) that produces exactly that finding:
  - `CHAIN_GAP`
  - `CHAIN_FORK`
  - `SEGMENT_START`
  - `MISSING_FROM_INDEX`
  - `MISSING_FROM_MIRROR`
  - `ROOT_MISMATCH`
  - `INDEX_PENDING`
  - `DUPLICATE_ANCHOR`
  - `DUPLICATE_ANCHOR_CONFLICT`
  - `FOREIGN_ANCHOR`
- [ ] A `FOREIGN_ANCHOR` message never satisfies a chain link, an index match, or a `MISSING_FROM_MIRROR` check. The operator accounts are passed in via `--operator <acct>` (repeatable) and are not hard-coded.
- [ ] A healthy fixture exits 0. It includes segment starts from a restart, a missed quorum, and a retry-drainer anchor with no `prev*` fields.
- [ ] Drift exits 1 and the JSON lists every finding with `anchorId`, `sequence_number` and code.
- [ ] Anchors younger than `--min-age` (default 600 s) are ignored on both sides, using mirror `consensus_timestamp` and index `anchoredAt`. Tests use a fixed clock at 599 s and 601 s.
- [ ] Exit 3, not 1, when the mirror is unreachable, a page returns 429/5xx past 5 retries, or pagination stops before the window is covered.
- [ ] Chunked anchor messages delivered out of order are reassembled. Messages of other types on the topic are ignored.
- [ ] `--state` resumes from the last fully processed sequence number, and a second run with no new messages makes one mirror request per page in the overlap window only.
- [ ] Opening the index read-only never creates or migrates a shard. A test checks the index directory's mtime and file list are unchanged.
- [ ] Network guard: only the configured mirror host is contacted.
- [ ] One live read-only run against mainnet over the last 24 h is pasted into the PR description, with its finding counts by code.
- [ ] safety-reviewer PASS recorded.
