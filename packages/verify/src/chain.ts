/**
 * Chain-check: build a continuity report for an agent's per-agent `prev` chain
 * (tasks/P4.md). Forks (a decision with >1 child) are reported as branches, and
 * are explicitly NOT treated as tampering — a legitimately branched history is
 * still authentic. Gaps (a `prev` pointing at an absent decision) are surfaced
 * too. Actual tampering is detected per-record via the drift flag (see verify).
 */
import type { ContinuityReport, IndexRow } from "./ports.js";

const byId = (rows: IndexRow[]) => new Map(rows.map((r) => [r.decisionId, r]));

export function chainCheck(agentId: string, rows: IndexRow[]): ContinuityReport {
  const present = byId(rows);
  const childrenOf = new Map<string, string[]>();
  const referenced = new Set<string>();

  for (const r of rows) {
    if (r.prev !== null) {
      referenced.add(r.prev);
      (childrenOf.get(r.prev) ?? childrenOf.set(r.prev, []).get(r.prev)!).push(r.decisionId);
    }
  }

  const sorted = (xs: string[]) => xs.slice().sort();

  const genesis = sorted(rows.filter((r) => r.prev === null).map((r) => r.decisionId));
  const heads = sorted(rows.filter((r) => !referenced.has(r.decisionId)).map((r) => r.decisionId));

  const branches = [...childrenOf.entries()]
    .filter(([, kids]) => kids.length > 1)
    .map(([parent, kids]) => ({ parent, children: sorted(kids) }))
    .sort((a, b) => (a.parent < b.parent ? -1 : 1));

  const gaps = rows
    .filter((r) => r.prev !== null && !present.has(r.prev))
    .map((r) => ({ decisionId: r.decisionId, missingPrev: r.prev! }))
    .sort((a, b) => (a.decisionId < b.decisionId ? -1 : 1));

  const linear =
    rows.length > 0 &&
    genesis.length === 1 &&
    heads.length === 1 &&
    branches.length === 0 &&
    gaps.length === 0;

  return {
    agentId,
    count: rows.length,
    genesis,
    heads,
    branches,
    gaps,
    linear,
    tampering: false,
  };
}
