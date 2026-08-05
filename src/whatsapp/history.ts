import type { Locator, Page } from "playwright";
import { boundaryReached, collectMessages } from "../collector.js";
import type { MessageRecord, ScrapeLimit } from "../domain.js";
import { parseRenderedMessages } from "./parser.js";
import { whatsappSelectors } from "./selectors.js";

export type ScrollResult = "moved" | "stalled" | "start";

export interface HistoryAdapter {
  limit: ScrapeLimit;
  now: Date;
  maxCycles: number;
  stallCycles: number;
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
  windows: MessageRecord[][],
  adapter: HistoryAdapter,
  complete: boolean,
  warning?: string,
): HistoryResult {
  const collected = collectMessages(windows, adapter.limit, adapter.now);
  return {
    messages: collected.messages,
    complete,
    warnings: warning === undefined
      ? collected.warnings
      : [...collected.warnings, warning],
  };
}

export async function loadHistory(adapter: HistoryAdapter): Promise<HistoryResult> {
  requirePositiveInteger(adapter.maxCycles, "maxCycles");
  requirePositiveInteger(adapter.stallCycles, "stallCycles");

  const windows: MessageRecord[][] = [];
  const seen = new Map<string, MessageRecord>();
  let stalls = 0;

  for (let cycle = 0; cycle < adapter.maxCycles; cycle += 1) {
    let window: MessageRecord[];
    try {
      window = await adapter.parseWindow();
    } catch (error) {
      if (seen.size === 0) throw error;
      return finish(
        windows,
        adapter,
        false,
        "History loading stopped during message parsing; returning verified records collected so far.",
      );
    }

    windows.push(window);
    for (const record of window) seen.set(record.id, record);

    if (boundaryReached(seen.values(), adapter.limit, adapter.now)) {
      return finish(windows, adapter, true);
    }

    if (cycle + 1 >= adapter.maxCycles) {
      return finish(
        windows,
        adapter,
        false,
        "Maximum history-loading cycles reached before the requested boundary.",
      );
    }

    let scrollResult: ScrollResult;
    try {
      scrollResult = await adapter.scrollOlder();
    } catch (error) {
      if (seen.size === 0) throw error;
      return finish(
        windows,
        adapter,
        false,
        "History loading stopped during scrolling; returning verified records collected so far.",
      );
    }

    if (scrollResult === "start") {
      if (adapter.limit.kind === "days") return finish(windows, adapter, true);
      return finish(
        windows,
        adapter,
        false,
        `Requested ${adapter.limit.value} messages, but only ${seen.size} available in this chat.`,
      );
    }

    if (scrollResult === "stalled") {
      stalls += 1;
      if (stalls >= adapter.stallCycles) {
        return finish(
          windows,
          adapter,
          false,
          "WhatsApp stopped loading older messages before the requested boundary.",
        );
      }
    } else {
      stalls = 0;
    }
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
    parseWindow: () => parseRenderedMessages(page, chat),
    async scrollOlder(): Promise<ScrollResult> {
      const container = await firstVisibleContainer(page);
      if (container === null) {
        throw new Error("WhatsApp message scroll container was not found");
      }

      const before = await container.evaluate(snapshotBrowser, whatsappSelectors.messageRows, { timeout: 300 });
      await container.evaluate(scrollBrowser, undefined, { timeout: 300 });

      const deadline = Date.now() + 2_000;
      let stableTopObservations = before.top <= 0 ? 1 : 0;
      while (Date.now() < deadline) {
        const after = await currentSnapshot(page);
        if (after !== null) {
          if (changed(before, after)) return "moved";
          stableTopObservations = after.top <= 0 ? stableTopObservations + 1 : 0;
        }
        await page.waitForTimeout(100);
      }

      return stableTopObservations >= 3 ? "start" : "stalled";
    },
  };
}
