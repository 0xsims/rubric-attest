/**
 * @0xsims/schema — JSON Schema / Zod adapter (tasks/P3.md).
 *
 * Produces hashes-only DAR builder inputs from a decision's `input`/`output`
 * plus either a raw JSON Schema descriptor or a Zod schema (converted via
 * zod-to-json-schema). The conversion is deterministic, so the same Zod schema
 * yields a byte-identical JSON Schema and a stable schemaHash.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { DarBuildInput, DarMeta } from "@0xsims/attest-decision";

/** A JSON Schema descriptor (plain JSON; JCS-canonicalizable). */
export type JsonSchema = Record<string, unknown>;

export const SCHEMA_ADAPTER_VERSION = "1.0.0" as const;
const ADAPTER = { name: "schema", version: SCHEMA_ADAPTER_VERSION } as const;

/** Merge the adapter identity into caller-supplied meta (caller wins on overlap). */
function withAdapter(meta?: DarMeta): DarMeta {
  return { adapter: { ...ADAPTER }, ...meta };
}

export interface SchemaDecisionInput {
  agentId: string;
  /** Adapter input, hashed to inputHash. */
  input: unknown;
  /** Adapter output, hashed to outputHash. */
  output: unknown;
  /** The raw JSON Schema descriptor the decision was produced under. */
  schema: JsonSchema;
  meta?: DarMeta;
}

/** Package DAR builder inputs from input/output + a raw JSON Schema descriptor. */
export function toDecision(input: SchemaDecisionInput): DarBuildInput {
  return {
    agentId: input.agentId,
    input: input.input,
    output: input.output,
    schema: input.schema,
    meta: withAdapter(input.meta),
  };
}

/**
 * Convert a Zod schema to a JSON Schema descriptor. Deterministic: identical Zod
 * schemas convert to byte-identical JSON Schema, hence a stable schemaHash.
 */
export function zodToSchema(zod: ZodTypeAny, name?: string): JsonSchema {
  return zodToJsonSchema(zod, name) as JsonSchema;
}

export interface ZodDecisionInput {
  agentId: string;
  input: unknown;
  output: unknown;
  zod: ZodTypeAny;
  /** Optional definition name for the converted schema. */
  name?: string;
  meta?: DarMeta;
}

/** Package DAR builder inputs from input/output + a Zod schema. */
export function toDecisionFromZod(input: ZodDecisionInput): DarBuildInput {
  return toDecision({
    agentId: input.agentId,
    input: input.input,
    output: input.output,
    schema: zodToSchema(input.zod, input.name),
    meta: input.meta,
  });
}
