import type { Locator, Page } from "playwright";
import { boundaryReached, collectMessages } from "../collector.js";
import type { MessageRecord, ScrapeLimit } from "../domain.js";
import { assertExactChatHeader } from "./navigator.js";
import { parseRenderedMessages } from "./parser.js";
import { whatsappSelectors } from "./selectors.js";

export type ScrollResult = "moved" | "stalled" | "start";

export interface HistoryAdapter {
  limit: ScrapeLimit;
  now: Date;
  maxCycles: number;
  stallCycles: number;
  verifySelectedChat(): Promise<void>;
  parseWindow(): Promise<MessageRecord[]>;
  scrollOlder(): Promise<ScrollResult>;
}

export interface HistoryResult {
  messages: MessageRecord[];
  complete: boolean;
  warnings: string[];
}

function requirePositiveInteger(value: number, label: "maxCycles" | "stallCycles"): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function finish(
  latestById: ReadonlyMap<string, MessageRecord>,
  fallbackCollisions: number,
  adapter: HistoryAdapter,
  complete: boolean,
  warning?: string,
): HistoryResult {
  const collected = collectMessages([[...latestById.values()]], adapter.limit, adapter.now);
  const fallbackWarning = fallbackCollisions === 0
    ? []
    : [`Detected ${fallbackCollisions} ambiguous fallback message ID collision(s) within a single window.`];
  return {
    messages: collected.messages,
    complete,
    warnings: [
      ...collected.warnings,
      ...fallbackWarning,
      ...(warning === undefined ? [] : [warning]),
    ],
  };
}

const stoppedWarning = "WhatsApp stopped loading older messages before the requested boundary.";
const selectedChatWarning = "Selected WhatsApp chat could not be verified during history loading.";

function sanitizedStageError(stage: "parsing" | "scrolling"): Error {
  const message = stage === "parsing"
    ? "Failed to parse rendered WhatsApp history."
    : "Failed to scroll WhatsApp history.";
  return new Error(message);
}

function sanitizedSelectedChatError(): Error {
  return new Error(selectedChatWarning);
}

export async function loadHistory(adapter: HistoryAdapter): Promise<HistoryResult> {
  requirePositiveInteger(adapter.maxCycles, "maxCycles");
  requirePositiveInteger(adapter.stallCycles, "stallCycles");

  const latestById = new Map<string, MessageRecord>();
  let fallbackCollisions = 0;
  let noProgressCycles = 0;
  let stalledScrolls = 0;
  let hasScrolled = false;
  let finalViewportAtHistoryStart = false;

  for (
    let cycle = 0;
    cycle < adapter.maxCycles || finalViewportAtHistoryStart;
    cycle += 1
  ) {
    try {
      await adapter.verifySelectedChat();
    } catch {
      throw sanitizedSelectedChatError();
    }

    let window: MessageRecord[];
    try {
      window = await adapter.parseWindow();
    } catch {
      if (latestById.size === 0) throw sanitizedStageError("parsing");
      return finish(
        latestById,
        fallbackCollisions,
        adapter,
        false,
        "History loading stopped during message parsing; returning verified records collected so far.",
      );
    }

    const fallbackIdsInWindow = new Set<string>();
    let newIds = 0;
    for (const record of window) {
      const id = record.id;
      if (/^[0-9a-f]{24}$/.test(id)) {
        if (fallbackIdsInWindow.has(id)) fallbackCollisions += 1;
        fallbackIdsInWindow.add(id);
      }
      if (!latestById.has(id)) newIds += 1;
      latestById.set(id, record);
    }

    if (boundaryReached(latestById.values(), adapter.limit, adapter.now)) {
      return finish(latestById, fallbackCollisions, adapter, true);
    }

    if (finalViewportAtHistoryStart) {
      if (adapter.limit.kind === "days") {
        return finish(latestById, fallbackCollisions, adapter, true);
      }
      return finish(
        latestById,
        fallbackCollisions,
        adapter,
        false,
        `Requested ${adapter.limit.value} messages, but only ${latestById.size} available in this chat.`,
      );
    }

    if (newIds > 0) {
      noProgressCycles = 0;
      stalledScrolls = 0;
    } else if (hasScrolled) {
      noProgressCycles += 1;
      if (noProgressCycles >= adapter.stallCycles) {
        return finish(latestById, fallbackCollisions, adapter, false, stoppedWarning);
      }
    }

    let scrollResult: ScrollResult;
    try {
      scrollResult = await adapter.scrollOlder();
    } catch {
      if (latestById.size === 0) throw sanitizedStageError("scrolling");
      return finish(
        latestById,
        fallbackCollisions,
        adapter,
        false,
        "History loading stopped during scrolling; returning verified records collected so far.",
      );
    }

    if (scrollResult === "start") {
      finalViewportAtHistoryStart = true;
      hasScrolled = true;
      continue;
    }

    if (scrollResult === "stalled") {
      stalledScrolls += 1;
      if (stalledScrolls >= adapter.stallCycles) {
        return finish(latestById, fallbackCollisions, adapter, false, stoppedWarning);
      }
    }

    if (cycle + 1 >= adapter.maxCycles) {
      return finish(
        latestById,
        fallbackCollisions,
        adapter,
        false,
        "Maximum history-loading cycles reached before the requested boundary.",
      );
    }
    hasScrolled = true;
  }

  throw new Error("unreachable history-loading state");
}

