/**
 * DAR builder (spec/dar-0.1.md §2). Assembles a DAR core from adapter inputs:
 * mints a ULID `decisionId`, computes `schemaHash`/`decisionHash` (JCS+SHA3-256),
 * and maintains the per-agent `prev` chain.
 */
import { DAR_VERSION, type DarCore, type HashString, type LeafType } from "./constants.js";
import { hashJson, sha3_256 } from "./hash.js";
import { canonicalize, canonicalizeToBytes } from "./jcs.js";
import { ulid as defaultUlid } from "./ulid.js";

const LEAF_TYPES: ReadonlySet<string> = new Set(["decision", "schema-change", "checkpoint"]);
const HASH_STRING = /^sha3-256:[0-9a-f]{64}$/;
const DEFAULT_MAX_DECISION_BYTES = 256 * 1024; // bounds attest() latency + spool line size

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
  /** Reject a decision whose canonical form exceeds this many bytes. Default 256 KiB. */
  maxDecisionBytes?: number;
}

export class DarBuilder {
  private readonly newDecisionId: () => string;
  private readonly now: () => number;
  private readonly maxDecisionBytes: number;
  private readonly heads = new Map<string, string>();
  // Keyed by object identity: reusing the same schema object across build()
  // calls skips re-hashing. CONTRACT: schema objects must be treated as
  // immutable — mutating one in place after its first build() would return the
  // stale cached hash. Distinct objects with identical contents are re-hashed.
  private readonly schemaCache = new WeakMap<object, HashString>();

  constructor(deps: DarBuilderDeps = {}) {
    this.newDecisionId = deps.newDecisionId ?? defaultUlid;
    this.now = deps.now ?? Date.now;
    this.maxDecisionBytes = deps.maxDecisionBytes ?? DEFAULT_MAX_DECISION_BYTES;
  }

  build(input: DarBuildInput): DarCore {
    const { agentId, decision } = input;
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new Error("DAR: agentId must be a non-empty string");
    }
    if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error("DAR: decision must be a JSON object");
    }
    const leafType: LeafType = input.leafType ?? "decision";
    if (!LEAF_TYPES.has(leafType)) {
      throw new Error(`DAR: unknown leafType '${leafType}'`);
    }

    const schemaHash = this.resolveSchemaHash(input);

    // Canonicalize once, cap the size (bounds attest() latency and spool line
    // size), then hash the same bytes. Throws on non-JSON payloads.
    const decisionBytes = canonicalizeToBytes(decision);
    if (decisionBytes.length > this.maxDecisionBytes) {
      throw new Error(
        `DAR: decision is ${decisionBytes.length} bytes; exceeds maxDecisionBytes (${this.maxDecisionBytes})`,
      );
    }
    const decisionHash = sha3_256(decisionBytes);

    const decisionId = this.newDecisionId();
    const prev = this.heads.get(agentId) ?? null;
    const ts = new Date(this.now()).toISOString();

    const dar: DarCore = {
      v: DAR_VERSION,
      decisionId,
      agentId,
      ts,
      prev,
      leafType,
      schemaHash,
      decisionHash,
      decision,
    };

    this.heads.set(agentId, decisionId);
    return dar;
  }

  private resolveSchemaHash(input: DarBuildInput): HashString {
    if (input.schemaHash) {
      if (!HASH_STRING.test(input.schemaHash)) {
        throw new Error(`DAR: schemaHash must be 'sha3-256:<64 hex>', got '${input.schemaHash}'`);
      }
      return input.schemaHash;
    }
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
