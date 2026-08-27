#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliCommand } from "./domain.js";
import { runCommand } from "./app.js";
import { parseCommand } from "./options.js";

export const CLI_NAME = "whatsapp-scrape";

type CommandRunner = (command: CliCommand) => Promise<string | null>;

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
    const output = await execute(command);
    if (output !== null) process.stdout.write(`Export written to ${output}\n`);
    return 0;
  } catch {
    process.stderr.write(
      "WhatsApp extraction failed. Review private diagnostics if available.\n",
    );
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
