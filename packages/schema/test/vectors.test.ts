import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToSchema } from "../src/index.js";

describe("zod -> JSON Schema conversion vectors", () => {
  it("converts an object schema with enum + optional (named)", () => {
    const pricing = z.object({
      action: z.enum(["approve", "deny"]),
      limitUsd: z.string(),
      score: z.number().int().min(0).max(100).optional(),
    });
    expect(zodToSchema(pricing, "PricingDecision")).toEqual({
      $ref: "#/definitions/PricingDecision",
      definitions: {
        PricingDecision: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["approve", "deny"] },
            limitUsd: { type: "string" },
            score: { type: "integer", minimum: 0, maximum: 100 },
          },
          required: ["action", "limitUsd"],
          additionalProperties: false,
        },
      },
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  it("converts nested objects and arrays (unnamed)", () => {
    const nested = z.object({
      id: z.string().uuid(),
      tags: z.array(z.string()),
      meta: z.object({ tier: z.number(), active: z.boolean() }),
    });
    expect(zodToSchema(nested)).toEqual({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        tags: { type: "array", items: { type: "string" } },
        meta: {
          type: "object",
          properties: { tier: { type: "number" }, active: { type: "boolean" } },
          required: ["tier", "active"],
          additionalProperties: false,
        },
      },
      required: ["id", "tags", "meta"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });

  it("is deterministic (stable schemaHash source)", () => {
    const s = z.object({ a: z.string(), b: z.number() });
    expect(JSON.stringify(zodToSchema(s))).toBe(JSON.stringify(zodToSchema(s)));
  });
});
