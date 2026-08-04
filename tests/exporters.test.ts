import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
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
        "**09:14 - David:** שלום 👋\n" +
        "Are we meeting?\n" +
        "[video - מפגש.mp4 - הערב - 00:12 - 2 MB]\n",
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
    expect(markdown).toContain("**??:?? - David:** [call]");
    expect(markdown).toContain("**??:?? - שרה:** RTL נשמר\n[sticker]");
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
});

describe("writeExport", () => {
  it("writes pretty JSON that parses to exactly the source document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wa-export-"));
    const input = result();
    const path = await writeExport(input, "json", directory);
    const body = await readFile(path, "utf8");

    expect(JSON.parse(body)).toEqual(input);
    expect(body).toBe(`${JSON.stringify(input, null, 2)}\n`);
  });

  it("never overwrites repeated or concurrent exports and leaves no temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wa-export-race-"));
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

  it.each([
    ["blank chat", { chat: "  " }],
    ["invalid extractedAt", { extractedAt: "yesterday" }],
    ["invalid request", { request: { kind: "days", value: 0 } }],
    ["invalid complete", { complete: "yes" }],
    ["invalid warnings", { warnings: "warning" }],
    ["invalid message", { messages: [{ id: "", sender: "David" }] }],
  ])("refuses a runtime document with %s before a final file appears", async (_label, change) => {
    const directory = await mkdtemp(join(tmpdir(), "wa-export-invalid-"));
    const invalid = { ...result(), ...change } as unknown as ExtractionResult;

    await expect(writeExport(invalid, "json", directory)).rejects.toThrow(/invalid extraction document/i);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it.each([
    ["CON. ", /^_CON-/],
    ["AUX", /^_AUX-/],
    ["bad<>:\"/\\|?*\u0001name. ", /^bad----------name-/],
  ])("creates a Windows-safe filename for %j", async (chat, expectedStart) => {
    const directory = await mkdtemp(join(tmpdir(), "wa-export-name-"));
    const path = await writeExport(result({ chat }), "json", directory);
    const name = basename(path);

    expect(name).toMatch(expectedStart);
    expect(name).not.toMatch(/[<>:\"/\\|?*\u0000-\u001f]/);
    expect(name).not.toMatch(/[. ]\.json$/);
  });

  it("caps the normalized chat filename component without changing exported content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wa-export-long-"));
    const chat = `${"Ａ".repeat(100)} סוף`;
    const input = result({ chat });
    const before = structuredClone(input);
    const path = await writeExport(input, "json", directory);

    expect(basename(path).length).toBeLessThan(150);
    expect(JSON.parse(await readFile(path, "utf8")).chat).toBe(chat);
    expect(input).toEqual(before);
  });

  it("uses a bounded canonical timestamp in the filename without changing extractedAt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wa-export-stamp-"));
    const extractedAt = `Tue, 04 Aug 2026 18:30:00 GMT (${"a".repeat(300)})`;
    expect(Number.isFinite(Date.parse(extractedAt))).toBe(true);
    const input = result({ extractedAt });

    const path = await writeExport(input, "json", directory);

    expect(basename(path).length).toBeLessThan(150);
    expect(JSON.parse(await readFile(path, "utf8")).extractedAt).toBe(extractedAt);
  });
});
