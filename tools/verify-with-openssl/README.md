# verify-with-openssl

A bash script that checks a Rubric tier-2 proof bundle using only OpenSSL, jq and
coreutils. No TenPrint code runs during verification.

## What it checks

1. **Leaf.** `SHA-256(0x00 || JCS(hop0.leafMessage))` equals `leafHash`.
2. **Batch inclusion.** Folding `leafHash` up `hop1.path` with
   `SHA-256(0x01 || L || R)` gives `hop1.batchRoot`.
3. **Aggregate.** `hop1.batchRoot` is one of `hop2.tier1Flushes`, and the flush
   list recomputes to `hop2.aggregateRoot` (SHA3-256, treeVersion 3 only).
4. **Signed fields.** `federation.signedFields` is a `tier2-aggregate`
   `threshold-multisig` whose `aggregate_root`, `anchor_id`, `tier1_count` and
   `total_items` match the bundle.
5. **Signatures.** Each ML-DSA-65 signature (pure, empty context) verifies over
   `JCS(signedFields)`, and its public key is one published for that region in
   `rubric-keys.json`. Keys are compared as bytes. A key entry with no `status`
   field is treated as active, but an explicit `"status": null` is rejected as
   a malformed key file (exit 1). Keys with status `active` or `retired` are
   trusted, because retired keys still verify the anchors they signed. Any other
   status (`revoked`, `compromised` or anything else) is rejected, and the
   script prints the region, key id and status it rejected. The retired
   `legacy-shared-2026h1` key is published with the same bytes for every
   region, so anchors signed only with it cannot reach quorum: each key is
   counted once.
6. **Quorum.** At least 3 valid signatures from distinct regions with distinct
   keys. The threshold is fixed in the script and is not read from the bundle.

If you leave out `rubric-keys.json`, signatures are checked against the keys
inside the bundle. That only shows the signatures are well formed. It does not
show who made them, so the result line says so and the script exits 2.

## Requirements

- OpenSSL 3.5 or later (first release with ML-DSA-65). Check with
  `openssl list -signature-algorithms | grep ML-DSA-65`.
- jq
- coreutils (`od`, `base64`, `mktemp`, `wc`, `tr`)
- sed
- bash 4 or later

## Usage

```
verify-with-openssl.sh BUNDLE.json [rubric-keys.json]
```

Exit status:

- `0` pass: every check passed and the signers are bound to `rubric-keys.json`.
- `1` fail: a check failed, or the bundle or key registry is malformed. The
  script prints `RESULT: FAIL` and the reason.
- `2` unbound: no `rubric-keys.json` was given, so signers are not bound to
  published keys. The script also exits 2 if a required tool is missing or
  OpenSSL lacks sha3-256 or ML-DSA-65.

Run it on the included example from this directory:

```
./verify-with-openssl.sh examples/b5effad6-proof.json examples/rubric-keys.json
```

`examples/b5effad6-proof.json` is a canary record. It contains no customer data,
no payload and no payloadKey. `examples/rubric-keys.json` is a copy of the
published key registry.

Expected output:

```
Bundle: examples/b5effad6-proof.json
hop0  leaf
  PASS  SHA-256(0x00||JCS(leafMessage)) = leafHash
hop1  batch inclusion
  PASS  1-step path folds to batchRoot 2330b02b60015ae47b0d2d427cbe46e99a6be3c071f5bfea667b6661e82ca485
hop2  aggregate
  PASS  batchRoot is one of the 1 tier-1 flush roots
  PASS  flush list recomputes to aggregateRoot 419a9becb846d67eeb05514b92b18ca37a071e14c035bd9c25fc4c976f06fd27
federation
  PASS  signedFields is a tier2-aggregate threshold-multisig
  PASS  signedFields.aggregate_root = aggregateRoot
  PASS  signedFields.anchor_id = hop2.anchorId
  PASS  tier1_count matches flush list
  PASS  total_items matches flush list
  trusted keys: examples/rubric-keys.json
  PASS  us: ML-DSA-65 signature verifies
  PASS  sg: ML-DSA-65 signature verifies
  PASS  jp: ML-DSA-65 signature verifies
  PASS  quorum 3/3 distinct regions and keys

Not checked here: the HCS ledger anchor (fetch hcs.mirrorNodeUrl, base64-decode .message,
compare .aggregateRoot) and the optional payload commitment, which needs your record + payloadKey.
RESULT: PASS
```

