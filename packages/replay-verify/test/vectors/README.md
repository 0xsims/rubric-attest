# Golden vectors for `@tenprint/verify`

These files were generated from **rubric-protocol's own code**, not from this
package, and `test/vectors.test.ts` checks that this package reproduces every
value bit-for-bit.

## Source

* rubric-protocol commit **54afb5a1** (`main`, "fix(aggregator): M39 retry
  drainer used require('crypto') in the ESM build (#72)"). The checkout used was
  the worktree `rp-p7a-anchor-payers` at 2a96596c, which is 54afb5a1 plus one
  change to `scripts/gen-rubric-keys.sh` only; none of the files below differ.
* Compiled unchanged, with rubric-protocol's own TypeScript (5.9.3; `module`
  and `moduleResolution` `nodenext`, `target` `es2022`):
  * `src/verify/canonical.ts` (`canonicalize`)
  * `src/verify/merkle.ts` (`makeLeafV2`, `buildTreeV3`, `buildForest`)
  * `src/verify/spec-merkle.ts` (`buildTieredLeafMessage`, `leafHash`,
    `buildSpecTree`, `proofForLeaf`, `verifyProof`)
  * (`src/verify/bundle-types.ts` is pulled in for types only.)
* Signing: `@noble/post-quantum` **0.3.0** from rubric-protocol's
  `node_modules` (lockfile integrity
  `sha512-RrwI6QqgToSwhyN9E9p+xwKi39k9pDxLy5A60u+murRupwUiKRrIrHMhKEuaZQ20+aAITU3Z/ZHtZ0hC6EKT/w==`,
  the same as this repo's lockfile), called exactly as
  `RubricOracle.signCanonical` does (`oracle.ts:177-192`):
  `ml_dsa65.sign(secretKey, utf8(canonicalize(value)))`.

The generator is a throwaway script kept **outside both repositories**
(`/home/rubric-build/work/p7-vecgen/gen.mjs`, with its `tsconfig.json`):

```
node <rubric-protocol>/node_modules/typescript/bin/tsc -p /home/rubric-build/work/p7-vecgen/tsconfig.json
node /home/rubric-build/work/p7-vecgen/gen.mjs packages/replay-verify/test/vectors
```

Before writing any file, the generator rebuilt rubric-protocol's ratified
vectors (`test/vectors/tiered-golden-vectors-v0_1.json`, cases with 1, 3 and 4
leaves) with the compiled `spec-merkle.ts` and asserted that leaves, roots and
proofs match. `ratified-crosscheck.json` keeps those values so this package's
test re-checks them with its own code.

## Files

| File | Contents |
|---|---|
| `jcs.json` | JCS inputs (as JSON text) and `canonicalize()` output: key order incl. non-BMP keys, number forms, string escapes. |
| `batch-trees.json` | Batch trees of 1, 2, 3, 4, 5 and 7 leaves: each leaf message, its canonical form, leaf hash, payload hash; the root; every proof (`merkle_proof`, `merkle_proof_directions`). |
| `aggregate-trees.json` | Aggregate trees of 1, 2 and 3 flushes: `makeLeafV2` preimages and hashes, the `buildTreeV3` root, and the wrapped `aggregateRoot` (as `tiered-aggregator.ts:553-561`). |
| `wrap.json` | `buildForest([{root}])` for several roots. |
| `ratified-crosscheck.json` | The 1-, 3- and 4-leaf ratified vectors. |
| `signed-tiered.json` | One signed tiered record: envelope, its JCS bytes, the ML-DSA-65 signature, a full warm record, its tier-2 anchor bundle and anchor message. |
| `signed-dar.json` | One completed DAR bundle in two variants, `tier1Batch` (signature source `tier1-batch`) and `tier2Federation` (source `tier2-federation`, three region signatures over `signedFields`), each with its anchor bundle and anchor message. |
| `test-keys.json` | The public halves and seeds of the TEST keys. |

## What is modelled rather than imported

`oracle.ts` (keystore, passphrase, KMS), `tier1-worker.ts` (a worker thread),
`tiered-aggregator.ts`, `attestation-publisher.ts`, `threshold-endpoint.ts` and
`dar-emit.ts` cannot be imported in isolation. So the **record shapes, the batch
envelope, the federation `signedFields`, the anchor message and the DAR bundle
wiring** are written by the generator to match those files at the line ranges
cited in the spec (§4.5); every hash, tree and signature in them is computed
by the imported code above. The DAR leaf `L` uses rubric-protocol's
`canonicalize` (dar-emit uses `@rubric-protocol/attest-decision`'s JCS, which is
the same for these inputs). The real-mainnet end-to-end test
(`test/mainnet.test.ts`) is what checks the wiring against production output.

## TEST keys only

Every signature here is made with ML-DSA-65 keys derived from **public seeds**
(`SHA-256("rubric-replay-verify TEST KEY <region> (not a real key)")`). They are
not, and must never be, listed in any real keys file. Signing is deterministic,
so `vectors.test.ts` also re-signs from the seed and expects the same bytes;
that is the known-answer gate for any `@noble/post-quantum` upgrade.
