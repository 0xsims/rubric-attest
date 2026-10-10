# Task P7a: Publish `anchorPayers` in the keys file

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (D4, §2.6, §4.3 step 5). Decision D4 is closed: topic 0.0.10416909 is immutable with no submit key, so anchor origin is a pinned payer list, currently `0.0.3923341`, published as `anchorPayers` in `https://rubric-protocol.com/.well-known/rubric-keys.json`.

The published file is `.well-known/rubric-keys.json` in the **rubric-web** repo, deployed by its `deploy-site.sh` (rsync `--delete` to `/var/www/rubric`, served by nginx, `ops/nginx-rubric-protocol.conf:485-490`). `rubric-protocol/scripts/gen-rubric-keys.sh` predates it and produces a different file (no retired signers, old note, a new attestation per run); the board disabled it on 2026-10-10. P7 does not wait for this task: its built-in list is the trust root either way (§4.3 step 5).

## Steps

1. Run the strategy subagent on this task.
2. Run the board subagent before changing the file. The keys file is a published format, and spec §6 O6 sent a published pinned list to the board.
3. Find every consumer of `rubric-keys.json` (both repos, the site, the SDKs) and confirm each one tolerates an unknown top-level field. Record the list in the PR, including what could not be searched.
4. In rubric-web, add `"anchorPayers": ["0.0.3923341"]` as a top-level field of `.well-known/rubric-keys.json`. Keep `format: "rubric-keys/1"`, and leave `signers`, `note` and `attestation` unchanged. Do not re-attest: the attestation covers `signers` only (`covers: "signers"`), and `anchorPayers` stays unattested.
5. In rubric-protocol, make `scripts/gen-rubric-keys.sh` exit non-zero before doing anything, with a message that names the rubric-web file.
6. Reviews:
   * crypto on the diff.
   * safety-reviewer before commit, then commit on PASS.
   * Open the PRs. Do not merge or deploy the file; a human deploys it.

## Accept criteria

- [ ] Board review recorded in the PR.
- [ ] The file has `anchorPayers` equal to `["0.0.3923341"]`: an array of Hedera account ID strings in `0.0.<n>` form, with no duplicates.
- [ ] Apart from `anchorPayers` and `updatedAt`, the file is byte-identical to the current one (diff in the PR), and SHA3-256 of the compact JSON `signers` array still equals `attestation.payloadSha3`.
- [ ] The value equals the P7 verifier's built-in list and the P8 drift-check default. The disabled script's header names all three places that must change together.
- [ ] Every consumer from step 3 still passes its tests against the new file.
- [ ] Adding a payer later is a one-line change to the rubric-web file. Payers are never removed or reordered (§2.6).
- [ ] safety-reviewer PASS recorded.

## Before a human deploys (board, 2026-10-10)

- [ ] The §4.3 step 5 precedence rule (built-in list is the trust root) is merged.
- [ ] SHA3-256 of the live compact `signers` array still equals `payloadSha3`.
- [ ] After deploy, re-fetch the live file: `anchorPayers` is `["0.0.3923341"]` and the five retired `legacy-shared-2026h1` entries are still present.
