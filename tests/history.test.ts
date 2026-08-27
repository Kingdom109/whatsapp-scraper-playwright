import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MessageRecord, ScrapeLimit } from "../src/domain.js";
import {
  createPlaywrightHistoryAdapter,
  loadHistory,
  type HistoryAdapter,
  type ScrollResult,
} from "../src/whatsapp/history.js";

const NOW = new Date("2026-08-04T12:00:00+03:00");

function message(id: string, timestamp: string | null, text = id): MessageRecord {
  return {
    id,
    timestamp,
    sender: "A",
    direction: "incoming",
    text,
    media: null,
    kind: "message",
    warnings: [],
  };
}

function adapter(
  windows: MessageRecord[][],
  scrolls: ScrollResult[],
  limit: ScrapeLimit,
  overrides: Partial<HistoryAdapter> = {},
): HistoryAdapter {
  let index = 0;
  let scrollIndex = 0;
  return {
    limit,
    now: NOW,
    maxCycles: 10,
    stallCycles: 2,
    parseWindow: async () => windows[index] ?? windows.at(-1) ?? [],
    scrollOlder: async () => {
      const result = scrolls[scrollIndex++] ?? "stalled";
      if (result === "moved") index = Math.min(index + 1, windows.length - 1);
      return result;
    },
    ...overrides,
  };
}

