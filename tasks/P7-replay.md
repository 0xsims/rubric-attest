# Task P7: Standalone replay verifier

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (§2.4–2.6, §4). Decision D2 is closed: a standalone package with zero calls to our API. It does not depend on P6.

## Steps

1. Run the strategy subagent on this task. Then, with the crypto subagent:
   * Pick the ML-DSA-65 library.
   * Document the exact signed byte string for each bundle kind in spec §4.5, with rubric-protocol file:line references.
   * Confirm the §2.5 byte constructions (including `makeLeafV2` and the hex-string wrap) against the code.
   * Anchor origin is closed (spec D4): the topic has no submit key and never can, so origin is the pinned payer list only. Read `anchorPayers` from the keys file, with the hardcoded fallback `["0.0.3923341"]` (§4.3 step 5). Publishing the field is `tasks/P7a-anchor-payers.md`; P7 does not wait for it.

   Write no verifier code until §4.5 is filled in.
2. Generate golden vectors from rubric-protocol's own code (`spec-merkle.ts`, `merkle.ts`, `canonical.ts`, the signer) and commit them under `packages/replay-verify/test/vectors/`:
   * batch trees of 1, 2, 3, 4, 5 and 7 leaves;
   * aggregate trees of 1, 2 and 3 flushes;
   * wrap;
   * one signed tiered record;
   * one signed DAR bundle.
3. Implement `packages/replay-verify` per §4. It must not import any other `@rubric-protocol/*` package. Use one `fetch` wrapper that enforces the §4.2 allowlist.
4. Reviews:
   * crypto and spec-guardian on the diff.
   * safety-reviewer before commit, then commit on PASS.
   * Open a PR. Do not merge or publish (the release subagent comes before any publish).

## Accept criteria

- [ ] `package.json` has no `@rubric-protocol/*` dependency, and a test asserts this.
- [ ] Network allowlist:
  - Under a guard that fails on any request outside §4.2, verifying a real historical mainnet tiered record and a real DAR bundle (fixtures committed, with their tier-2 anchor bundles) returns exit 0.
  - Any attempt to call `rubric-protocol.com/v1/*`, the keys file's `attestation.verify` URL, or `mainnet.mirrornode.hedera.com` throws.
- [ ] With `--keys` given, the run makes zero requests to rubric-protocol.com.
- [ ] Golden vectors from step 2 all reproduce bit-for-bit.
- [ ] Negative vectors each give the stated result, and none gives exit 0:
  - [ ] one byte changed in `leafMessage`: `FAIL`, exit 1
  - [ ] one proof sibling changed: `FAIL`, exit 1
  - [ ] a `forestRoot` changed in the anchor bundle: `FAIL`, exit 1
  - [ ] the anchor bundle paired with the wrong anchor message (different `anchorId`): `FAIL`, exit 1
  - [ ] signature by a different valid ML-DSA-65 key: `FAIL`, exit 1
  - [ ] the keys file's key for `envelope.issuer_node_region` differs from the embedded `publicKey` (rotated key): `UNSUPPORTED` / `KEY_NOT_PUBLISHED`, exit 3
  - [ ] `treeVersion: 2`, or any `alg.levels` that differs from spec §2.4: `UNSUPPORTED`, exit 3
  - [ ] mirror returns 5xx/429 past retries, or the keys URL is unreachable: `UNAVAILABLE`, exit 4
  - [ ] DAR core edited after signing: `FAIL`, exit 1
  - [ ] a valid signed envelope from batch A, combined with a leaf and proof from batch B (and a consistent forged anchor bundle): `FAIL`, exit 1, because the fold does not equal `envelope.batch_root`
  - [ ] `tier1Flushes[]` entry whose `flushId` or `itemCount` disagrees with the signed envelope: `FAIL`, exit 1
  - [ ] `merkle_proof` and `merkle_proof_directions` of different lengths: `FAIL`, exit 1
  - [ ] a valid signature under an embedded `publicKey` that is not in the keys file (self-signed forgery): exit 3, never exit 0
  - [ ] a forged anchor message with a matching `anchorId` from a non-pinned payer: excluded. With no genuine message present, the result is `UNSUPPORTED` / `ANCHOR_ORIGIN_UNVERIFIED`, exit 3, never exit 0.
  - [ ] a chunk whose `payer_account_id` differs from the account in its `initial_transaction_id`: discarded before reassembly.
  - [ ] a genuine chunked message that is still missing a chunk after a forged chunk is dropped: does not count, exit 3, never exit 0.
  - [ ] a keys file whose `anchorPayers` is `[]`: no genuine payer, exit 3, never exit 0, even though the fallback list would match.
  - [ ] a keys file whose `anchorPayers` is `null`, `"0.0.3923341"`, `[3923341]` or `["0.0.3923341-abcde"]`: `UNSUPPORTED` / `ANCHOR_PAYERS_INVALID`, exit 3, never exit 0, with no fallback.
  - [ ] a keys file whose `anchorPayers` is `["0.0.39"]`: no prefix or substring match against payer `0.0.3923341`, exit 3, never exit 0.
  - [ ] two genuine messages with the same `anchorId` and conflicting `aggregateRoot`: `FAIL` / `DUPLICATE_ANCHOR_CONFLICT`, exit 1
- [ ] A genuine single-part anchor message with no `chunk_info` from the pinned payer gives `PASS`.
- [ ] A genuine chunked anchor message plus a forged chunk from a non-pinned payer that claims the same `initial_transaction_id` gives `PASS`: the forged chunk is discarded before reassembly.
- [ ] A genuine message plus a forged message with the same `anchorId` and a different `aggregateRoot` from a non-pinned payer gives `PASS`: the forgery is ignored and cannot cause `DUPLICATE_ANCHOR_CONFLICT`.
- [ ] Pinned list source: a keys file with `anchorPayers` uses that list and the report says `keys-file`; a keys file without the field uses the fallback and the report says `fallback`. A test asserts the fallback is exactly `["0.0.3923341"]`.
- [ ] The verifier never requests `/api/v1/topics/<topic>` (topic info); the network guard rejects it.
- [ ] Two genuine messages with the same `anchorId` and the same `aggregateRoot` (retry) give `PASS`, and the earliest `consensus_timestamp` is reported.
- [ ] A chunked anchor message (≥1024 bytes) with chunks returned out of order reassembles and verifies.
- [ ] Without a stored sequence number, the anchor is found by the `anchoredAt ± 15 min` search across at least two `links.next` pages (recorded fixture).
- [ ] The report always lists all five steps, and a step that did not run is never shown as `PASS`.
- [ ] The README states the trust model plainly: the keys come from rubric-protocol.com over TLS (or are pinned with `--keys`), and rotated keys are unsupported until spec §6 O2 is decided. It also states that topic 0.0.10416909 accepts messages from anyone, so an anchor is genuine only because its payer is in `anchorPayers` (or the fallback).
- [ ] safety-reviewer PASS recorded.
