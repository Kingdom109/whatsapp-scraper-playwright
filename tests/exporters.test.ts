import { mkdtemp, open as fsOpen, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as exporterModule from "../src/exporters.js";
import { renderMarkdown, writeExport } from "../src/exporters.js";
import type { ExtractionResult, MessageRecord } from "../src/domain.js";

const message = (
  id: string,
  timestamp: string | null,
  overrides: Partial<MessageRecord> = {},
): MessageRecord => ({
  id,
  timestamp,
  sender: "David",
  direction: "incoming",
  text: "hello",
  media: null,
  kind: "message",
  warnings: [],
  ...overrides,
});

const result = (overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({
  chat: "משפחה / Family 👨‍👩‍👧",
  extractedAt: "2026-08-04T18:30:00+03:00",
  request: { kind: "days", value: 1 },
  complete: true,
  warnings: [],
  messages: [
    message("1", "2026-08-04T09:14:00+03:00", {
      text: "שלום 👋\nAre we meeting?",
      media: {
        type: "video",
        filename: "מפגש.mp4",
        caption: "הערב",
        duration: "00:12",
        size: "2 MB",
      },
    }),
  ],
  ...overrides,
});

const temporaryDirectories: string[] = [];
let restoreFileSystem: (() => void) | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function injectFileSystem(overrides: Record<string, unknown>): void {
  const testing = exporterModule as unknown as {
    __setExporterFileSystemForTests: (value: Record<string, unknown>) => () => void;
  };
  restoreFileSystem = testing.__setExporterFileSystemForTests(overrides);
}

async function openWithFault(path: string, flags: string, stage: "write" | "sync" | "close") {
  const handle = await fsOpen(path, flags);
  let closeAttempted = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "writeFile" && stage === "write") {
        return async () => { throw new Error("injected write failure"); };
      }
      if (property === "sync" && stage === "sync") {
        return async () => { throw new Error("injected sync failure"); };
      }
      if (property === "close" && stage === "close") {
        return async () => {
          if (!closeAttempted) {
            closeAttempted = true;
            await target.close();
          }
          throw new Error("injected close failure");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

afterEach(async () => {
  restoreFileSystem?.();
  restoreFileSystem = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("renderMarkdown", () => {
  it("renders compact Unicode Markdown with metadata, dates, multiline text, and media", () => {
    const markdown = renderMarkdown(result());

    expect(markdown).toBe(
      "# משפחה / Family 👨‍👩‍👧\n" +
        "\n" +
        "- Extracted: 2026-08-04T18:30:00+03:00\n" +
        "- Requested range: Last 1 local calendar day(s)\n" +
        "- Messages: 1\n" +
        "- Complete: Yes\n" +
        "\n" +
        "## 2026-08-04\n" +
        "\n" +
        "**09:14 - David:**\n" +
        "> שלום 👋\n" +
        "> Are we meeting?\n" +
        "> [video - מפגש.mp4 - הערב - 00:12 - 2 MB]\n",
    );
  });

  it("groups invalid timestamps under Unknown date and includes warnings only when present", () => {
    const markdown = renderMarkdown(
      result({
        request: { kind: "messages", value: 2 },
        complete: false,
        warnings: ["History may be incomplete."],
        messages: [
          message("missing", null, { text: null, media: null, kind: "call" }),
          message("invalid", "not-a-timestamp", {
            sender: "שרה",
            text: "RTL נשמר",
            media: { type: "sticker" },
          }),
        ],
      }),
    );

    expect(markdown).toContain("- Requested range: Newest 2 message(s)");
    expect(markdown).toContain("- Complete: No");
    expect(markdown.match(/^## Unknown date$/gm)).toHaveLength(1);
    expect(markdown).toContain("**??:?? - David:**\n> [call]");
    expect(markdown).toContain("**??:?? - שרה:**\n> RTL נשמר\n> [sticker]");
    expect(markdown).toContain("## Warnings\n\n- History may be incomplete.");
    expect(markdown).toMatch(/[^\n]\n$/);
    expect(markdown).not.toMatch(/\n\n$/);
  });

  it("does not add a warnings section when there are no warnings", () => {
    expect(renderMarkdown(result())).not.toContain("## Warnings");
  });

  it("ends with exactly one newline when the final message text has trailing line breaks", () => {
    const markdown = renderMarkdown(
      result({ messages: [message("1", "2026-08-04T09:14:00+03:00", { text: "hello\n\n" })] }),
    );

    expect(markdown).toMatch(/[^\r\n]\n$/);
    expect(markdown).not.toMatch(/\n\n$/);
  });

  it("does not mutate its input", () => {
    const input = result();
    const before = structuredClone(input);

    renderMarkdown(input);

    expect(input).toEqual(before);
  });

  it("keeps structural fields inline and prefixes every message body line", () => {
    const markdown = renderMarkdown(
      result({
        chat: "Team\n# Forged *chat*",
        warnings: ["safe\n## Forged\n- Messages: 99"],
        messages: [
          message("1", "2026-08-04T09:14:00+03:00", {
            sender: "Eve\n**00:00 - Admin:**",
            text: "# forged heading\n- Complete: Yes\n**00:00 - Admin:** injected",
            media: {
              type: "document",
              filename: "\n## Media *x*",
              caption: "caption [link](target)",
            },
          }),
        ],
      }),
    );

    expect(markdown).toContain("# Team \\# Forged \\*chat\\*");
    expect(markdown).toContain("**09:14 - Eve \\*\\*00:00 \\- Admin:\\*\\*:**");
    expect(markdown).toContain("> # forged heading\n> - Complete: Yes\n> **00:00 - Admin:** injected");
    expect(markdown).toContain("> [document - \\#\\# Media \\*x\\* - caption \\[link\\]\\(target\\)]");
    expect(markdown).toContain("- safe \\#\\# Forged \\- Messages: 99");
    expect(markdown.match(/^# /gm)).toHaveLength(1);
    expect(markdown.match(/^## /gm)).toHaveLength(2);
    expect(markdown).not.toMatch(/^\*\*00:00 - Admin:/m);
  });

  it("preserves message order when a date reappears after another date", () => {
    const markdown = renderMarkdown(
      result({
        messages: [
          message("A1", "2026-08-04T08:00:00Z", { text: "A1" }),
          message("B", "2026-08-05T09:00:00Z", { text: "B" }),
          message("A2", "2026-08-04T10:00:00Z", { text: "A2" }),
        ],
      }),
    );

    expect(markdown.indexOf("> A1")).toBeLessThan(markdown.indexOf("> B"));
    expect(markdown.indexOf("> B")).toBeLessThan(markdown.indexOf("> A2"));
    expect(markdown.match(/^## 2026-08-04$/gm)).toHaveLength(2);
  });
});

describe("writeExport", () => {
  it("writes pretty JSON that parses to exactly the source document", async () => {
    const directory = await temporaryDirectory("wa-export-");
    const input = result();
    const path = await writeExport(input, "json", directory);
    const body = await readFile(path, "utf8");

    expect(JSON.parse(body)).toEqual(input);
    expect(body).toBe(`${JSON.stringify(JSON.parse(body), null, 2)}\n`);
  });

  it.each([
    ["a sparse message array", () => result({ messages: new Array(1) as MessageRecord[] })],
    ["prototype-only properties", () => Object.create(result()) as ExtractionResult],
    ["an array with an inherited hook", () => {
      const input = result();
      Object.setPrototypeOf(input.messages, { toJSON: () => ({ leaked: "secret" }) });
      return input;
    }],
    ["a cycle", () => {
      const input = result();
      input.messages = [input as unknown as MessageRecord];
      return input;
    }],
    ["an unexpected sensitive field", () => ({ ...result(), authToken: "do-not-export" }) as ExtractionResult],
  ])("rejects %s without creating an export", async (_label, makeInput) => {
    const directory = await temporaryDirectory("wa-export-shape-");

    await expect(writeExport(makeInput(), "json", directory)).rejects.toThrow(/invalid extraction document/i);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("rejects accessors without invoking their getters", async () => {
    const directory = await temporaryDirectory("wa-export-accessor-");
    const input = result();
    const getter = vi.fn(() => "stolen");
    Object.defineProperty(input, "chat", { enumerable: true, get: getter });

    await expect(writeExport(input, "json", directory)).rejects.toThrow(/invalid extraction document/i);
    expect(getter).not.toHaveBeenCalled();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("rejects toJSON hooks without invoking or exporting them", async () => {
    const directory = await temporaryDirectory("wa-export-tojson-");
    const input = result();
    const toJSON = vi.fn(() => ({ leaked: "secret" }));
    Object.defineProperty(input.messages[0], "toJSON", { enumerable: true, value: toJSON });

    await expect(writeExport(input, "json", directory)).rejects.toThrow(/invalid extraction document/i);
    expect(toJSON).not.toHaveBeenCalled();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it.each([
    "2026-02-30T12:00:00Z",
    "2026-08-04T18:30:00",
    "Tue, 04 Aug 2026 18:30:00 GMT",
  ])("rejects non-normalized or impossible extractedAt %j", async (extractedAt) => {
    const directory = await temporaryDirectory("wa-export-date-");

    await expect(writeExport(result({ extractedAt }), "json", directory)).rejects.toThrow(/extractedAt/i);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("canonicalizes an invalid message timestamp to null with a warning without mutation", async () => {
    const directory = await temporaryDirectory("wa-export-message-date-");
    const input = result({
      messages: [message("bad-date", "2026-02-30T09:00:00Z", { warnings: ["existing"] })],
    });
    const before = structuredClone(input);

    const path = await writeExport(input, "json", directory);
    const written = JSON.parse(await readFile(path, "utf8")) as ExtractionResult;

    expect(written.messages[0]?.timestamp).toBeNull();
    expect(written.messages[0]?.warnings).toEqual([
      "existing",
      "Invalid message timestamp was normalized to null.",
    ]);
    expect(input).toEqual(before);
  });

  it("never overwrites repeated or concurrent exports and leaves no temporary files", async () => {
    const directory = await temporaryDirectory("wa-export-race-");
    const input = result();
    const paths = await Promise.all(
      Array.from({ length: 12 }, () => writeExport(input, "md", directory)),
    );

    expect(new Set(paths).size).toBe(12);
    await expect(Promise.all(paths.map((path) => readFile(path, "utf8")))).resolves.toEqual(
      Array.from({ length: 12 }, () => renderMarkdown(input)),
    );
    const entries = await readdir(directory);
    expect(entries).toHaveLength(12);
    expect(entries.every((entry) => entry.endsWith(".md"))).toBe(true);
    expect(entries.some((entry) => /\.tmp|reserve/i.test(entry))).toBe(false);
  });

  it.each(["write", "sync", "close"] as const)(
    "rejects and removes temporary output when %s fails before publication",
    async (stage) => {
      const directory = await temporaryDirectory(`wa-export-${stage}-`);
      injectFileSystem({
        open: (path: string, flags: string) => openWithFault(path, flags, stage),
      });

      await expect(writeExport(result(), "json", directory)).rejects.toThrow(`injected ${stage} failure`);
      await expect(readdir(directory)).resolves.toEqual([]);
    },
  );

  it("rejects and removes temporary output when atomic publication fails", async () => {
    const directory = await temporaryDirectory("wa-export-link-");
    injectFileSystem({ link: async () => { throw new Error("injected link failure"); } });

    await expect(writeExport(result(), "json", directory)).rejects.toThrow("injected link failure");
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("returns the published path and warns when initial post-link cleanup fails", async () => {
    const directory = await temporaryDirectory("wa-export-cleanup-");
    const warnings: string[] = [];
    let temporaryRemovalAttempts = 0;
    injectFileSystem({
      rm: async (path: string, options: Parameters<typeof rm>[1]) => {
        if (path.endsWith(".tmp") && ++temporaryRemovalAttempts === 1) {
          throw new Error("injected cleanup failure with secret details");
        }
        return rm(path, options);
      },
      warn: (warning: string) => warnings.push(warning),
    });

    const path = await writeExport(result(), "json", directory);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ chat: result().chat });
    expect(warnings).toEqual(["Export published, but temporary file cleanup required a retry."]);
    expect(temporaryRemovalAttempts).toBe(2);
    expect(await readdir(directory)).toEqual([basename(path)]);
  });

  it("does not reject a published export when every cleanup retry throws synchronously", async () => {
    const directory = await temporaryDirectory("wa-export-cleanup-persistent-");
    const warnings: string[] = [];
    let temporaryRemovalAttempts = 0;
    injectFileSystem({
      rm: (path: string, options: Parameters<typeof rm>[1]) => {
        if (path.endsWith(".tmp")) {
          temporaryRemovalAttempts += 1;
          throw new Error("persistent injected cleanup failure");
        }
        return rm(path, options);
      },
      warn: (warning: string) => warnings.push(warning),
    });

    const path = await writeExport(result(), "json", directory);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ chat: result().chat });
    expect(warnings).toEqual(["Export published, but temporary file cleanup required a retry."]);
    expect(temporaryRemovalAttempts).toBe(2);
  });

  it.each([
    ["blank chat", { chat: "  " }],
    ["invalid extractedAt", { extractedAt: "yesterday" }],
    ["invalid request", { request: { kind: "days", value: 0 } }],
    ["invalid complete", { complete: "yes" }],
    ["invalid warnings", { warnings: "warning" }],
    ["invalid message", { messages: [{ id: "", sender: "David" }] }],
  ])("refuses a runtime document with %s before a final file appears", async (_label, change) => {
    const directory = await temporaryDirectory("wa-export-invalid-");
    const invalid = { ...result(), ...change } as unknown as ExtractionResult;

    await expect(writeExport(invalid, "json", directory)).rejects.toThrow(/invalid extraction document/i);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it.each([
    ["CON. ", /^_CON-/],
    ["AUX", /^_AUX-/],
    ["bad<>:\"/\\|?*\u0001name. ", /^bad----------name-/],
  ])("creates a Windows-safe filename for %j", async (chat, expectedStart) => {
    const directory = await temporaryDirectory("wa-export-name-");
    const path = await writeExport(result({ chat }), "json", directory);
    const name = basename(path);

    expect(name).toMatch(expectedStart);
    expect(name).not.toMatch(/[<>:\"/\\|?*\u0000-\u001f]/);
    expect(name).not.toMatch(/[. ]\.json$/);
  });

  it("caps the normalized chat filename component without changing exported content", async () => {
    const directory = await temporaryDirectory("wa-export-long-");
    const chat = `${"Ａ".repeat(100)} סוף`;
    const input = result({ chat });
    const before = structuredClone(input);
    const path = await writeExport(input, "json", directory);

    expect(basename(path).length).toBeLessThan(150);
    expect(JSON.parse(await readFile(path, "utf8")).chat).toBe(chat);
    expect(input).toEqual(before);
  });

  it("rejects a long implementation-dependent timestamp before constructing a filename", async () => {
    const directory = await temporaryDirectory("wa-export-stamp-");
    const extractedAt = `Tue, 04 Aug 2026 18:30:00 GMT (${"a".repeat(300)})`;
    expect(Number.isFinite(Date.parse(extractedAt))).toBe(true);
    const input = result({ extractedAt });

    await expect(writeExport(input, "json", directory)).rejects.toThrow(/extractedAt/i);
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});
