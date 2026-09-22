import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Spool } from "../src/index.js";

const childPath = fileURLToPath(new URL("./helpers/kill9-child.mts", import.meta.url));

let dir: string;
let spoolPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rubric-kill9-"));
  spoolPath = join(dir, "attest.spool");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface ChildResult {
  ids: string[];
}

function runChildThenKill(n: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", childPath, spoolPath, String(n)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let killed = false;
    let ids: string[] = [];

    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const idLine = out.split("\n").find((l) => l.startsWith("IDS:"));
      if (idLine) ids = JSON.parse(idLine.slice(4)) as string[];
      if (out.includes("READY") && !killed) {
        killed = true;
        child.kill("SIGKILL"); // kill -9 while the flush is hanging
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("exit", (code, signal) => {
      if (signal === "SIGKILL") resolve({ ids });
      else reject(new Error(`child exited unexpectedly code=${code} signal=${signal}\n${err}`));
    });
    child.on("error", reject);
  });
}

describe("kill -9 during flush loses zero spooled records", () => {
  it("recovers every record from the spool after a hard kill", async () => {
    const N = 200;
    const { ids } = await runChildThenKill(N);
    expect(ids.length).toBe(N);
    expect(ids.every((id) => typeof id === "string" && id.length === 26)).toBe(true);

    // Reopen the spool in this process: nothing was acked, so all N replay.
    const spool = new Spool(spoolPath);
    const recovered = spool.pending();
    expect(recovered.length).toBe(N);
    expect(recovered.map((r) => r.dar.decisionId)).toEqual(ids);
    spool.close();
  }, 30_000);
});
