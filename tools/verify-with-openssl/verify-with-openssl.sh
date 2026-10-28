#!/usr/bin/env bash
# verify-with-openssl.sh — check a Rubric tier-2 proof bundle with OpenSSL 3.5+, jq and coreutils.
# No TenPrint code runs at verify time.
#
# Usage: verify-with-openssl.sh BUNDLE.json [rubric-keys.json]
#
# BUNDLE.json is the body of GET /v1/proof/:id (src/api/server.ts:3730): hop0, hop1, hop2, federation.
# rubric-keys.json is /.well-known/rubric-keys.json. Without it, signatures are checked against the
# keys the bundle itself carries. That proves the signatures are well formed, not who made them.
#
# Exit status: 0 pass, 1 fail (including a missing BUNDLE argument or a rubric-keys.json that is not
# exactly one JSON document), 2 unbound (no rubric-keys.json; prints RESULT: UNBOUND), a required
# tool is missing, or OpenSSL lacks sha3-256 or ML-DSA-65.
#
# Construction (treeVersion 3, see src/verify/merkle.ts and src/verify/spec-merkle.ts):
#   leaf       = SHA-256(0x00 || JCS(leafMessage))
#   batch node = SHA-256(0x01 || L || R)      dir "R": sibling is the right operand
#   agg leaf   = SHA3-256(JCS({"__leafType":"DOCUMENT_HASH","forestRoot":..,"itemCount":..}))
#   agg tagged = SHA3-256(0x00 || agg leaf)    node = SHA3-256(0x01 || L || R), odd node promoted
#   aggregate  = SHA3-256(utf8(treeRootHex || treeRootHex))   (buildForest single-tree self-pair)
#   signature  = ML-DSA-65, pure, empty context, over utf8(JCS(federation.signedFields))
set -euo pipefail

QUORUM=3                       # src/verify/federation-policy.ts:9; never taken from the bundle
PK_LEN=1952                    # ML-DSA-65 public key bytes
SIG_LEN=3309                   # ML-DSA-65 signature bytes

BUNDLE=${1:-}
[[ -n $BUNDLE ]] || { echo "  FAIL  usage: $0 BUNDLE.json [rubric-keys.json]"; echo "RESULT: FAIL"; exit 1; }
KEYS=${2:-}
for t in openssl jq od base64 sed tr wc mktemp; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
openssl dgst -sha3-256 </dev/null >/dev/null 2>&1 \
  || { echo "OpenSSL $(openssl version) has no sha3-256" >&2; exit 2; }
