import type { ElementHandle, Page } from "playwright";

export interface ChatInventory {
  active: string[];
  archived: string[];
}

export interface ChatInventoryOptions {
  settleMs?: number;
  maxCycles?: number;
}

type ScrollState = { top: number; height: number; clientHeight: number };

async function findCurrentChatScroller(page: Page): Promise<ElementHandle<HTMLElement>> {
  for (;;) {
    const candidates = page.locator("body *");
    const selectedIndex = await candidates.evaluateAll((nodes) => {
      let bestIndex = -1;
      let bestRange = -1;
      nodes.forEach((node, index) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.closest("#main") !== null) return;
        if (node.querySelector('[data-testid="cell-frame-title"], span[title]') === null) return;
        const style = getComputedStyle(node);
        if (style.overflowY !== "auto" && style.overflowY !== "scroll") return;
        const range = node.scrollHeight - node.clientHeight;
        if (range <= bestRange) return;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) return;
        const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const y = Math.min(innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height, innerHeight - rect.top) / 2));
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !node.contains(hit)) return;
        bestIndex = index;
        bestRange = range;
      });
      return bestIndex;
    });
    if (selectedIndex < 0) {
      await page.waitForTimeout(250);
      continue;
    }
    const handles = await candidates.elementHandles();
    const selected = handles[selectedIndex];
    await Promise.all(handles.filter((_, index) => index !== selectedIndex).map((handle) => handle.dispose()));
    if (selected !== undefined) return selected as ElementHandle<HTMLElement>;
    await page.waitForTimeout(250);
  }
}

async function titlesIn(scroller: ElementHandle<HTMLElement>): Promise<string[]> {
  return scroller.evaluate((root) => {
    const preferred = root.querySelectorAll(
      '[data-testid="cell-frame-title"][title], [data-testid="cell-frame-title"] span[title]',
    );
    const elements = preferred.length > 0 ? preferred : root.querySelectorAll('span[title]');
    const excluded = new Set(["All", "Unread", "Groups", "Loading…", "Archived"]);
    const titles: string[] = [];
    for (const element of elements) {
      const value = (element.getAttribute("title") ?? "").replace(/[\p{White_Space}]+/gu, " ").trim();
      if (value === "" || excluded.has(value) || titles.includes(value)) continue;
      titles.push(value);
    }
    return titles;
  });
}

async function scrollState(scroller: ElementHandle<HTMLElement>): Promise<ScrollState> {
  return scroller.evaluate((element) => ({
    top: element.scrollTop,
    height: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
}

export async function traverseCurrentChatList(
  page: Page,
  options: ChatInventoryOptions = {},
): Promise<string[]> {
  const settleMs = options.settleMs ?? 350;
  const maxCycles = options.maxCycles ?? 2_000;
  const scroller = await findCurrentChatScroller(page);
  const found: string[] = [];
  const seen = new Set<string>();
  let stableBottomCycles = 0;
  try {
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(settleMs);
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      const beforeSize = seen.size;
      for (const title of await titlesIn(scroller)) {
        if (!seen.has(title)) {
          seen.add(title);
          found.push(title);
        }
      }
      const state = await scrollState(scroller);
      const atBottom = state.top + state.clientHeight >= state.height - 2;
      stableBottomCycles = atBottom && seen.size === beforeSize ? stableBottomCycles + 1 : 0;
      if (stableBottomCycles >= 3) break;
      await scroller.evaluate((element) => {
        element.scrollTop = Math.min(
          element.scrollHeight - element.clientHeight,
          element.scrollTop + Math.max(element.clientHeight * 0.5, 1),
        );
      });
      await page.waitForTimeout(settleMs);
      if (cycle + 1 === maxCycles) throw new Error("WhatsApp chat-list traversal did not reach a stable bottom");
    }
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(settleMs);
    return found;
  } finally {
    await scroller.dispose();
  }
}

async function openArchivedChatList(page: Page, settleMs: number): Promise<boolean> {
  const matches = page.getByText("Archived", { exact: true });
  for (let index = 0; index < await matches.count(); index += 1) {
    const candidate = matches.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    await candidate.click();
    await page.waitForTimeout(settleMs);
    return true;
  }
  return false;
}

export async function inventoryChats(
  page: Page,
  options: ChatInventoryOptions = {},
): Promise<ChatInventory> {
  const active = await traverseCurrentChatList(page, options);
  if (!await openArchivedChatList(page, options.settleMs ?? 350)) {
    return { active, archived: [] };
  }
  const archived = await traverseCurrentChatList(page, options);
  return { active, archived };
}