describe("loadHistory", () => {
  it("merges overlapping windows latest-wins and returns chronological count", async () => {
    const result = await loadHistory(adapter([
      [message("c", "2026-08-04T03:00:00+03:00"), message("d", "2026-08-04T04:00:00+03:00")],
      [message("b", "2026-08-04T02:00:00+03:00"), message("c", "2026-08-04T03:00:00+03:00", "updated")],
      [message("a", "2026-08-04T01:00:00+03:00"), message("b", "2026-08-04T02:00:00+03:00")],
    ], ["moved", "moved"], { kind: "messages", value: 4 }));

    expect(result).toMatchObject({ complete: true, warnings: [] });
    expect(result.messages.map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
    expect(result.messages.find(({ id }) => id === "c")?.text).toBe("updated");
  });

  it("stops at the count boundary before scrolling", async () => {
    let scrollCalls = 0;
    const result = await loadHistory(adapter([
      [message("a", "2026-08-04T01:00:00+03:00"), message("b", "2026-08-04T02:00:00+03:00")],
    ], [], { kind: "messages", value: 2 }, {
      scrollOlder: async () => { scrollCalls += 1; return "stalled"; },
    }));

    expect(result.complete).toBe(true);
    expect(scrollCalls).toBe(0);
  });

  it("completes a day request after observing an older-than-cutoff record", async () => {
    const result = await loadHistory(adapter([
      [message("today", "2026-08-04T10:00:00+03:00")],
      [message("old", "2026-08-02T23:59:59+03:00"), message("today", "2026-08-04T10:00:00+03:00")],
    ], ["moved"], { kind: "days", value: 1 }));

    expect(result.complete).toBe(true);
    expect(result.messages.map(({ id }) => id)).toEqual(["today"]);
  });

  it("completes a day request at true start when the chat began within the requested days", async () => {
    const result = await loadHistory(adapter([
      [message("only", "2026-08-04T10:00:00+03:00")],
    ], ["start"], { kind: "days", value: 3 }));

    expect(result).toMatchObject({ complete: true, warnings: [] });
    expect(result.messages.map(({ id }) => id)).toEqual(["only"]);
  });

  it("reports the available count when true start is short of a count request", async () => {
    const result = await loadHistory(adapter([
      [message("a", "2026-08-04T10:00:00+03:00"), message("b", "2026-08-04T11:00:00+03:00")],
    ], ["start"], { kind: "messages", value: 5 }));

    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/only 2 available/i);
  });

  it("returns partial after the configured number of repeated stalls", async () => {
    const result = await loadHistory(adapter([
      [message("a", "2026-08-04T10:00:00+03:00")],
    ], ["stalled", "stalled"], { kind: "messages", value: 5 }));

    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/stopped loading older messages/i);
  });

  it("treats repeated viewport movement without new IDs as stalled progress", async () => {
    let parseCalls = 0;
    const result = await loadHistory(adapter([
      [message("same", "2026-08-04T10:00:00+03:00")],
    ], [], { kind: "messages", value: 5 }, {
      maxCycles: 10,
      stallCycles: 2,
      parseWindow: async () => {
        parseCalls += 1;
        return [message("same", "2026-08-04T10:00:00+03:00")];
      },
      scrollOlder: async () => "moved",
    }));

    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/stopped loading older messages/i);
    expect(parseCalls).toBe(3);
  });

  it("returns partial at max cycles without an extra scroll", async () => {
    let scrollCalls = 0;
    const result = await loadHistory(adapter([
      [message("a", "2026-08-04T10:00:00+03:00")],
    ], [], { kind: "messages", value: 5 }, {
      maxCycles: 2,
      stallCycles: 3,
      scrollOlder: async () => { scrollCalls += 1; return "moved"; },
    }));

    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/maximum history-loading cycles/i);
    expect(scrollCalls).toBe(1);
  });

  it.each([
    ["parse", "Failed to parse rendered WhatsApp history."],
    ["scroll", "Failed to scroll WhatsApp history."],
  ] as const)("sanitizes every inspectable representation of a zero-record %s error", async (stage, publicMessage) => {
    const original = new Error("private message body must not leak");
    const failing = adapter([[]], [], { kind: "messages", value: 2 }, stage === "parse"
      ? { parseWindow: async () => { throw original; } }
      : { scrollOlder: async () => { throw original; } });

    const thrown = await loadHistory(failing).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(publicMessage);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    const rendered = [
      String(thrown),
      (thrown as Error).stack ?? "",
      inspect(thrown, { depth: null, showHidden: true }),
      JSON.stringify(thrown),
    ].join("\n");
    expect(rendered).not.toContain(original.message);
  });

  it.each(["parse", "scroll"] as const)("returns verified records with a non-sensitive warning after a %s error", async (stage) => {
    let parseCalls = 0;
    const original = new Error("private message body must not leak");
    const failing = adapter([[message("a", "2026-08-04T10:00:00+03:00")]], ["moved"], { kind: "messages", value: 2 }, stage === "parse"
      ? { parseWindow: async () => { if (parseCalls++ > 0) throw original; return [message("a", "2026-08-04T10:00:00+03:00")]; } }
      : { scrollOlder: async () => { throw original; } });

    const result = await loadHistory(failing);

    expect(result.complete).toBe(false);
    expect(result.messages.map(({ id }) => id)).toEqual(["a"]);
    expect(result.warnings.join(" ")).toContain(stage === "parse" ? "parsing" : "scrolling");
    expect(result.warnings.join(" ")).not.toContain(original.message);
  });

  it("propagates collection warnings for malformed timestamps", async () => {
    const result = await loadHistory(adapter([
      [message("bad", "not a timestamp"), message("good", "2026-08-04T10:00:00+03:00")],
    ], ["start"], { kind: "days", value: 1 }));

    expect(result.complete).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/invalid timestamps/i);
  });

  it("consolidates same-window fallback-ID ambiguity without retaining duplicate windows", async () => {
    const fallbackId = "0123456789abcdef01234567";
    let parseCalls = 0;
    const result = await loadHistory(adapter([], [], { kind: "messages", value: 3 }, {
      maxCycles: 3,
      stallCycles: 4,
      parseWindow: async () => {
        parseCalls += 1;
        return [
          message(fallbackId, "2026-08-04T10:00:00+03:00", `first-${parseCalls}`),
          message(fallbackId, "2026-08-04T10:00:00+03:00", `second-${parseCalls}`),
        ];
      },
      scrollOlder: async () => "moved",
    }));

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("second-3");
    expect(result.warnings.filter((warning) => warning.includes("ambiguous fallback"))).toEqual([
      "Detected 3 ambiguous fallback message ID collision(s) within a single window.",
    ]);
  });

  it("finalizes high-overlap history with work proportional to unique IDs", async () => {
    let idReads = 0;
    const unique = Array.from({ length: 100 }, (_, index) => {
      const record = message(`id-${index}`, "2026-08-04T10:00:00+03:00");
      Object.defineProperty(record, "id", {
        configurable: true,
        enumerable: true,
        get: () => { idReads += 1; return `id-${index}`; },
      });
      return record;
    });

    const result = await loadHistory(adapter([], [], { kind: "messages", value: 101 }, {
      maxCycles: 500,
      stallCycles: 501,
      parseWindow: async () => unique,
      scrollOlder: async () => "moved",
    }));

    expect(result.messages).toHaveLength(100);
    expect(result.warnings.join(" ")).toMatch(/maximum history-loading cycles/i);
    expect(idReads).toBeLessThan(110_000);
  });

  it.each([
    ["maxCycles", 0], ["maxCycles", 1.5], ["stallCycles", -1], ["stallCycles", Number.NaN],
  ] as const)("rejects invalid %s setting %s", async (setting, value) => {
    const input = adapter([[]], [], { kind: "messages", value: 1 }, { [setting]: value });
    await expect(loadHistory(input)).rejects.toThrow(`${setting} must be a positive integer`);
  });

  it("does not mutate adapter windows or now", async () => {
    const record = message("a", "2026-08-04T10:00:00+03:00");
    const window = [record];
    const now = new Date(NOW);
    const input = adapter([window], ["start"], { kind: "days", value: 1 }, { now });
    const before = JSON.stringify({ window, now });

    await loadHistory(input);

    expect(JSON.stringify({ window, now })).toBe(before);
  });
});

