/** Package-level invariants: no service code, pinned dependency, the trust root. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { BUILT_IN_ANCHOR_PAYERS, ALG_V3 } from "../src/index.js";

const pkgDir = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", pkgDir), "utf8"));

describe("package.json", () => {
  it("has no @rubric-protocol/* dependency of any kind", () => {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
      const deps = pkg[field] ?? {};
      const names = Array.isArray(deps) ? deps : Object.keys(deps);
      expect(names.filter((n: string) => n.startsWith("@rubric-protocol/")), field).toEqual([]);
    }
  });

  it("has exactly one runtime dependency: @noble/post-quantum pinned to 0.3.0", () => {
    expect(pkg.dependencies).toEqual({ "@noble/post-quantum": "0.3.0" });
  });

  it("is @rubric-protocol/replay-verify 0.1.0 with the rubric-replay bin", () => {
    expect(pkg.name).toBe("@rubric-protocol/replay-verify");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.bin).toEqual({ "rubric-replay": "./dist/bin.js" });
  });
});

describe("source imports", () => {
  const srcDir = new URL("src/", pkgDir);
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  it("imports nothing from another @rubric-protocol package or from outside src/", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(new URL(f, srcDir), "utf8");
      const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const s of specs) {
        const ok = s.startsWith("./") || s.startsWith("node:") || s === "@noble/post-quantum/ml-dsa";
        expect(ok, `${f} imports ${s}`).toBe(true);
      }
    }
  });
});

describe("trust root", () => {
  it("the built-in anchor-payer list is exactly ['0.0.3923341'] and frozen", () => {
    expect([...BUILT_IN_ANCHOR_PAYERS]).toEqual(["0.0.3923341"]);
    expect(Object.isFrozen(BUILT_IN_ANCHOR_PAYERS)).toBe(true);
  });

  it("the accepted alg block is exactly the one rubric-protocol main emits", () => {
    expect(JSON.stringify(ALG_V3)).toBe(
      '{"canonicalization":"JCS/RFC8785","zk":"Poseidon2-BN254","levels":{"batch":{"hash":"SHA-256","domainSeparation":"RFC6962","merkleOdd":"promote"},"aggregate":{"hash":"SHA3-256","domainSeparation":"RFC6962","merkleOdd":"promote"},"wrap":{"hash":"SHA3-256","domainSeparation":"none","merkleOdd":"self-pair"}}}',
    );
  });
});
