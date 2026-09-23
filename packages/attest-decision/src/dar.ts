/**
 * DAR builder (spec/dar-0.1.md §2). Assembles a HASHES-ONLY DAR core from
 * adapter inputs: hashes the schema, input, and output (JCS+SHA3-256), derives
 * `decisionHash` over those three commitments, mints a ULID `decisionId`, and
 * maintains the per-agent `prev` chain. The core never carries raw content.
 */
import {
  DAR_VERSION,
  type AdapterInfo,
  type DarCore,
  type HashString,
  type LeafType,
  type PayloadRecord,
} from "./constants.js";
import { hashJson, sha3_256 } from "./hash.js";
import { canonicalize, canonicalizeToBytes } from "./jcs.js";
import { ulid as defaultUlid } from "./ulid.js";

const LEAF_TYPES: ReadonlySet<string> = new Set(["decision", "schema-change", "checkpoint"]);
const HASH_STRING = /^sha3-256:[0-9a-f]{64}$/;
const DEFAULT_MAX_DECISION_BYTES = 256 * 1024; // bounds attest() latency + payload size

/** Non-content metadata an adapter may attach to a decision. */
export interface DarMeta {
  schemaRef?: string;
  adapter?: AdapterInfo;
  leafType?: LeafType;
}

export interface DarBuildInput {
  agentId: string;
  /** Adapter-supplied decision input; hashed to `inputHash`. */
  input: unknown;
  /** Adapter-supplied decision output; hashed to `outputHash`. */
  output: unknown;
  /** Schema descriptor to hash, or a precomputed `schemaHash`. One is required. */
  schema?: unknown;
  schemaHash?: HashString;
  meta?: DarMeta;
}

export interface DarBuilderDeps {
  /** Injectable id generator (default: monotonic ULID). */
  newDecisionId?: () => string;
  /** Injectable clock in epoch ms (default: Date.now). */
  now?: () => number;
  /** Reject a decision whose canonical input+output exceeds this many bytes. Default 256 KiB. */
  maxDecisionBytes?: number;
}

/** Derive `decisionHash` from the three content commitments (spec §4.2). */
export function decisionHashOf(schemaHash: HashString, inputHash: HashString, outputHash: HashString): HashString {
  return hashJson({ schemaHash, inputHash, outputHash });
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

  /**
   * Build a DAR core. `options.prev`, when given (including `null`), is used as
   * `prev` instead of this builder's in-memory head for the agent; the Attestor
   * passes it when a shared chain-head store is configured.
   */
  build(input: DarBuildInput, options?: { prev?: string | null }): DarCore {
    const { agentId } = input;
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new Error("DAR: agentId must be a non-empty string");
    }
    const leafType: LeafType = input.meta?.leafType ?? "decision";
    if (!LEAF_TYPES.has(leafType)) {
      throw new Error(`DAR: unknown leafType '${leafType}'`);
    }

    const schemaHash = this.resolveSchemaHash(input);

    // Canonicalize input/output once, cap the combined size, then hash.
    const inputBytes = canonicalizeToBytes(input.input);
    const outputBytes = canonicalizeToBytes(input.output);
    if (inputBytes.length + outputBytes.length > this.maxDecisionBytes) {
      throw new Error(
        `DAR: input+output is ${inputBytes.length + outputBytes.length} bytes; exceeds maxDecisionBytes (${this.maxDecisionBytes})`,
      );
    }
    const inputHash = sha3_256(inputBytes);
    const outputHash = sha3_256(outputBytes);
    const decisionHash = decisionHashOf(schemaHash, inputHash, outputHash);

    const decisionId = this.newDecisionId();
    const prev = options?.prev !== undefined ? options.prev : (this.heads.get(agentId) ?? null);
    const ts = new Date(this.now()).toISOString();

    const dar: DarCore = {
      v: DAR_VERSION,
      decisionId,
      agentId,
      ts,
      prev,
      leafType,
      schemaHash,
      inputHash,
      outputHash,
      decisionHash,
      ...(input.meta?.schemaRef !== undefined ? { schemaRef: input.meta.schemaRef } : {}),
      ...(input.meta?.adapter !== undefined ? { adapter: input.meta.adapter } : {}),
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
    if (input.schema === undefined) throw new Error("DAR: schema or schemaHash is required");
    if (typeof input.schema === "object" && input.schema !== null) {
      const cached = this.schemaCache.get(input.schema);
      if (cached) return cached;
      const h = hashJson(input.schema);
      this.schemaCache.set(input.schema, h);
      return h;
    }
    return hashJson(input.schema);
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

/** Build the raw payload record for `payload`-mode transmission (never in the core). */
export function toPayload(decisionId: string, input: DarBuildInput): PayloadRecord {
  return {
    decisionId,
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    input: input.input,
    output: input.output,
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
}

/** The Merkle leaf hash of a DAR core: SHA3-256 over its JCS bytes (spec §4.3). */
export function leafHash(dar: DarCore): HashString {
  return hashJson(dar);
}

/** JCS canonicalization of a DAR core — the exact leaf-hash preimage. */
export function canonicalDar(dar: DarCore): string {
  return canonicalize(dar);
}
