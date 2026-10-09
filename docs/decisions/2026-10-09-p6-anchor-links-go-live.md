# Board decision: P6 anchor links go-live (2026-10-09)

Subject: rubric-protocol #67 (`93bd6b66`, merged to main at `7fcaf65b`) and
#68 (`33a2dc47`, merged to main at `32703b74`), with follow-up #69 (merged
to main at `c22dd75d`). They cover two steps:
**(A)** setting `RUBRIC_ANCHOR_LINKS_ENABLED=true` on `rubric-aggregator`,
and **(B)** the first production `--apply` of
`scripts/anchor-links-backfill.mjs`. Spec:
`docs/specs/attestation-index-and-replay.md` §3.2–§3.4, §3.6, §7.

Anchor-link lines can never be removed from `attestation-index.jsonl` (D5).
So each step is irreversible, and each is run by a human. This record does
not flip the flag or run apply.

The board has ruled four times. Round 4 (below) is in force, and the
Conditions section is the round 4 text. Round 4 was ruled on rubric-protocol
PR 69 (merged to main at `c22dd75d`), a socket check of Redis on all five
nodes, and a stamped US dry run. Rounds 1–3 are kept underneath as history.

## Verdict (round 4, in force)

| Item | Ruling |
|---|---|
| A: writer flag | **NO-GO now.** GO WITH CONDITIONS on **US only** once 0.1–0.6 (round 4 text) are met against `c22dd75d`. |
| B: first `--apply` | **NO-GO** until Stage 1 passes, 2.2 passes, and 2.3 passes, including the `00949ddc` root cause with #62 timing and the 2.3 note. |
| C: scope | **Staged; NO-GO for every satellite** until 3.1 passes. US first, then one node at a time. |

| Director | Risk | Vote |
|---|---|---|
| Acquirer | No recorded value ties the running US `dist` to a reviewed commit. The `.deployed-sha`/`.deployed-inputs` values and a `dist` hash were not supplied. `deploy.sh` ignores a failed aggregator restart, so the stamp shows a build, not the running process. PR 69's own fixes have no `/code-review high`. | HOLD |
| Standards reviewer | Anchor `00949ddc` commits each of 19 ids to three different payloads. B would write one permanent link per id to it, and link lines carry no `flushId`. Whether this is a closed pre-#62 defect or an open claim bypass depends on a deploy time that was not supplied. | HOLD |
| Compliance buyer | The record rests on operator statements without artifacts: five Redis hosts with no per-host output, a host-script review with no file list, the equivalence test run once of 20, and the RMW race with neither a fix nor a signed acceptance. | HOLD |

Round 4 is real progress. PR 69 fixed review findings 2, 3, 4, 5 and 10.
The board adopts the socket check as the 0.2 method. The stamped dry run under
`c22dd75d` would pass every 2.3 count threshold. But the round 3 targets
(`32703b74`) no longer describe the deployed build, the deploy stamp's values
were not supplied, and 0.3, 0.4 and 0.6 were not supplied at all. The
`00949ddc` record shows content differing across flushes. Under #62 that is
possible only before #62 was deployed, or through a path that skips the
claim. The deploy time that decides between them is missing.

The one condition that flips A is Stage 0 (0.1–0.6, round 4 text), recorded
in #56 as raw per-host command output against `c22dd75d`. B's deciding fact
is separate: the UTC time #62 went live on US, compared with the 2026-07-14
21:37 UTC submissions of the 19 `m42-golden` ids (operator-stated).

## Round 4 evidence, and how it was weighed

| Evidence | Weight |
|---|---|
| PR 69 merged at `c22dd75d`, stated as deployed | **Code accepted, deployment not.** `onTier1Flush` appends every index line before its first await, and the anchor job now judges cold/ when warm/ is missing (`coldLinkRefusal`). PR 69 changed `scripts/anchor-links-backfill.mjs` (blob `53ae4ddb…` → `f1e2521e…`) and `src/aggregator/*`, so the round 3 targets are re-pointed to `c22dd75d` (finding 17). |
| `/code-review high` on #68's diff (`32703b74`), 10 findings | **Accepted for #68's diff.** The reasons for 1, 6, 8, 9 (not acted on) and 7 (partly) are not recorded. PR 69's own fixes are unreviewed at high (finding 18). |
| Safety-reviewer PASS on the PR 69 staged diff | **Partial.** The submission does not show that the PASS covers the diff merged at `c22dd75d`. |
| Tests on a compiled build, equivalence ALL PASS once | **Partial.** 0.1 asks for 20 runs. The `deploy.sh` stamp harness was not run. |
| Tier-2 bundle RMW race | **Open.** PR 69 does not mention it. The anchor path and the retry drainer both write the bundle back with a plain `writeFileSync` (finding 19). |
| `deploy.sh` US stamp | **Design accepted, values not supplied.** It hashes git object ids at HEAD, not `dist`, and it is written even if the aggregator restart fails (finding 21). |
| 0.2: live aggregator socket on `vultr`, `rubric-node-sg-1`, `rubric-node-jp-1`, `rubric-node-ca-1`, `rubric-node-eu-1` shows only `127.0.0.1:6379`; `SHARED_REDIS_HOST` unset on all five | **Method adopted; result not recorded.** The socket is a measurement, and the round 3 log line was not (finding 20). No raw per-host output was supplied. |
| 0.5: `rubric-backup-v2.sh` only rsyncs and tars whole directories; `reconcile-anchors.mjs` only reads warm and cold json files; the other four and all of `rubric-tracker` don't touch the store | **Partial.** Classified by statement. No tracker file list, grep-hit classification, or cron and timer review. |
| Stamped dry run, `~/p6-dryrun-stamped.txt` (`vultr`, 2026-10-09T16:44:05Z, `c22dd75d`, exit 0) | **Accepted as a real run and as planning evidence.** It is not the 2.3 pre-apply run. Its 38 `notThisFlush` entries are exactly the 19 ids × `26df6c9d`/`721b2a13`, all `warm-other-flush` at seq 276440, 2000 occurrences. Its header is not in 2.3's format (finding 23). |
| Anchor `00949ddc` cold-stub analysis (operator-stated: tier-2 bundle anchored 2026-07-14 holds `26df6c9d` 1000 items, `721b2a13` 1000, `acc07fd1` 22; all 19 ids have `sourceId` `m42-golden`, region us, no agent or pipeline, issued 21:37:10–21:37:40 UTC; one `payloadHash` per id per flush, about 53 copies each; 3 different payloads across the three flushes; all 2003 duplicate index lines are these 19 ids) | **Partial.** Not verified by the board; 2003 itself matches 105761 − 103758. The #62 and M42b deploy times on US, content digest equality, per-id copy counts for `acc07fd1`, and the key behind each submission were not supplied (findings 24–26). |
| 0.3 HEAD, porcelain, stamp values and `dist` hash; 0.4; 0.6; 2.2 signer tally; 3.1 `notInIndex` root cause | **Not supplied. Not met.** |

