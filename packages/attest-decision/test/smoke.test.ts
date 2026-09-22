import { describe, it, expect } from "vitest";
import {
  DAR_VERSION,
  HASH_ALGORITHM,
  HASH_PREFIX,
} from "../src/index.js";

describe("@rubric/attest-decision scaffolding", () => {
  it("pins the frozen DAR/0.1 constants from the spec", () => {
    expect(DAR_VERSION).toBe("DAR/0.1");
    expect(HASH_ALGORITHM).toBe("sha3-256");
    expect(HASH_PREFIX).toBe("sha3-256:");
  });
});
