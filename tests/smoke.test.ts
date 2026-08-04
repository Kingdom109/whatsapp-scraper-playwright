import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NAME } from "../src/cli.js";

describe("CLI scaffold", () => {
  it("exposes the expected command name", () => {
    expect(CLI_NAME).toBe("whatsapp-scrape");
  });

  it("prints the command name when run as a process", () => {
    const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", sourceCli], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("whatsapp-scrape\n");
  });

  it("prints the command name when run through a linked package path", () => {
    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const temporaryRoot = mkdtempSync(join(tmpdir(), "whatsapp-cli-"));
    const linkedRoot = join(temporaryRoot, "linked-package");

    try {
      symlinkSync(repositoryRoot, linkedRoot, "junction");
      const linkedCli = join(linkedRoot, "src", "cli.ts");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", linkedCli],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("whatsapp-scrape\n");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
