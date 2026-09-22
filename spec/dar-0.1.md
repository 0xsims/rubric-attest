# DAR/0.1 — Decision Attestation Record

Status: **frozen** (minor 0.1). Additive changes bump the minor; breaking changes
bump the major. See [Versioning rules](#5-versioning-rules).

A **Decision Attestation Record (DAR)** is the canonical, hashable record that
attests that a named agent made a decision, under a named schema, at a point in
time, in a per-agent hash-linked chain. A DAR is the leaf of the attestation
Merkle tree; server-side attestation metadata (Merkle proof, anchor reference,
signature) wraps a DAR but is **not** part of it.

This document is the single source of truth for the DAR field set and for the
canonicalization/hashing rules. The field set defined in
[§2](#2-dar-core-field-table) is frozen for minor 0.1.

---

## 1. Layers

A complete attestation has two layers. Only the first is a DAR.

| Layer | Produced by | Hashed into the Merkle leaf | Section |
|-------|-------------|------------------------------|---------|
| **DAR core** | client SDK (`attest-decision`) | yes — the leaf hash is over the DAR core | [§2](#2-dar-core-field-table) |
| **Attestation envelope** | attestation service (post-anchor) | no | [§6](#6-attestation-envelope-non-normative-for-hashing) |

The split exists so that the leaf hash is fully determined by the client at
`attest()` time and can be recomputed by any offline verifier from the DAR core
alone — independent of when/where/whether it was anchored.

---

## 2. DAR core field table

The DAR core is a JSON object with **exactly** the following fields. No other
fields are permitted at minor 0.1. Order is irrelevant (JCS sorts keys); the
table lists fields in their canonical (sorted) order for readability.

| Field | JSON type | Required | Description |
|-------|-----------|----------|-------------|
| `agentId` | string | yes | Stable identifier of the deciding agent. Opaque to the record; the chaining (`prev`) namespace is per `agentId`. Non-empty. |
| `decision` | object | yes | The attested decision payload, as produced by an adapter's `toDecision()`. Must be a JCS-canonicalizable JSON object (see [§3.3](#33-payload-constraints)). Interpreted only by the adapter; opaque to the DAR layer. |
| `decisionHash` | string | yes | Hash of the canonicalized `decision`. Encoded per [§4.2](#42-hash-string-encoding). Redundant with `decision` (a verifier recomputes it) but carried so an index/proof can reference decisions without the payload. |
| `decisionId` | string | yes | [ULID](https://github.com/ulid/spec) (26 chars, Crockford base32). Globally unique per decision. Its embedded millisecond timestamp is advisory; `ts` is authoritative. |
| `leafType` | string (enum) | yes | Leaf discriminant. `"decision"` for a DAR. Reserved values: `"schema-change"`, `"checkpoint"`. Unknown values are a verify error at this minor. |
| `prev` | string \| null | yes | `decisionId` of the immediately preceding DAR **for the same `agentId`**, or `null` for the genesis record of that agent's chain. Forms a per-agent hash-linked chain. |
| `schemaHash` | string | yes | Hash of the canonicalized schema descriptor that produced `decision`. Encoded per [§4.2](#42-hash-string-encoding). Two DARs with the same `schemaHash` were produced under byte-identical schemas. |
| `ts` | string | yes | Decision time, RFC 3339 / ISO 8601 UTC with millisecond precision and a `Z` suffix, e.g. `2026-09-22T00:10:00.000Z`. Authoritative timestamp of the record. |
| `v` | string (const) | yes | Record format tag. Exactly `"DAR/0.1"` for this minor. |

### 2.1 Notes on specific fields

- **`v`** pins both the field set and the rules. A verifier keys its field set
  and validation off `v` (see [§5](#5-versioning-rules)).
- **`prev` chaining** is per `agentId`. The service does not enforce global
  ordering; a chain is the sequence reachable by following `prev` within one
  `agentId`. A `prev` that points outside the agent's chain is a continuity
  error surfaced by verification/reporting (P4/P5), not a DAR-format error.
- **`decisionHash` / `schemaHash`** are carried explicitly so the index (P2) and
  proofs/exports (P4/P5) can key on them without rehydrating payloads. They are
  **derived**: a verifier MUST recompute and compare, and reject on mismatch.
- **`decisionId` is a ULID, not the leaf hash.** The Merkle leaf identity is the
  leaf hash ([§4.3](#43-leaf-hash)); `decisionId` is the client-minted primary
  key used for `prev` links and lookups.

---

## 3. Canonicalization (JCS, RFC 8785)

### 3.1 Rule

**Canonicalize, then hash.** Every hash in this spec is computed over the UTF-8
bytes of the [RFC 8785 JSON Canonicalization Scheme (JCS)](https://www.rfc-editor.org/rfc/rfc8785)
serialization of the input value. There is no separate "raw" hashing path.

JCS in one line: UTF-8 output, object keys sorted by UTF-16 code unit, no
insignificant whitespace, strings escaped minimally per RFC 8785 §3.2.2.2, and
numbers serialized via the ECMAScript `Number.prototype.toString` / RFC 8785
number algorithm (§3.2.2.3).

### 3.2 What gets canonicalized

- `decisionHash` = hash over `JCS(decision)`.
- `schemaHash` = hash over `JCS(schema-descriptor)`.
- The Merkle **leaf hash** = hash over `JCS(DAR core)` — the full object in
  [§2](#2-dar-core-field-table), including `decisionHash`, `schemaHash`, `prev`,
  etc. (See [§4.3](#43-leaf-hash).)

### 3.3 Payload constraints

To be JCS-canonicalizable and stably hashable, `decision` and the schema
descriptor MUST NOT contain:

- Numbers outside the IEEE-754 double range, `NaN`, or `±Infinity`.
- `-0` (canonicalized to `0`; producers SHOULD avoid emitting it).
- Non-integer numbers whose shortest round-trip representation is
  implementation-dependent — producers SHOULD prefer strings for exact
  decimals (e.g. monetary values).
- `undefined`, functions, symbols, or other non-JSON values.
- Duplicate object keys (JSON with duplicate keys is rejected).

Integers larger than `Number.MAX_SAFE_INTEGER` MUST be carried as strings.

---

## 4. Hashing (SHA3-256, FIPS 202)

### 4.1 Algorithm

All hashes are **SHA3-256** (Keccak, FIPS 202), 256-bit output. This is an
invariant of the system, not a per-record choice.

### 4.2 Hash string encoding

Hash-valued fields (`decisionHash`, `schemaHash`) and the leaf hash are encoded
as:

```
sha3-256:<64 lowercase hex chars>
```

Example: `sha3-256:a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a`
(the SHA3-256 of the empty byte string).

The `sha3-256:` prefix is mandatory and makes the invariant explicit and
self-describing. Verifiers MUST reject any other algorithm prefix at this
major version.

### 4.3 Leaf hash

The Merkle leaf hash committed for a DAR is:

```
leafHash = "sha3-256:" + hex( SHA3-256( utf8( JCS( darCore ) ) ) )
```

where `darCore` is the object in [§2](#2-dar-core-field-table). Because the leaf
hash covers the entire frozen field set, it transitively commits to
`decisionHash` and `schemaHash`, and thus to the decision payload and schema.

Interior Merkle node hashing, domain separation, and proof format are defined by
the attestation service (P4) and are out of scope for the DAR format.

---

## 5. Versioning rules

The record tag is `DAR/<major>.<minor>`.

- **Field set is frozen per minor.** A `v` of `DAR/0.1` denotes exactly the
  field set in [§2](#2-dar-core-field-table).
- **Additive change → bump the minor** (`0.1` → `0.2`). Additive means: adding a
  new **optional** field, or adding a new value to an open enum. Removing a
  field, renaming, changing a type, making an optional field required, or
  changing canonicalization/hashing is **not** additive.
- **Breaking change → bump the major** (`0.x` → `1.0`). Changing the hash
  algorithm, the canonicalization scheme, the hash encoding, the leaf-hash
  preimage, or removing/retyping any field is breaking.

### 5.1 Verifier compatibility

Because additive fields **are** part of the leaf-hash preimage at their minor, a
verifier cannot recompute a leaf hash for a record whose minor it does not fully
know. Therefore:

- **Unknown major** → reject. Do not attempt to verify.
- **Known major, higher minor than the verifier knows** → the verifier MAY
  validate structure it recognizes but MUST NOT claim leaf-hash verification;
  it reports `needs-upgrade` rather than pass/fail. It MUST NOT strip unknown
  fields and rehash.
- **Known major, known minor** → full verification.
- **Same major, lower-or-equal minor** → full verification (the verifier is a
  superset of the record's field set; only fields declared for the record's
  minor participate in its leaf hash).

### 5.2 Immutability of published rules

Once a `(major, minor)` is published, its field set and hashing rules are
immutable. Corrections that change bytes-on-the-wire require a new version.

---

## 6. Attestation envelope (non-normative for hashing)

These fields are attached by the attestation service after a DAR is anchored.
They are **not** part of the DAR core and do **not** participate in the leaf
hash. They are listed here for completeness; their authoritative shape is owned
by P4 (verify route) and P2 (index).

| Field | Description |
|-------|-------------|
| `attestationId` | Service-assigned identifier for the anchored leaf. |
| `merkleProof` | Inclusion proof from `leafHash` to a published root. |
| `anchorRef` | Reference to the on-chain anchor (e.g. HCS message/topic + sequence). |
| `signature` | Service signature over the batch/root, with key reference. |
| `extensions` | Open object for transport-specific data (e.g. `extensions.bazaar`). |

---

## 7. Example DAR core (illustrative, non-canonical formatting)

```json
{
  "agentId": "agent://jev/pricing-v3",
  "decision": { "action": "approve", "limitUsd": "2500.00", "reasonCode": "AUTO_OK" },
  "decisionHash": "sha3-256:1f9840a85d5af5bf1d1762f925bdaddc4201f984...<truncated>",
  "decisionId": "01J8Z9Q9Z9Q9Z9Q9Z9Q9Z9Q9Z9",
  "leafType": "decision",
  "prev": "01J8Z9Q0000000000000000000",
  "schemaHash": "sha3-256:9b871512327c09ce91dd649b3f96a63b7408ef26...<truncated>",
  "ts": "2026-09-22T00:10:00.000Z",
  "v": "DAR/0.1"
}
```

The JCS canonicalization of this object (keys already sorted, no whitespace)
is the exact preimage of `leafHash` per [§4.3](#43-leaf-hash).
