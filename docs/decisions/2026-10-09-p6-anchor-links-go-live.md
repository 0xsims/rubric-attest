# Board decision: P6 anchor links go-live (2026-10-09)

Subject: rubric-protocol #67 (merged at `93bd6b66`) and #68 (`33a2dc47`).
They cover two steps:
**(A)** setting `RUBRIC_ANCHOR_LINKS_ENABLED=true` on `rubric-aggregator`,
and **(B)** the first production `--apply` of
`scripts/anchor-links-backfill.mjs`. Spec:
`docs/specs/attestation-index-and-replay.md` §3.2–§3.4, §3.6, §7.

Anchor-link lines can never be removed from `attestation-index.jsonl` (D5).
So each step is irreversible, and each is run by a human. This record does
not flip the flag or run apply.

The board has ruled twice. Round 2 (below) is in force. Round 1 is kept
underneath as history.

## Verdict (round 2, in force)

| Item | Ruling |
|---|---|
| A: writer flag | **NO-GO now.** It stays GO WITH CONDITIONS on **US only** once Stage 0 is met. No Stage 0 gate is met yet. The deciding gate is 0.2 (O3). |
| B: first `--apply` | **NO-GO.** Stage 1 must pass first. The fresh dry run fails 2.3 on `notThisFlush` (2000) and `incompleteMessages` (23). |
| C: scope | **Staged plan stands**, amended at 3.1. US first. Satellites stay off until O3 is answered and US has run cleanly for 7 days. Then one node at a time. |

The board vote was HOLD again from all three directors (acquirer, standards
reviewer, compliance buyer). The one condition that flips A is the 0.2
evidence pack:
- the `Connected to Redis at` line and `TIERED_GROUP_NAME` from the start-up
  logs of all five aggregators;
- a listing of topic `0.0.10416909` messages by payer.

It must show five separate local Redis instances, with each payer matching
the node that holds its bundles.

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

## Gate scorecard (round 2)

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

- [ ] 0.1 Run `/code-review 93bd6b66 high` and `/code-review 33a2dc47 high`
      on rubric-protocol, and record the findings in #67 and #68. The
      `stubBindsFlush` and exit-code fixes are in #68. Still open: the
      tier-2 bundle read-modify-write race (`index.ts:93-105`). Fix it with
      a locked or atomic write, or record a signed acceptance of the risk.
- [ ] 0.2 Answer O3 with evidence: list topic `0.0.10416909` messages by
      payer and transaction node. On all five nodes, record the Redis host
      that `rubric-aggregator` actually uses. Take it from its start-up log
      (`pm2 logs rubric-aggregator --lines 2000 --nostream | grep 'Connected
      to Redis'`, `src/aggregator/index.ts:56`), along with
      `TIERED_GROUP_NAME` (default `rubric-aggregator-group`).
      - Don't use `pm2 env` for this. The aggregator loads `/root/tempus/.env`
        itself (`index.ts:13`) and reads `SHARED_REDIS_HOST` before
        `REDIS_HOST`. So `pm2 env` can show a local host while a shared one
        is in use. It also prints private keys.
      - Record hosts privately, or redacted in #67.
      - If more than one aggregator reads a shared stream: **stop**. A is
        NO-GO until each link is written to the jsonl of the node that owns
        the id.
- [ ] 0.3 On US, hash `dist/aggregator` the same way `sync-all.sh:54`
      hashes `dist/api`. Confirm it matches a fresh build of `33a2dc47` or
      later. The fleet digest does not cover it.
- [ ] 0.4 On US, confirm #61 is in `/root/tempus/reconcile-rt.py` by
      checking its source or a hash.
- [ ] 0.5 On US, check each host script in spec §3.6:
      `/root/rubric-backup-v2.sh`, `/root/rubric-stats.py`,
      `/root/rubric-tracker/*`, `/root/rubric-assert/run.sh`,
      `/root/tempus/reconcile-anchors.mjs`, `/root/health-monitor.sh`.
      Record "skips `kind` lines" or "does not read the jsonl" for each.
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
- [ ] 1.3 Soak for at least 24 h. Pass criteria:
      - zero `WARM_*` events
      - `linkErrors = 0` on `/v1/aggregator/stats`
      - reader counts unchanged
      - new `kind` lines roughly equal to items anchored
      - every linked id present as an attestation line in the US jsonl
      - tier-2 anchor latency recorded before and after, with no material
        regression, including across a `reconcile-rt` swap (finding 7)

