# Task P7: Standalone replay verifier

Read CLAUDE.md. The spec is `docs/specs/attestation-index-and-replay.md` (§2.4–2.6, §4). Decision D2 is closed: a standalone package with zero calls to our API. It does not depend on P6.

## Steps

1. Run the strategy subagent on this task. Then, with the crypto subagent:
   * Pick the ML-DSA-65 library.
   * Document the exact signed byte string for each bundle kind in spec §4.5, with rubric-protocol file:line references.
   * Confirm the §2.5 byte constructions (including `makeLeafV2` and the hex-string wrap) against the code.
   * Resolve spec §6 O6: read topic 0.0.10416909's `submit_key` and its `timestamp.from` from the mirror. If there is no key, or if any anchor messages were posted before `timestamp.from`, get the operator payer accounts from the owner. Board review is needed if a pinned list is published.

   Write no verifier code until §4.5 is filled in and O6 has an answer.
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
  - [ ] a forged anchor message with a matching `anchorId` from a non-pinned payer on a topic without `submit_key`: excluded. With no genuine message present, the result is `UNSUPPORTED` / `ANCHOR_ORIGIN_UNVERIFIED`, exit 3, never exit 0.
  - [ ] a topic that now has a `submit_key`, plus a matching message from a non-pinned payer whose `consensus_timestamp` is before the key's `timestamp.from`: excluded. With no other genuine message, the result is exit 3, never exit 0.
  - [ ] two genuine messages with the same `anchorId` and conflicting `aggregateRoot`: `FAIL` / `DUPLICATE_ANCHOR_CONFLICT`, exit 1
- [ ] Two genuine messages with the same `anchorId` and the same `aggregateRoot` (retry) give `PASS`, and the earliest `consensus_timestamp` is reported.
- [ ] A chunked anchor message (≥1024 bytes) with chunks returned out of order reassembles and verifies.
- [ ] Without a stored sequence number, the anchor is found by the `anchoredAt ± 15 min` search across at least two `links.next` pages (recorded fixture).
- [ ] The report always lists all five steps, and a step that did not run is never shown as `PASS`.
- [ ] The README states the trust model plainly: the keys come from rubric-protocol.com over TLS (or are pinned with `--keys`), and rotated keys are unsupported until spec §6 O2 is decided.
- [ ] safety-reviewer PASS recorded.
