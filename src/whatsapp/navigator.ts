import type { Locator, Page } from "playwright";
import { whatsappSelectors } from "./selectors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 20;
const SEARCH_SETTLE_MS = 200;
const SEARCH_TIMEOUT_MS = 2_000;
const HEADER_TIMEOUT_MS = 1_000;

export class ChatNotFoundError extends Error {
  constructor() {
    super("Exact WhatsApp chat was not found");
    this.name = "ChatNotFoundError";
  }
}

export class AmbiguousChatError extends Error {
  readonly candidates: string[];

  constructor(candidates: string[]) {
    super(`Multiple visible WhatsApp chats exactly match: ${candidates.join(", ")}`);
    this.name = "AmbiguousChatError";
    this.candidates = [...candidates];
  }
}

function normalizeName(value: string): string {
  return value.replace(/[\p{White_Space}]+/gu, " ").trim();
}

async function firstVisibleLocator(
  page: Page,
  candidates: readonly string[],
): Promise<Locator | null> {
  for (const selector of candidates) {
    const matches = page.locator(selector);
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      try {
        if (await match.isVisible()) return match;
      } catch {
        // A re-render can detach a candidate between count() and isVisible().
      }
    }
  }
  return null;
}

async function visibleTitlesForFirstWorkingCandidate(page: Page): Promise<Locator[]> {
  for (const selector of whatsappSelectors.chatTitles) {
    const matches = page.locator(selector);
    const visible: Locator[] = [];
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      try {
        if (await match.isVisible()) visible.push(match);
      } catch {
        // Ignore title nodes replaced while search results are rendering.
      }
    }
    if (visible.length > 0) return visible;
  }
  return [];
}

async function visibleTitle(locator: Locator): Promise<string> {
  const attribute = normalizeName(await locator.getAttribute("title") ?? "");
  if (attribute !== "") return attribute;
  return normalizeName(await locator.innerText());
}

async function waitForSearchResultsToSettle(page: Page): Promise<Locator[]> {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  let lastSignature: string | undefined;
  let unchangedSince = Date.now();
  let titles: Locator[] = [];

  while (Date.now() < deadline) {
    titles = await visibleTitlesForFirstWorkingCandidate(page);
    const signature = JSON.stringify(await Promise.all(titles.map(visibleTitle)));
    if (signature !== lastSignature) {
      lastSignature = signature;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= SEARCH_SETTLE_MS) {
      return titles;
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  return titles;
}

export async function waitForWhatsAppReady(
  page: Page,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<"ready" | "login-required"> {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  do {
    if (await firstVisibleLocator(page, whatsappSelectors.appReady) !== null) return "ready";
    if (await firstVisibleLocator(page, whatsappSelectors.qrCode) !== null) return "login-required";
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);

  throw new Error("WhatsApp readiness was not detected before the timeout");
}

export async function ensureLoggedIn(
  page: Page,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const state = await waitForWhatsAppReady(page, Math.max(0, deadline - Date.now()));
  if (state === "ready") return;

  process.stderr.write("Scan the visible WhatsApp QR code with your phone to continue.\n");
  do {
    if (await firstVisibleLocator(page, whatsappSelectors.appReady) !== null) return;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);

  throw new Error("WhatsApp login did not complete before the timeout");
}

export async function openExactChat(page: Page, requestedName: string): Promise<void> {
  const expected = normalizeName(requestedName);
  if (expected === "") throw new Error("WhatsApp chat name must not be blank");

  const search = await firstVisibleLocator(page, whatsappSelectors.searchBox);
  if (search === null) throw new Error("WhatsApp chat search control was not found");
  await search.fill(expected);

  const titles = await waitForSearchResultsToSettle(page);
  const visibleNames = await Promise.all(titles.map(visibleTitle));
  const exactMatches = titles
    .map((title, index) => ({ title, name: visibleNames[index] ?? "" }))
    .filter(({ name }) => name === expected);

  if (exactMatches.length === 0) throw new ChatNotFoundError();
  if (exactMatches.length > 1) {
    throw new AmbiguousChatError(exactMatches.map(({ name }) => name));
  }

  await exactMatches[0]!.title.click();
  const headerDeadline = Date.now() + HEADER_TIMEOUT_MS;
  let actual = "";
  do {
    const header = await firstVisibleLocator(page, whatsappSelectors.chatHeaderTitle);
    if (header !== null) {
      actual = await visibleTitle(header);
      if (actual === expected) return;
    }
    if (Date.now() >= headerDeadline) break;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  } while (Date.now() <= headerDeadline);

  if (await firstVisibleLocator(page, whatsappSelectors.chatHeaderTitle) === null) {
    throw new Error("Opened WhatsApp chat header could not be verified");
  }
  throw new Error("Opened WhatsApp chat header did not exactly match the requested chat");
}
