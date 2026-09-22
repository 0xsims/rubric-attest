/**
 * Jev decision-shape mapping (tasks/P3.md).
 *
 * This file is the ONLY place that knows Jev's documented decision shape — its
 * field names never appear anywhere else in the pipeline. Everything downstream
 * consumes the DAR builder inputs produced by `toDecision()`.
 */
import type { DarBuildInput, LeafType } from "@0xsims/attest-decision";

/** Jev's documented decision shape (schema tag "jev.decision/1"). */
export interface JevDecision {
  jevSchema: "jev.decision/1";
  agent: { id: string; label?: string };
  policy: { id: string; revision: number };
  outcome: { action: string; score?: number; reasons?: string[] };
  subject: Record<string, unknown>;
  emittedAt: string; // RFC 3339 UTC
}

/** Semantic parameters for constructing a Jev decision, free of Jev field names. */
export interface JevDecisionParams {
  agentId: string;
  policyId: string;
  policyRevision: number;
  action: string;
  score?: number;
  reasons?: string[];
  subject: Record<string, unknown>;
  emittedAtMs: number;
}

/** Build a Jev-shaped decision from semantic parameters (the shape lives here). */
export function makeJevDecision(p: JevDecisionParams): JevDecision {
  const outcome: JevDecision["outcome"] = { action: p.action };
  if (p.score !== undefined) outcome.score = p.score;
  if (p.reasons !== undefined) outcome.reasons = p.reasons;
  return {
    jevSchema: "jev.decision/1",
    agent: { id: p.agentId },
    policy: { id: p.policyId, revision: p.policyRevision },
    outcome,
    subject: p.subject,
    emittedAt: new Date(p.emittedAtMs).toISOString(),
  };
}

/** The schema descriptor a Jev decision is attested under (derived from its policy). */
function jevSchemaDescriptor(jev: JevDecision): Record<string, unknown> {
  return {
    source: "jev",
    schema: jev.jevSchema,
    policyId: jev.policy.id,
    policyRevision: jev.policy.revision,
  };
}

/**
 * Map a Jev decision to DAR builder inputs. Absent optional fields are omitted
 * (not set to `undefined`) so the decision payload stays strict-JCS clean.
 */
export function toDecision(jev: JevDecision): DarBuildInput {
  const decision: Record<string, unknown> = {
    action: jev.outcome.action,
    subject: jev.subject,
  };
  if (jev.outcome.score !== undefined) decision.score = jev.outcome.score;
  if (jev.outcome.reasons !== undefined) decision.reasons = jev.outcome.reasons;

  const leafType: LeafType = "decision";
  return {
    agentId: jev.agent.id,
    decision,
    schema: jevSchemaDescriptor(jev),
    leafType,
  };
}
