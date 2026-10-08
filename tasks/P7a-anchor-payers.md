# Task P7a: Publish `anchorPayers` in the keys file

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (D4, §2.6, §4.3 step 5). Decision D4 is closed: topic 0.0.10416909 is immutable with no submit key, so anchor origin is a pinned payer list, currently `0.0.3923341`, published as `anchorPayers` in `https://rubric-protocol.com/.well-known/rubric-keys.json`.

The work is in `rubric-protocol`: `scripts/gen-rubric-keys.sh`, which generates the static file served by nginx (`ops/nginx-rubric-protocol.conf:487-492`). P7 does not wait for this task; until it ships, the verifier uses its hardcoded fallback.

## Steps

1. Run the strategy subagent on this task.
2. Run the board subagent before changing the file. The keys file is a published format, and spec §6 O6 sent a published pinned list to the board.
3. Find every consumer of `rubric-keys.json` (both repos, the site, the SDKs) and confirm each one tolerates an unknown top-level field. Record the list in the PR.
4. Change `scripts/gen-rubric-keys.sh` to emit `"anchorPayers": ["0.0.3923341"]` as a top-level field. Keep `format: "rubric-keys/1"`, and leave `signers` and `attestation` unchanged.
5. Reviews:
   * crypto on the diff.
   * safety-reviewer before commit, then commit on PASS.
   * Open a PR. Do not merge or deploy the file; a human deploys it.

## Accept criteria

- [ ] Board review recorded in the PR.
- [ ] The generated file has `anchorPayers` equal to `["0.0.3923341"]`: an array of Hedera account ID strings in `0.0.<n>` form, with no duplicates.
- [ ] Apart from `anchorPayers` and `updatedAt`, the generated file is byte-identical to the current one (diff in the PR).
- [ ] The value equals the P7 verifier's hardcoded fallback and the P8 drift-check default, and a comment in the script names all three places that must change together.
- [ ] Every consumer from step 3 still passes its tests against the new file.
- [ ] Adding or removing a payer later is a one-line change to the script, documented in its header.
- [ ] safety-reviewer PASS recorded.