## Checking a live proof

Fetch the proof bundle for an attestation ID and the current key registry. No
API key is needed:

```
curl -fsS https://tenprint.ai/verify/v1/proof/<id> -o proof.json
curl -fsS https://tenprint.ai/.well-known/rubric-keys.json -o rubric-keys.json
./verify-with-openssl.sh proof.json rubric-keys.json
```

Anonymous proofs may leave out `hop0.leafMessage` when it carries customer
fields. The script then prints `SKIP  no hop0.leafMessage; starting from
leafHash` and checks everything from `leafHash` upward.

A proof only has a tier-2 section once its batch has been aggregated and
anchored. Before then the script stops with `hop2.tier1Flushes missing`. Try
again later.

The key registry comes from the same operator as the proof. Get it once and keep
your own copy, or compare it with a copy from another source, so a later change
to the published keys is visible to you.

## Tamper test

Change `federation.signedFields.anchored_at` by one millisecond and run the
script again. In the example this moves `.831Z` to `.832Z`:

```
jq '.federation.signedFields.anchored_at |= sub("(?<d>[0-9])Z$"; "\(((.d|tonumber)+1)%10)Z")' \
  examples/b5effad6-proof.json > /tmp/tampered.json
./verify-with-openssl.sh /tmp/tampered.json examples/rubric-keys.json
```

The hash checks still pass, because `anchored_at` is not part of the Merkle
path. Every signature fails, the quorum is not met, and the script exits 1:

```
Bundle: /tmp/tampered.json
hop0  leaf
  PASS  SHA-256(0x00||JCS(leafMessage)) = leafHash
hop1  batch inclusion
  PASS  1-step path folds to batchRoot 2330b02b60015ae47b0d2d427cbe46e99a6be3c071f5bfea667b6661e82ca485
hop2  aggregate
  PASS  batchRoot is one of the 1 tier-1 flush roots
  PASS  flush list recomputes to aggregateRoot 419a9becb846d67eeb05514b92b18ca37a071e14c035bd9c25fc4c976f06fd27
federation
  PASS  signedFields is a tier2-aggregate threshold-multisig
  PASS  signedFields.aggregate_root = aggregateRoot
  PASS  signedFields.anchor_id = hop2.anchorId
  PASS  tier1_count matches flush list
  PASS  total_items matches flush list
  trusted keys: examples/rubric-keys.json
  FAIL  us: ML-DSA-65 signature does not verify
  FAIL  sg: ML-DSA-65 signature does not verify
  FAIL  jp: ML-DSA-65 signature does not verify
  FAIL  quorum not met: 0/3

Not checked here: the HCS ledger anchor (fetch hcs.mirrorNodeUrl, base64-decode .message,
compare .aggregateRoot) and the optional payload commitment, which needs your record + payloadKey.
RESULT: FAIL
```

A changed byte in `leafMessage`, a path sibling, a flush root or the aggregate
root fails at the matching hash step instead.

## Limits

- **HCS ledger anchor: not checked.** The script does not confirm that
  `aggregateRoot` was written to the Hedera topic. To check it, fetch
  `hcs.mirrorNodeUrl`, base64-decode `.message`, and compare its
  `.aggregateRoot` with `hop2.aggregateRoot`.
- **Payload commitment: not checked.** Binding the leaf to your decision record
  needs the record and its payloadKey, which Rubric does not keep. The formula
  is in `hop0.commitmentFn`.
- The `federation.ledgerCommitment` link to the next anchor is not checked.
- Canonicalization uses `jq -S -c`. That matches RFC 8785 for strings and safe
  integers, which is all the signed structures contain. Bundles with floats,
  integers above 2^53 or U+007F are refused, not guessed at.
- Only treeVersion 3 bundles are accepted.

## License

Apache-2.0
