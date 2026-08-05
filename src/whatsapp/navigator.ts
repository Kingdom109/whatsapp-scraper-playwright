import type { ElementHandle, Page } from "playwright";
import { whatsappSelectors } from "./selectors.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 20;
const SEARCH_SETTLE_MS = 200;
const SEARCH_TIMEOUT_MS = 2_000;
const SEARCH_ACTION_RESERVE_MS = 250;
const HEADER_TIMEOUT_MS = 1_000;

interface Deadline {
  readonly expiresAt: number;
}

interface TitleSample {
  readonly handle: ElementHandle<Node>;
  readonly name: string;
}

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

function deadlineAfter(timeoutMs: number): Deadline {
  return { expiresAt: Date.now() + Math.max(0, timeoutMs) };
}

function remainingMs(deadline: Deadline): number {
  return Math.max(0, deadline.expiresAt - Date.now());
}

async function waitForNextPoll(page: Page, deadline: Deadline): Promise<void> {
  const remaining = remainingMs(deadline);
  if (remaining > 0) await page.waitForTimeout(Math.min(POLL_INTERVAL_MS, remaining));
}

async function safelyDispose(handles: readonly ElementHandle[]): Promise<void> {
  await Promise.all(handles.map(async (handle) => {
    try {
      await handle.dispose();
    } catch {
      // The page may have replaced or destroyed the execution context.
    }
  }));
}

async function handleIsVisibleAndConnected(handle: ElementHandle): Promise<boolean> {
  try {
    if (!await handle.isVisible()) return false;
    return await handle.evaluate((element) => element.isConnected);
  } catch {
    return false;
  }
}

async function firstVisibleHandle(
  page: Page,
  candidates: readonly string[],
  deadline: Deadline,
): Promise<ElementHandle<Node> | null> {
  for (const selector of candidates) {
    if (remainingMs(deadline) === 0) return null;
    let handles: ElementHandle<Node>[];
    try {
      handles = await page.locator(selector).elementHandles();
    } catch (error) {
      if (page.isClosed()) throw error;
      continue;
    }
    for (const handle of handles) {
      if (remainingMs(deadline) === 0) {
        await safelyDispose(handles);
        return null;
      }
      if (await handleIsVisibleAndConnected(handle)) {
        await safelyDispose(handles.filter((candidate) => candidate !== handle));
        return handle;
      }
    }
    await safelyDispose(handles);
  }
  return null;
}

async function readPinnedTitle(
  handle: ElementHandle<Node>,
): Promise<string | null> {
  try {
    const attribute = normalizeName(await handle.getAttribute("title") ?? "");
    const name = attribute !== "" ? attribute : normalizeName(await handle.textContent() ?? "");
    if (!await handleIsVisibleAndConnected(handle)) return null;
    return name;
  } catch {
    return null;
  }
}

async function sampleVisibleTitles(
  page: Page,
  deadline: Deadline,
): Promise<TitleSample[]> {
  for (const selector of whatsappSelectors.chatTitles) {
    if (remainingMs(deadline) === 0) return [];
    let handles: ElementHandle<Node>[];
    try {
      handles = await page.locator(selector).elementHandles();
    } catch (error) {
      if (page.isClosed()) throw error;
      continue;
    }
    const samples: TitleSample[] = [];
    for (const handle of handles) {
      if (remainingMs(deadline) === 0) break;
      const name = await readPinnedTitle(handle);
      if (name !== null) samples.push({ handle, name });
    }
    await safelyDispose(handles.filter((handle) =>
      !samples.some((sample) => sample.handle === handle),
    ));
    if (samples.length > 0) return samples;
  }
  return [];
}

function titleSignature(samples: readonly TitleSample[]): string {
  return JSON.stringify(samples.map(({ name }) => name));
}

async function disposeSamples(samples: readonly TitleSample[]): Promise<void> {
  await safelyDispose(samples.map(({ handle }) => handle));
}

async function tryClickPinnedExact(
  page: Page,
  sample: TitleSample,
  expected: string,
  deadline: Deadline,
): Promise<boolean> {
  const name = await readPinnedTitle(sample.handle);
  if (name !== expected || remainingMs(deadline) === 0) return false;
  try {
    await sample.handle.click({ timeout: remainingMs(deadline) });
    return true;
  } catch (error) {
    if (page.isClosed()) throw error;
    return false;
  }
}

