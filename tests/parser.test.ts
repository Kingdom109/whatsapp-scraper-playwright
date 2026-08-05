import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fallbackMessageId } from "../src/collector.js";
import {
  parseDisplayedMetadata,
  parseRenderedMessages,
} from "../src/whatsapp/parser.js";

const fixturePath = fileURLToPath(new URL("fixtures/messages.html", import.meta.url));

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ locale: "en-GB" });
  await page.setContent(await readFile(fixturePath, "utf8"));
});

afterAll(async () => {
  await browser.close();
});

describe("parseDisplayedMetadata", () => {
  it("uses the historical local offset for winter and summer message dates", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "Asia/Jerusalem";
    try {
      expect(parseDisplayedMetadata("[9:14, 4/1/2026] Alice:", { dateOrder: "dmy" })).toEqual({
        timestamp: "2026-01-04T09:14:00+02:00",
        sender: "Alice",
        warning: null,
      });
      expect(parseDisplayedMetadata("[9:14, 4/8/2026] Alice:", { dateOrder: "dmy" })).toEqual({
        timestamp: "2026-08-04T09:14:00+03:00",
        sender: "Alice",
        warning: null,
      });
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("maps ambiguous numeric dates using locale order and converts AM/PM", () => {
    expect(parseDisplayedMetadata("[9:14 PM, 4/8/2026] Alice:", { dateOrder: "dmy" }).timestamp)
      .toMatch(/^2026-08-04T21:14:00/);
    expect(parseDisplayedMetadata("[9:14 AM, 4/8/2026] Alice:", { dateOrder: "mdy" }).timestamp)
      .toMatch(/^2026-04-08T09:14:00/);
  });

  it("does not guess an ambiguous date when locale order is unknown", () => {
    const result = parseDisplayedMetadata("[09:14, 4/8/2026] Alice:", { dateOrder: null });
    expect(result.timestamp).toBeNull();
    expect(result.warning).toMatch(/unsupported metadata/i);
  });

  it.each([
    "[09:14, 31/02/2026] Alice:",
    "[09:14, 08/31/2026] Alice:",
    "not WhatsApp metadata",
    "",
  ])("rejects unsupported metadata without guessing: %s", (metadata) => {
    const result = parseDisplayedMetadata(metadata, { dateOrder: "dmy" });
    expect(result.timestamp).toBeNull();
    expect(result.warning).toMatch(/unsupported metadata/i);
  });
});

describe("parseRenderedMessages", () => {
  it("maps the first matching row selector in DOM order without mutating the page", async () => {
    const before = await page.content();
    const messages = await parseRenderedMessages(page, "Synthetic Team");

    expect(await page.content()).toBe(before);
    expect(messages).toHaveLength(23);
    expect(messages.map(({ id }) => id)).not.toContain("must-not-be-selected");

    const incoming = messages[0]!;
    expect(incoming).toMatchObject({
      id: "stable-incoming",
      timestamp: expect.any(String),
      sender: "Alice",
      direction: "incoming",
      text: "Hello from the synthetic fixture",
      media: null,
      kind: "message",
      warnings: [],
    });

    expect(messages[1]).toMatchObject({
      sender: "Me",
      direction: "outgoing",
      text: "שלום לכולם 👋\nשורה שנייה",
    });
    expect(messages[2]).toMatchObject({ text: null, media: { type: "image", caption: "A generated gradient" } });
    expect(messages[3]).toMatchObject({
      text: null,
      media: { type: "document", filename: "sample-notes.pdf", duration: "1 page", size: "24 KB" },
    });
    expect(messages[4]).toMatchObject({ media: { type: "voice-note", duration: "0:08" } });
    expect(messages[5]).toMatchObject({ media: { type: "video", duration: "0:12" } });
    expect(messages[6]).toMatchObject({ media: { type: "gif" } });
    expect(messages[7]).toMatchObject({ media: { type: "sticker" } });
    expect(messages[8]).toMatchObject({ kind: "deleted", text: null, media: null });
    expect(messages[9]).toMatchObject({ kind: "system", direction: "system", sender: "Synthetic Team" });
    expect(messages[10]).toMatchObject({ kind: "call", text: "Missed voice call" });
    expect(messages[11]).toMatchObject({ kind: "unsupported", text: null, media: null });
    expect(messages[11]!.warnings).toEqual([expect.stringMatching(/unsupported message/i)]);

    expect(messages[12]).toMatchObject({
      text: "Fresh response",
      reply: { sender: "Bob", text: "Quoted words" },
      reactions: [
        { emoji: "❤️", count: 4 },
        { emoji: "🔥", count: 5 },
        { emoji: "👍", count: 2 },
      ],
    });
    expect(messages[12]!.text).toBe("Fresh response");

    const quotedImage = messages.find(({ id }) => id === "stable-quoted-image")!;
    expect(quotedImage).toMatchObject({ text: "Reply to an image", media: null, reply: { sender: "Bob" } });
    expect(quotedImage.reply).toEqual({ sender: "Bob" });

    const quotedDocument = messages.find(({ id }) => id === "stable-quoted-document")!;
    expect(quotedDocument).toMatchObject({ text: "Reply to a document", media: null, reply: { sender: "Bob" } });
    expect(quotedDocument.reply).toEqual({ sender: "Bob" });

    for (const [id, text] of [
      ["stable-quoted-call", "Reply to a call"],
      ["stable-quoted-deleted", "Reply to a deleted message"],
      ["stable-quoted-system", "Reply to a system notice"],
    ] as const) {
      expect(messages.find((message) => message.id === id)).toMatchObject({
        kind: "message",
        direction: "incoming",
        text,
        reply: { sender: "Bob" },
      });
    }

    expect(messages.find(({ id }) => id === "stable-direct-no-sender")).toMatchObject({
      sender: "Synthetic Team",
      direction: "incoming",
    });

    const withoutId = messages.find(({ text }) => text === "No stable identifier")!;
    expect(withoutId.id).toBe(fallbackMessageId("Synthetic Team", {
      timestamp: withoutId.timestamp,
      sender: withoutId.sender,
      direction: withoutId.direction,
      text: withoutId.text,
      media: withoutId.media,
      kind: withoutId.kind,
      warnings: withoutId.warnings,
    }));

    for (const id of ["stable-bad-date", "stable-us-date", "stable-no-meta"]) {
      const message = messages.find((candidate) => candidate.id === id)!;
      expect(message.timestamp).toBeNull();
      expect(message.warnings).toEqual([expect.stringMatching(/unsupported metadata/i)]);
    }
  });

  it.each([
    ["en-GB", "[9:14 PM, 4/8/2026] Alice:", /^2026-08-04T21:14:00/],
    ["he-IL", "[21:14, 4/8/2026] Alice:", /^2026-08-04T21:14:00/],
    ["en-US", "[9:14 PM, 4/8/2026] Alice:", /^2026-04-08T21:14:00/],
  ])("uses browser locale date order for %s", async (locale, metadata, expected) => {
    const localePage = await browser.newPage({ locale });
    try {
      await localePage.setContent(`<main id="main"><article class="message-in" data-testid="msg-container" data-id="locale"><span data-testid="msg-meta" data-pre-plain-text="${metadata}"></span><span data-testid="selectable-text">Locale sample</span></article></main>`);
      const [message] = await parseRenderedMessages(localePage, "Direct chat");
      expect(message?.timestamp).toMatch(expected);
    } finally {
      await localePage.close();
    }
  });
});

describe("real tsx runtime", () => {
  it("executes the source parser callback through node --import tsx", async () => {
    const parserUrl = new URL("../src/whatsapp/parser.ts", import.meta.url).href;
    const html = await readFile(fixturePath, "utf8");
    const script = `
      import { chromium } from "playwright";
      import { parseRenderedMessages } from ${JSON.stringify(parserUrl)};
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ locale: "en-GB" });
        await page.setContent(${JSON.stringify(html)});
        const messages = await parseRenderedMessages(page, "Synthetic Team");
        process.stdout.write(String(messages.length));
      } finally {
        await browser.close();
      }
    `;
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", script,
    ], { encoding: "utf8", timeout: 30_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("23");
  });
});
