import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  AmbiguousChatError,
  ChatNotFoundError,
  ensureLoggedIn,
  openExactChat,
  waitForWhatsAppReady,
} from "../src/whatsapp/navigator.js";
import { whatsappSelectors } from "../src/whatsapp/selectors.js";

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
      : ""}<div id="search" role="textbox" contenteditable="true" oninput="document.querySelector('[data-pre-search]')?.remove()"></div><span data-pre-search data-testid="cell-frame-title" title="Before search">Before search</span>`;
  const rows = chats.map(({ title, header = title, titleAttribute = title }, index) =>
    `<button data-row="${index}" data-clicked="0" onclick="this.dataset.clicked='1';const h=document.querySelector('[data-testid=conversation-info-header-chat-title]');if(h){h.setAttribute('title',this.dataset.header);h.textContent=this.dataset.header}" data-header="${header}"><span data-testid="cell-frame-title" title="${titleAttribute}">${title}</span></button>`,
  ).join("");
  const header = options.header === false
    ? ""
    : '<header><span data-testid="conversation-info-header-chat-title" title="">Unopened</span></header>';
  return `<div id="side">${search}${rows}</div><div id="main">${header}</div>`;
}

async function clickCounts(): Promise<string[]> {
  return page.locator("[data-row]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-clicked") ?? ""),
  );
}

function withAdversarialTitleReorder(realPage: Page): Page {
  const wrapTitleLocator = (locator: ReturnType<Page["locator"]>, clickable: boolean): ReturnType<Page["locator"]> =>
    new Proxy(locator, {
      get(target, property) {
        if (property === "nth") {
          return (index: number) => wrapTitleLocator(target.nth(index), true);
        }
        if (property === "click" && clickable) {
          return async (options?: Parameters<typeof target.click>[0]) => {
            await realPage.locator("#results").evaluate((results) => {
              results.prepend(results.lastElementChild!);
            });
            return target.click(options);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return new Proxy(realPage, {
    get(target, property) {
      if (property === "locator") {
        return (selector: string, options?: Parameters<Page["locator"]>[1]) => {
          const locator = target.locator(selector, options);
          return whatsappSelectors.chatTitles.some((candidate) => candidate === selector)
            ? wrapTitleLocator(locator, false)
            : locator;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  page = await browser.newPage();
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
          oninput="document.querySelector('[data-pre-search]').remove();setTimeout(() => document.querySelector('[data-row]').style.display='block', 35)"></div>
        <span data-pre-search data-testid="cell-frame-title" title="Before search">Before search</span>
        <button style="display:none" data-row="0" data-clicked="0"
          onclick="this.dataset.clicked='1';const h=document.querySelector('[data-testid=conversation-info-header-chat-title]');h.setAttribute('title','Team');h.textContent='Team'">
          <span data-testid="cell-frame-title" title="Team">Team</span>
        </button>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title" title="">Unopened</span></header></div>
    `);

    await openExactChat(page, "Team");

    expect(await clickCounts()).toEqual(["1"]);
  });

  it("waits beyond the settle window for a result rendered 350ms after fill", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true"
          oninput="setTimeout(() => document.querySelector('[data-row]').style.display='block', 350)"></div>
        <button style="display:none" data-row="0" data-clicked="0"
          onclick="this.dataset.clicked='1';const h=document.querySelector('[data-testid=conversation-info-header-chat-title]');h.title='Team';h.textContent='Team'">
          <span data-testid="cell-frame-title" title="Team">Team</span>
        </button>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title">Unopened</span></header></div>
    `);

    await openExactChat(page, "Team");

    expect(await clickCounts()).toEqual(["1"]);
  });

  it("does not settle on stale pre-fill partial results", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true"
          oninput="setTimeout(() => {document.querySelector('[data-row=partial]').style.display='none';document.querySelector('[data-row=exact]').style.display='block'}, 350)"></div>
        <button data-row="partial" data-clicked="0" onclick="this.dataset.clicked='1'">
          <span data-testid="cell-frame-title" title="Team Archive">Team Archive</span>
        </button>
        <button style="display:none" data-row="exact" data-clicked="0"
          onclick="this.dataset.clicked='1';const h=document.querySelector('[data-testid=conversation-info-header-chat-title]');h.title='Team';h.textContent='Team'">
          <span data-testid="cell-frame-title" title="Team">Team</span>
        </button>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title">Unopened</span></header></div>
    `);

    await openExactChat(page, "Team");

    expect(await page.locator('[data-row="partial"]').getAttribute("data-clicked")).toBe("0");
    expect(await page.locator('[data-row="exact"]').getAttribute("data-clicked")).toBe("1");
  });

  it("does not treat a stable interim lifecycle result as final zero-exact", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true"
          oninput="document.querySelector('[data-pre-search]').remove();document.querySelector('[data-row=interim]').style.display='block';setTimeout(() => {document.querySelector('[data-row=interim]').style.display='none';document.querySelector('[data-row=exact]').style.display='block'}, 350)"></div>
        <span data-pre-search data-testid="cell-frame-title" title="Before search">Before search</span>
        <button style="display:none" data-row="interim" data-clicked="0" onclick="this.dataset.clicked='1'">
          <span data-testid="cell-frame-title" title="Loading Team Archive">Loading Team Archive</span>
        </button>
        <button style="display:none" data-row="exact" data-clicked="0"
          onclick="this.dataset.clicked='1';const h=document.querySelector('[data-testid=conversation-info-header-chat-title]');h.title='Team';h.textContent='Team'">
          <span data-testid="cell-frame-title" title="Team">Team</span>
        </button>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title">Unopened</span></header></div>
    `);

    await openExactChat(page, "Team");

    expect(await page.locator('[data-row="interim"]').getAttribute("data-clicked")).toBe("0");
    expect(await page.locator('[data-row="exact"]').getAttribute("data-clicked")).toBe("1");
  });

  it("never clicks an unrelated row while results repeatedly reorder", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true"
          oninput="document.querySelector('[data-pre-search]').remove()"></div>
        <span data-pre-search data-testid="cell-frame-title" title="Before search">Before search</span>
        <div id="results">
          <button data-row="exact" data-clicked="0"
            onclick="this.dataset.clicked='1';const h=document.querySelector('[data-testid=conversation-info-header-chat-title]');h.title='Team';h.textContent='Team'">
            <span data-testid="cell-frame-title" title="Team">Team</span>
          </button>
          <button data-row="unrelated" data-clicked="0" onclick="this.dataset.clicked='1'">
            <span data-testid="cell-frame-title" title="Other">Other</span>
          </button>
        </div>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title">Unopened</span></header></div>
    `);

    await openExactChat(withAdversarialTitleReorder(page), "Team");

    expect(await page.locator('[data-row="exact"]').getAttribute("data-clicked")).toBe("1");
    expect(await page.locator('[data-row="unrelated"]').getAttribute("data-clicked")).toBe("0");
  });

  it("fails within the search budget when a title disappears", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true"
          oninput="setTimeout(() => document.querySelector('[data-row]').remove(), 50)"></div>
        <button data-row="0" data-clicked="0"><span data-testid="cell-frame-title" title="Team">Team</span></button>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title">Unopened</span></header></div>
    `);
    const started = Date.now();

    await expect(openExactChat(page, "Team")).rejects.toBeInstanceOf(ChatNotFoundError);

    expect(Date.now() - started).toBeLessThan(2_800);
    expect(await page.locator('[data-row][data-clicked="1"]').count()).toBe(0);
  });

  it("fails within the header budget when the header disappears after click", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true" oninput="document.querySelector('[data-pre-search]').remove()"></div>
        <span data-pre-search data-testid="cell-frame-title" title="Before search">Before search</span>
        <button data-row="0" data-clicked="0"
          onclick="this.dataset.clicked='1';document.querySelector('#main header').remove()">
          <span data-testid="cell-frame-title" title="Team">Team</span>
        </button>
      </div>
      <div id="main"><header><span data-testid="conversation-info-header-chat-title">Unopened</span></header></div>
    `);
    const started = Date.now();

    await expect(openExactChat(page, "Team")).rejects.toThrow("header could not be verified");

    expect(Date.now() - started).toBeLessThan(1_800);
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

  it("ignores hidden duplicate and partial chat titles", async () => {
    await page.setContent(navigationHtml([
      { title: "Team" },
      { title: "Team" },
      { title: "Team Archive" },
    ]));
    await page.locator('[data-row="1"], [data-row="2"]').evaluateAll((rows) => {
      for (const row of rows) (row as HTMLElement).style.display = "none";
    });

    await openExactChat(page, "Team");

    expect(await clickCounts()).toEqual(["1", "0", "0"]);
  });

  it("verifies the first visible header instead of a hidden attached match", async () => {
    await page.setContent(`
      <div id="side">
        <div id="search" role="textbox" contenteditable="true" oninput="document.querySelector('[data-pre-search]').remove()"></div>
        <span data-pre-search data-testid="cell-frame-title" title="Before search">Before search</span>
        <button data-row="0" data-clicked="0"
          onclick="this.dataset.clicked='1';document.querySelectorAll('[data-testid=conversation-info-header-chat-title]')[1].setAttribute('title','Other')">
          <span data-testid="cell-frame-title" title="Team">Team</span>
        </button>
      </div>
      <div id="main"><header>
        <span style="display:none" data-testid="conversation-info-header-chat-title" title="Team"></span>
        <span data-testid="conversation-info-header-chat-title" title="Other">visible header</span>
      </header></div>
    `);

    await expect(openExactChat(page, "Team")).rejects.toThrow("did not exactly match");

    expect(await clickCounts()).toEqual(["1"]);
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
    await page.setContent('<div id="main">ready</div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("ready");
  });

  it("returns login-required when a QR candidate is visible", async () => {
    await page.setContent('<div id="app"><canvas aria-label="Scan QR code"></canvas></div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("login-required");
  });

  it("prefers ready when ready and QR candidates are both visible", async () => {
    await page.setContent('<div id="main">ready</div><div id="app"><canvas aria-label="QR code"></canvas></div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("ready");
  });

  it("returns login-required when app-ready markup is hidden and QR is visible", async () => {
    await page.setContent('<div id="main" style="display:none">ready</div><div id="app"><canvas aria-label="QR code"></canvas></div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("login-required");
  });

  it("returns ready when app-ready markup is visible and QR is hidden", async () => {
    await page.setContent('<div id="main">ready</div><div id="app"><canvas style="display:none" aria-label="QR code"></canvas></div>');

    await expect(waitForWhatsAppReady(page, 100)).resolves.toBe("ready");
  });

  it("times out when all readiness candidates are hidden", async () => {
    await page.setContent('<div id="main" style="display:none">ready</div><div id="app"><canvas style="display:none" aria-label="QR code"></canvas></div>');

    await expect(waitForWhatsAppReady(page, 40)).rejects.toThrow("WhatsApp readiness");
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
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div id="main">ready</div>'), 35);
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
    await page.setContent('<div id="main">ready</div>');
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await ensureLoggedIn(page, 100);

    expect(stderr).not.toHaveBeenCalled();
  });

  it("does not print a login instruction for a hidden QR candidate", async () => {
    await page.setContent('<div id="app"><canvas style="display:none" aria-label="QR code"></canvas></div>');
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(ensureLoggedIn(page, 40)).rejects.toThrow("WhatsApp readiness");

    expect(stderr).not.toHaveBeenCalled();
  });
});
