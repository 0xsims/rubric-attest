import { describe, it, expect } from "vitest";
import { JEV_ADAPTER_VERSION } from "../src/index.js";

describe("@rubric/jev scaffolding", () => {
  it("loads", () => {
    expect(JEV_ADAPTER_VERSION).toBe("0.1.0");
  });
});