### Stage 2: B on US

- [ ] 2.1 Run the dry run with an explicit store:
      `node scripts/anchor-links-backfill.mjs --store /mnt/tempus-attestation-store`.
      Save the JSON output. *Met for the pre-Stage-1 run on 2026-10-09
      15:16. Re-run after Stage 1.*
- [ ] 2.2 The #68 not-in-index filter stands in for an explicit list of
      planned link ids, once 0.1 and 0.3 are met.
- [ ] 2.3 Thresholds, read from the raw JSON and never from the exit code or
      a summary:
      - `badId`, `rootMismatch`, `conflicts` and `linkErrors` are all 0.
      - `notThisFlush` is 0, or every entry is covered by a written root
        cause. For anchor `00949ddc-b802-407a-af7b-2d2e6042bf25`
        (seq 276440), the root cause must say why 19 ids from flush
        `acc07fd1…` appear under flushes `26df6c9d…` and `721b2a13…`, and
        where `acc07fd1…` was anchored.
      - `incompleteMessages` is 0, or payer `0.0.3923341` is identified. If
        it is a fleet account, list its messages here as known-unlinked
        failed submits, and P8 treats them as expected.
      - Every `unresolvedIds` entry is explained by flush id, for example
        stubs that retention has already removed. Unexplained entries mean
        stop.
      - `noBundle` matches the anchors made by other nodes, checked against
        the 0.2 payer listing.
      - `foreignChunks` is recorded. Any value is acceptable, because those
        chunks are dropped.
- [ ] 2.4 Record the jsonl's byte size and sha256, then run `--apply`.
      `--apply` refuses a store whose jsonl is not the writer's `INDEX_PATH`.
      `linksAppended` must equal the dry run's prediction. Any difference
      must be explained by anchors that the writer linked in between, which
      show up as `alreadyPresent`. Then:
      - Dry-run again. It must show `linksAppended = 0` and `conflicts = 0`.
      - Confirm that the `id` of every new `kind` line has an attestation
        line in the jsonl.

### Stage 3: satellites

- [ ] 3.1 Only after O3 is resolved and US has run cleanly for 7 days.
      Before the first satellite apply, dry-run all five nodes. Confirm that
      each `anchorId` resolves to a bundle on **exactly one** node. If any
      resolves on two, bundles are being replicated: stop. Join the 0.2
      payer listing to the node that holds each bundle, and explain why US
      holds 81% of all topic bundles (28,904 of 35,846).
- [ ] 3.2 Then go one satellite at a time, repeating 0.3–2.4 with that
      node's own values. `sync-all.sh` ships neither
      `scripts/anchor-links-backfill.mjs` nor `reconcile-rt.py`, so copy
      them, verify them by hash, and record that.

## What flips each NO-GO

- **A:** the 0.2 evidence pack, plus 0.1 and 0.3–0.6 recorded.
- **B:** Stage 1 passed, a written root cause for anchor `00949ddc`, a
  `dist/aggregator` hash (0.3), and payer `0.0.3923341` identified.
- **C:** the payer listing joined to the node holding each bundle, showing
  that each `anchorId` resolves on exactly one node and explaining US's 81%
  share.

## Scope consequences while the satellites are off

- Satellite ids have no anchor links. decision-verify must report them as
  unlinked, not as failures.
- P8 will see topic anchors that no US link covers. Until O3 is answered and
  the satellites are on, it must treat those as expected rather than as
  drift.

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
  - `kind` lines growing faster than anchored items
  - a linked id missing from the local jsonl
- **Correction:** a wrong link is superseded through the erratum process
  (rubric-protocol `docs/RUBRIC-ERRATUM-2026-001.md`), never edited out.