Operator's conclusion, recorded as submitted: the 19 ids are internal test
fixtures, no customer data is involved, and the backfill correctly refuses
their links. The board accepts the first two subject to 2.3. It corrects the
third: the backfill refuses the 38 pairs from `26df6c9d` and `721b2a13`, but
writes one link per id through `acc07fd1` (finding 24).

## Round 4 findings

17. **The round 3 targets describe a build that is no longer deployed.**
    PR 69 changed `scripts/anchor-links-backfill.mjs` and `src/aggregator/*`
    after `32703b74`. The script's sha256 at `c22dd75d` is
    `f64e1c3a12595ea29994f316237aaefe41efeee6f902ece112f7a579eaf45501`,
    which matches the stamped run's 16-hex prefix. 0.1, 0.3 and 2.3 are
    re-pointed to `c22dd75d`.
18. **PR 69's own fixes have no `/code-review high`.** The review covered
    #68's diff. The fixes for its findings 2, 3, 4, 5 and 10 are new
    link-writer and backfill code. This is finding 15's pattern again.
19. **The RMW race has two sites.** The anchor path (`index.ts:93-105`) and
    the retry drainer (`index.ts:212-241`) both read the tier-2 bundle and
    write it back with a plain `writeFileSync`. A fix or a signed acceptance
    must name both.
20. **The socket check replaces the log line as the 0.2 method.**
    `index.ts:56` prints the configured host before any connection exists,
    so it shows configuration, not a connection. `ss -tnp` on the aggregator
    pid shows the connection. Two gaps remain: a loopback port can be a
    tunnel, so the owners of the `:6379` listener and its clients are
    recorded; and the runbook's `grep -c '^SHARED_REDIS_HOST='` misses
    `export` and indented lines, so round 3's regex is kept. The
    `TIERED_GROUP_NAME` and `HEDERA_ACCOUNT_ID` counts are dropped: a group
    name matters only on a shared stream, and the payer cannot identify a
    node (finding 10).
21. **The deploy stamp shows what was built, not what is running.**
    `deploy.sh` runs `pm2 restart rubric-aggregator 2>/dev/null || true` and
    writes the stamp afterwards. The stamp hashes git object ids at HEAD,
    not `dist`. 0.3 also needs the aggregator's start time after the stamp's
    mtime, and a `dist` hash.
22. **Round 3's 0.3 hash method could never match a scratch build, and it
    covers too little.** `sync-all.sh:54` hashes absolute paths under
    `/root/tempus/dist`, so a build under `/tmp` always differs. The backfill
    also loads `dist/api` modules (`anchor-links-backfill.mjs:27-31`), so
    `dist/aggregator` alone does not cover what writes lines. 0.3 now uses
    sha256 over relative paths in `dist/api` and `dist/aggregator`.
23. **The stamped dry run would pass the 2.3 count thresholds, but its
    header does not meet 2.3.** Against round 2: anchors +21, `indexIds`
    +43, `linksAppended` +41 (≤ +43), `noBundle` +2;
    `bytesToAppend / linksAppended` = 358. Every count that could write a
    wrong line is 0. The header is one hand-formatted line with a 16-hex
    prefix, and nothing in the capture shows it came from `hostname`,
    `date -u` and a hash command. 2.3 now requires the full sha256 and the
    commands in the capture.
24. **B would write 19 links for the fixture ids, not none.** Flush
    `acc07fd1` passes `warmLinkVerdict`, because the warm record names
    `acc07fd1` and `00949ddc`. So each of the 19 ids gets one
    `backfill-mirror` link to `00949ddc` (seq 276440). Link lines carry no
    `flushId`. A verifier holding the link will find three leaves per id in
    that anchor, two of them with payloads that differ from the warm record.
    The operator's figures agree with each other: 1000 + 1000 + 22 = 2022 =
    19 + 2003. With no `kind` lines in the jsonl, `alreadyPresent` 3 fits
    22 items over 19 ids in `acc07fd1`. That is an inference, confirmed at
    2.3.
25. **The 2.3 root-cause clause is not met as written, and is restated.**
    `sourceId` is a payload field the caller writes (`index.ts:150`), so it
    cannot show one party. Under #62 the same id with a different digest is
    refused, so three payloads per id could only have been flushed if (a)
    #62 was not live on US at the operator-stated 21:37 UTC on 2026-07-14, a
    closed historical
    defect that B can proceed past with a note, or (b) the submissions used a
    path that skips the claim, finding 9's class, which is open and makes B
    NO-GO. The deciding fact is the #62 deploy time on US, which was not
    supplied. The submission also says "three test runs" while stating that
    all 19 ids were issued within 30 s; it must say whether `issuedAt` is recorded per
    (id, flush).
26. **A note is required before apply. An erratum is not, unless the facts
    change.** Anchor `00949ddc` accurately commits to what was flushed, and
    a link to it through `acc07fd1` is true. It still breaks the
    one-id-one-content rule #62 enforces, and these fixture ids sit in the
    production index and on mainnet. An erratum is required if (b) holds, or
    if any of the 19 ids was ever given to a customer.

## Gate scorecard (round 4, in force)

| Gate | Score | Reason |
|---|---|---|
| 0.1 | PARTIAL | #68's diff reviewed and 5 review findings fixed. PR 69's own diff not reviewed at high. Reasons for review findings 1, 6–9 not recorded. Equivalence run 1 time of 20. RMW race (two sites) neither fixed nor accepted. #67 tree check and the scope of the PASS not supplied. |
| 0.2 | PARTIAL | Socket method adopted. The result is stated for five hosts with no raw per-host output. Listener and client owners not recorded. |
| 0.3 | NOT MET | No HEAD, porcelain, stamp values or `dist` hash supplied. |
| 0.4 | NOT MET | Not supplied. |
| 0.5 | PARTIAL | Classified by statement. No tracker file list, grep-hit classification, or cron and timer review. |
| 0.6 | NOT MET | Not supplied. |
| 1.1–1.3 | NOT MET | Not started, which is the correct order. |
| 2.1 | MET | Real runs at 15:16 (unstamped) and 16:44:05Z (`c22dd75d`), both with an explicit store. |
| 2.2 | PARTIAL | The filter stands in once 0.1 and 0.3 are met. The signer tally was not run. |
| 2.3 | NOT MET | The pre-apply run must follow Stage 1. Root cause partial: #62 and M42b times, digest equality, `acc07fd1` counts and submitter key not supplied. Note not recorded. |
| 2.4 | NOT MET | Not run. |
| 3.1 | NOT MET | 0.2 not recorded. No `notInIndex` root cause. No 7 clean days after B. |
| 3.2 | NOT MET | Follows 3.1. |

