/**
 * Assemble an evidence bundle (tasks/P5.md): DARs + proofs + anchor refs for an
 * agent over a ts range, a continuity report (reusing @rubric/verify chainCheck,
 * so forks render as branches and gaps as gaps), and a schema-change log.
 */
import { chainCheck } from "@rubric/verify";
import type {
  DecisionEvidence,
  EvidenceBundle,
  EvidenceIndex,
  IndexRow,
  SchemaEpoch,
  StorePort,
} from "./ports.js";

/** Consecutive-run epochs of schemaHash across ordered rows. */
export function buildSchemaChangeLog(rows: IndexRow[]): SchemaEpoch[] {
  const log: SchemaEpoch[] = [];
  for (const r of rows) {
    const last = log[log.length - 1];
    if (last && last.schemaHash === r.schemaHash) {
      last.count++;
    } else {
      log.push({ schemaHash: r.schemaHash, fromDecisionId: r.decisionId, fromTs: r.ts, count: 1 });
    }
  }
  return log;
}

export interface AssembleOptions {
  agent: string;
  from: string;
  to: string;
  generatedAt: string;
}

export function assembleEvidence(
  index: EvidenceIndex,
  store: StorePort,
  opts: AssembleOptions,
): EvidenceBundle {
  const rows = index.byAgentRange(opts.agent, opts.from, opts.to);

  const decisions: DecisionEvidence[] = rows.map((r) => {
    const bundle = store.get(r.bundlePath);
    if (!bundle) {
      throw new Error(`evidence: bundle missing for ${r.decisionId} at ${r.bundlePath}`);
    }
    return bundle;
  });

  return {
    version: "rubric-evidence/0.1",
    agent: opts.agent,
    range: { from: opts.from, to: opts.to },
    generatedAt: opts.generatedAt,
    decisionCount: decisions.length,
    decisions,
    continuity: chainCheck(opts.agent, rows),
    schemaChangeLog: buildSchemaChangeLog(rows),
  };
}
