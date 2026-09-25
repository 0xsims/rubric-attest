/**
 * DAR builder (spec/dar-0.1.md §2). Assembles a HASHES-ONLY DAR core from
 * adapter inputs: hashes the schema, input, and output (JCS+SHA3-256), derives
 * `decisionHash` over those three commitments, mints a ULID `decisionId`, and
 * maintains the per-agent `prev` chain. The core never carries raw content.
 */
import {
  AGENT_ID_RE,
  DAR_VERSION,
  RESERVED_AGENT_ID_RE,
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
  /**
   * Permit Rubric's own agentIds (`rubric`, `rubric://…`, `rubric-…`, …). Only
   * Rubric's internal emitters, whose keys the server exempts, set this.
   * Default false.
   */
  allowReservedAgentIds?: boolean;
}

/** An agentId the server's batch ingest would reject. Thrown from build() and attest(). */
export class AgentIdError extends Error {
  constructor(
    message: string,
    readonly agentId: unknown,
  ) {
    super(message);
    this.name = "AgentIdError";
  }
}

/**
 * Check a full agentId (namespace prefix included) against the server's batch
 * ingest rules: `^[A-Za-z0-9._:/@-]{1,200}$`, and not `rubric` alone or followed
 * by `:` `/` `_` `.` `@` `-` unless `allowReserved`. Throws AgentIdError.
 */
export function validateAgentId(agentId: unknown, options?: { allowReserved?: boolean }): asserts agentId is string {
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new AgentIdError("DAR: agentId must be a non-empty string", agentId);
  }
  if (!AGENT_ID_RE.test(agentId)) {
    throw new AgentIdError(
      `DAR: agentId '${agentId.slice(0, 64)}' must be 1-200 characters of A-Z a-z 0-9 . _ : / @ -`,
      agentId,
    );
  }
  if (!options?.allowReserved && RESERVED_AGENT_ID_RE.test(agentId)) {
    throw new AgentIdError(`DAR: agentId '${agentId.slice(0, 64)}' is reserved for Rubric's own agents`, agentId);
  }
}

/** Derive `decisionHash` from the three content commitments (spec §4.2). */
export function decisionHashOf(schemaHash: HashString, inputHash: HashString, outputHash: HashString): HashString {
  return hashJson({ schemaHash, inputHash, outputHash });
}

export class DarBuilder {
  private readonly newDecisionId: () => string;
  private readonly now: () => number;
  private readonly maxDecisionBytes: number;
  private readonly allowReservedAgentIds: boolean;
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
    this.allowReservedAgentIds = deps.allowReservedAgentIds ?? false;
  }

  /**
   * Build a DAR core. `options.prev`, when given (including `null`), is used as
   * `prev` instead of this builder's in-memory head for the agent; the Attestor
   * passes it when a shared chain-head store is configured.
   *
   * `options.decisionId` and `options.at` (epoch ms) replace the minted id and
   * the clock; the Attestor passes them for a record it accepted in attest()
   * but builds later (while its namespace is being discovered or checked).
   *
   * Throws AgentIdError if `agentId` is outside the server's rules.
   */
  build(input: DarBuildInput, options?: { prev?: string | null; decisionId?: string; at?: number }): DarCore {
    const { agentId } = input;
    validateAgentId(agentId, { allowReserved: this.allowReservedAgentIds });
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

    const decisionId = options?.decisionId ?? this.newDecisionId();
    const prev = options?.prev !== undefined ? options.prev : (this.heads.get(agentId) ?? null);
    const ts = new Date(options?.at ?? this.now()).toISOString();

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