describe("createPlaywrightHistoryAdapter", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser.close(); });

  async function content(inner: string): Promise<void> {
    page = await browser.newPage();
    await page.setContent(`<main id="main">${inner}</main>`);
  }

  it("detects immediate upward movement without changing content", async () => {
    await content('<div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"><div style="height:2000px"><div data-id="oldest"></div></div></div>');
    const container = page.locator('[data-testid="conversation-panel-messages"]');
    await container.evaluate((element) => { element.scrollTop = 1200; });
    const beforeHtml = await container.innerHTML();

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "messages", value: 2 }, NOW).scrollOlder();

    expect(result).toBe("moved");
    expect(await container.innerHTML()).toBe(beforeHtml);
    await page.close();
  });

  it("polls for delayed loading and detects an oldest identifier change", async () => {
    await content('<div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"><div data-testid="msg-container" data-id="new"></div></div>');
    await page.evaluate(() => { setTimeout(() => document.querySelector("[data-id]")?.setAttribute("data-id", "old"), 150); });

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "messages", value: 2 }, NOW).scrollOlder();

    expect(result).toBe("moved");
    await page.close();
  });

  it("does not infer start from a quiet top without an affirmative marker", async () => {
    await content('<div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"><div style="height:800px"><div data-id="oldest"></div></div></div>');

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "days", value: 1 }, NOW).scrollOlder();

    expect(result).toBe("stalled");
    await page.close();
  });

  it("does not infer start from an initially empty top while loading continues after the poll", async () => {
    await content('<div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"></div>');
    await page.evaluate(() => {
      setTimeout(() => {
        const late = document.createElement("div");
        late.setAttribute("data-id", "late");
        document.querySelector('[data-testid="conversation-panel-messages"]')?.append(late);
      }, 2_500);
    });

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "days", value: 1 }, NOW).scrollOlder();

    expect(result).toBe("stalled");
    await page.waitForTimeout(600);
    expect(await page.locator("[data-id=late]").count()).toBe(1);
    await page.close();
  });

  it("returns start only for a visible affirmative centralized marker", async () => {
    await content(`
      <div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"></div>
      <div data-testid="history-start">Beginning of chat history</div>
    `);

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "days", value: 1 }, NOW).scrollOlder();

    expect(result).toBe("start");
    await page.close();
  });

  it("distinguishes a non-top stall from start and stays bounded under a long default timeout", async () => {
    await content('<div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"><div style="height:2000px"><div data-id="oldest"></div></div></div>');
    await page.locator('[data-testid="conversation-panel-messages"]').evaluate((element) => {
      element.scrollTop = 1000;
      Object.defineProperty(element, "scrollBy", { value: () => undefined });
    });
    page.setDefaultTimeout(30_000);
    const started = performance.now();

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "messages", value: 2 }, NOW).scrollOlder();

    expect(result).toBe("stalled");
    expect(performance.now() - started).toBeLessThan(4_000);
    await page.close();
  });

  it("skips hidden candidates and survives selector detachment by using a visible fallback", async () => {
    await content(`
      <div data-testid="conversation-panel-messages" style="display:none"></div>
      <div class="copyable-area"><div tabindex="-1" style="height:200px;overflow:auto"><div style="height:2000px"><div data-id="oldest"></div></div></div></div>
    `);
    const fallback = page.locator('#main .copyable-area [tabindex="-1"]');
    await fallback.evaluate((element) => { element.scrollTop = 1200; });
    await page.evaluate(() => {
      const original = document.querySelector('#main .copyable-area [tabindex="-1"]');
      original?.addEventListener("scroll", () => {
        const replacement = original.cloneNode(true) as HTMLElement;
        replacement.querySelector("[data-id]")?.setAttribute("data-id", "replacement-oldest");
        original.replaceWith(replacement);
        replacement.scrollTop = 600;
      }, { once: true });
    });

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "messages", value: 2 }, NOW).scrollOlder();

    expect(result).toBe("moved");
    await page.close();
  });

  it("uses a non-text fallback marker and emits no console output", async () => {
    await content('<div data-testid="conversation-panel-messages" style="height:200px;overflow:auto"><div class="legacy-message"><span>private body</span></div></div>');
    const logs: string[] = [];
    page.on("console", (entry) => logs.push(entry.text()));
    await page.evaluate(() => {
      const container = document.querySelector('[data-testid="conversation-panel-messages"]');
      container?.addEventListener("scroll", () => {
        document.querySelector(".legacy-message")?.setAttribute("data-history-marker", "changed");
      }, { once: true });
      Object.defineProperty(container, "scrollBy", {
        value: () => container.dispatchEvent(new Event("scroll")),
      });
    });

    const result = await createPlaywrightHistoryAdapter(page, "Chat", { kind: "messages", value: 2 }, NOW).scrollOlder();

    expect(result).toBe("moved");
    expect(logs).toEqual([]);
    await page.close();
  });
});

describe("real tsx runtime", () => {
  it("executes source scroll callbacks through node --import tsx", () => {
    const historyUrl = new URL("../src/whatsapp/history.ts", import.meta.url).href;
    const script = `
      import { chromium } from "playwright";
      import { createPlaywrightHistoryAdapter } from ${JSON.stringify(historyUrl)};
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent('<main id="main"><div data-testid="conversation-panel-messages" style="height:100px;overflow:auto"><div style="height:1000px"><div data-testid="msg-container" data-id="a"></div></div></div></main>');
        await page.locator('[data-testid="conversation-panel-messages"]').evaluate((element) => { element.scrollTop = 800; });
        const adapter = createPlaywrightHistoryAdapter(page, "Chat", { kind: "messages", value: 2 }, new Date());
        process.stdout.write(await adapter.scrollOlder());
      } finally {
        await browser.close();
      }
    `;
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", script,
    ], { encoding: "utf8", timeout: 30_000 });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("moved");
  });
});
