#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CLI_NAME = "whatsapp-scrape";

const invokedPath = process.argv[1];

if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  process.stdout.write(`${CLI_NAME}\n`);
}