## Verdict (round 3, superseded)

| Item | Ruling |
|---|---|
| A: writer flag | **NO-GO now.** GO WITH CONDITIONS on **US only** once 0.1–0.6 are met. 0.2 must show local Redis on all five nodes. |
| B: first `--apply` | **NO-GO** until Stage 1 passes, the anchor `00949ddc` root cause is recorded (2.3), and 2.2–2.3 pass. |
| C: scope | **Staged; NO-GO for every satellite** until 3.1 passes. US first, then one node at a time. |

The vote is HOLD from all three directors. The acquirer moved from APPROVE to
HOLD on finding 16: no record shows which build on US would write permanent
lines. The one condition that flips A is the Stage 0 evidence pack (0.1–0.6),
recorded in #56 with hostnames. Round 2's flip condition ("each payer
matching the node that holds its bundles") is withdrawn: every chunk on the
topic has one payer, `0.0.3923341` (spec §3.6), so the payer cannot identify
a node.

## Round 3 evidence, and how it was weighed

| Evidence | Weight |
|---|---|
| #68 merged (`32703b74`), deployed, fleet digest `aed6b5fbadb1` on all 5 nodes | **Code accepted, digest not.** The digest still covers only `dist/api` + `dist/verify` (`sync-all.sh:53-54`). `.deployed-inputs` is written only on the four satellites (`sync-fleet.sh`), so it says nothing about US; 0.3 checks US directly. |
| #68 records a `/code-review high` | **Accepted for #67 only.** It reviewed `7fcaf65b`, not #68's own diff, which rewrote the link writer, the warm guard and the backfill. Safety-reviewer PASS is a separate gate (0.1). |
| O3: satellite `pm2 env` shows `REDIS_HOST=127.0.0.1`; US defaults to `127.0.0.1` | **Rejected**, as in round 2. `index.ts:47` reads `SHARED_REDIS_HOST` first, after `dotenv.config()` (`index.ts:13`, cwd `/root/tempus`) loads `.env`. The aggregator's env allowlist passes no Redis host. "US defaults" comes from a code comment (`aggregator-producer.ts:6-7`), not a measurement. |
| #61 deployed on US; no satellite runs `reconcile-rt` from cron | Unchanged from round 2: partial for US (no hash), accepted for satellites, plus a systemd timer check at Stage 3. |
| §3.6 host scripts: all five named files exist, none contains `attestation-index`; a recursive grep of `/root/rubric-tracker` found nothing | **Rejected as evidence for 0.5.** A script can reach the jsonl through a variable, a glob, `readdir` on `bundles/`, an env path, or imported `dist` code. Line counters matter too. The tracker needs an explicit file list. |
| US dry run, `~/p6-dryrun.json` | **The same run as round 2.** All 19 counts are identical, including `anchors` 35846. It has no hostname, time or script hash. Planning evidence only. Every count that could write a wrong line is 0. The summary again left out `notThisFlush` (2000). |

## Round 3 findings

9. **Finding 6 stands; the in-index guard does not keep links local.** The
   aggregator that consumes an item runs its tier-1 flush, writes the stub,
   and appends the jsonl line itself (`index.ts:136-152`). Under a shared
   stream the guard proves "flushed here", not "owned here". `stubBindError`
   does not help: the stub really is bound to this flush. Correction to the
   premise: the claim lives on the stream's own Redis with no TTL, made in
   one Lua script with the enqueue (`src/shared/attestation-claim.ts:1-21`),
   so a shared stream means federation-wide claims. The remaining exposure is
   ids from before #62, unacked stream entries replayed at restart, and any
   enqueue path that skips the claim.
10. **The payer does not identify a node.** `0.0.3923341` is the D4 anchor
    payer and the only payer on the topic. Which nodes use it is answered per
    node (0.2), not from the mirror.
11. **The 2000 `notThisFlush` refusals come from one anchor message.** All of
    them are `warm-other-flush`, at anchor
    `00949ddc-b802-407a-af7b-2d2e6042bf25` (seq 276440), flushes
    `26df6c9d-c1be-4644-8067-beb85dac102a` and
    `721b2a13-2291-4feb-87c4-1c30e5f16a71`. The warm record names flush
    `acc07fd1-401c-4f19-9163-1a60a0dc2e00` and the same anchor. #68's
    explanation that the owning anchor was "not visited" is refuted by this
    data.
12. **The 23 incomplete messages match the independent full-topic scan**
    (spec §3.6). The backfill parses only complete messages
    (`anchor-links-backfill.mjs:139-143`), so they can only cause missing
    links.
13. **Anchor-job links carry `hcsConsensusTs: null`, so the backfill appends
    a second line that fills it in.** These are not counted as
    `alreadyPresent`. Round 2's 2.4 accounting is replaced.
14. **28,904 of 35,846 anchors have a bundle on US.** This is anchors minus
    noBundle from the same run, not new evidence. A bundle on US doesn't
    prove US made the anchor, and noBundle doesn't prove another node did.
    It doesn't explain the 1.12M `notInIndex` gap either, because the node
    that flushes an item also indexes it.
15. **`/code-review high` is recorded for #67 (`7fcaf65b`), not for #68's own
    diff.**
16. **No record shows which build on US would write permanent lines.** The
    fleet digest covers only `dist/api` + `dist/verify`, `.deployed-inputs`
    exists only on satellites, and the dry run carries no hostname, time or
    script hash. Turning the flag on would make an unidentified
    `dist/aggregator` write lines that can't be removed.

## Round 2 verdict (superseded)

