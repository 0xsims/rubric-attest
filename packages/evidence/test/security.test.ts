import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStoreReader } from "../src/index.js";

let base: string | undefined;
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("openStoreReader path containment", () => {
  it("does not read outside the store dir via a traversing bundlePath", () => {
    base = mkdtempSync(join(tmpdir(), "rubric-sec-"));
    const store = join(base, "store");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(base, "secret.json"), JSON.stringify({ secret: true }));
    writeFileSync(join(store, "ok.json"), JSON.stringify({ attestationId: "a" }));

    const reader = openStoreReader(store);
    expect(reader.get("../secret.json")).toBeUndefined(); // contained — no escape
    expect(reader.get("../../etc/hosts")).toBeUndefined();
    expect(reader.get("/etc/hosts")).toBeUndefined(); // absolute rejected
    expect(reader.get("ok.json")).toBeDefined(); // normal read still works
  });
});
