import { describe, it, expect } from "vitest";
import { SCHEMA_ADAPTER_VERSION } from "../src/index.js";

describe("@rubric/schema scaffolding", () => {
  it("loads", () => {
    expect(SCHEMA_ADAPTER_VERSION).toBe("0.1.0");
  });
});