interface ScrollSnapshot {
  top: number;
  height: number;
  clientHeight: number;
  oldest: string;
}

type SnapshotBrowser = (element: Element, rowSelectors: readonly string[]) => ScrollSnapshot;
type ScrollBrowser = (element: Element) => void;

// Static JavaScript prevents tsx/esbuild from adding Node-only helpers such as
// `__name` to callbacks that Playwright serializes into the browser realm.
const snapshotBrowser = new Function("element", "rowSelectors", String.raw`
  const container = element;
  const row = container.querySelector(rowSelectors.join(","));
  const marker = row === null ? "" : [
    row.getAttribute("data-id") ?? "",
    row.getAttribute("data-history-marker") ?? "",
    row.getAttribute("data-pre-plain-text") ?? "",
    row.tagName,
    row.getAttribute("class") ?? "",
    row.childElementCount,
  ].join("|");
  return {
    top: container.scrollTop,
    height: container.scrollHeight,
    clientHeight: container.clientHeight,
    oldest: marker,
  };
`) as SnapshotBrowser;

const scrollBrowser = new Function("element", String.raw`
  element.scrollBy(0, -Math.max(element.clientHeight * 0.8, 500));
`) as ScrollBrowser;

async function firstVisibleContainer(page: Page): Promise<Locator | null> {
  for (const selector of whatsappSelectors.scrollContainer) {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function currentSnapshot(page: Page): Promise<ScrollSnapshot | null> {
  const container = await firstVisibleContainer(page);
  if (container === null) return null;
  return container.evaluate(snapshotBrowser, whatsappSelectors.messageRows, { timeout: 300 })
    .catch(() => null);
}

async function hasVisibleHistoryStart(page: Page): Promise<boolean> {
  for (const selector of whatsappSelectors.historyStart) {
    const candidates = page.locator(selector);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      if (await candidates.nth(index).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

function changed(before: ScrollSnapshot, after: ScrollSnapshot): boolean {
  return before.top !== after.top
    || before.height !== after.height
    || before.clientHeight !== after.clientHeight
    || before.oldest !== after.oldest;
}

export function createPlaywrightHistoryAdapter(
  page: Page,
  chat: string,
  limit: ScrapeLimit,
  now: Date,
): HistoryAdapter {
  return {
    limit,
    now,
    maxCycles: 500,
    stallCycles: 3,
    verifySelectedChat: () => assertExactChatHeader(page, chat),
    parseWindow: () => parseRenderedMessages(page, chat),
    async scrollOlder(): Promise<ScrollResult> {
      const container = await firstVisibleContainer(page);
      if (container === null) {
        throw new Error("WhatsApp message scroll container was not found");
      }

      if (await hasVisibleHistoryStart(page)) return "start";

      const before = await container.evaluate(snapshotBrowser, whatsappSelectors.messageRows, { timeout: 300 });
      await container.evaluate(scrollBrowser, undefined, { timeout: 300 });

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const after = await currentSnapshot(page);
        if (after !== null) {
          if (changed(before, after)) return "moved";
        }
        if (await hasVisibleHistoryStart(page)) return "start";
        await page.waitForTimeout(100);
      }

      return await hasVisibleHistoryStart(page) ? "start" : "stalled";
    },
  };
}
