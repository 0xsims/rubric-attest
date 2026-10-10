/**
 * tenprint-verify --record <warm-record.json | dar-bundle.json>
 *               --anchor-bundle <anchorId>.json
 *               [--keys <rubric-keys.json>] [--mirror <base-url>] [--topic 0.0.10416909] [--json]
 * tenprint-verify --example [--mirror <base-url>] [--json]
 *
 * Exit: 0 all PASS, 1 FAIL, 2 usage / unreadable input, 3 UNSUPPORTED, 4 UNAVAILABLE (spec §4.4).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatReport } from "./format.js";
import { UsageError, type FetchLike, type Sleep } from "./net.js";
import { InputError } from "./record.js";
import { verify } from "./verify.js";

const USAGE =
  "usage: tenprint-verify --record <warm-record.json|dar-bundle.json> --anchor-bundle <anchorId>.json " +
  "[--keys <rubric-keys.json>] [--mirror <base-url>] [--topic 0.0.10416909] [--json]\n" +
  "       tenprint-verify --example [--mirror <base-url>] [--json]\n";

/**
 * The bundled canary case (README walkthrough): a real mainnet tiered record whose payload is a
 * commitment hash only, its tier-2 anchor bundle, and a recorded keys file. The keys file is
 * pinned, so the guard refuses the keys URL and the only requests go to the mirror.
 * Resolves the same from src/ and dist/.
 */
const EXAMPLE_DIR = new URL("../test/fixtures/mainnet/tiered/", import.meta.url);
export const EXAMPLE_FILES = {
  record: fileURLToPath(new URL("record.json", EXAMPLE_DIR)),
  anchorBundle: fileURLToPath(new URL("anchor-bundle.json", EXAMPLE_DIR)),
  keys: fileURLToPath(new URL("rubric-keys.json", EXAMPLE_DIR)),
};
const EXAMPLE_NOTE =
  "tenprint-verify --example: bundled canary record 02d03bdf-e810-4dfd-a3a0-926b5ad48684 " +
  "(payload is a commitment hash only), anchor bundle d59658dd-e087-4363-922c-becb76e51494, " +
  "bundled keys file pinned; checking live against the public mirror, zero requests to rubric-protocol.com\n";

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
        example: { type: "boolean" },
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
  if (values.example) {
    const clash = (["record", "anchor-bundle", "keys", "topic"] as const).filter((k) => values[k] !== undefined);
    if (clash.length > 0) {
      io.stderr(`--example cannot be combined with ${clash.map((k) => `--${k}`).join(", ")}\n${USAGE}`);
      return 2;
    }
    io.stderr(EXAMPLE_NOTE);
  } else if (!values.record || !values["anchor-bundle"]) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const paths = values.example
      ? EXAMPLE_FILES
      : { record: values.record!, anchorBundle: values["anchor-bundle"]!, keys: values.keys };
    const record = readJson(paths.record, "--record", readFile);
    const anchorBundle = readJson(paths.anchorBundle, "--anchor-bundle", readFile);
    const keys = paths.keys !== undefined ? readJson(paths.keys, "--keys", readFile) : undefined;
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
