/**
 * Ports for evidence export (tasks/P5.md). The assembly logic depends only on
 * these, so tests inject mocks and the CLI injects real adapters that read the
 * SQLite index shards + bundle-store files offline.
 */
import type { IndexRow, StorePort, VerifiableBundle, ContinuityReport } from "@rubric-protocol/verify";

export type { IndexRow, StorePort, VerifiableBundle, ContinuityReport };

/** Index reader: an agent's rows within a ts range, ordered (ts, decisionId). */
export interface EvidenceIndex {
  byAgentRange(agentId: string, fromTs: string, toTs: string): IndexRow[];
  close?(): void;
}

/** One decision's evidence: the DAR plus its proof, anchor ref, and signature. */
export type DecisionEvidence = VerifiableBundle;

/** A schema epoch: a run of consecutive decisions under one schemaHash. */
export interface SchemaEpoch {
  schemaHash: string;
  fromDecisionId: string;
  fromTs: string;
  count: number;
}

export interface EvidenceBundle {
  version: "rubric-evidence/0.1";
  agent: string;
  range: { from: string; to: string };
  generatedAt: string;
  decisionCount: number;
  decisions: DecisionEvidence[];
  continuity: ContinuityReport;
  schemaChangeLog: SchemaEpoch[];
}