| Item | Ruling |
|---|---|
| A: writer flag | **NO-GO now.** It stays GO WITH CONDITIONS on **US only** once Stage 0 is met. No Stage 0 gate is met yet. The deciding gate is 0.2 (O3). |
| B: first `--apply` | **NO-GO.** Stage 1 must pass first. The fresh dry run fails 2.3 on `notThisFlush` (2000) and `incompleteMessages` (23). |
| C: scope | **Staged plan stands**, amended at 3.1. US first. Satellites stay off until O3 is answered and US has run cleanly for 7 days. Then one node at a time. |

The round 2 vote was HOLD from all three directors. Its flip condition (a
payer listing matching each node) is withdrawn in round 3 (finding 10).

## Round 2 evidence, and how it was weighed

| Evidence | Weight |
|---|---|
| #68 merged and deployed, fleet digest `aed6b5fbadb1` on all 5 nodes | **Code accepted, digest not.** In #68, `sync-all.sh:53-54` still hashes only `dist/api` and `dist/verify`. So the digest cannot show which `dist/aggregator` build is live, and neither the link writer nor `warm-anchor-guard.js` (which the backfill loads) is covered. |
| #68 fixes: strict stub binding, not-in-index filtering in backfill and anchor job, exit 4 on conflict | **Accepted in code** (`anchor-link.ts:83-93`, `anchor-links-backfill.mjs:368`, `warm-backfill.ts:145`, `anchor-links-backfill.mjs:419-424`). No `/code-review high` record was supplied for `93bd6b66` or #68. The tier-2 bundle read-modify-write race is **not fixed**: `src/aggregator/index.ts:93-105` writes the bundle back with a plain `writeFileSync`, which is neither locked nor atomic. |
| O3: every node runs its own aggregator on local Redis, per satellite `pm2 env` `REDIS_HOST=127.0.0.1` | **Rejected as evidence.** 0.2 ruled out `pm2 env`. `index.ts:47` reads `SHARED_REDIS_HOST` before `REDIS_HOST`, and dotenv can load it from `/root/tempus/.env`, so a pm2 `REDIS_HOST` value proves nothing. The start-up log, `TIERED_GROUP_NAME` and payer listing were not supplied. |
| #61 deployed on US | **Partial.** Stated, with no source check or hash. |
| No satellite runs `reconcile-rt` from cron | Accepted. Relevant at Stage 3. |
| Host script checks (0.5) | **Not supplied.** The operator's message held the literal placeholder `PASTE_HERE`. |
| Fresh US dry run, `~/p6-dryrun.json` (15:16) | **Accepted as a real run** (2.1 met). It **fails 2.3**, see below. The operator's summary left out `notThisFlush`. From now on, thresholds are read from the raw JSON, never from a summary. |

Dry run counts: anchors 35846, linksAppended 76327, bytesToAppend 27325066
(about +50% on a ~55 MB jsonl), alreadyPresent 3, notInIndex 1121882,
unresolvedIds 0, noBundle 6942, rootMismatch 0, malformedMessages 0,
badId 0, conflicts 0, **notThisFlush 2000** (19 ids, 38 pairs),
foreignChunks 0, **incompleteMessages 23**, linkErrors 0,
indexAttestationLines 105718, indexIds 103715.

- **`notThisFlush`:** every one of the 2000 comes from one anchor message,
  `00949ddc-b802-407a-af7b-2d2e6042bf25` (seq 276440). That message lists 19
  ids about 53 times each under flushes `26df6c9d…` and `721b2a13…`. The
  warm record for each of those ids says flush `acc07fd1…`. The same id
  under three flushes points to a double-flush, replay or double-anchor bug
  on the write path, separate from P6. The guard refused these ids, so the
  run would write nothing for them, but the cause is unexplained.
- **`incompleteMessages`:** 23 chunked messages from payer `0.0.3923341`,
  each `total=10` with some chunks missing.
- **`notInIndex`:** 1.12M against 103,715 indexed ids. A jsonl that started
  late, with older history before it, would explain this. But 28,904 of the
  35,846 topic anchors (81%) have a bundle on US. Neither fact proves or rules
  out O3.

## Round 2 findings

6. **A wrong link is still possible under O3, even with #68.**
   `warm-anchor-guard.ts:36` allows a link when an id has no warm file, so the
   stub alone is the evidence. Ids are claimed per node, so the same id
   string can exist on two nodes. Suppose aggregators share a stream and
   node X's `foo` is anchored on US. If US's own `foo` is in the US jsonl but
   retention has deleted its warm file, a permanent wrong link is written.
   #68 turns most O3 failures into missing links, but not this one. 0.2 still
   blocks A.
7. **The anchor job sometimes reads the whole jsonl.** It gets the jsonl's
   ids through a cached reader (`index.ts:94`, then `index-reader.ts:31-34`).
   A normal anchor reads only the bytes appended since the last read. The
   whole file is read again at start-up, and whenever it is replaced
   (`reconcile-rt.py` `os.replace`), shrinks or is rewritten. That is about
   55 MB now and about 82 MB after B. Anchor latency is added to the 1.3 soak
   criteria, especially around a reconcile run.
8. **The not-in-index filter can stand in for 2.2**, the list of planned
   link ids. The guarantee lives in code, so it counts only once 0.1 (review)
   and 0.3 (build hash) are met. A check after apply is added to 2.4.

## Gate scorecard (round 3, superseded)

| Gate | Score | Reason |
|---|---|---|
| 0.1 | PARTIAL | #67 reviewed; #68's own review, the RMW race acceptance and the equivalence runs are open. |
| 0.2–0.6 | NOT MET | 0.2 rests on `pm2 env`; 0.3 has no `dist/aggregator` hash; 0.4 has no hash; 0.5 is a literal grep; 0.6 not supplied. |
| 1.1–1.3 | NOT MET | Not started, which is the correct order. |
| 2.1 | MET | `~/p6-dryrun.json` is a real run with an explicit store. |
| 2.2 | PARTIAL | The #68 filter stands in once 0.1 and 0.3 are met; the signer tally is not run. |
| 2.3–2.4, 3.1–3.2 | NOT MET | |

## Gate scorecard (round 2, superseded)

