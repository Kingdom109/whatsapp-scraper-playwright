#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_NAME = "whatsapp-scrape";

const invokedPath = process.argv[1];

if (
  invokedPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(invokedPath))
) {
  process.stdout.write(`${CLI_NAME}\n`);
}
