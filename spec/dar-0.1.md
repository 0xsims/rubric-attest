# DAR/0.1 — Decision Attestation Record

Status: **frozen** (minor 0.1). Additive changes bump the minor; breaking changes
bump the major. See [Versioning rules](#5-versioning-rules).

A **Decision Attestation Record (DAR)** is the canonical, hashable record that
attests that a named agent made a decision, under a named schema, at a point in
time, in a per-agent hash-linked chain. **The DAR core is hashes-only: it commits
to the decision's schema, input, and output via hashes and never carries the raw
content.** A DAR is the leaf of the attestation Merkle tree; server-side
attestation metadata (Merkle proof, anchor reference, signature) wraps a DAR but
is **not** part of it.

This document is the single source of truth for the DAR field set and for the
canonicalization/hashing rules. The field set defined in
[§2](#2-dar-core-field-table) is frozen for minor 0.1.

---

## 1. Layers

A complete attestation has two layers. Only the first is a DAR.

| Layer | Produced by | Hashed into the Merkle leaf | Section |
|-------|-------------|------------------------------|---------|
| **DAR core** (hashes-only) | client SDK (`attest-decision`) | yes — the leaf hash is over the DAR core | [§2](#2-dar-core-field-table) |
| **Attestation envelope** | attestation service (post-anchor) | no | [§6](#6-attestation-envelope-non-normative-for-hashing) |

The split exists so that the leaf hash is fully determined by the client at
`attest()` time and can be recomputed by any offline verifier from the DAR core
alone — independent of when/where/whether it was anchored, and without ever
handling the raw decision content.

---

## 2. DAR core field table

The DAR core is a JSON object with **exactly** the following fields. It carries
**only hashes and metadata — never raw content**. Required fields must be
present; optional fields are omitted when absent (never `null`/`undefined`). No
other fields are permitted at minor 0.1. Order is irrelevant (JCS sorts keys);
the table lists fields in their canonical (sorted) order for readability.

| Field | JSON type | Required | Description |
|-------|-----------|----------|-------------|
| `adapter` | object | no | Adapter that produced the inputs: `{ name: string, version: string }`. |
| `agentId` | string | yes | Stable identifier of the deciding agent. The chaining (`prev`) namespace is per `agentId`. Non-empty. |
| `decisionHash` | string | yes | SHA3-256 over the JCS of `{ schemaHash, inputHash, outputHash }`, encoded per [§4.2](#42-hash-string-encoding). The single commitment that binds this decision's schema, input, and output. |
| `decisionId` | string | yes | [ULID](https://github.com/ulid/spec) (26 chars, Crockford base32). Globally unique per decision. Its embedded ms timestamp is advisory; `ts` is authoritative among client-claimed fields. |
| `inputHash` | string | yes | Hash of the JCS of the adapter-supplied **input**, encoded per [§4.2](#42-hash-string-encoding). The raw input is never in the core. |
| `leafType` | string (enum) | yes | Leaf discriminant. `"decision"` for a DAR. Reserved values: `"schema-change"`, `"checkpoint"`. Unknown values are a verify error at this minor. |
| `outputHash` | string | yes | Hash of the JCS of the adapter-supplied **output**, encoded per [§4.2](#42-hash-string-encoding). The raw output is never in the core. |
| `prev` | string \| null | yes | `decisionId` of the immediately preceding DAR **for the same `agentId`**, or `null` for the genesis record of that agent's chain. |
| `schemaHash` | string | yes | Hash of the JCS of the schema descriptor the decision was produced under, encoded per [§4.2](#42-hash-string-encoding). Two DARs with the same `schemaHash` were produced under byte-identical schemas. |
| `schemaRef` | string | no | Stable, human-meaningful reference to the schema (e.g. a URN or `id@version`). Advisory pointer only; `schemaHash` is the commitment. |
| `ts` | string | yes | **Client-claimed** decision time, RFC 3339 / ISO 8601 UTC with millisecond precision and a `Z` suffix, e.g. `2026-09-22T00:10:00.000Z`. The **trusted** time is the HCS consensus timestamp of the anchored batch root (see [§6](#6-attestation-envelope-non-normative-for-hashing)); `ts` is only what the client asserts. |
| `v` | string (const) | yes | Record format tag. Exactly `"DAR/0.1"` for this minor. |

### 2.1 Notes on specific fields

- **The core never carries raw content.** `schemaHash`, `inputHash`, and
  `outputHash` are the only representations of the schema/input/output in the
  record. Raw payloads are transmitted only in `payload` mode, in the transport
  envelope — never in the core (see [§3.4](#34-content-transmission)).
- **`decisionHash` is derived** from the three content commitments:
  `decisionHash = "sha3-256:" + hex(SHA3-256(utf8(JCS({ schemaHash, inputHash, outputHash }))))`.
  A verifier MUST recompute it from those three fields and reject on mismatch.
- **`prev` chaining** is per `agentId`. A `prev` that points outside the agent's
  chain is a continuity error surfaced by verification/reporting (P4/P5), not a
  DAR-format error.
- **`decisionId` is a ULID, not the leaf hash.** The Merkle leaf identity is the
  leaf hash ([§4.3](#43-leaf-hash)); `decisionId` is the client-minted primary
  key used for `prev` links and lookups.
- **`ts` is untrusted.** It is the client's claim; the authoritative time is the
  anchored root's HCS consensus timestamp.

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

An adapter's `toDecision()` supplies `{ schema, input, output, meta }`. From
those:

- `schemaHash` = hash over `JCS(schema)`.
- `inputHash` = hash over `JCS(input)`.
- `outputHash` = hash over `JCS(output)`.
- `decisionHash` = hash over `JCS({ schemaHash, inputHash, outputHash })`.
- The Merkle **leaf hash** = hash over `JCS(DAR core)` — the full hashes-only
  object in [§2](#2-dar-core-field-table). (See [§4.3](#43-leaf-hash).)

`meta` supplies the optional metadata (`schemaRef`, `adapter`, `leafType`); it is
not itself hashed, but any of its values that land in the core (`schemaRef`,
`adapter`) are committed via the leaf hash.

### 3.3 Payload constraints

To be JCS-canonicalizable and stably hashable, the `schema`, `input`, and
`output` values MUST NOT contain:

- Numbers outside the IEEE-754 double range, `NaN`, or `±Infinity`.
- `-0` (canonicalized to `0`; producers SHOULD avoid emitting it).
- Non-integer numbers whose shortest round-trip representation is
  implementation-dependent — producers SHOULD prefer strings for exact decimals.
- `undefined`, functions, symbols, or other non-JSON values.
- Unpaired UTF-16 surrogates (invalid Unicode).
- Duplicate object keys (JSON with duplicate keys is rejected).

Integers larger than `Number.MAX_SAFE_INTEGER` MUST be carried as strings; the
SDK rejects an integer-valued number beyond the safe range rather than hash a
silently-rounded value.

### 3.4 Content transmission

Hash-only is the **default** and is the only mode in which raw content leaves the
producer's memory at all only as hashes: the DAR core (and the batch posted to
`/v1/tiered-attest`) contains hashes only.

When a client is explicitly configured with mode `"payload"`, the raw
`{ schema, input, output, meta }` for each record is transmitted **in the
transport envelope** alongside the DAR cores — never inside a DAR core. The
envelope is `{ records: DarCore[], payloads?: PayloadRecord[] }`; `payloads` is
present only in `payload` mode. This lets a client optionally ship content for
storage/inspection without ever changing the core or its leaf preimage.

---

## 4. Hashing (SHA3-256, FIPS 202)

### 4.1 Algorithm

All hashes are **SHA3-256** (Keccak, FIPS 202), 256-bit output. This is an
invariant of the system, not a per-record choice.

### 4.2 Hash string encoding

Hash-valued fields (`schemaHash`, `inputHash`, `outputHash`, `decisionHash`) and
the leaf hash are encoded as:

```
sha3-256:<64 lowercase hex chars>
```

The `sha3-256:` prefix is mandatory. Verifiers MUST reject any other algorithm
prefix at this major version.

### 4.3 Leaf hash

The Merkle leaf hash committed for a DAR is:

```
leafHash = "sha3-256:" + hex( SHA3-256( utf8( JCS( darCore ) ) ) )
```

where `darCore` is the hashes-only object in [§2](#2-dar-core-field-table).
Because the leaf hash covers the entire frozen field set, it transitively commits
to `schemaHash`, `inputHash`, `outputHash`, and `decisionHash` — and thus to the
schema, input, and output content, without the leaf ever containing that content.

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
  changing canonicalization/hashing / the leaf-hash preimage is **not** additive.
- **Breaking change → bump the major** (`0.x` → `1.0`). Changing the hash
  algorithm, the canonicalization scheme, the hash encoding, the leaf-hash
  preimage, or removing/retyping any field is breaking.

> **Pre-release note.** Moving to a hashes-only core (removing `decision`, adding
> `inputHash`/`outputHash`, redefining `decisionHash`) is a breaking preimage
> change. Because nothing has been published under the old preimage, the tag
> remains `DAR/0.1` rather than bumping the major; this is the frozen 0.1 layout.

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
- **Same major, lower-or-equal minor** → full verification.

### 5.2 Immutability of published rules

Once a `(major, minor)` is published, its field set and hashing rules are
immutable. Corrections that change bytes-on-the-wire require a new version.

---

## 6. Attestation envelope (non-normative for hashing)

These fields are attached by the attestation service after a DAR is anchored.
They are **not** part of the DAR core and do **not** participate in the leaf
hash.

| Field | Description |
|-------|-------------|
| `attestationId` | Service-assigned identifier for the anchored leaf. |
| `merkleProof` | Inclusion proof from `leafHash` to a published root. |
| `anchorRef` | Reference to the on-chain anchor (HCS message/topic + sequence). The **HCS consensus timestamp** of the anchored root is the trusted time for the batch. |
| `signature` | Service signature over the batch/root, with key reference. |
| `extensions` | Open object for transport-specific data (e.g. `extensions.bazaar`). |

The transport request envelope (`payload` mode) may additionally carry
`payloads` — the raw `{ schema, input, output, meta }` per record — for storage
or inspection; these are not part of any DAR core or leaf preimage.

---

## 7. Example DAR core (illustrative)

A hashes-only core (real values from a fixed builder; hashes truncated for
readability):

```json
{
  "adapter": { "name": "jev", "version": "1.0.0" },
  "agentId": "agent://jev/pricing-v3",
  "decisionHash": "sha3-256:5aaa6718f841a1fe5816d7de277bdbd7...",
  "decisionId": "01J8Z9Q0000000000000000001",
  "inputHash": "sha3-256:b54423a7c473a5ef57851831562eb6d3...",
  "leafType": "decision",
  "outputHash": "sha3-256:ac71c58da8ab7d36a2027dff44d5b331...",
  "prev": null,
  "schemaHash": "sha3-256:4b65cd1582a4328877fdb57f45dd4d45...",
  "schemaRef": "urn:jev:pricing:v3",
  "ts": "2025-09-22T00:10:00.000Z",
  "v": "DAR/0.1"
}
```

The JCS canonicalization of this object (keys sorted, no whitespace) is the exact
preimage of `leafHash` per [§4.3](#43-leaf-hash). Here `decisionHash` is
`SHA3-256(JCS({ schemaHash, inputHash, outputHash }))` over the three commitments
above — no raw schema, input, or output appears in the record.