ALGS=$(openssl list -signature-algorithms 2>/dev/null) || ALGS=""
[[ $ALGS == *[Mm][Ll]-[Dd][Ss][Aa]-65* ]] \
  || { echo "OpenSSL $(openssl version) has no ML-DSA-65 (needs 3.5+)" >&2; exit 2; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
FAIL=0
# Bundle and key-file values are untrusted. Drop C0 controls (including newlines), DEL and UTF-8 C1
# controls before printing, so no value can start a new line or forge a RESULT line. The sed loop
# repeats until nothing changes, so removing one C1 pair cannot leave another behind.
clean() { printf '%s' "$*" | LC_ALL=C tr -d '\000-\037\177' | LC_ALL=C sed ':a; s/\xc2[\x80-\x9f]//g; ta'; }
ok()  { printf '  PASS  %s\n' "$(clean "$*")"; }
bad() { printf '  FAIL  %s\n' "$(clean "$*")"; FAIL=1; }
die() { printf '  FAIL  %s\n' "$(clean "$*")"; echo "RESULT: FAIL"; exit 1; }
# Any unchecked jq (or other) failure is a FAIL with exit 1, never jq's own exit code.
set -E
trap 'rc=$?; printf "  FAIL  command failed (exit %s): %s\n" "$rc" "$BASH_COMMAND"; echo "RESULT: FAIL"; exit 1' ERR

hex2bin() { local h; h=$(tr -d ' \n' | tr 'A-F' 'a-f'); [[ $h =~ ^([0-9a-f]{2})*$ ]] || return 1; printf '%b' "$(sed 's/../\\x&/g' <<<"$h")"; }
bin2hex() { od -An -v -tx1 | tr -d ' \n'; }
digest()  { openssl dgst "-$1" -binary | bin2hex; }   # stdin -> lowercase hex
j()       { jq -r "$@" "$BUNDLE"; }

# RFC 8785 for the values this protocol signs: jq -S -c matches canonical.ts for ASCII-or-UTF-8
# strings and safe integers. Floats, very large numbers and U+007F (which jq escapes and JCS does
# not) are refused rather than canonicalized differently.
jcs() {
  jq -e '[.. | select(type=="number") | select(. != floor or (if . < 0 then -. else . end) > 9007199254740991)] | length == 0' >/dev/null <<<"$1" \
    || { echo "jcs: non-integer or unsafe number; not supported by this script" >&2; return 1; }
  jq -e '[.. | strings, (.. | objects | keys[])] | map(test("\u007f")) | any | not' >/dev/null <<<"$1" \
    || { echo "jcs: U+007F in a string; not supported by this script" >&2; return 1; }
  jq -S -c 'walk(if type=="number" then . + 0 else . end)' <<<"$1" | tr -d '\n'
}

echo "Bundle: $(clean "$BUNDLE")"
jq -e 'type == "object"' "$BUNDLE" >/dev/null 2>&1 || die "malformed bundle: $BUNDLE is unreadable or not a JSON object"

# ---- hop0: leafMessage -> leafHash --------------------------------------------------------------
echo "hop0  leaf"
LEAF=$(j '.hop1.leafHash // .leafHash' | tr 'A-F' 'a-f')
[[ $LEAF =~ ^[0-9a-f]{64}$ ]] || die "leafHash missing or not 32-byte hex"
if [[ $(j '.hop0.leafMessage | type') == object ]]; then
  CANON=$(jcs "$(j -c '.hop0.leafMessage')") || die "leafMessage could not be canonicalized"
  GOT=$( { printf '\x00'; printf '%s' "$CANON"; } | digest sha256)
  [[ $GOT == "$LEAF" ]] && ok "SHA-256(0x00||JCS(leafMessage)) = leafHash" || bad "leaf recomputes to $GOT, bundle says $LEAF"
else
  echo "  SKIP  no hop0.leafMessage; starting from leafHash"
fi

# ---- hop1: leafHash -> batchRoot (SHA-256, RFC 6962 tags, positional) ---------------------------
echo "hop1  batch inclusion"
H=$LEAF
N=$(j '.hop1.path | length')
for ((i = 0; i < N; i++)); do
  SIB=$(j ".hop1.path[$i].sibling" | tr 'A-F' 'a-f')
  DIR=$(j ".hop1.path[$i].siblingDirection")
  [[ $SIB =~ ^[0-9a-f]{64}$ ]] || die "path[$i].sibling not 32-byte hex"
  case $DIR in
    R) H=$( { printf '\x01'; hex2bin <<<"$H"; hex2bin <<<"$SIB"; } | digest sha256) ;;
    L) H=$( { printf '\x01'; hex2bin <<<"$SIB"; hex2bin <<<"$H"; } | digest sha256) ;;
    *) die "path[$i].siblingDirection is '$DIR', expected L or R" ;;
  esac
done
BATCH=$(j '.hop1.batchRoot' | tr 'A-F' 'a-f')
[[ $H == "$BATCH" ]] && ok "$N-step path folds to batchRoot $BATCH" || bad "path folds to $H, bundle batchRoot is $BATCH"

# ---- hop2: batchRoot -> aggregateRoot (SHA3-256) ------------------------------------------------
echo "hop2  aggregate"
[[ $(j '.hop2.tier1Flushes | type') == array ]] || die "hop2.tier1Flushes missing (tier-2 bundle not yet available?)"
TV=$(j '.hop2.treeVersion'); ALGO=$(j '.hop2.algorithm // "sha3-256"')
[[ $TV == 3 ]]  || die "treeVersion $TV: only v3 binds flush content (v2 commits to count only, RUBRIC-SEC-2026-001)"
[[ $ALGO == sha3-256 ]] || die "aggregate algorithm $ALGO, expected sha3-256"
AGG=$(j '.hop2.aggregateRoot' | tr 'A-F' 'a-f')

j -e --arg b "$BATCH" '[.hop2.tier1Flushes[].forestRoot | ascii_downcase] | index($b) != null' >/dev/null \
  && ok "batchRoot is one of the $(j '.hop2.tier1Flushes | length') tier-1 flush roots" || bad "batchRoot not among tier1Flushes"

LEVEL=()
while IFS= read -r F; do
  LJ=$(jcs "$(jq -c '{__leafType:"DOCUMENT_HASH", forestRoot, itemCount}' <<<"$F")") || die "flush leaf could not be canonicalized"
  LV2=$(printf '%s' "$LJ" | digest sha3-256)                                    # makeLeafV2 hash
  LEVEL+=("$( { printf '\x00'; hex2bin <<<"$LV2"; } | digest sha3-256)")      # buildTreeV3 domainLeaf
