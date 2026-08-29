import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, type AppDependencies } from "../src/app.js";
import { captureDiagnostic } from "../src/diagnostics.js";
import { main } from "../src/cli.js";
import { OperationalFailure } from "../src/domain.js";
import { ProfileInUseError } from "../src/session.js";
import { AmbiguousChatError, ChatNotFoundError } from "../src/whatsapp/navigator.js";

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
    }, dependencies(events))).resolves.toEqual({
      path: "exports/result.md",
      complete: true,
      warnings: [],
    });

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

    await expect(runCommand({ kind: "login" }, dependencies(events))).resolves.toEqual({
      path: null,
      complete: true,
      warnings: [],
    });

    expect(events).toEqual(["open", "login", "close"]);
  });

  it("returns an incomplete scrape outcome with content-free warnings", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.load = async () => ({
      messages: [],
      complete: false,
      warnings: ["Private chat text must never reach the terminal."],
    });

    await expect(runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 10 },
      format: "md",
      diagnostics: false,
    }, deps)).resolves.toEqual({
      path: "exports/result.md",
      complete: false,
      warnings: ["The requested boundary was not reached; review the local export for details."],
    });
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
    }, deps)).rejects.toMatchObject({ kind: "ui-drift" });

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
    }, deps)).rejects.toMatchObject({
      kind: stage === "login" ? "login-timeout" : "export-failure",
    });

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
    }, deps)).rejects.toMatchObject({ kind: "ui-drift" });
  });

  it.each([
    ["profile contention", "profile-in-use", "The dedicated WhatsApp browser profile is already in use. Close the other scraper run and retry.", (deps: AppDependencies) => {
      deps.openSession = async () => { throw new ProfileInUseError(); };
    }],
    ["login timeout", "login-timeout", "WhatsApp login or QR pairing did not complete in time. Scan the visible QR code and retry.", (deps: AppDependencies) => {
      deps.ensureLogin = async () => { throw new Error("private login detail"); };
    }],
    ["missing chat", "chat-not-found", "The requested chat was not found. Check the exact displayed chat name and retry.", (deps: AppDependencies) => {
      deps.openChat = async () => { throw new ChatNotFoundError(); };
    }],
    ["ambiguous chat", "ambiguous-chat", "More than one visible chat exactly matches the requested name. Use the exact displayed name and retry.", (deps: AppDependencies) => {
      deps.openChat = async () => { throw new AmbiguousChatError(["Private chat"]); };
    }],
    ["history interface failure", "ui-drift", "WhatsApp's selected-chat, history, or interface state could not be verified. Retry; if it persists, rerun the scrape with --diagnostics and review private artifacts locally.", (deps: AppDependencies) => {
      deps.load = async () => { throw new Error("private history text"); };
    }],
    ["export failure", "export-failure", "The export could not be written. Check local export storage and retry.", (deps: AppDependencies) => {
      deps.write = async () => { throw new Error("private export text"); };
    }],
  ])("maps %s to a fixed content-free operational failure", async (_caseName, kind, message, configure) => {
    const events: string[] = [];
    const deps = dependencies(events);
    configure(deps);

    const failure = await runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: true,
    }, deps).catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind, message });
    expect(JSON.stringify(failure)).not.toContain("private");
    if (_caseName !== "profile contention") expect(events.at(-1)).toBe("close");
  });

  it("reports a fixed shutdown failure when an operation and close both fail", async () => {
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

    expect(failure).toMatchObject({
      kind: "shutdown-failure",
      message: "WhatsApp shutdown could not be confirmed. Close the visible browser before retrying.",
    });
    expect(JSON.stringify(failure)).not.toContain("original failure");
    expect(JSON.stringify(failure)).not.toContain("close failure");
  });

  it("closes once on an injected interrupt and removes both signal handlers", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    let enteredLogin!: () => void;
    const loginEntered = new Promise<void>((resolve) => { enteredLogin = resolve; });
    let finishLogin!: () => void;
    const loginPending = new Promise<void>((resolve) => { finishLogin = resolve; });
    const handlers = new Map<string, () => void>();
    const removed: string[] = [];
    deps.ensureLogin = async () => {
      events.push("login");
      enteredLogin();
      await loginPending;
    };
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => {
        removed.push(signal);
        handlers.delete(signal);
      };
    };

    const running = runCommand({ kind: "login" }, deps);
    await loginEntered;

    expect([...handlers.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGINT")!();
    handlers.get("SIGTERM")!();
    finishLogin();

    await expect(running).rejects.toMatchObject({ kind: "interrupted", signal: "SIGINT" });
    expect(events.filter((event) => event === "close")).toHaveLength(1);
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
    expect(handlers.size).toBe(0);
  });

  it("returns an interrupt outcome when SIGTERM arrives during final close", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    const handlers = new Map<string, () => void>();
    const removed: string[] = [];
    deps.openSession = async () => ({
      context: {} as never,
      page,
      close: async () => {
        events.push("close");
        handlers.get("SIGTERM")!();
      },
    });
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => {
        removed.push(signal);
        handlers.delete(signal);
      };
    };

    await expect(runCommand({ kind: "login" }, deps)).rejects.toMatchObject({
      kind: "interrupted",
      signal: "SIGTERM",
    });

    expect(events.filter((event) => event === "close")).toHaveLength(1);
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("drains a losing login operation before an interrupted run settles", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    let enteredLogin!: () => void;
    const loginEntered = new Promise<void>((resolve) => { enteredLogin = resolve; });
    let finishLogin!: () => void;
    const loginPending = new Promise<void>((resolve) => { finishLogin = resolve; });
    const handlers = new Map<string, () => void>();
    deps.ensureLogin = async () => {
      events.push("login");
      enteredLogin();
      await loginPending;
      events.push("login-settled");
    };
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    };

    let settled = false;
    const running = runCommand({ kind: "login" }, deps).finally(() => { settled = true; });
    await loginEntered;
    handlers.get("SIGINT")!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finishLogin();

    await expect(running).rejects.toMatchObject({ kind: "interrupted", signal: "SIGINT" });
    expect(events).toEqual(["open", "login", "close", "login-settled"]);
  });

  it("drains an interrupted export publication before the run settles", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    let enteredWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => { finishWrite = resolve; });
    const handlers = new Map<string, () => void>();
    deps.write = async () => {
      events.push("export-started");
      enteredWrite();
      await writePending;
      events.push("export-published");
      return "exports/published.md";
    };
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    };

    let settled = false;
    const running = runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: false,
    }, deps).finally(() => { settled = true; });
    await writeEntered;
    handlers.get("SIGTERM")!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finishWrite();

    await expect(running).rejects.toMatchObject({ kind: "interrupted", signal: "SIGTERM" });
    expect(events).toContain("export-published");
    expect(events.at(-1)).toBe("export-published");
  });

  it("does not diagnose an interrupted navigation run", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    let enteredChat!: () => void;
    const chatEntered = new Promise<void>((resolve) => { enteredChat = resolve; });
    let finishChat!: () => void;
    const chatPending = new Promise<void>((resolve) => { finishChat = resolve; });
    const handlers = new Map<string, () => void>();
    deps.openChat = async () => {
      events.push("chat");
      enteredChat();
      await chatPending;
    };
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    };

    const running = runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: true,
    }, deps);
    await chatEntered;
    handlers.get("SIGINT")!();
    finishChat();

    await expect(running).rejects.toMatchObject({ kind: "interrupted" });
    expect(events.some((event) => event.startsWith("diagnose:"))).toBe(false);
    expect(events.filter((event) => event === "close")).toHaveLength(1);
  });

  it("does not start diagnostics when navigation records SIGINT and rejects in the same turn", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    const handlers = new Map<string, () => void>();
    deps.openChat = async () => {
      events.push("chat");
      handlers.get("SIGINT")!();
      throw new Error("private UI failure");
    };
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    };

    await expect(runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: true,
    }, deps)).rejects.toMatchObject({ kind: "interrupted", signal: "SIGINT" });

    expect(events.some((event) => event.startsWith("diagnose:"))).toBe(false);
    expect(events.filter((event) => event === "close")).toHaveLength(1);
  });

  it("drains an already-started diagnostic after SIGTERM without masking interruption", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    const handlers = new Map<string, () => void>();
    let enteredDiagnostic!: () => void;
    const diagnosticEntered = new Promise<void>((resolve) => { enteredDiagnostic = resolve; });
    let finishDiagnostic!: () => void;
    const diagnosticPending = new Promise<void>((resolve) => { finishDiagnostic = resolve; });
    deps.openChat = async () => { throw new Error("private UI failure"); };
    deps.diagnose = async () => {
      events.push("diagnose-started");
      enteredDiagnostic();
      await diagnosticPending;
      events.push("diagnose-settled");
      throw new Error("private diagnostic failure");
    };
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    };

    let settled = false;
    const running = runCommand({
      kind: "scrape",
      chat: "Private chat",
      limit: { kind: "messages", value: 1 },
      format: "md",
      diagnostics: true,
    }, deps).finally(() => { settled = true; });
    await diagnosticEntered;
    handlers.get("SIGTERM")!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(events.filter((event) => event === "close")).toHaveLength(1);
    finishDiagnostic();

    await expect(running).rejects.toMatchObject({ kind: "interrupted", signal: "SIGTERM" });
    expect(events).toContain("diagnose-settled");
  });

  it("reports shutdown failure instead of interruption when interrupt close fails", async () => {
    const events: string[] = [];
    const deps = dependencies(events) as AppDependencies & {
      registerSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): () => void;
    };
    let enteredLogin!: () => void;
    const loginEntered = new Promise<void>((resolve) => { enteredLogin = resolve; });
    let finishLogin!: () => void;
    const loginPending = new Promise<void>((resolve) => { finishLogin = resolve; });
    const handlers = new Map<string, () => void>();
    deps.openSession = async () => ({
      context: {} as never,
      page,
      close: async () => {
        events.push("close");
        throw new Error("private close detail");
      },
    });
    deps.ensureLogin = async () => {
      enteredLogin();
      await loginPending;
    };
    deps.registerSignal = (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    };

    const running = runCommand({ kind: "login" }, deps);
    await loginEntered;
    handlers.get("SIGINT")!();
    finishLogin();

    const failure = await running.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      kind: "shutdown-failure",
      message: "WhatsApp shutdown could not be confirmed. Close the visible browser before retrying.",
    });
    expect(JSON.stringify(failure)).not.toContain("private close detail");
    expect(events.filter((event) => event === "close")).toHaveLength(1);
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

    expect(stderr).toHaveBeenCalledWith(
      "WhatsApp extraction could not be completed. Retry; if it persists, review private diagnostics locally.\n",
    );
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("secret message text");
    stderr.mockRestore();
  });

  it("prints fixed operational failures and uses the conventional interrupt status", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const execute = vi.fn(async () => { throw new OperationalFailure("interrupted", "SIGTERM"); });

    await expect(main(["login"], execute)).resolves.toBe(143);

    expect(stderr).toHaveBeenCalledWith("The run was interrupted. The browser session was closed.\n");
    stderr.mockRestore();
  });

  it("marks an incomplete export as non-success without printing raw warnings", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const execute = vi.fn(async () => ({
      path: "exports/result.md",
      complete: false,
      warnings: ["Private chat text must not be printed."],
    }));

    await expect(main(["Private chat", "--messages", "1"], execute as never)).resolves.toBe(2);

    expect(stdout).toHaveBeenCalledWith("Export written to exports/result.md\n");
    expect(stderr).toHaveBeenCalledWith("Export is incomplete.\n");
    expect(stderr).toHaveBeenCalledWith(
      "Warning: The requested boundary was not reached; review the local export for details.\n",
    );
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("Private chat text");
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
