import { afterEach, describe, expect, it, vi } from "vitest";
import { batchMain } from "../src/batch-cli.js";
import { OperationalFailure } from "../src/domain.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("batchMain", () => {
  it("reports an incomplete export without exposing chat content in the warning", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exitCode = await batchMain(
      ["Private event chat", "--days", "1"],
      async () => [{
        chat: "Private event chat",
        outcome: { path: "exports/result.json", complete: false, warnings: [] },
      }],
    );

    expect(exitCode).toBe(2);
    expect(stdout).toHaveBeenCalledWith("Export written to exports/result.json\n");
    expect(stderr).toHaveBeenCalledWith("Requested chat 1 export is incomplete.\n");
  });

  it("reports each failed requested chat with a fixed content-free summary", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exitCode = await batchMain(
      ["Private event chat", "--messages", "20"],
      async () => [{
        chat: "Private event chat",
        failure: new OperationalFailure("chat-not-found"),
      }],
    );

    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith("Requested chat 1 could not be scraped.\n");
  });
});
