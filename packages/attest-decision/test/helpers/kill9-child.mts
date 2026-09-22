/**
 * Child process for the kill -9 durability test. Appends N records, forces a
 * flush whose transport hangs (so we are "mid-flush"), announces READY, and
 * stays alive until the parent SIGKILLs it. Records were written to the spool
 * with writeSync, so they must survive the kill.
 */
import { Attestor, type DarCore, type Transport } from "../../src/index.js";

const spoolPath = process.argv[2]!;
const n = Number(process.argv[3]!);

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
  ids.push(attestor.attest({ agentId: "A", schema: { type: "object" }, decision: { i } }));
}

// Force a flush; it fsyncs the spool then blocks in the hanging transport.
void attestor.flush();

process.stdout.write("IDS:" + JSON.stringify(ids) + "\n");
process.stdout.write("READY\n");

setInterval(() => {}, 1000); // stay alive until killed
