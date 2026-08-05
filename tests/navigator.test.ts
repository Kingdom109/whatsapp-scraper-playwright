import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  AmbiguousChatError,
  ChatNotFoundError,
  ensureLoggedIn,
  openExactChat,
  waitForWhatsAppReady,
} from "../src/whatsapp/navigator.js";

let browser: Browser;
let page: Page;

function navigationHtml(
  chats: Array<{ title: string; header?: string; titleAttribute?: string }>,
  options: { header?: boolean; search?: boolean; hiddenPreferredSearch?: boolean } = {},
): string {
  const search = options.search === false
    ? ""
    : `${options.hiddenPreferredSearch
      ? '<div id="hidden-search" data-tab="3" contenteditable="true" style="display:none"></div>'
      : ""}<div id="search" role="textbox" contenteditable="true"></div>`;
  const rows = chats.map(({ title, header = title, titleAttribute = title }, index) =>
    `<button data-row="${index}" data-clicked="0" onclick="this.dataset.clicked='1';const h=document.querySelector('[data-testid=conversation-info-header-chat-title]');if(h)h.setAttribute('title',this.dataset.header)" data-header="${header}"><span data-testid="cell-frame-title" title="${titleAttribute}">${title}</span></button>`,
  ).join("");
  const header = options.header === false
    ? ""
    : '<header><span data-testid="conversation-info-header-chat-title" title=""></span></header>';
  return `<div id="side">${search}${rows}</div><div id="main">${header}</div>`;
}

async function clickCounts(): Promise<string[]> {
  return page.locator("[data-row]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-clicked") ?? ""),
  );
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  page = await browser.newPage();
  page.setDefaultTimeout(250);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await page.close();
});