| Gate | Score | Reason |
|---|---|---|
| 0.1 | PARTIAL | Stub, exit-code and local-index fixes are in #68. No `/code-review high` record. The bundle RMW race is open. |
| 0.2 | NOT MET | Rests on `pm2 env`, which this gate excludes. No start-up log, group name or payer listing. |
| 0.3 | NOT MET | `aed6b5fbadb1` does not cover `dist/aggregator`. |
| 0.4 | PARTIAL | "Deployed" is stated, with no source check or hash. |
| 0.5 | NOT MET | No evidence (`PASTE_HERE`). |
| 0.6 | NOT MET | Nothing supplied. |
| 1.1–1.3 | NOT MET | Not started, which is the correct order. |
| 2.1 | MET | `~/p6-dryrun.json` is a real run with an explicit store. |
| 2.2 | PARTIAL | The #68 filter stands in once 0.1 and 0.3 are met. |
| 2.3 | NOT MET | `notThisFlush` 2000 and `incompleteMessages` 23. `noBundle` can't be checked without the payer listing. |
| 2.4 | NOT MET | Not run. |
| 3.1–3.2 | NOT MET | O3 is open. |

## Round 1 (superseded verdict, kept for the record)

| Item | Ruling |
|---|---|
| A: writer flag | GO WITH CONDITIONS, on US only, after every Stage 0 gate. |
| B: first `--apply` | NO-GO until a valid dry run on US meets the Stage 2 thresholds. |
| C: scope | Staged. US first, satellites after O3 and 7 clean days on US. |

### Round 1 evidence

| Evidence | Weight |
|---|---|
| #55 reader filter on all 5 nodes, digest `5088270e00a5` | **Accepted for readers only.** `sync-all.sh:54` hashes `dist/api` + `dist/verify`. It does not cover `dist/aggregator`, where the link writer lives. So it says nothing about whether #67's writer is built on any node. |
| 0 jsonl lines with a `kind` key | Accepted. The **node is not named**, and each node has its own jsonl. Re-record it with the hostname (0.6). |
| Store filesystem is ext4 | Accepted. The node is not named either (0.6). |
| `reconcile-rt.py` skips `kind` lines; `retention.py` only lists the jsonl in `NEVER_DELETE` | Accepted for those two scripts. Spec §3.6 lists six more host scripts, and they are **unchecked** (0.5). `sync-all.sh` does not ship `reconcile-rt.py`, so each node's copy must be checked separately. |
| #61 merged | **Not enough.** It merged at 13:41Z, after #67. Merged is not deployed to `/root/tempus` (0.4). |
| 0 `WARM_ANCHOR_FOREIGN_RECORD_SKIPPED` / `WARM_RECORD_OVERWRITE_REFUSED` in pm2 logs | Accepted. |
| Dry run in `~/p6-dryrun.txt` | **Rejected.** The file has one line, `anchor-links-backfill: --store is required`. The script exited while parsing arguments, before it contacted the mirror. No counts exist. |

### Round 1 findings

1. **#67 merged without `/code-review high`.** Its own body says the review
   had not been run, and rubric-protocol `CLAUDE.md` lists "anything signed
   or anchored" as high-scrutiny. Turning the flag on is what makes the code
   live, so this blocks both A and B.
2. **`stubBindsFlush` accepts unbound stubs**
   (`src/api/anchor-link.ts:78-86`). A stub with no `tier1FlushId`/`flushId`
   and no `batchRoot`/`forestRoot` returns `true`. Stub ids can be
   caller-chosen, and the first link for an id wins for good (§3.2).
   *Round 2: fixed in #68.*
3. **The aggregator may consume federation-wide work.**
   `src/aggregator/index.ts:3` calls itself "the federation-wide single
   aggregator", consuming `rubric:tiered:stream`, and `ecosystem.config.cjs`
   runs it on every node with no hostname gate. If several aggregators read
   one shared stream, a node can anchor flushes whose ids were indexed on
   another node. With the flag on, it would then write links for ids that are
   not in its own jsonl. This is spec O3, still open, and it affects A as well
   as B. *Round 2: still open. See finding 6.*
4. **The backfill never checks that a linked id is in the local jsonl.** Its
   dry run prints counts and problem details, not the links it plans to
   append. So nobody can confirm from a dry run that every planned link is
   for a local id. *Round 2: filter added in #68. See finding 8.*
5. **The backfill exits 0 when it has unresolved ids or conflicts.** The
   exit code depends only on `linkErrors`. Operators judge from the JSON
   counts, never from the exit code. *Round 2: exits 4 on conflict in #68.
   Thresholds are still read from the JSON.*

## Conditions

All of these run on US. Repeat them per satellite only at Stage 3.

### Stage 0: gates for both A and B

- [ ] 0.1 Review and tests, against `c22dd75d` (rubric-protocol PR 69).
      - *Met in PR 69:* `/code-review high` on #68's own diff
        (`32703b74^..32703b74`), 10 findings with outcomes.
      - In PR 69, record the reason for each review finding not acted on (1,
        6, 8, 9) and for the part of review finding 7 not acted on.
      - Run `/code-review high` on PR 69's own changes to `src/` and
        `scripts/anchor-links-backfill.mjs` (`32703b74..c22dd75d`) and record
        the findings in PR 69. The fixes for review findings 2, 3, 4, 5 and
        10 are new writer and backfill code.
      - Record which staged diff the safety-reviewer PASS covers. It counts
        only if that diff is the one merged at `c22dd75d`.
      - Confirm in #67 that its head `93bd6b66` and its merge `7fcaf65b`
        have the same tree.
      - Read-modify-write race on the tier-2 bundle, at `index.ts:93-105`
        and in the retry drainer at `index.ts:212-241`: fix both with a
        locked or atomic write, or record a signed acceptance that names
        both sites.
      - Run `tests/index-readers/equivalence.test.mjs` 20 times against a
        compiled `c22dd75d` and record every failure with its failing case.
        One run is not 20.

      Build and test in a separate scratch checkout (for example a git
      worktree under `/tmp`), never in `/root/tempus`. If a failure shows an
      id in the id set that has no attestation line, A is NO-GO.
