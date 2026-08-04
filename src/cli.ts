#!/usr/bin/env node

export const CLI_NAME = "whatsapp-scrape";

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  process.stdout.write(`${CLI_NAME}\n`);
}
