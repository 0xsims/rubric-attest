/**
 * DAR builder (spec/dar-0.1.md §2). Assembles a DAR core from adapter inputs:
 * mints a ULID `decisionId`, computes `schemaHash`/`decisionHash` (JCS+SHA3-256),
 * and maintains the per-agent `prev` chain.
 */
import { DAR_VERSION, type DarCore, type HashString, type LeafType } from "./constants.js";
import { hashJson } from "./hash.js";
import { canonicalize } from "./jcs.js";
import { ulid as defaultUlid } from "./ulid.js";

export interface DarBuildInput {
  agentId: string;
  decision: Record<string, unknown>;
  /** Schema descriptor to hash, or a precomputed `schemaHash`. One is required. */
  schema?: Record<string, unknown>;
  schemaHash?: HashString;
  leafType?: LeafType;
}

export interface DarBuilderDeps {
  /** Injectable id generator (default: monotonic ULID). */
  newDecisionId?: () => string;
  /** Injectable clock in epoch ms (default: Date.now). */
  now?: () => number;
}

export class DarBuilder {
  private readonly newDecisionId: () => string;
  private readonly now: () => number;
  private readonly heads = new Map<string, string>();
  private readonly schemaCache = new WeakMap<object, HashString>();

  constructor(deps: DarBuilderDeps = {}) {
    this.newDecisionId = deps.newDecisionId ?? defaultUlid;
    this.now = deps.now ?? Date.now;
  }

  build(input: DarBuildInput): DarCore {
    const { agentId, decision } = input;
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new Error("DAR: agentId must be a non-empty string");
    }
    if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error("DAR: decision must be a JSON object");
    }

    const schemaHash = this.resolveSchemaHash(input);
    // Canonicalizes; throws on non-JSON payloads before anything is minted.
    const decisionHash = hashJson(decision);

    const decisionId = this.newDecisionId();
    const prev = this.heads.get(agentId) ?? null;
    const ts = new Date(this.now()).toISOString();

    const dar: DarCore = {
      v: DAR_VERSION,
      decisionId,
      agentId,
      ts,
      prev,
      leafType: input.leafType ?? "decision",
      schemaHash,
      decisionHash,
      decision,
    };

    this.heads.set(agentId, decisionId);
    return dar;
  }

  private resolveSchemaHash(input: DarBuildInput): HashString {
    if (input.schemaHash) return input.schemaHash;
    if (!input.schema) throw new Error("DAR: schema or schemaHash is required");
    const cached = this.schemaCache.get(input.schema);
    if (cached) return cached;
    const h = hashJson(input.schema);
    this.schemaCache.set(input.schema, h);
    return h;
  }

  /** Current chain head (last minted decisionId) for an agent, if any. */
  getHead(agentId: string): string | undefined {
    return this.heads.get(agentId);
  }

  /** Seed a chain head — used to continue chains after spool recovery. */
  seedHead(agentId: string, decisionId: string): void {
    this.heads.set(agentId, decisionId);
  }
}

/** The Merkle leaf hash of a DAR core: SHA3-256 over its JCS bytes (spec §4.3). */
export function leafHash(dar: DarCore): HashString {
  return hashJson(dar);
}

/** JCS canonicalization of a DAR core — the exact leaf-hash preimage. */
export function canonicalDar(dar: DarCore): string {
  return canonicalize(dar);
}
