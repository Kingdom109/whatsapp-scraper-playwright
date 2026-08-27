import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, type AppDependencies } from "../src/app.js";
import { captureDiagnostic } from "../src/diagnostics.js";
import { main } from "../src/cli.js";

const page = {} as Page;

function dependencies(events: string[]): AppDependencies {
  return {
    openSession: async () => {
      events.push("open");
      return {
        context: {} as never,
        page,
        close: async () => { events.push("close"); },
      };
    },
    ensureLogin: async () => { events.push("login"); },
    openChat: async () => { events.push("chat"); },
    createAdapter: () => {
      events.push("adapter");
      return {
        limit: { kind: "messages", value: 1 },
        now: new Date("2026-08-04T12:00:00+03:00"),
        maxCycles: 1,
        stallCycles: 1,
        parseWindow: async () => [],
        scrollOlder: async () => "stalled" as const,
      };
    },
    load: async () => {
      events.push("history");
      return { messages: [], complete: true, warnings: [] };
    },
    write: async (result) => {
      events.push(`export:${result.extractedAt}`);
      return "exports/result.md";
    },
    diagnose: async (_page, stage, includeDom) => {
      events.push(`diagnose:${stage}:${includeDom}`);
      return [];
    },
    now: () => new Date("2026-08-04T12:00:00+03:00"),
  };
}

describe("runCommand", () => {
  it("runs a scrape in lifecycle order and closes the session", async () => {
    const events: string[] = [];

    await expect(runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: false,
    }, dependencies(events))).resolves.toBe("exports/result.md");

    expect(events).toEqual([
      "open",
      "login",
      "chat",
      "adapter",
      "history",
      "export:2026-08-04T12:00:00+03:00",
      "close",
    ]);
  });

  it("login closes normally without navigating, loading, exporting, or diagnosing", async () => {
    const events: string[] = [];

    await expect(runCommand({ kind: "login" }, dependencies(events))).resolves.toBeNull();

    expect(events).toEqual(["open", "login", "close"]);
  });

  it.each([
    ["chat-navigation", "chat"],
    ["history-loading", "history"],
  ] as const)("diagnoses only a failed %s stage and still closes", async (stage, failureEvent) => {
    const events: string[] = [];
    const deps = dependencies(events);
    const original = new Error("private message contents");
    if (failureEvent === "chat") {
      deps.openChat = async () => { events.push("chat"); throw original; };
    } else {
      deps.load = async () => { events.push("history"); throw original; };
    }

    await expect(runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: true,
    }, deps)).rejects.toBe(original);

    expect(events).toContain(`diagnose:${stage}:true`);
    expect(events.at(-1)).toBe("close");
  });

  it.each(["login", "export"] as const)("does not diagnose a failed %s stage", async (stage) => {
    const events: string[] = [];
    const deps = dependencies(events);
    const original = new Error("private failure details");
    if (stage === "login") deps.ensureLogin = async () => { events.push("login"); throw original; };
    else deps.write = async () => { events.push("export"); throw original; };

    await expect(runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: false,
    }, deps)).rejects.toBe(original);

    expect(events.some((event) => event.startsWith("diagnose:"))).toBe(false);
    expect(events.at(-1)).toBe("close");
  });

  it("does not let diagnostic failure mask the original failure", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const original = new Error("original private failure");
    deps.openChat = async () => { throw original; };
    deps.diagnose = async () => { throw new Error("diagnostic failed"); };

    await expect(runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: false,
    }, deps)).rejects.toBe(original);
  });

  it("preserves the operation failure when closing also fails", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const original = new Error("original failure");
    const closeFailure = new Error("close failure");
    deps.ensureLogin = async () => { throw original; };
    deps.openSession = async () => ({
      context: {} as never,
      page,
      close: async () => { throw closeFailure; },
    });

    const failure = await runCommand({ kind: "login" }, deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, closeFailure]);
    expect((failure as Error).message).toBe("original failure");
  });
});

describe("captureDiagnostic", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("writes a private-labeled bounded viewport screenshot without DOM by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-diagnostic-"));
    roots.push(root);
    let screenshotOptions: Record<string, unknown> | undefined;
    const fakePage = {
      viewportSize: () => ({ width: 2000, height: 1400 }),
      screenshot: async (options: Record<string, unknown>) => {
        screenshotOptions = options;
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile(String(options.path), "image"));
      },
      content: async () => "<main>private text</main>",
    } as unknown as Page;

    const files = await captureDiagnostic(fakePage, "history-loading", false, {
      rootDirectory: root,
      now: () => new Date("2026-08-04T09:00:00.000Z"),
    });

    expect(files.map((file) => file.split(/[\\/]/).at(-1))).toEqual(["failure.json", "screen.png"]);
    expect(screenshotOptions).toMatchObject({
      fullPage: false,
      timeout: 5_000,
      clip: { x: 0, y: 0, width: 1440, height: 1000 },
    });
    const metadata = JSON.parse(await readFile(files[0]!, "utf8"));
    expect(metadata).toMatchObject({
      stage: "history-loading",
      category: "unexpected-ui-failure",
      privacy: "private-sensitive",
    });
    await expect(stat(join(files[0]!, "..", "page.html"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a bounded DOM snapshot only when explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-diagnostic-"));
    roots.push(root);
    const fakePage = {
      viewportSize: () => ({ width: 800, height: 600 }),
      screenshot: async (options: { path: string }) => {
        await import("node:fs/promises").then(({ writeFile }) => writeFile(options.path, "image"));
      },
      content: async () => `private-${"x".repeat(6_000_000)}`,
    } as unknown as Page;

    const files = await captureDiagnostic(fakePage, "chat-navigation", true, {
      rootDirectory: root,
      now: () => new Date("2026-08-04T09:00:00.000Z"),
    });

    expect(files.at(-1)?.endsWith("page.html")).toBe(true);
    expect((await stat(files.at(-1)!)).size).toBeLessThanOrEqual(5_000_000);
  });
});

describe("main", () => {
  it("parses before execution and exits nonzero without opening a session", async () => {
    const execute = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(main([], execute)).resolves.toBe(1);

    expect(execute).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("exactly one nonblank chat is required\n");
    stderr.mockRestore();
  });

  it("does not print private thrown content", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const execute = vi.fn(async () => { throw new Error("secret message text"); });

    await expect(main(["login"], execute)).resolves.toBe(1);

    expect(stderr).toHaveBeenCalledWith("WhatsApp extraction failed. Review private diagnostics if available.\n");
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("secret message text");
    stderr.mockRestore();
  });
});
