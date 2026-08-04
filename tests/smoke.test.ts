import { describe, expect, it } from "vitest";
import { CLI_NAME } from "../src/cli.js";

describe("CLI scaffold", () => {
  it("exposes the expected command name", () => {
    expect(CLI_NAME).toBe("whatsapp-scrape");
  });
});
