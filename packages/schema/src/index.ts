/**
 * @rubric/schema — JSON Schema / Zod adapter (tasks/P3.md).
 *
 * Produces DAR builder inputs from either a raw JSON Schema descriptor or a Zod
 * schema (converted via zod-to-json-schema). The conversion is deterministic, so
 * the same Zod schema yields a byte-identical JSON Schema and a stable schemaHash.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { DarBuildInput, LeafType } from "@rubric/attest-decision";

/** A JSON Schema descriptor (plain JSON; JCS-canonicalizable). */
export type JsonSchema = Record<string, unknown>;

export interface SchemaDecisionInput {
  agentId: string;
  decision: Record<string, unknown>;
  /** The raw JSON Schema descriptor the decision was produced under. */
  schema: JsonSchema;
  leafType?: LeafType;
}

/** Package DAR builder inputs from a decision + a raw JSON Schema descriptor. */
export function toDecision(input: SchemaDecisionInput): DarBuildInput {
  return {
    agentId: input.agentId,
    decision: input.decision,
    schema: input.schema,
    leafType: input.leafType ?? "decision",
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
  decision: Record<string, unknown>;
  zod: ZodTypeAny;
  /** Optional definition name for the converted schema. */
  name?: string;
  leafType?: LeafType;
}

/** Package DAR builder inputs from a decision + a Zod schema. */
export function toDecisionFromZod(input: ZodDecisionInput): DarBuildInput {
  return toDecision({
    agentId: input.agentId,
    decision: input.decision,
    schema: zodToSchema(input.zod, input.name),
    leafType: input.leafType,
  });
}

export const SCHEMA_ADAPTER_VERSION = "0.1.0" as const;