async function searchAndClickExact(
  page: Page,
  expected: string,
  deadline: Deadline,
): Promise<void> {
  const beforeFill = await sampleVisibleTitles(page, deadline);
  const beforeSignature = titleSignature(beforeFill);
  await disposeSamples(beforeFill);

  const search = await firstVisibleHandle(page, whatsappSelectors.searchBox, deadline);
  if (search === null) throw new Error("WhatsApp chat search control was not found");
  try {
    await search.fill(expected, { timeout: remainingMs(deadline) });
  } catch (error) {
    if (page.isClosed()) throw error;
    throw new Error("WhatsApp chat search could not be filled before the timeout");
  } finally {
    await safelyDispose([search]);
  }

  let lastSignature: string | undefined;
  let unchangedSince = Date.now();
  let lifecycleObserved = false;
  let lastExactNames: string[] = [];
  let lastExactWasStable = false;

  while (remainingMs(deadline) > 0) {
    const samples = await sampleVisibleTitles(page, deadline);
    const signature = titleSignature(samples);
    if (signature !== beforeSignature) lifecycleObserved = true;
    if (signature !== lastSignature) {
      lastSignature = signature;
      unchangedSince = Date.now();
    }
    const stable = Date.now() - unchangedSince >= SEARCH_SETTLE_MS;
    const exact = samples.filter(({ name }) => name === expected);
    lastExactNames = exact.map(({ name }) => name);
    lastExactWasStable = stable;

    const exactIsActionable = stable && exact.length > 0 && (
      lifecycleObserved || remainingMs(deadline) <= SEARCH_ACTION_RESERVE_MS
    );
    if (exactIsActionable) {
      if (exact.length > 1) {
        const candidates = exact.map(({ name }) => name);
        await disposeSamples(samples);
        throw new AmbiguousChatError(candidates);
      }
      if (exact.length === 1) {
        const clicked = await tryClickPinnedExact(page, exact[0]!, expected, deadline);
        await disposeSamples(samples);
        if (clicked) return;
        lastSignature = undefined;
        continue;
      }
    }

    await disposeSamples(samples);
    await waitForNextPoll(page, deadline);
  }

  if (lastExactNames.length === 0) throw new ChatNotFoundError();
  if (lastExactNames.length > 1 && lastExactWasStable) {
    throw new AmbiguousChatError(lastExactNames);
  }
  throw new Error("Exact WhatsApp chat could not be safely opened before the search timeout");
}

async function verifyExactHeader(page: Page, expected: string): Promise<void> {
  const deadline = deadlineAfter(HEADER_TIMEOUT_MS);
  let sawVisibleHeader = false;
  while (remainingMs(deadline) > 0) {
    const header = await firstVisibleHandle(page, whatsappSelectors.chatHeaderTitle, deadline);
    if (header !== null) {
      sawVisibleHeader = true;
      const actual = await readPinnedTitle(header);
      await safelyDispose([header]);
      if (actual === expected) return;
    }
    await waitForNextPoll(page, deadline);
  }
  if (!sawVisibleHeader) {
    throw new Error("Opened WhatsApp chat header could not be verified");
  }
  throw new Error("Opened WhatsApp chat header did not exactly match the requested chat");
}

export async function waitForWhatsAppReady(
  page: Page,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<"ready" | "login-required"> {
  const deadline = deadlineAfter(timeoutMs);
  do {
    const ready = await firstVisibleHandle(page, whatsappSelectors.appReady, deadline);
    if (ready !== null) {
      await safelyDispose([ready]);
      return "ready";
    }
    const qr = await firstVisibleHandle(page, whatsappSelectors.qrCode, deadline);
    if (qr !== null) {
      await safelyDispose([qr]);
      return "login-required";
    }
    await waitForNextPoll(page, deadline);
  } while (remainingMs(deadline) > 0);
  throw new Error("WhatsApp readiness was not detected before the timeout");
}

export async function ensureLoggedIn(
  page: Page,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = deadlineAfter(timeoutMs);
  const state = await waitForWhatsAppReady(page, remainingMs(deadline));
  if (state === "ready") return;

  process.stderr.write("Scan the visible WhatsApp QR code with your phone to continue.\n");
  do {
    const ready = await firstVisibleHandle(page, whatsappSelectors.appReady, deadline);
    if (ready !== null) {
      await safelyDispose([ready]);
      return;
    }
    await waitForNextPoll(page, deadline);
  } while (remainingMs(deadline) > 0);
  throw new Error("WhatsApp login did not complete before the timeout");
}

export async function openExactChat(page: Page, requestedName: string): Promise<void> {
  const expected = normalizeName(requestedName);
  if (expected === "") throw new Error("WhatsApp chat name must not be blank");

  await searchAndClickExact(page, expected, deadlineAfter(SEARCH_TIMEOUT_MS));
  await verifyExactHeader(page, expected);
}