- [ ] 0.2 On each of `vultr`, `rubric-node-sg-1`, `rubric-node-jp-1`,
      `rubric-node-ca-1` and `rubric-node-eu-1`, record the raw output of:
      - `hostname`
      - `ss -tnp | grep "pid=$(pm2 pid rubric-aggregator),"`
        (rubric-protocol `docs/ATTESTATION-ID-OWNERSHIP.md`). This is the
        authoritative evidence. It must show the aggregator's Redis
        connection going to `127.0.0.1:6379` and to no other Redis address.
        Empty output means the gate is not met.
      - `ss -tlnp 'sport = :6379'`: the listener is owned by `redis-server`
        and bound to loopback only.
      - `ss -tnp 'dport = :6379'`: the client process names. A client owned
        by `sshd`, `ssh`, `stunnel` or `socat` is a tunnel, and the node
        fails.
      - supporting count, which prints no value:
        `grep -cE '^\s*(export\s+)?SHARED_REDIS_HOST=' /root/tempus/.env`
        must print `0`.

      This replaces round 3's `Connected to Redis` log line, which
      (`index.ts:56`) prints the configured host before any connection
      exists. The `TIERED_GROUP_NAME` and `HEDERA_ACCOUNT_ID` counts are
      dropped (finding 20). Don't use `pm2 env`: it can miss `.env`, and it
      prints private keys. Record the per-host lines in #56; a summary of
      five hosts is not the output.
      **Pass for A: on all five nodes the aggregator connects only to a
      loopback-only `redis-server` on `127.0.0.1:6379`, with no tunnel
      client. There is no other way to pass.** If any node fails, A is
      NO-GO and the ruling goes back to the board. A new round would at
      least need the anchor-job path to refuse a link when an id has
      neither a warm nor a cold file, and every path that enqueues to
      `rubric:tiered:stream` shown to go through the claim script.
- [ ] 0.3 On US (`vultr`), read-only. **Never run `sync-all.sh` for this: it
      ships to and builds on all four satellites.** Record the raw output of:
      - `hostname`
      - `git -C /root/tempus rev-parse HEAD`: `c22dd75d` in full, or a later
        commit whose
        `git rev-parse HEAD:src HEAD:package.json HEAD:package-lock.json HEAD:tsconfig.json HEAD:ecosystem.config.cjs`
        output is identical to `c22dd75d`'s.
      - `git -C /root/tempus status --porcelain -- src package.json package-lock.json tsconfig.json ecosystem.config.cjs`:
        prints nothing.
      - `cat /root/tempus/.deployed-sha /root/tempus/.deployed-inputs` and
        `stat -c '%y' /root/tempus/.deployed-sha`. The sha equals HEAD. The
        inputs value equals
        `git -C <scratch> rev-parse HEAD:src HEAD:package.json HEAD:package-lock.json HEAD:tsconfig.json HEAD:ecosystem.config.cjs | sha256sum | cut -c1-16`
        (the computation in `deploy.sh`). **Never run `deploy.sh` for this:
        it builds and restarts production in `/root/tempus`.**
      - `ps -o lstart= -p $(pm2 pid rubric-aggregator)`: later than the
        stamp's mtime, because `deploy.sh` ignores a failed restart.
      - `(cd /root/tempus/dist && find api aggregator -name '*.js' -type f | LC_ALL=C sort | xargs sha256sum | sha256sum)`,
        matching the same command in a scratch build of `c22dd75d` (as in
        0.1), never in `/root/tempus`. Relative paths let the two match.
        `dist/api` is included because the writer and the backfill load it
        (`anchor-links-backfill.mjs:27-31`).

      Empty output from any command means the gate is not met. If the
      `dist` hashes differ, record both, and the board rules on it.
- [ ] 0.4 On US, confirm #61 is in `/root/tempus/reconcile-rt.py` by
      checking its source or a hash.
- [ ] 0.5 On US, check each host script in spec §3.6:
      `/root/rubric-backup-v2.sh`, `/root/rubric-stats.py`,
      `/root/rubric-tracker/*`, `/root/rubric-assert/run.sh`,
      `/root/tempus/reconcile-anchors.mjs`, `/root/health-monitor.sh`.
      - Run `find /root/rubric-tracker -type f` and record the file list.
      - For every file, run
        `grep -nE 'jsonl|attestation-index|bundles|INDEX|tempus-attestation-store|readdir|glob|dist/'`
        and have a human read every hit.
      - Check root's `crontab -l`, `/etc/crontab`, `/etc/cron.d/*` and
        `systemctl list-timers --all` for any jsonl consumer not on the
        list.
      - **Record only file paths, the matching identifiers and the
        classification. Never paste raw crontab lines or grep hits into #56**:
        they can hold inline secrets (for example `*_INDEX_TOKEN=`).
      - Classify each script as one of: does not read the jsonl / copies
        bytes only / reads through `dist` index-reader / parses and skips
        `kind` / **parses or counts without skipping**. A script in the last
        class must be fixed before the first `kind` line is written.

      A grep for the literal string `attestation-index` alone is not
      evidence.
- [ ] 0.6 On US, record the hostname alongside
      `grep -c '"kind"' /mnt/tempus-attestation-store/bundles/attestation-index.jsonl`
      (must be 0) and `findmnt -no FSTYPE -T /mnt/tempus-attestation-store`.
      The output must be non-empty, and must not be NFS or another network
      filesystem. Without `-T`, a path that isn't itself a mount point
      prints nothing.

### Stage 1: A on US

- [ ] 1.1 Record the jsonl's byte size and sha256. This is the audit
      boundary: every line before it is pre-P6.
- [ ] 1.2 Set `RUBRIC_ANCHOR_LINKS_ENABLED=true` in `/root/tempus/.env` on
      US only. The flag is not in the `ecosystem.config.cjs` env list, and
      `sync-all.sh` does not ship `.env`. Then run `pm2 restart
      ecosystem.config.cjs --only rubric-aggregator --update-env`. Never
      start the process other than through `ecosystem.config.cjs`. The
      start-up log must show `anchor links (RUBRIC_ANCHOR_LINKS_ENABLED): ON;
      index /mnt/tempus-attestation-store/bundles/attestation-index.jsonl`.
      It must also show `anchor links: N attestation ids in the index` with
      N ≥ 103758 (the `indexIds` of the `c22dd75d` stamped dry run; only #68
      and later code prints this line), and must show neither
      `anchor links will not be written` nor `unreadable`. If either
      appears, Stop at once.
- [ ] 1.3 Soak for at least 24 h, including at least one `reconcile-rt` run.
      Pass criteria:
      - zero `WARM_*` events, `linkErrors = 0` on `/v1/aggregator/stats`,
        no aggregator restart, RSS under 512 MB, reader counts unchanged
      - `linksSkippedNotInIndex = 0`. The only exception is a retry-drainer
        re-anchor of a flush from before the restart, traced by flushId.
        Otherwise Stop and find the root cause.
      - every item in anchors since the restart is accounted for as
        `linksAppended`, `linksSkippedNotInIndex` or `linksSkippedForeign`,
        or lies in a flush counted under `linksSkippedNoStub` (that counter
        counts flushes, not items)
      - a read-only audit of **every** `kind` line in the file (0.6 proved
        there were none before P6) finds each line's id as an attestation
        line. Don't audit from the 1.1 byte offset: `reconcile-rt.py`
        rewrites earlier lines, so offsets and the 1.1 sha256 shift after
        its run.
      - anchor latency, measured per tier-2 bundle as `anchorConfirmedAt −
        anchoredAt`, excluding bundles with `lateAnchor: true` from both
        windows: the maximum during the soak is no more than the maximum of
        the 24 h before the flag plus 10 s, including the anchor right after
        the `reconcile-rt` swap (finding 7)
      - list by id every `linksSkippedNotInIndex` traced to the
        retry-drainer exception; 2.3 allows for exactly those ids