describe("openExactChat", () => {
  it("opens the one exact result among partial matches", async () => {
    await page.setContent(navigationHtml([
      { title: "Team Archive" },
      { title: "Team" },
      { title: "Team Announcements" },
    ]));

    await openExactChat(page, "Team");

    expect(await page.locator("#search").textContent()).toBe("Team");
    expect(await clickCounts()).toEqual(["0", "1", "0"]);
    expect(await page.locator("#main header span").getAttribute("title")).toBe("Team");
  });

  it("does not click a partial-only result", async () => {
    await page.setContent(navigationHtml([{ title: "Team Archive" }]));

    await expect(openExactChat(page, "Team")).rejects.toBeInstanceOf(ChatNotFoundError);

    expect(await clickCounts()).toEqual(["0"]);
  });

  it("reports a missing chat without clicking any row", async () => {
    await page.setContent(navigationHtml([{ title: "Other" }]));

    await expect(openExactChat(page, "Missing")).rejects.toThrow("Exact WhatsApp chat was not found");

    expect(await clickCounts()).toEqual(["0"]);
  });

  it("rejects duplicate exact matches and exposes only their visible names", async () => {
    await page.setContent(navigationHtml([
      { title: "Team" },
      { title: "Team" },
      { title: "Team Archive" },
    ]));

    const error = await openExactChat(page, "Team").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AmbiguousChatError);
    expect((error as AmbiguousChatError).candidates).toEqual(["Team", "Team"]);
    expect(await clickCounts()).toEqual(["0", "0", "0"]);
  });

  it("rejects a mismatched opened header after clicking only the exact row", async () => {
    await page.setContent(navigationHtml([
      { title: "Team", header: "Other" },
      { title: "Other" },
    ]));

    await expect(openExactChat(page, "Team")).rejects.toThrow("did not exactly match");

    expect(await clickCounts()).toEqual(["1", "0"]);
  });

  it("rejects a missing search control without clicking rows", async () => {
    await page.setContent(navigationHtml([{ title: "Team" }], { search: false }));

    await expect(openExactChat(page, "Team")).rejects.toThrow("WhatsApp chat search control was not found");

    expect(await clickCounts()).toEqual(["0"]);
  });

  it("uses the first visible working search candidate", async () => {
    await page.setContent(navigationHtml([{ title: "Team" }], { hiddenPreferredSearch: true }));

    await openExactChat(page, "Team");

    expect(await page.locator("#hidden-search").textContent()).toBe("");
    expect(await page.locator("#search").textContent()).toBe("Team");
  });

  it("waits for asynchronously rendered search results before matching", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true"
          oninput="setTimeout(() => document.querySelector('[data-row]').style.display='block', 35)"></div>
        <button style="display:none" data-row="0" data-clicked="0"
          onclick="this.dataset.clicked='1';document.querySelector('[data-testid=conversation-info-header-chat-title]').setAttribute('title','Team')">
          <span data-testid="cell-frame-title" title="Team">Team</span>
        </button>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title" title=""></span></header></div>
    `);

    await openExactChat(page, "Team");

    expect(await clickCounts()).toEqual(["1"]);
  });

  it("rejects a missing header after clicking only the exact row", async () => {
    await page.setContent(navigationHtml([
      { title: "Team" },
      { title: "Other" },
    ], { header: false }));

    await expect(openExactChat(page, "Team")).rejects.toThrow("Opened WhatsApp chat header could not be verified");

    expect(await clickCounts()).toEqual(["1", "0"]);
  });

  it("normalizes ASCII and non-breaking whitespace in the request, result, and header", async () => {
    await page.setContent(navigationHtml([
      { title: "Alpha\u00a0  Team", header: " Alpha   Team ", titleAttribute: "" },
    ]));

    await openExactChat(page, "  Alpha\tTeam  ");

    expect(await page.locator("#search").textContent()).toBe("Alpha Team");
    expect(await clickCounts()).toEqual(["1"]);
  });

  it("keeps matching case-sensitive", async () => {
    await page.setContent(navigationHtml([{ title: "team" }]));

    await expect(openExactChat(page, "Team")).rejects.toBeInstanceOf(ChatNotFoundError);

    expect(await clickCounts()).toEqual(["0"]);
  });

  it.each(["", " \t\u00a0 "])("rejects a blank requested name %j before interacting", async (name) => {
    await page.setContent(navigationHtml([{ title: "Team" }]));

    await expect(openExactChat(page, name)).rejects.toThrow("WhatsApp chat name must not be blank");

    expect(await page.locator("#search").textContent()).toBe("");
    expect(await clickCounts()).toEqual(["0"]);
  });
});

describe("waitForWhatsAppReady", () => {
  it("returns ready when an app-ready candidate is visible", async () => {
    await page.setContent('<div id="main"></div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("ready");
  });

  it("returns login-required when a QR candidate is visible", async () => {
    await page.setContent('<div id="app"><canvas aria-label="Scan QR code"></canvas></div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("login-required");
  });

  it("prefers ready when ready and QR candidates are both visible", async () => {
    await page.setContent('<div id="main"></div><div id="app"><canvas aria-label="QR code"></canvas></div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("ready");
  });

  it("times out with a targeted readiness error that does not expose page content", async () => {
    await page.setContent('<p>PRIVATE-SYNTHETIC-CONTENT</p>');

    const error = await waitForWhatsAppReady(page, 40).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("WhatsApp readiness");
    expect((error as Error).message).not.toContain("PRIVATE-SYNTHETIC-CONTENT");
  });
});

describe("ensureLoggedIn", () => {
  it("waits through a remaining QR until the app becomes ready and writes one instruction", async () => {
    await page.setContent('<div id="app"><canvas aria-label="QR code"></canvas></div>');
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await page.evaluate(() => {
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div id="main"></div>'), 35);
    });

    await ensureLoggedIn(page, 150);

    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/scan.*visible.*QR code/i);
  });

  it("times out waiting specifically for login while QR remains and writes once", async () => {
    await page.setContent('<div id="app"><canvas aria-label="QR code"></canvas><p>PRIVATE-LOGIN-CONTENT</p></div>');
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const error = await ensureLoggedIn(page, 50).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("WhatsApp login");
    expect((error as Error).message).not.toContain("PRIVATE-LOGIN-CONTENT");
    expect(stderr).toHaveBeenCalledOnce();
  });

  it("returns immediately when ready without writing a QR instruction", async () => {
    await page.setContent('<div id="main"></div>');
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await ensureLoggedIn(page, 100);

    expect(stderr).not.toHaveBeenCalled();
  });
});
