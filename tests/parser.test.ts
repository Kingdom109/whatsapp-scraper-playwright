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
  page = await browser.newPage();
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
      expect(parseDisplayedMetadata("[9:14, 4/1/2026] Alice:")).toEqual({
        timestamp: "2026-01-04T09:14:00+02:00",
        sender: "Alice",
        warning: null,
      });
      expect(parseDisplayedMetadata("[9:14, 4/8/2026] Alice:")).toEqual({
        timestamp: "2026-08-04T09:14:00+03:00",
        sender: "Alice",
        warning: null,
      });
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it.each([
    "[09:14, 31/02/2026] Alice:",
    "[09:14, 08/31/2026] Alice:",
    "not WhatsApp metadata",
    "",
  ])("rejects unsupported metadata without guessing: %s", (metadata) => {
    const result = parseDisplayedMetadata(metadata);
    expect(result.timestamp).toBeNull();
    expect(result.warning).toMatch(/unsupported metadata/i);
  });
});

describe("parseRenderedMessages", () => {
  it("maps the first matching row selector in DOM order without mutating the page", async () => {
    const before = await page.content();
    const messages = await parseRenderedMessages(page, "Synthetic Team");

    expect(await page.content()).toBe(before);
    expect(messages).toHaveLength(17);
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
    expect(messages[3]).toMatchObject({ media: { type: "document", filename: "sample-notes.pdf", size: "24 KB" } });
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
      reactions: [{ emoji: "👍", count: 2 }],
    });
    expect(messages[12]!.text).not.toMatch(/Quoted words|👍/);

    const withoutId = messages[13]!;
    expect(withoutId.id).toBe(fallbackMessageId("Synthetic Team", {
      timestamp: withoutId.timestamp,
      sender: withoutId.sender,
      direction: withoutId.direction,
      text: withoutId.text,
      media: withoutId.media,
      kind: withoutId.kind,
      warnings: withoutId.warnings,
    }));

    for (const message of messages.slice(14)) {
      expect(message.timestamp).toBeNull();
      expect(message.warnings).toEqual([expect.stringMatching(/unsupported metadata/i)]);
    }
  });
});
