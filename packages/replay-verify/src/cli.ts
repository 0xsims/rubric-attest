/**
 * tenprint-verify --record <warm-record.json | dar-bundle.json>
 *               --anchor-bundle <anchorId>.json
 *               [--keys <rubric-keys.json>] [--mirror <base-url>] [--topic 0.0.10416909] [--json]
 *
 * Exit: 0 all PASS, 1 FAIL, 2 usage / unreadable input, 3 UNSUPPORTED, 4 UNAVAILABLE (spec §4.4).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatReport } from "./format.js";
import { UsageError, type FetchLike, type Sleep } from "./net.js";
import { InputError } from "./record.js";
import { verify } from "./verify.js";

const USAGE =
  "usage: tenprint-verify --record <warm-record.json|dar-bundle.json> --anchor-bundle <anchorId>.json " +
  "[--keys <rubric-keys.json>] [--mirror <base-url>] [--topic 0.0.10416909] [--json]\n";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readFile?: (path: string) => string;
  fetch?: FetchLike;
  sleep?: Sleep;
}

function readJson(path: string, what: string, readFile: (p: string) => string): unknown {
  let text: string;
  try {
    text = readFile(path);
  } catch (e) {
    throw new InputError(`${what} ${path} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`${what} ${path} is not JSON`);
  }
}

/** Runs the CLI and returns the exit code. Never calls process.exit. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        record: { type: "string" },
        "anchor-bundle": { type: "string" },
        keys: { type: "string" },
        mirror: { type: "string" },
        topic: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (!values.record || !values["anchor-bundle"]) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const record = readJson(values.record, "--record", readFile);
    const anchorBundle = readJson(values["anchor-bundle"], "--anchor-bundle", readFile);
    const keys = values.keys !== undefined ? readJson(values.keys, "--keys", readFile) : undefined;
    const report = await verify({
      record,
      anchorBundle,
      keys,
      mirror: values.mirror,
      topic: values.topic,
      fetch: io.fetch,
      sleep: io.sleep,
    });
    io.stdout(values.json ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
    return report.exitCode;
  } catch (e) {
    if (e instanceof InputError || e instanceof UsageError) {
      io.stderr(`tenprint-verify: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
