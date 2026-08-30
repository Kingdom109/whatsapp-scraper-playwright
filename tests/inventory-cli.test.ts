import { describe, expect, it, vi } from "vitest";
import { inventoryMain, writeInventoryFile } from "../src/inventory-cli.js";

describe("inventoryMain", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("closes the browser and returns the %s exit code while inventory is running", async (signal, exitCode) => {
    const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const close = vi.fn(async () => {});
    let beginInventory!: () => void;
    const started = new Promise<void>((resolve) => { beginInventory = resolve; });
    const never = new Promise<{ active: string[]; archived: string[] }>(() => {});

    const running = inventoryMain({
      openSession: async () => ({ page: {}, close }),
      ensureLogin: async () => {},
      inventory: async () => {
        beginInventory();
        return never;
      },
      registerSignal: (signal, handler) => {
        handlers.set(signal, handler);
        return () => handlers.delete(signal);
      },
      writeInventory: async () => { throw new Error("must not write after interruption"); },
    });

    await started;
    handlers.get(signal)!();

    await expect(running).resolves.toBe(exitCode);
    expect(close).toHaveBeenCalledTimes(1);
    expect(handlers.size).toBe(0);
  });
});

describe("writeInventoryFile", () => {
  it("publishes the completed inventory only after the temporary file is renamed", async () => {
    const calls: string[] = [];
    const files = new Set<string>();

    await writeInventoryFile("exports/inventory.json", { active: ["Active"], archived: [] }, {
      mkdir: async () => { calls.push("mkdir"); },
      writeFile: async (path) => { calls.push(`write:${path}`); files.add(path); },
      rename: async (from, to) => {
        calls.push(`rename:${from}:${to}`);
        expect(files.has(to)).toBe(false);
        files.delete(from);
        files.add(to);
      },
      unlink: async (path) => { calls.push(`unlink:${path}`); files.delete(path); },
      randomUUID: () => "test-id",
    });

    expect(calls).toEqual([
      "mkdir",
      "write:exports/inventory.json.test-id.tmp",
      "rename:exports/inventory.json.test-id.tmp:exports/inventory.json",
    ]);
    expect(files).toEqual(new Set(["exports/inventory.json"]));
  });

  it("removes the temporary file when publishing fails", async () => {
    const removed: string[] = [];

    await expect(writeInventoryFile("exports/inventory.json", { active: [], archived: [] }, {
      mkdir: async () => {},
      writeFile: async () => {},
      rename: async () => { throw new Error("rename failed"); },
      unlink: async (path) => { removed.push(path); },
      randomUUID: () => "test-id",
    })).rejects.toThrow("rename failed");

    expect(removed).toEqual(["exports/inventory.json.test-id.tmp"]);
  });
});
