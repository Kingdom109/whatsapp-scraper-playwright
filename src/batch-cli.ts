#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBatchScrapes } from "./app.js";
import { OperationalFailure } from "./domain.js";
import { parseBatchCommands } from "./options.js";

export async function batchMain(
  argv = process.argv.slice(2),
  runBatch: typeof runBatchScrapes = runBatchScrapes,
): Promise<number> {
  let commands;
  try {
    commands = parseBatchCommands(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid batch command"}\n`);
    return 1;
  }
  try {
    const results = await runBatch(commands);
    let qualified = false;
    for (const [index, result] of results.entries()) {
      if (result.outcome?.path !== null && result.outcome?.path !== undefined) {
        process.stdout.write(`Export written to ${result.outcome.path}\n`);
      }
      if (result.failure !== undefined) {
        process.stderr.write(`Requested chat ${index + 1} could not be scraped.\n`);
        qualified = true;
      } else if (result.outcome?.complete === false) {
        process.stderr.write(`Requested chat ${index + 1} export is incomplete.\n`);
        qualified = true;
      }
    }
    return qualified ? 2 : 0;
  } catch (error) {
    const failure = error instanceof OperationalFailure ? error : new OperationalFailure("unexpected");
    process.stderr.write(`${failure.message}\n`);
    if (failure.kind === "interrupted") return failure.signal === "SIGTERM" ? 143 : 130;
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(invokedPath))
) {
  process.exitCode = await batchMain();
}