done < <(j -c '.hop2.tier1Flushes[]')
((${#LEVEL[@]})) || die "tier1Flushes is empty"
while ((${#LEVEL[@]} > 1)); do
  NEXT=()
  for ((i = 0; i < ${#LEVEL[@]}; i += 2)); do
    if ((i + 1 < ${#LEVEL[@]})); then
      NEXT+=("$( { printf '\x01'; hex2bin <<<"${LEVEL[i]}"; hex2bin <<<"${LEVEL[i+1]}"; } | digest sha3-256)")
    else
      NEXT+=("${LEVEL[i]}")                                                      # promote, no duplicate
    fi
  done
  LEVEL=("${NEXT[@]}")
done
TREE_ROOT=${LEVEL[0]}
GOT=$(printf '%s%s' "$TREE_ROOT" "$TREE_ROOT" | digest sha3-256)                # buildForest self-pair, hex text
[[ $GOT == "$AGG" ]] && ok "flush list recomputes to aggregateRoot $AGG" || bad "flush list recomputes to $GOT, bundle says $AGG"

# ---- federation: signedFields bind the root; quorum of ML-DSA-65 signatures ---------------------
echo "federation"
[[ $(j '.federation.signedFields | type') == object ]] || die "no federation.signedFields"
SF=$(j -c '.federation.signedFields')
sf() { jq -r "$1" <<<"$SF"; }
[[ $(sf .attestation_type) == threshold-multisig && $(sf .subject) == tier2-aggregate ]] \
  && ok "signedFields is a tier2-aggregate threshold-multisig" || bad "signedFields attestation_type/subject wrong"
[[ $(sf .aggregate_root | tr 'A-F' 'a-f') == "$AGG" ]] && ok "signedFields.aggregate_root = aggregateRoot" || bad "signedFields.aggregate_root != aggregateRoot"
[[ $(sf .anchor_id) == "$(j '.hop2.anchorId')" ]] && ok "signedFields.anchor_id = hop2.anchorId" || bad "signedFields.anchor_id != hop2.anchorId"
[[ $(sf .tier1_count) == "$(j '.hop2.tier1Flushes | length')" ]] && ok "tier1_count matches flush list" || bad "tier1_count != flush count"
[[ $(sf .total_items) == "$(j '[.hop2.tier1Flushes[].itemCount] | add')" ]] && ok "total_items matches flush list" || bad "total_items != sum of itemCount"

jcs "$SF" > "$WORK/msg" || die "signedFields could not be canonicalized"

# Raw FIPS 204 public key -> SubjectPublicKeyInfo DER (id-ml-dsa-65, 2.16.840.1.101.3.4.3.18).
# 30 82 07b2 { 30 0b { 06 09 608648016503040312 } 03 82 07a1 00 <1952 bytes> }
spki() { { printf '\x30\x82\x07\xb2\x30\x0b\x06\x09\x60\x86\x48\x01\x65\x03\x04\x03\x12\x03\x82\x07\xa1\x00'; cat "$1"; } > "$2"; }

if [[ -n $KEYS ]]; then
  # Slurp the registry and require exactly one JSON document, so an empty file or a second
  # document appended after the first cannot change which keys are trusted.
  NDOC=$(jq -s 'length' "$KEYS" 2>/dev/null) || die "$KEYS is unreadable or not JSON"
  [[ $NDOC == 1 ]] || die "malformed $KEYS: contains $NDOC JSON documents, expected exactly one"
  # Validate the whole registry in one pass before any key matching. Prints the first problem, or
  # nothing if the file is well formed. An explicit "status": null is rejected.
  KEYERR=$(jq -s -r '.[0] |
    if type != "object" then "top level is not a JSON object"
    elif .format != "rubric-keys/1" then "format is not rubric-keys/1"
    elif (.signers | type) != "array" then ".signers is not an array"
    else
      [.signers | to_entries[] | .key as $n | .value
        | if type != "object" then "signers[\($n)] is not an object"
          elif (.region | type) != "string" then "signers[\($n)].region is not a string"
          elif (.publicKey | type) != "string" then "signers[\($n)].publicKey is not a string"
          elif has("status") and (.status | type) != "string" then "signers[\($n)].status is present but not a string"
          else empty end][0] // ""
    end' "$KEYS" 2>/dev/null) || die "$KEYS is unreadable or not JSON"
  [[ -z $KEYERR ]] || die "malformed $KEYS: $KEYERR"
  # One line per ML-DSA-65 key: region, keyId, status (absent means active), publicKey, separated by
  # 0x1f. Control characters are replaced with "?" so no field can split or forge a line.
  KEYTAB=$(jq -s -r '.[0].signers[] | select(.algorithm == "ML-DSA-65")
             | [.region, (.keyId | tostring), (if has("status") then .status else "active" end), .publicKey]
             | map(tostring | explode | map(if . < 32 or . == 127 then 63 else . end) | implode)
             | join("\u001f")' "$KEYS" 2>/dev/null) || die "$KEYS: key lookup failed"
  echo "  trusted keys: $(clean "$KEYS")"
else
  echo "  WARN  no rubric-keys.json given: checking against keys embedded in the bundle (no identity binding)"
fi

declare -A SEEN_REGION=() SEEN_KEY=()
COUNT=0
NS=$(j '.federation.signatures | length')
for ((i = 0; i < NS; i++)); do
  REGION=$(j ".federation.signatures[$i].region")
  j -r ".federation.signatures[$i].publicKey" | base64 -d > "$WORK/claimed.raw" 2>/dev/null || { bad "$REGION: publicKey not base64"; continue; }
  [[ $(wc -c < "$WORK/claimed.raw") -eq $PK_LEN ]] || { bad "$REGION: publicKey is not $PK_LEN bytes"; continue; }
  CLAIMED=$(bin2hex < "$WORK/claimed.raw")

  if [[ -n $KEYS ]]; then
    # Accept the signature only under a key published for this region with status active or
    # retired (retired keys still verify the anchors they signed). No status field means active.
    # Revoked, compromised or any other status rejects the key. Compared as bytes, not base64 text.
    MATCH=""; REJECTED=""
    while IFS=$'\x1f' read -r KREGION KID STATUS PK; do
      [[ $KREGION == "$REGION" ]] || continue
      [[ $(base64 -d <<<"$PK" 2>/dev/null | bin2hex) == "$CLAIMED" ]] || continue
      case $STATUS in
        active|retired) MATCH=1 ;;
        *) REJECTED="region $REGION, key $KID, status $STATUS" ;;
      esac
    done <<<"$KEYTAB"
    [[ -z $REJECTED ]] || { bad "$REGION: key rejected ($REJECTED)"; continue; }
    [[ -n $MATCH ]] || { bad "$REGION: signing key not published for region $REGION"; continue; }
  fi

  j -r ".federation.signatures[$i].signature" | hex2bin > "$WORK/sig" || { bad "$REGION: signature not hex"; continue; }
  [[ $(wc -c < "$WORK/sig") -eq $SIG_LEN ]] || { bad "$REGION: signature is not $SIG_LEN bytes"; continue; }
  spki "$WORK/claimed.raw" "$WORK/pk.der"

  # Pure ML-DSA, empty context: -rawin hands OpenSSL the whole message, no digest.
  if openssl pkeyutl -verify -pubin -inkey "$WORK/pk.der" -keyform DER -rawin \
       -in "$WORK/msg" -sigfile "$WORK/sig" >/dev/null 2>&1; then
    if [[ -n ${SEEN_REGION[$REGION]:-} || -n ${SEEN_KEY[$CLAIMED]:-} ]]; then
      echo "  ----  $(clean "$REGION"): valid but duplicate region or key, not counted"
    else
      SEEN_REGION[$REGION]=1; SEEN_KEY[$CLAIMED]=1; COUNT=$((COUNT + 1))
      ok "$REGION: ML-DSA-65 signature verifies"
    fi
  else
    bad "$REGION: ML-DSA-65 signature does not verify"
  fi
done
((COUNT >= QUORUM)) && ok "quorum $COUNT/$QUORUM distinct regions and keys" || bad "quorum not met: $COUNT/$QUORUM"

echo
echo "Not checked here: the HCS ledger anchor (fetch hcs.mirrorNodeUrl, base64-decode .message,"
echo "compare .aggregateRoot) and the optional payload commitment, which needs your record + payloadKey."
if ((FAIL)); then echo "RESULT: FAIL"; exit 1; fi
if [[ -z $KEYS ]]; then echo "RESULT: UNBOUND (signatures well formed but not bound to published keys)"; exit 2; fi
echo "RESULT: PASS"
