/**
 * Child process for the kill -9 durability test. Appends N records, announces
 * READY, and stays alive until the parent SIGKILLs it. Two modes:
 *   - "flush":   force a flush whose transport hangs (mid-flush kill). The flush
 *                fsyncs the spool before hanging.
 *   - "noflush": do NOT flush — records are only `writeSync`-appended (no fsync).
 *                This isolates the core durability claim: a plain writeSync hands
 *                bytes to the kernel, so they survive process death without fsync.
 */
import { Attestor, type DarCore, type Transport } from "../../src/index.js";

const spoolPath = process.argv[2]!;
const n = Number(process.argv[3]!);
const mode = process.argv[4] ?? "flush";

const hangingTransport: Transport = {
  send(_records: DarCore[]): Promise<void> {
    return new Promise<void>(() => {}); // never resolves
  },
};

const attestor = new Attestor({
  transport: hangingTransport,
  spoolPath,
  maxWaitMs: 60_000,
  maxBatch: 100_000, // avoid the count trigger; we flush explicitly
});

const ids: (string | null)[] = [];
for (let i = 0; i < n; i++) {
  ids.push(attestor.attest({ agentId: "A", schema: { type: "object" }, input: { i }, output: { ok: true } }));
}

if (mode === "flush") {
  // Force a flush; it fsyncs the spool then blocks in the hanging transport.
  void attestor.flush();
}
// In "noflush" mode we never flush: records exist only via writeSync (no fsync).

process.stdout.write("IDS:" + JSON.stringify(ids) + "\n");
process.stdout.write("READY\n");

setInterval(() => {}, 1000); // stay alive until killed
