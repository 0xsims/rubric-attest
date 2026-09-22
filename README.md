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

## SDK usage (`@rubric/attest-decision`)

```ts
import { Attestor, HttpTransport } from "@rubric/attest-decision";

const attestor = new Attestor({
  transport: new HttpTransport({ baseUrl: "https://attest.example" }), // reads RUBRIC_API_KEY
  spoolPath: "/var/lib/rubric/attest.spool",
});

// Fire-and-forget: returns immediately (<1 ms), never throws into app code.
attestor.attest({
  agentId: "agent://jev/pricing-v3",
  schema: pricingSchema, // hashed to schemaHash
  decision: { action: "approve", limitUsd: "2500.00" },
});
```

Records are appended to a durable spool and flushed in batches (64 records or
5000 ms) with one POST per flush to `/v1/tiered-attest`. A `kill -9` at any point
loses zero spooled records — the next process drains the spool on startup.

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
