/**
 * Stub Jev client (tasks/P3.md). Emits Jev's documented decision shape, standing
 * in for the real external Jev service in tests and local dev. Deterministic
 * given its inputs. It only constructs values of the `JevDecision` type owned by
 * the mapping file — it does not itself map to DAR inputs.
 */
import { makeJevDecision, type JevDecision } from "./mapping.js";

export interface StubJevOptions {
  agentId?: string;
  policyId?: string;
  policyRevision?: number;
  /** Approve when `subject.amountUsd` is at or below this limit. */
  limitUsd?: number;
}

export class StubJevClient {
  private readonly agentId: string;
  private readonly policyId: string;
  private readonly policyRevision: number;
  private readonly limitUsd: number;

  constructor(opts: StubJevOptions = {}) {
    this.agentId = opts.agentId ?? "agent://jev/stub";
    this.policyId = opts.policyId ?? "policy/default";
    this.policyRevision = opts.policyRevision ?? 1;
    this.limitUsd = opts.limitUsd ?? 1000;
  }

  /** Emit a Jev decision for a subject. `atMs` sets Jev's emitted time. */
  decide(subject: Record<string, unknown>, atMs: number = Date.now()): JevDecision {
    const amount = typeof subject.amountUsd === "number" ? subject.amountUsd : 0;
    const approved = amount <= this.limitUsd;
    return makeJevDecision({
      agentId: this.agentId,
      policyId: this.policyId,
      policyRevision: this.policyRevision,
      action: approved ? "approve" : "deny",
      score: approved ? 90 : 20,
      reasons: approved ? undefined : ["amount_over_limit"],
      subject,
      emittedAtMs: atMs,
    });
  }
}
