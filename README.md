# Rubric Decision Attestation

Monorepo for the Rubric Decision Attestation system. See [`CLAUDE.md`](./CLAUDE.md)
for the build constitution (invariants) and [`tasks/`](./tasks) for the phased
plan.

## Layout

| Path | What |
|------|------|
| [`spec/dar-0.1.md`](./spec/dar-0.1.md) | DAR/0.1 record format: field table, JCS + SHA3-256 rules, versioning rules. **Frozen.** |
| `packages/attest-decision` | Core SDK — DAR builder, JCS canonicalization, SHA3-256, fire-and-forget `attest()`, batcher, durable spool (P1). |
| `packages/jev` | Adapter — Jev decision shape → DAR inputs; all Jev knowledge confined here (P3). |
| `packages/schema` | Adapter — JSON Schema / Zod → DAR inputs (P3). |
| `tasks/` | Phase definitions `P0`–`P5`. |
| `.github/workflows/ci.yml` | Install + lint + typecheck + test, on every PR. |

## Invariants (see `CLAUDE.md`)

- **Hashing** SHA3-256 everywhere. **Canonicalization** JCS (RFC 8785).
  Canonicalize, then hash.
- **Record format** DAR/0.1 per `spec/dar-0.1.md`. Field set frozen; additive
  changes bump the minor.
- The SDK reads exactly one credential env var: `RUBRIC_API_KEY`.
- `attest()` never blocks the caller and never throws into app code; failures
  spool.

## Development

Requires Node.js >= 20.

```sh
npm install      # install workspace deps
npm run lint     # eslint
npm run typecheck # tsc --noEmit across all packages
npm run test     # vitest run
npm run check    # all three
```

This is an npm-workspaces monorepo; `npm install` at the root wires the packages
together.
