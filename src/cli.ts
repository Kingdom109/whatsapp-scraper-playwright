#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OperationalFailure,
  sanitizeOutcomeWarnings,
  type CliCommand,
  type CommandOutcome,
} from "./domain.js";
import { runCommand } from "./app.js";
import { parseCommand } from "./options.js";

export const CLI_NAME = "whatsapp-scrape";

type CommandRunner = (command: CliCommand) => Promise<CommandOutcome>;

export async function main(
  argv = process.argv.slice(2),
  execute: CommandRunner = runCommand,
): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCommand(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid command"}\n`);
    return 1;
  }

  try {
    const outcome = await execute(command);
    if (outcome.path !== null) process.stdout.write(`Export written to ${outcome.path}\n`);
    if (!outcome.complete) process.stderr.write("Export is incomplete.\n");
    for (const warning of sanitizeOutcomeWarnings(outcome.complete, outcome.warnings)) {
      process.stderr.write(`Warning: ${warning}\n`);
    }
    return outcome.complete ? 0 : 2;
  } catch (error) {
    const failure = error instanceof OperationalFailure
      ? error
      : new OperationalFailure("unexpected");
    process.stderr.write(`${failure.message}\n`);
    if (failure.kind === "interrupted") return failure.signal === "SIGTERM" ? 143 : 130;
    return 1;
  }
}

const invokedPath = process.argv[1];

if (
  invokedPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(invokedPath))
) {
  process.exitCode = await main();
}
