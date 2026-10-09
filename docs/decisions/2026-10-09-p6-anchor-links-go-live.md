# Board decision: P6 anchor links go-live (2026-10-09)

Subject: rubric-protocol #67 (merged at `93bd6b66`), which covers two steps:
**(A)** setting `RUBRIC_ANCHOR_LINKS_ENABLED=true` on `rubric-aggregator`,
and **(B)** the first production `--apply` of
`scripts/anchor-links-backfill.mjs`. Spec:
`docs/specs/attestation-index-and-replay.md` §3.2–§3.4, §3.6, §7.

Anchor-link lines can never be removed from `attestation-index.jsonl` (D5).
So each step is irreversible, and each is run by a human. This record does
not flip the flag or run apply.

## Verdict

| Item | Ruling |
|---|---|
| A: writer flag | **GO WITH CONDITIONS**, on **US only**, after every Stage 0 gate below. |
| B: first `--apply` | **NO-GO** until a valid dry run on US meets the Stage 2 thresholds. |
| C: scope | **Staged.** US first. The satellites stay off until O3 is answered and US has run cleanly for 7 days. Then one node at a time. |

The board vote was HOLD from all three directors (acquirer, standards
reviewer, compliance buyer). One thing flips it: a real US dry run that
meets every Stage 2 threshold and lists the ids it plans to link, all of
them present in the US jsonl, recorded after `/code-review high` on
`93bd6b66`.

## Evidence supplied, and how it was weighed

| Evidence | Weight |
|---|---|
| #55 reader filter on all 5 nodes, digest `5088270e00a5` | **Accepted for readers only.** `sync-all.sh:54` hashes `dist/api` + `dist/verify`. It does not cover `dist/aggregator`, where the link writer lives. So it says nothing about whether #67's writer is built on any node. |
| 0 jsonl lines with a `kind` key | Accepted. The **node is not named**, and each node has its own jsonl. Re-record it with the hostname (0.6). |
| Store filesystem is ext4 | Accepted. The node is not named either (0.6). |
| `reconcile-rt.py` skips `kind` lines; `retention.py` only lists the jsonl in `NEVER_DELETE` | Accepted for those two scripts. Spec §3.6 lists six more host scripts, and they are **unchecked** (0.5). `sync-all.sh` does not ship `reconcile-rt.py`, so each node's copy must be checked separately. |
| #61 merged | **Not enough.** It merged at 13:41Z, after #67. Merged is not deployed to `/root/tempus` (0.4). |
| 0 `WARM_ANCHOR_FOREIGN_RECORD_SKIPPED` / `WARM_RECORD_OVERWRITE_REFUSED` in pm2 logs | Accepted. |
| Dry run in `~/p6-dryrun.txt` | **Rejected.** The file has one line, `anchor-links-backfill: --store is required`. The script exited while parsing arguments, before it contacted the mirror. No counts exist. |

## Findings that shaped the ruling

1. **#67 merged without `/code-review high`.** Its own body says the review
   had not been run, and rubric-protocol `CLAUDE.md` lists "anything signed
   or anchored" as high-scrutiny. Turning the flag on is what makes the code
   live, so this blocks both A and B.
2. **`stubBindsFlush` accepts unbound stubs**
   (`src/api/anchor-link.ts:78-86`). A stub with no `tier1FlushId`/`flushId`
   and no `batchRoot`/`forestRoot` returns `true`. Stub ids can be
   caller-chosen, and the first link for an id wins for good (§3.2).
3. **The aggregator may consume federation-wide work.**
   `src/aggregator/index.ts:3` calls itself "the federation-wide single
   aggregator", consuming `rubric:tiered:stream`, and `ecosystem.config.cjs`
   runs it on every node with no hostname gate. If several aggregators read
   one shared stream, a node can anchor flushes whose ids were indexed on
   another node. With the flag on, it would then write links for ids that are
   not in its own jsonl. This is spec O3, still open, and it affects A as well
   as B.
