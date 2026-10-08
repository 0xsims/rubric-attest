/**
 * Child process for the cross-process chain test. Waits for a go-file so all
 * children start together, attests N records for one agent through a shared
 * FileChainHeadStore, prints the returned ids, and exits without delivering, so
 * every record stays in this child's spool for the parent to read.
 */
import { existsSync } from "node:fs";
import { Attestor, FileChainHeadStore, type Transport } from "../../src/index.js";

const [storeDir, spoolPath, nArg, agentId, goFile] = process.argv.slice(2) as [string, string, string, string, string];
const n = Number(nArg);

const failing: Transport = {
  send(): Promise<void> {
    return Promise.reject(new Error("offline"));
  },
};

const errors: string[] = [];
const attestor = new Attestor({
  transport: failing,
  spoolPath,
  maxWaitMs: 60_000,
  maxBatch: 100_000,
  chainStore: new FileChainHeadStore({ dir: storeDir, lockTimeoutMs: 10_000 }),
  onError: (e) => errors.push(String(e)),
  allowReservedAgentIds: true, // the parent uses Rubric's own agentId, as its emitter does
});

const deadline = Date.now() + 10_000;
while (!existsSync(goFile) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

const ids: (string | null)[] = [];
for (let i = 0; i < n; i++) {
  ids.push(attestor.attest({ agentId, schema: { type: "object" }, input: { pid: process.pid, i }, output: { ok: true } }));
}
process.stdout.write("RESULT:" + JSON.stringify({ ids, errors }) + "\n");
process.exit(0);
