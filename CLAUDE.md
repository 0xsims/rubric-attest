# Rubric Decision Attestation — build constitution

## Invariants. Never change without a human decision.
- Hashing: SHA3-256 everywhere. Canonicalization: JCS (RFC 8785). Canonicalize, then hash.
- Record format: DAR/0.1 per spec/dar-0.1.md. Field set is frozen. Additive changes bump the minor.
- The SDK reads exactly one credential env var: RUBRIC_API_KEY.
- attest() never blocks the caller. Failures spool. Never throw into app code.
- No server-side standard-path batching. Do not build it.
- Test traffic uses /v1/tiered-attest with the stress key only. Never /v1/attest. Never direct HCS.

## Workflow
- Work only in your assigned worktree. One phase per agent, defined in tasks/P*.md.
- Done means the phase acceptance tests are green. Nothing else counts.
- Green: open a PR. Never push main. Never set ALLOW_MAIN_PUSH.
- "Never push main" is server-enforced: the repo is public with an active branch ruleset (`protect-main`) that requires a pull request and passing `build` + `perf` checks (strict/up-to-date), blocks force-pushes and deletion of main, and has no bypass actors (applies to admins too).
- No deploys. No pm2, nginx, cron, sync-all. Build and test only.
- Secrets are out of scope. A task that seems to need a key you lack: stop, flag it in the PR.