### Stage 2: B on US

- [ ] 2.1 Run the dry run with an explicit store:
      `node scripts/anchor-links-backfill.mjs --store /mnt/tempus-attestation-store`.
      Save the JSON output. *Met for the pre-Stage-1 runs on 2026-10-09
      15:16 (`~/p6-dryrun.json`, unstamped) and 16:44:05Z
      (`~/p6-dryrun-stamped.txt`, `c22dd75d`). Re-run after Stage 1.*
- [ ] 2.2 The #68 not-in-index filter stands in for an explicit list of
      planned link ids, once 0.1 and 0.3 are met. In addition, a read-only
      signer tally over every tier-1 flush the run resolves must show 100%
      US: the `issuer_node_region` from the signed envelope, or the stub's
      `publicKey` checked against US key history. If any flush is not US,
      B and C are NO-GO.
- [ ] 2.3 Re-run the dry run no more than 1 h before apply, from
      `/root/tempus`, captured as one file with the commands in it:
      `{ hostname; date -u +%FT%TZ; git rev-parse HEAD; sha256sum scripts/anchor-links-backfill.mjs; (cd dist && find api aggregator -name '*.js' -type f | LC_ALL=C sort | xargs sha256sum | sha256sum); node scripts/anchor-links-backfill.mjs --store /mnt/tempus-attestation-store; echo "exit=$?"; } > ~/p6-preapply.txt 2>&1`
      The script sha256 must be the full
      `f64e1c3a12595ea29994f316237aaefe41efeee6f902ece112f7a579eaf45501`
      (the file at `c22dd75d`). The `dist` hash must equal 0.3's. A 16-hex
      prefix, or a header typed by hand, does not count. Read the thresholds
      from the raw JSON, never from the exit code or a summary:
      - `badId`, `rootMismatch`, `malformedMessages`, `conflicts` and
        `linkErrors` are 0, and the exit code is 0.
      - `unresolvedIds`: 0, or every entry explained by flushId.
      - **Anchor `00949ddc` root cause, recorded before apply.** It must
        state:
        - whether `acc07fd1-401c-4f19-9163-1a60a0dc2e00` is in
          `00949ddc….json` `tier1Flushes`. *Stated by the operator in round
        4: yes. Confirm from the file.*
        - the copy count of each of the 19 ids in each of the three flush
          stub files. For `26df6c9d…` and `721b2a13…`, the `occurrences` in
          `~/p6-dryrun-stamped.txt` serve. Add `acc07fd1…`.
        - per (id, flush): `payloadHash`, content digest and `issuedAt`;
        - the UTC times when #62 and M42b were deployed on US, from deploy
          or pm2 records, not from memory;
        - the API key fingerprint behind each submission or, before #62, the
          request log entry. `sourceId` is a payload field the caller writes
          (`index.ts:150`) and does not identify a party.

        Copies within one flush that share one payload hash are the M42
        queue replay, and they don't block B. Content that differs across
        flushes blocks B unless every submission of every one of the 19 ids
        predates the #62 deploy on US and came from one internal key. Then
        the cause is a pre-#62 resubmission by one party. If any differing
        submission is later than the #62 deploy, it skipped the claim
        (finding 9's class): B is NO-GO and the ruling goes back to the
        board.

        *Recorded after round 4.* Board-verified from `git log`: the #62
        merge. Operator-stated: the deploy and submission times.
        - rubric-protocol #62 (id claiming) is `8c7c66d2`, merged
          2026-10-09T06:36:44-04:00 (10:36:44 UTC). It is an ancestor of
          `c22dd75d`.
        - #62 was deployed fleet-wide 2026-10-09 10:48 UTC (operator-stated;
          the deploy or pm2 record is not yet supplied).
        - The `m42-golden` submissions are 2026-07-14 21:37 UTC
          (operator-stated, from the cold stub files). That is about three
          months before #62 existed.

        On the operator-stated submission time, the timing condition is
        met: every submission of the 19 ids predates #62. If that time is
        confirmed, cause (b) in finding 25 (a later path that skips the
        claim) is ruled out for these ids. Whether this is the closed
        historical defect of cause (a) depends on the key condition below.
        Still open before apply:
        - per (id, flush) `issuedAt`, `payloadHash` and content digest, read
          from the stub files;
        - the #62 deploy or pm2 record for US;
        - the one-internal-key condition: before #62, the request log entry
          for each submission;
        - the M42b deploy time on US.
      - **Open design item: exclusion list for the fixture ids.** Add an
        explicit exclusion list to `scripts/anchor-links-backfill.mjs` for
        the 19 `m42-golden` ids. The backfill then writes none of the 19
        links (one per id) it would otherwise write through `acc07fd1`
        (finding 24).
        The list is the 19 ids in `~/p6-dryrun-stamped.txt`
        `details.notThisFlush`. Excluded ids are reported by count and id in
        the JSON output, and are not counted as `linksAppended`. This needs
        a code change in rubric-protocol, with its own review and the 0.1
        and 0.3 hashes re-taken. If it lands, the 2.3 `linksAppended` bounds
        drop by 19, and the note below records the ids as unlinked fixtures
        instead of single-leaf links.
      - **Note, before apply, when B proceeds.** Record in
        `docs/specs/attestation-index-and-replay.md` and in #56 that anchor
        `00949ddc-b802-407a-af7b-2d2e6042bf25` (seq 276440) commits each of
        the 19 listed ids to three leaves with different payloads. Record
        that the ids are the internal `m42-golden` fixture, and that B writes
        one link per id to this anchor, for the `acc07fd1` leaf named by the
        warm record (finding 24). decision-verify must check these links
        against that leaf only and report the ids as test fixtures. An
        erratum (rubric-protocol `docs/RUBRIC-ERRATUM-2026-001.md` process)
        is required instead if any of the 19 ids was ever given to a
        customer.
      - `notThisFlush`: once the root cause is recorded, every entry must be
        one of the 38 pairs (the 19 ids in `~/p6-dryrun-stamped.txt`, the
        same 19 as `~/p6-dryrun.json`, × flushes
        `26df6c9d-c1be-4644-8067-beb85dac102a` /
        `721b2a13-2291-4feb-87c4-1c30e5f16a71`), with reason
        `warm-other-flush`, recordFlush `acc07fd1-…`, anchor `00949ddc-…`,
        seq 276440. Counts: `notThisFlush` ≤ 2000, `notThisFlushPairs` ≤ 38,
        `notThisFlushIds` ≤ 19. Anything else means stop.
      - `incompleteMessages`: any value. List each as a failed submit from
        the anchor payer `0.0.3923341`, known to be unlinked. For P8, record
        whether chunk 1 decodes to `{"type":"RUBRIC_TIER2_ANCHOR"`.
      - `notInIndexIds` ≤ 1121882 plus the ids listed under the 1.3
        retry-drainer exception. Any other rise means stop.
      - `alreadyPresent` ≤ 3, unless explained. Confirm that the 3 are
        repeats within this run in flush `acc07fd1` (22 items, 19 ids).
      - `linksAppended`: at least 76368 minus any explained rise in
        `unresolvedIds`, and at most 76368 + (new `indexIds` − 103758). Any
        overrun must be traced by id.
      - `bytesToAppend / linksAppended` between 340 and 380.
      - `noBundle` and `foreignChunks`: record them. They don't block B;
        noBundle is reconciled at 3.1.
