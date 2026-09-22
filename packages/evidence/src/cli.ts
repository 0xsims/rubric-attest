#!/usr/bin/env node
/**
 * CLI (tasks/P5.md):
 *   rubric-evidence export --agent <id> --index <dir> --store <dir> \
 *     [--from <ts>] [--to <ts>] [--out <file>] [--summary <file>]
 *
 * Writes the JSON evidence bundle (to --out or stdout) and the plain-text
 * summary (to --summary or stderr). Runs offline against the index shards.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openIndexReader, openStoreReader } from "./adapters.js";
import { exportEvidence } from "./export.js";

const MIN_TS = "0000-01-01T00:00:00.000Z";
const MAX_TS = "9999-12-31T23:59:59.999Z";

function usage(): never {
  process.stderr.write(
    "usage: rubric-evidence export --agent <id> --index <dir> --store <dir> " +
      "[--from <ts>] [--to <ts>] [--out <file>] [--summary <file>]\n",
  );
  process.exit(2);
}

function main(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      index: { type: "string" },
      store: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
      "generated-at": { type: "string" },
    },
  });

  if (!values.agent || !values.index || !values.store) usage();

  const index = openIndexReader(values.index);
  try {
    const { bundle, summary } = exportEvidence(index, openStoreReader(values.store), {
      agent: values.agent,
      from: values.from ?? MIN_TS,
      to: values.to ?? MAX_TS,
      generatedAt: values["generated-at"] ?? new Date().toISOString(),
    });

    const json = JSON.stringify(bundle, null, 2) + "\n";
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);

    if (values.summary) writeFileSync(values.summary, summary);
    else process.stderr.write("\n" + summary);
  } finally {
    index.close?.();
  }
}

// Support the `export` subcommand verb: `rubric-evidence export --agent ...`.
const args = process.argv.slice(2);
main(args[0] === "export" ? args.slice(1) : args);