4. **The backfill never checks that a linked id is in the local jsonl.** Its
   dry run prints counts and problem details, not the links it plans to
   append. So nobody can confirm from a dry run that every planned link is
   for a local id.
5. **The backfill exits 0 when it has unresolved ids or conflicts.** The
   exit code depends only on `linkErrors`. Operators judge from the JSON
   counts, never from the exit code.

## Conditions

All of these run on US. Repeat them per satellite only at Stage 3.

### Stage 0: gates for both A and B

- [ ] 0.1 Run `/code-review 93bd6b66 high` on rubric-protocol and record the
      findings in #67. Fix `stubBindsFlush` so a stub must carry a flush id
      or a root, or record a signed acceptance of the risk. Do the same for
      the backfill's exit code (finding 5) and the tier-2 bundle
      read-modify-write race noted by crypto.
- [ ] 0.2 Answer O3 with evidence: list topic `0.0.10416909` messages by
      payer and transaction node. On all five nodes, record the Redis host
      that `rubric-aggregator` actually uses. Take it from its start-up log
      (`pm2 logs rubric-aggregator --lines 2000 --nostream | grep 'Connected
      to Redis'`, `src/aggregator/index.ts:47`), along with
      `TIERED_GROUP_NAME` (default `rubric-aggregator-group`).
      - Don't use `pm2 env` for this. The aggregator loads `/root/tempus/.env`
        itself (`index.ts:13`), so `pm2 env` can show no host while a shared
        one is in use. It also prints private keys.
      - Record hosts privately, or redacted in #67.
      - If more than one aggregator reads a shared stream: **stop**. A is
        NO-GO until each link is written to the jsonl of the node that owns
        the id.
- [ ] 0.3 On US, hash `dist/aggregator` the same way `sync-all.sh:54`
      hashes `dist/api`. Confirm it matches a fresh build of `93bd6b66` or
      later.
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

### Stage 2: B on US

- [ ] 2.1 Run the dry run with an explicit store:
      `node scripts/anchor-links-backfill.mjs --store /mnt/tempus-attestation-store`.
      Save the JSON output.
- [ ] 2.2 Get the list of ids the run would link, either from a small
      reviewed change to the script or from a one-off read-only script
      against the same build. Confirm 100% of them are in the US jsonl.
- [ ] 2.3 Thresholds, read from the JSON and never from the exit code:
      - `badId`, `rootMismatch`, `conflicts`, `notThisFlush`,
        `incompleteMessages` and `linkErrors` are all 0.
      - Every `unresolvedIds` entry is explained by flush id, for example
        stubs that retention has already removed. Unexplained entries mean
        stop.
      - `noBundle` matches the anchors made by other nodes.
      - `foreignChunks` is recorded. Any value is acceptable, because those
        chunks are dropped.
- [ ] 2.4 Record the jsonl's byte size and sha256, then run `--apply`.
      `--apply` refuses a store whose jsonl is not the writer's `INDEX_PATH`.
      `linksAppended` must equal the dry run's prediction. Any difference
      must be explained by anchors that the writer linked in between, which
      show up as `alreadyPresent`. Then dry-run again: it must show
      `linksAppended = 0` and `conflicts = 0`.

### Stage 3: satellites

- [ ] 3.1 Only after O3 is resolved and US has run cleanly for 7 days.
      Before the first satellite apply, dry-run all five nodes and confirm
      that each `anchorId` resolves to a bundle on **exactly one** node. If
      any resolves on two, bundles are being replicated: stop.
- [ ] 3.2 Then go one satellite at a time, repeating 0.3–2.4 with that
      node's own values. `sync-all.sh` ships neither
      `scripts/anchor-links-backfill.mjs` nor `reconcile-rt.py`, so copy
      them, verify them by hash, and record that.

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
  - a conflict on a repeat dry run
  - any `WARM_*` event
  - a jsonl reader error or count change
  - `kind` lines growing faster than anchored items
  - a linked id missing from the local jsonl
- **Correction:** a wrong link is superseded through the erratum process
  (rubric-protocol `docs/RUBRIC-ERRATUM-2026-001.md`), never edited out.