- [ ] 2.4 Record the jsonl's byte size and sha256. Pause the
      `reconcile-rt.py` cron for the whole window: comment out its entry
      with `crontab -e` (or in the `/etc/cron.d` file found at 0.5), then
      confirm that `crontab -l | grep -c '^[^#].*reconcile-rt'` (or the
      same `grep -c` on that `/etc/cron.d` file) prints 0,
      and that no `reconcile-rt.py` process is running
      (`pgrep -fc reconcile-rt.py` prints 0). Run `--apply`. It refuses
      a store whose jsonl is not the writer's `INDEX_PATH`. It must exit 0
      with no `applyRefused`. The number of new lines with
      `"source":"backfill-mirror"` must equal the apply's own
      `linksAppended` exactly. Fill-in lines for anchor-job links (finding
      13) are expected and are not counted as `alreadyPresent`. Then:
      - a read-only audit finds every `kind` line's id as an attestation
        line;
      - a re-dry-run shows `linksAppended = 0` (apart from anchors after the
        apply), `conflicts = 0`, exit 0;
      - record the size and sha256, then restore the cron entry and
        confirm the `grep -c` above prints 1.

      If the apply exits nonzero, is interrupted, or any check fails,
      restore the cron entry anyway (see Abort).

### Stage 3: satellites

- [ ] 3.1 Only after all of these: 0.2 shows local Redis on all five nodes;
      the 1.12M `notInIndex` gap has a written root cause (check
      `[INDEX-WRITER] REJECTED unsigned` in the logs, the first jsonl `ts`
      against the earliest anchor, and the 2.2 signer tally); and US has run
      cleanly for 7 days after B. Then dry-run all five nodes and confirm:
      - each `anchorId` resolves to a bundle on **exactly one** node (if any
        resolves on two, bundles are being replicated: stop);
      - US `noBundle` equals the anchors resolved on satellites plus those
        archived past 90 days;
      - each node's signer tally is 100% its own region.

      The payer listing is not used: the topic has one payer (finding 10).
- [ ] 3.2 Then go one satellite at a time, repeating 0.3–2.4 with that
      node's own values. Each satellite builds its own 2.3 exceptions from
      its own dry run; the US exceptions can't be reused. `sync-all.sh`
      ships neither `scripts/anchor-links-backfill.mjs` nor
      `reconcile-rt.py`, so copy them, verify them by hash, and record that.
      Confirm `reconcile-rt.py` runs from neither cron nor a systemd timer.

## What flips each NO-GO

- **A:** 0.1–0.6 (round 4 text) recorded in #56 as raw per-host output
  against `c22dd75d`, and 0.2 shows every aggregator on a loopback-only
  `redis-server` at `127.0.0.1:6379` on all five nodes.
- **B:** Stage 1 passed; the anchor `00949ddc` root cause shows every
  differing submission predates the #62 deploy on US and came from one
  internal key, and the 2.3 note is recorded; the 2.2 signer tally is 100%
  US; the 2.3 pre-apply run passes against `c22dd75d`.
- **C:** 3.1.

## Scope consequences while the satellites are off

- Satellite ids have no anchor links. decision-verify must report them as
  unlinked, not as failures.
- US-anchored ids that aren't in the US jsonl have no links, by design.
  decision-verify must report them as unlinked too.
- P8 will see topic anchors that no US link covers. Until O3 is answered and
  the satellites are on, it must treat those, and US anchors over
  not-in-index ids, as expected rather than as drift.

## Abort and rollback

Lines cannot be removed, so rollback only stops new ones.

- **Stop:** set `RUBRIC_ANCHOR_LINKS_ENABLED=false` explicitly in
  `/root/tempus/.env`, then run `pm2 restart ecosystem.config.cjs --only
  rubric-aggregator --update-env`. Don't just delete the line: pm2 can keep a
  previously merged value. Confirm the start-up log shows
  `anchor links (RUBRIC_ANCHOR_LINKS_ENABLED): off`. If it still shows ON,
  the value is coming from pm2's saved env, because dotenv does not
  override it. Clear it there and restart through the ecosystem file.
- **Abort on any of:**
  - `linkErrors > 0`
  - a conflict on a repeat dry run, or backfill exit code 4
  - any `WARM_*` event
  - a jsonl reader error or count change
  - the 1.3 accounting not balancing, or `linksSkippedNotInIndex` > 0
    without a trace
  - the start-up log showing `unreadable` or `will not be written`
  - a linked id missing from the local jsonl
- **After an aborted apply:** restore the `reconcile-rt.py` cron entry
  paused at 2.4, whatever the apply's exit code (1, 4, interrupted). Record
  the jsonl's size and sha256, and dry-run again before deciding anything
  else.
- **Correction:** a wrong link is superseded through the erratum process
  (rubric-protocol `docs/RUBRIC-ERRATUM-2026-001.md`), never edited out.
