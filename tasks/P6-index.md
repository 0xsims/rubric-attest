# Task P6: Index every bundle type

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (§2, §3). Decision D1 is closed: extend `packages/attest-index` and keep the day-shard SQLite. Do not replace it.

The work spans two repos:
* `rubric-attest`: `packages/attest-index` (schema v2, `IndexSink`, backfill).
* `rubric-protocol`: the call sites in spec §3.4.

## Steps

1. Run the strategy subagent on this task before starting. Confirm whether a DAR bundle and the tiered stub it was bridged into share an `attestationId`. Record the answer in spec §3.1 (merge rule, or the `bridgedTo` column).
2. attest-index:
   * Schema v2 and the v1 → v2 migration (§3.1–3.2).
   * The `anchors` table.
   * `AttestationRow` / `AnchorRow` types and the new queries.
   * `IndexSink` / `createIndexSink` (§3.4).
   * `IndexRow` and the four existing queries keep their signatures.
3. Backfill (§3.5):
   * Add a recogniser per bundle kind and `--kinds`.
   * Add the optional `--mirror` pass and the `byKind` / `conflicts` output.
4. rubric-protocol: add the six call sites in §3.4. Each one goes after the bundle file is durably written, and each is a single call.
5. Reviews:
   * crypto on the hook placement.
   * spec-guardian on the DAR paths.
   * safety-reviewer on each repo's staged diff. Commit on PASS.
   * Open one PR per repo. Do not merge.

## Accept criteria

- [ ] An existing v1 shard migrates to v2 in one transaction, and every row survives (count and `attestationId` set are unchanged). A v1 shard opened read-only is still queryable. A writer refuses a shard whose `user_version` is above 2.
- [ ] `packages/verify`, `packages/evidence` and `chain-fix/chain-report.mjs` compile and pass their tests with no source changes. `IndexRow` is unchanged, and the release is a minor version bump.
- [ ] The four existing DAR queries return the same results as before on a DAR-only fixture, and return no non-DAR rows on a mixed fixture.
- [ ] For each kind (tiered, direct, threshold, dar, anchor), a fixture bundle produces exactly one row through the sink and through backfill, and the two rows are equal.
- [ ] `leafHash` is always alg-prefixed. A test proves a `sha256:` leaf and a `sha3-256:` leaf with the same hex are not treated as equal.
- [ ] Late fields are only filled, never changed:
  - Writing `anchorId`/`aggregateRoot`/`hcsSequence`/`hcsConsensusTs` onto NULL fills them.
  - Writing a different non-null value leaves the row unchanged and is counted as a conflict.
  - Re-running backfill twice gives byte-identical shard query results.
- [ ] No code path writes a wall-clock time into `hcsConsensusTs`. Proven by a grep in the PR plus a test of the backfill `--mirror` pass against a recorded mirror response.
- [ ] An index failure never affects a bundle:
  - With the index directory read-only, or a shard locked past `busy_timeout`, every rubric-protocol bundle write still succeeds.
  - The bundle bytes and signatures are identical to a run with the sink disabled, and `onError` is called.
  - Tested against the compiled build, per rubric-protocol CLAUDE.md.
- [ ] Two writer processes (server and aggregator) writing the same day-shard concurrently lose no rows. Run a test with ≥10k events per process.
- [ ] Without `--mirror`, backfill makes zero network requests, verified with a fetch/socket guard in the test.
- [ ] A shard key is never the index write time. A test writes a row for a bundle issued yesterday and checks it lands in yesterday's shard.
- [ ] safety-reviewer PASS recorded for both PRs.
