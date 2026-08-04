# WhatsApp Chat Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, read-only Playwright CLI that extracts a bounded range from one explicitly named WhatsApp chat into AI-friendly Markdown or optional JSON.

**Architecture:** A thin CLI validates the request and delegates to an application service. The application composes a dedicated persistent browser session, exact-match chat navigation, incremental virtualized-history parsing, a pure deduplicating collector, and atomic exporters. WhatsApp-specific selectors remain isolated so interface changes do not spread through the domain or export code.

**Tech Stack:** Node.js 24, TypeScript, Playwright, Vitest, npm, Chromium, native Node.js filesystem and cryptography APIs.

---

## File Map

- `package.json`: scripts, executable mapping, and dependencies.
- `tsconfig.json`: strict TypeScript compilation settings.
- `.gitignore`: excludes credentials, browser profiles, exports, diagnostics, dependencies, and build output.
- `src/domain.ts`: normalized message, media, request, result, and exported-document types.
- `src/options.ts`: pure command-line parsing and validation.
- `src/collector.ts`: fingerprinting, deduplication, ordering, and date/count boundaries.
- `src/exporters.ts`: Markdown/JSON rendering, safe filenames, and atomic file writes.
- `src/session.ts`: dedicated persistent profile, process lock, login detection, QR recovery, and shutdown.
- `src/whatsapp/selectors.ts`: all WhatsApp Web selector candidates in one place.
- `src/whatsapp/parser.ts`: converts a rendered message window into normalized records.
- `src/whatsapp/navigator.ts`: exact chat search, ambiguity handling, opening, and header verification.
- `src/whatsapp/history.ts`: incremental parse-scroll-wait loop and stall/boundary detection.
- `src/diagnostics.ts`: privacy-labeled failure screenshots and optional DOM snapshots.
- `src/app.ts`: login and scrape orchestration.
- `src/cli.ts`: executable entry point and exit-code mapping.
- `tests/fixtures/messages.html`: synthetic WhatsApp-like markup with no real chat content.
- `tests/*.test.ts`: focused automated tests for each module.
- `README.md`: installation, login, usage, privacy, recovery, and live acceptance instructions.

`--days N` means local calendar days including today: `--days 1` includes messages since local midnight today; `--days 3` includes today and the two preceding local calendar days.

### Task 1: Scaffold a private, testable TypeScript CLI

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Add the failing executable smoke test**

Create `tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CLI_NAME } from "../src/cli.js";

describe("CLI scaffold", () => {
  it("exposes the expected command name", () => {
    expect(CLI_NAME).toBe("whatsapp-scrape");
  });
});
```

- [ ] **Step 2: Add package and compiler configuration**

Create `package.json`:

```json
{
  "name": "whatsapp-chat-scraper",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "whatsapp-scrape": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "tsx src/cli.ts"
  },
  "dependencies": {
    "playwright": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  },
  "engines": {
    "node": ">=22"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
.whatsapp-profile/
.runtime/
exports/
diagnostics/
playwright-report/
test-results/
*.tmp
.env
```

- [ ] **Step 3: Install dependencies and verify the smoke test fails**

Run:

```powershell
npm.cmd install
npm.cmd test -- tests/smoke.test.ts
```

Expected: FAIL because `src/cli.ts` does not exist.

- [ ] **Step 4: Add the minimal executable module**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node

export const CLI_NAME = "whatsapp-scrape";

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  process.stdout.write(`${CLI_NAME}\n`);
}
```

- [ ] **Step 5: Verify scaffold, lockfile, typecheck, and build**

Run:

```powershell
npm.cmd test -- tests/smoke.test.ts
npm.cmd run check
npm.cmd run build
```

Expected: one passing test, typecheck exit code 0, and `dist/cli.js` created.

- [ ] **Step 6: Commit the scaffold**

```powershell
git add package.json package-lock.json tsconfig.json .gitignore src/cli.ts tests/smoke.test.ts
git commit -m "chore: scaffold Playwright TypeScript CLI"
```

### Task 2: Define domain types and validate CLI requests

**Files:**
- Create: `src/domain.ts`
- Create: `src/options.ts`
- Create: `tests/options.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write request-parsing tests**

Create `tests/options.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/options.js";

describe("parseCommand", () => {
  it("parses login", () => {
    expect(parseCommand(["login"])).toEqual({ kind: "login" });
  });

  it("defaults a day-limited scrape to Markdown", () => {
    expect(parseCommand(["Family Group", "--days", "3"])).toEqual({
      kind: "scrape",
      chat: "Family Group",
      limit: { kind: "days", value: 3 },
      format: "md",
      diagnostics: false
    });
  });

  it("parses count and JSON", () => {
    expect(parseCommand(["David", "--messages", "200", "--format", "json"])).toMatchObject({
      limit: { kind: "messages", value: 200 },
      format: "json"
    });
  });

  it.each([
    ["Family"],
    ["Family", "--days", "1", "--messages", "2"],
    ["Family", "--days", "0"],
    ["Family", "--format", "csv", "--days", "1"]
  ])("rejects invalid arguments: %j", (...args: string[]) => {
    expect(() => parseCommand(args)).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm.cmd test -- tests/options.test.ts`

Expected: FAIL because `src/options.ts` does not exist.

- [ ] **Step 3: Add exact domain contracts**

Create `src/domain.ts`:

```ts
export type OutputFormat = "md" | "json";
export type Direction = "incoming" | "outgoing" | "system";
export type MessageKind = "message" | "system" | "call" | "deleted" | "unsupported";
export type MediaType = "image" | "video" | "audio" | "voice-note" | "document" | "gif" | "sticker";

export interface MediaInfo {
  type: MediaType;
  caption?: string;
  filename?: string;
  duration?: string;
  size?: string;
}

export interface ReplyInfo {
  sender?: string;
  text?: string;
}

export interface ReactionInfo {
  emoji: string;
  count: number;
}

export interface MessageRecord {
  id: string;
  timestamp: string | null;
  sender: string;
  direction: Direction;
  text: string | null;
  media: MediaInfo | null;
  kind: MessageKind;
  reply?: ReplyInfo;
  reactions?: ReactionInfo[];
  warnings: string[];
}

export type ScrapeLimit =
  | { kind: "days"; value: number }
  | { kind: "messages"; value: number };

export type CliCommand =
  | { kind: "login" }
  | {
      kind: "scrape";
      chat: string;
      limit: ScrapeLimit;
      format: OutputFormat;
      diagnostics: boolean;
    };

export interface ExtractionResult {
  chat: string;
  extractedAt: string;
  request: ScrapeLimit;
  complete: boolean;
  warnings: string[];
  messages: MessageRecord[];
}
```

- [ ] **Step 4: Implement pure argument parsing**

Create `src/options.ts`:

```ts
import { parseArgs } from "node:util";
import type { CliCommand, OutputFormat, ScrapeLimit } from "./domain.js";

function positiveInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseCommand(argv: string[]): CliCommand {
  if (argv.length === 1 && argv[0] === "login") return { kind: "login" };

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      days: { type: "string" },
      messages: { type: "string" },
      format: { type: "string", default: "md" },
      diagnostics: { type: "boolean", default: false }
    }
  });

  if (positionals.length !== 1 || !positionals[0]?.trim()) throw new Error("Provide exactly one chat name");
  const days = positiveInteger("--days", values.days);
  const messages = positiveInteger("--messages", values.messages);
  if ((days === undefined) === (messages === undefined)) throw new Error("Provide exactly one of --days or --messages");
  if (values.format !== "md" && values.format !== "json") throw new Error("--format must be md or json");

  const limit: ScrapeLimit = days === undefined
    ? { kind: "messages", value: messages! }
    : { kind: "days", value: days };

  return {
    kind: "scrape",
    chat: positionals[0].trim(),
    limit,
    format: values.format as OutputFormat,
    diagnostics: values.diagnostics ?? false
  };
}
```

- [ ] **Step 5: Verify parsing and commit**

Run:

```powershell
npm.cmd test -- tests/options.test.ts
npm.cmd run check
```

Expected: all option tests pass and typecheck exits 0.

Commit:

```powershell
git add src/domain.ts src/options.ts tests/options.test.ts
git commit -m "feat: validate scraper commands"
```

### Task 3: Implement deterministic collection and boundaries

**Files:**
- Create: `src/collector.ts`
- Create: `tests/collector.test.ts`

- [ ] **Step 1: Write deduplication and boundary tests**

Create `tests/collector.test.ts` with a local `message()` fixture and these assertions:

```ts
import { describe, expect, it } from "vitest";
import { collectMessages, localCalendarCutoff } from "../src/collector.js";
import type { MessageRecord } from "../src/domain.js";

const message = (id: string, timestamp: string, text = id): MessageRecord => ({
  id,
  timestamp,
  sender: "Alice",
  direction: "incoming",
  text,
  media: null,
  kind: "message",
  warnings: []
});

describe("collectMessages", () => {
  it("deduplicates overlapping windows and sorts chronologically", () => {
    const result = collectMessages(
      [[message("b", "2026-08-04T10:00:00+03:00")], [message("a", "2026-08-04T09:00:00+03:00"), message("b", "2026-08-04T10:00:00+03:00")]],
      { kind: "messages", value: 10 },
      new Date("2026-08-04T12:00:00+03:00")
    );
    expect(result.messages.map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("keeps only the newest requested count", () => {
    const result = collectMessages(
      [[message("a", "2026-08-04T08:00:00+03:00"), message("b", "2026-08-04T09:00:00+03:00")]],
      { kind: "messages", value: 1 },
      new Date("2026-08-04T12:00:00+03:00")
    );
    expect(result.messages.map(({ id }) => id)).toEqual(["b"]);
  });

  it("uses inclusive local calendar days", () => {
    const now = new Date(2026, 7, 4, 12, 0, 0);
    const cutoff = localCalendarCutoff(now, 3);
    expect(cutoff.getFullYear()).toBe(2026);
    expect(cutoff.getMonth()).toBe(7);
    expect(cutoff.getDate()).toBe(2);
    expect(cutoff.getHours()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the collector test and confirm failure**

Run: `npm.cmd test -- tests/collector.test.ts`

Expected: FAIL because `src/collector.ts` does not exist.

- [ ] **Step 3: Implement pure collection functions**

Create `src/collector.ts`:

```ts
import { createHash } from "node:crypto";
import type { MessageRecord, ScrapeLimit } from "./domain.js";

export function fallbackMessageId(chat: string, record: Omit<MessageRecord, "id">): string {
  return createHash("sha256")
    .update(JSON.stringify([chat, record.sender, record.timestamp, record.direction, record.kind, record.text, record.media]))
    .digest("hex")
    .slice(0, 24);
}

export function localCalendarCutoff(now: Date, days: number): Date {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return cutoff;
}

export function boundaryReached(records: Iterable<MessageRecord>, limit: ScrapeLimit, now: Date): boolean {
  const messages = [...records];
  if (limit.kind === "messages") return messages.length >= limit.value;
  const cutoff = localCalendarCutoff(now, limit.value).getTime();
  return messages.some(({ timestamp }) => timestamp !== null && Date.parse(timestamp) < cutoff);
}

export function collectMessages(
  windows: MessageRecord[][],
  limit: ScrapeLimit,
  now: Date
): { messages: MessageRecord[]; warnings: string[] } {
  const byId = new Map<string, MessageRecord>();
  for (const record of windows.flat()) byId.set(record.id, record);
  const sorted = [...byId.values()].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  if (limit.kind === "messages") return { messages: sorted.slice(-limit.value), warnings: [] };
  const cutoff = localCalendarCutoff(now, limit.value).getTime();
  const messages = sorted.filter(({ timestamp }) => timestamp !== null && Date.parse(timestamp) >= cutoff);
  const missing = sorted.filter(({ timestamp }) => timestamp === null).length;
  return {
    messages,
    warnings: missing === 0 ? [] : [`Excluded ${missing} message(s) with incomplete timestamps from the day boundary.`]
  };
}
```

- [ ] **Step 4: Run focused and full tests, then commit**

```powershell
npm.cmd test -- tests/collector.test.ts
npm.cmd test
npm.cmd run check
git add src/collector.ts tests/collector.test.ts
git commit -m "feat: collect bounded unique messages"
```

Expected: all tests pass and typecheck exits 0.

### Task 4: Render AI-friendly Markdown and validated JSON atomically

**Files:**
- Create: `src/exporters.ts`
- Create: `tests/exporters.test.ts`

- [ ] **Step 1: Write exporter tests using a temporary directory**

Create `tests/exporters.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown, writeExport } from "../src/exporters.js";
import type { ExtractionResult } from "../src/domain.js";

const result: ExtractionResult = {
  chat: "משפחה / Family",
  extractedAt: "2026-08-04T18:30:00+03:00",
  request: { kind: "days", value: 1 },
  complete: true,
  warnings: [],
  messages: [{
    id: "1",
    timestamp: "2026-08-04T09:14:00+03:00",
    sender: "David",
    direction: "incoming",
    text: "שלום\nAre we meeting?",
    media: null,
    kind: "message",
    warnings: []
  }]
};

describe("exporters", () => {
  it("renders compact Unicode Markdown", () => {
    const markdown = renderMarkdown(result);
    expect(markdown).toContain("# משפחה / Family");
    expect(markdown).toContain("**09:14 - David:** שלום\nAre we meeting?");
  });

  it("writes parseable JSON without overwriting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wa-export-"));
    const first = await writeExport(result, "json", directory);
    const second = await writeExport(result, "json", directory);
    expect(second).not.toBe(first);
    expect(JSON.parse(await readFile(first, "utf8"))).toMatchObject({ chat: result.chat });
  });
});
```

- [ ] **Step 2: Run the exporter test and confirm failure**

Run: `npm.cmd test -- tests/exporters.test.ts`

Expected: FAIL because `src/exporters.ts` does not exist.

- [ ] **Step 3: Implement rendering and atomic writes**

Create `src/exporters.ts` with these exported functions and behavior:

```ts
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtractionResult, MediaInfo, OutputFormat } from "./domain.js";

function safeName(value: string): string {
  const cleaned = value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();
  return (cleaned || "chat").slice(0, 80);
}

function mediaLabel(media: MediaInfo): string {
  const fields = [media.type, media.filename, media.caption, media.duration, media.size].filter(Boolean);
  return `[${fields.join(" - ")}]`;
}

export function renderMarkdown(result: ExtractionResult): string {
  const lines = [
    `# ${result.chat}`,
    "",
    `- Extracted: ${result.extractedAt}`,
    `- Requested range: ${result.request.kind === "days" ? `Last ${result.request.value} local calendar day(s)` : `Newest ${result.request.value} message(s)`}`,
    `- Messages: ${result.messages.length}`,
    `- Complete: ${result.complete ? "Yes" : "No"}`
  ];
  let date = "";
  for (const message of result.messages) {
    const nextDate = message.timestamp?.slice(0, 10) ?? "Unknown date";
    if (nextDate !== date) {
      lines.push("", `## ${nextDate}`);
      date = nextDate;
    }
    const time = message.timestamp?.slice(11, 16) ?? "??:??";
    const content = [message.text, message.media ? mediaLabel(message.media) : null].filter(Boolean).join("\n") || `[${message.kind}]`;
    lines.push("", `**${time} - ${message.sender}:** ${content}`);
  }
  if (result.warnings.length > 0) lines.push("", "## Warnings", "", ...result.warnings.map((warning) => `- ${warning}`));
  return `${lines.join("\n")}\n`;
}

function assertExportDocument(value: ExtractionResult): void {
  if (!value.chat || !Array.isArray(value.messages) || !Array.isArray(value.warnings)) {
    throw new Error("Refusing to write an invalid extraction document");
  }
}

export async function writeExport(result: ExtractionResult, format: OutputFormat, directory = "exports"): Promise<string> {
  assertExportDocument(result);
  await mkdir(directory, { recursive: true });
  const stamp = result.extractedAt.replace(/[:+]/g, "-");
  const base = `${safeName(result.chat)}-${stamp}`;
  const body = format === "md" ? renderMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`;
  for (let suffix = 0; ; suffix += 1) {
    const finalPath = join(directory, `${base}${suffix === 0 ? "" : `-${suffix}`}.${format}`);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx");
      await handle.writeFile(body, "utf8");
      await handle.close();
      try {
        await open(finalPath, "wx").then((reserved) => reserved.close());
      } catch (error: unknown) {
        await rm(temporaryPath, { force: true });
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      await rm(finalPath, { force: true });
      await rename(temporaryPath, finalPath);
      return finalPath;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
```

- [ ] **Step 4: Verify exact output behavior and commit**

```powershell
npm.cmd test -- tests/exporters.test.ts
npm.cmd run check
git add src/exporters.ts tests/exporters.test.ts
git commit -m "feat: export chats as Markdown or JSON"
```

Expected: exporter tests pass, generated JSON parses, output names differ, and typecheck exits 0.

### Task 5: Protect and persist the dedicated browser session

**Files:**
- Create: `src/session.ts`
- Create: `tests/session.test.ts`

- [ ] **Step 1: Write exclusive-lock tests**

Create `tests/session.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProfileLock } from "../src/session.js";

describe("profile lock", () => {
  it("rejects a second active owner and permits reuse after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-lock-"));
    const first = await acquireProfileLock(root);
    await expect(acquireProfileLock(root)).rejects.toThrow("already running");
    await first.release();
    const second = await acquireProfileLock(root);
    await second.release();
  });
});
```

- [ ] **Step 2: Run the lock test and confirm failure**

Run: `npm.cmd test -- tests/session.test.ts`

Expected: FAIL because `src/session.ts` does not exist.

- [ ] **Step 3: Implement the lock and persistent-context lifecycle**

Create `src/session.ts`:

```ts
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

export interface ProfileLock { release(): Promise<void> }
export interface WhatsAppSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function acquireProfileLock(runtimeDir: string): Promise<ProfileLock> {
  await mkdir(runtimeDir, { recursive: true });
  const path = join(runtimeDir, "profile.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      await handle.close();
      return { release: () => rm(path, { force: true }) };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8").catch(() => "0"));
      if (Number.isInteger(pid) && pid > 0 && processExists(pid)) throw new Error(`WhatsApp scraper is already running as process ${pid}`);
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire the WhatsApp browser profile lock");
}

export async function openWhatsAppSession(options: {
  profileDir?: string;
  runtimeDir?: string;
  headed?: boolean;
} = {}): Promise<WhatsAppSession> {
  const profileDir = options.profileDir ?? ".whatsapp-profile";
  const runtimeDir = options.runtimeDir ?? ".runtime";
  const lock = await acquireProfileLock(runtimeDir);
  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: options.headed === false,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded" });
    return {
      context,
      page,
      async close() {
        try { await context.close(); } finally { await lock.release(); }
      }
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
```

- [ ] **Step 4: Verify locking and add a browser-launch smoke check**

Run:

```powershell
npm.cmd test -- tests/session.test.ts
npm.cmd run check
npm.cmd exec playwright install chromium
```

Then run a temporary one-line import through `tsx` that opens a session against temporary profile/runtime folders, verifies the URL begins with `https://web.whatsapp.com/`, and closes it. Do not use the real `.whatsapp-profile` for this smoke check.

Expected: lock test passes, Chromium installation succeeds, WhatsApp Web opens, and no temporary browser process remains.

- [ ] **Step 5: Commit session persistence infrastructure**

```powershell
git add src/session.ts tests/session.test.ts package-lock.json
git commit -m "feat: add persistent WhatsApp browser session"
```

### Task 6: Parse synthetic WhatsApp message windows

**Files:**
- Create: `src/whatsapp/selectors.ts`
- Create: `src/whatsapp/parser.ts`
- Create: `tests/fixtures/messages.html`
- Create: `tests/parser.test.ts`

- [ ] **Step 1: Create a privacy-safe synthetic fixture**

Create `tests/fixtures/messages.html`:

```html
<!doctype html>
<html lang="en">
  <body>
    <main id="main">
      <div class="message-in" data-id="m1">
        <div class="copyable-text" data-pre-plain-text="[09:14, 04/08/2026] Alice:">
          <span class="selectable-text">Are we meeting?</span>
        </div>
      </div>
      <div class="message-out" data-id="m2">
        <div class="copyable-text" data-pre-plain-text="[09:15, 04/08/2026] Me:">
          <span class="selectable-text">שלום<br>כן, בשעה חמש</span>
        </div>
      </div>
      <div class="message-in" data-id="m3">
        <div class="copyable-text" data-pre-plain-text="[09:20, 04/08/2026] Alice:">
          <div data-testid="image-thumb"></div>
          <span class="selectable-text">New entrance</span>
        </div>
      </div>
      <div class="message-in" data-id="m4">
        <div class="copyable-text" data-pre-plain-text="[09:25, 04/08/2026] Bob:">
          <div data-testid="document-thumb" data-filename="agenda.pdf" data-size="42 KB"></div>
        </div>
      </div>
      <div class="message-in" data-id="m5">
        <div class="copyable-text" data-pre-plain-text="[09:30, 04/08/2026] Alice:">
          <span data-testid="deleted-message">This message was deleted</span>
        </div>
      </div>
    </main>
  </body>
</html>
```

- [ ] **Step 2: Write browser-backed parser assertions**

Create `tests/parser.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { parseRenderedMessages } from "../src/whatsapp/parser.js";

describe("parseRenderedMessages", () => {
  it("normalizes text, direction, Unicode, media, and deleted rows", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(await readFile("tests/fixtures/messages.html", "utf8"));
    const messages = await parseRenderedMessages(page, "Family Group");
    await browser.close();
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({ sender: "Alice", direction: "incoming", kind: "message" });
    expect(messages[1]?.text).toContain("שלום");
    expect(messages[2]?.media).toMatchObject({ type: "image", caption: "New entrance" });
    expect(messages[3]?.media).toMatchObject({ type: "document", filename: "agenda.pdf" });
    expect(messages[4]).toMatchObject({ kind: "deleted" });
  });
});
```

- [ ] **Step 3: Run the parser test and confirm failure**

Run: `npm.cmd test -- tests/parser.test.ts`

Expected: FAIL because the WhatsApp parser modules do not exist.

- [ ] **Step 4: Add isolated selector candidates**

Create `src/whatsapp/selectors.ts`:

```ts
export const selectors = {
  appReady: ["#pane-side", "[data-testid='chat-list']"],
  qrCode: ["canvas[aria-label*='QR']", "[data-testid='qrcode']"],
  searchBox: ["#side [contenteditable='true'][role='textbox']", "[data-testid='chat-list-search']"],
  chatTitles: ["#pane-side span[title]", "[data-testid='cell-frame-title'] span[title]"],
  chatHeaderTitle: ["#main header span[title]", "#main header [data-testid='conversation-info-header-chat-title']"],
  messageRows: ["#main .message-in, #main .message-out", "#main [data-id][role='row']"],
  messageText: [".selectable-text", "[data-testid='msg-text']"],
  metadata: [".copyable-text[data-pre-plain-text]"],
  scrollContainer: ["#main [data-testid='conversation-panel-messages']", "#main .copyable-area"],
  deleted: ["[data-testid='deleted-message']"],
  media: {
    image: ["[data-testid='image-thumb']", "img[src^='blob:']"],
    video: ["[data-testid='video-thumb']", "video"],
    audio: ["[data-testid='audio-play']"],
    voiceNote: ["[data-testid='ptt-play']"],
    document: ["[data-testid='document-thumb']"],
    gif: ["[data-testid='gif-label']"],
    sticker: ["[data-testid='sticker-img']"]
  }
} as const;
```

- [ ] **Step 5: Implement `parseRenderedMessages` as one page evaluation**

Create `src/whatsapp/parser.ts` with a serializable raw-row shape, a pure mapper, and a thin Playwright reader:

```ts
import type { Locator, Page } from "playwright";
import { fallbackMessageId } from "../collector.js";
import type { MediaInfo, MediaType, MessageRecord } from "../domain.js";
import { selectors } from "./selectors.js";

interface RawRow {
  id: string | null;
  classes: string;
  metadata: string | null;
  text: string | null;
  deleted: boolean;
  media: (MediaInfo & { type: MediaType }) | null;
}

function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:00${sign}${hours}:${minutes}`;
}

function parseMetadata(value: string | null): { timestamp: string | null; sender: string | null } {
  const match = value?.match(/^\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]\s*(.*?):\s*$/);
  if (!match) return { timestamp: null, sender: null };
  const [, hour, minute, day, month, year, sender] = match;
  return {
    timestamp: localIso(new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))),
    sender: sender?.trim() || null
  };
}

export function mapRawRow(chat: string, raw: RawRow): MessageRecord {
  const parsed = parseMetadata(raw.metadata);
  const direction = raw.classes.includes("message-out") ? "outgoing" : "incoming";
  const withoutId: Omit<MessageRecord, "id"> = {
    timestamp: parsed.timestamp,
    sender: direction === "outgoing" ? "Me" : parsed.sender ?? chat,
    direction,
    text: raw.deleted ? null : raw.text?.trim() || null,
    media: raw.media,
    kind: raw.deleted ? "deleted" : raw.text || raw.media ? "message" : "unsupported",
    warnings: parsed.timestamp === null ? ["Could not parse the displayed timestamp."] : []
  };
  return { id: raw.id ?? fallbackMessageId(chat, withoutId), ...withoutId };
}

async function firstExisting(root: Locator, candidates: readonly string[]): Promise<Locator | null> {
  for (const selector of candidates) {
    const locator = root.locator(selector).first();
    if (await locator.count()) return locator;
  }
  return null;
}

async function readMedia(row: Locator): Promise<MediaInfo | null> {
  const entries: [MediaType, readonly string[]][] = [
    ["voice-note", selectors.media.voiceNote], ["audio", selectors.media.audio],
    ["video", selectors.media.video], ["gif", selectors.media.gif],
    ["sticker", selectors.media.sticker], ["document", selectors.media.document],
    ["image", selectors.media.image]
  ];
  for (const [type, candidates] of entries) {
    const marker = await firstExisting(row, candidates);
    if (!marker) continue;
    const media: MediaInfo = { type };
    const filename = await marker.getAttribute("data-filename");
    const size = await marker.getAttribute("data-size");
    if (filename) media.filename = filename;
    if (size) media.size = size;
    return media;
  }
  return null;
}

export async function parseRenderedMessages(page: Page, chat: string): Promise<MessageRecord[]> {
  const root = page.locator("#main");
  let rows: Locator | null = null;
  for (const selector of selectors.messageRows) {
    const candidate = page.locator(selector);
    if (await candidate.count()) { rows = candidate; break; }
  }
  if (!rows) return [];
  const output: MessageRecord[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const metadata = await firstExisting(row, selectors.metadata);
    const text = await firstExisting(row, selectors.messageText);
    const deleted = await firstExisting(row, selectors.deleted);
    const media = await readMedia(row);
    const caption = media && text ? (await text.innerText()).trim() : "";
    if (media && caption) media.caption = caption;
    output.push(mapRawRow(chat, {
      id: await row.getAttribute("data-id"),
      classes: await row.getAttribute("class") ?? "",
      metadata: metadata ? await metadata.getAttribute("data-pre-plain-text") : null,
      text: text ? await text.innerText() : null,
      deleted: deleted !== null,
      media
    }));
  }
  return output;
}
```

- [ ] **Step 6: Verify all synthetic variants and commit**

Run:

```powershell
npm.cmd test -- tests/parser.test.ts
npm.cmd test
npm.cmd run check
git add src/whatsapp/selectors.ts src/whatsapp/parser.ts tests/fixtures/messages.html tests/parser.test.ts
git commit -m "feat: parse rendered WhatsApp messages"
```

Expected: five synthetic rows normalize correctly; all tests pass; no fixture contains real names, phone numbers, or chat text.

### Task 7: Add exact-match chat navigation and login recovery

**Files:**
- Create: `src/whatsapp/navigator.ts`
- Create: `tests/navigator.test.ts`

- [ ] **Step 1: Write mocked-page contract tests**

Create `tests/navigator.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { AmbiguousChatError, ChatNotFoundError, openExactChat } from "../src/whatsapp/navigator.js";

let browser: Browser;
let page: Page;

function html(titles: string[]): string {
  const rows = titles.map((title) => `<button onclick="document.querySelector('#main header span').setAttribute('title', '${title}')"><span title="${title}">${title}</span></button>`).join("");
  return `<div id="side"><div contenteditable="true" role="textbox"></div></div><div id="pane-side">${rows}</div><div id="main"><header><span title=""></span></header></div>`;
}

describe("openExactChat", () => {
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser.close(); });
  beforeEach(async () => { page = await browser.newPage(); });

  it("opens and verifies one exact match", async () => {
    await page.setContent(html(["Family", "Family Archive"]));
    await openExactChat(page, "Family");
    expect(await page.locator("#main header span").getAttribute("title")).toBe("Family");
    await page.close();
  });

  it("does not click a partial match", async () => {
    await page.setContent(html(["Family Archive"]));
    await expect(openExactChat(page, "Family")).rejects.toBeInstanceOf(ChatNotFoundError);
    expect(await page.locator("#main header span").getAttribute("title")).toBe("");
    await page.close();
  });

  it("rejects duplicate exact matches", async () => {
    await page.setContent(html(["Family", "Family"]));
    await expect(openExactChat(page, "Family")).rejects.toBeInstanceOf(AmbiguousChatError);
    await page.close();
  });

  it("rejects a mismatched opened header", async () => {
    await page.setContent(`<div id="side"><div contenteditable="true" role="textbox"></div></div><div id="pane-side"><button><span title="Family">Family</span></button></div><div id="main"><header><span title="Other"></span></header></div>`);
    await expect(openExactChat(page, "Family")).rejects.toThrow("did not match");
    await page.close();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm.cmd test -- tests/navigator.test.ts`

Expected: FAIL because `src/whatsapp/navigator.ts` does not exist.

- [ ] **Step 3: Implement readiness and exact navigation**

Create `src/whatsapp/navigator.ts`:

```ts
import type { Page } from "playwright";
import { selectors } from "./selectors.js";

export class ChatNotFoundError extends Error {}
export class AmbiguousChatError extends Error {
  constructor(public readonly candidates: string[]) { super(`Multiple chats exactly match: ${candidates.join(", ")}`); }
}

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

async function firstSelector(page: Page, candidates: readonly string[]): Promise<string | null> {
  for (const selector of candidates) if (await page.locator(selector).count()) return selector;
  return null;
}

export async function waitForWhatsAppReady(page: Page, timeoutMs = 120_000): Promise<"ready" | "login-required"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await firstSelector(page, selectors.appReady)) return "ready";
    if (await firstSelector(page, selectors.qrCode)) return "login-required";
    await page.waitForTimeout(250);
  }
  throw new Error("WhatsApp Web did not become ready before the timeout");
}

export async function openExactChat(page: Page, requestedName: string): Promise<void> {
  const expected = normalize(requestedName);
  const searchSelector = await firstSelector(page, selectors.searchBox);
  if (!searchSelector) throw new Error("WhatsApp chat search control was not found");
  await page.locator(searchSelector).first().fill(expected);
  await page.waitForTimeout(500);
  const titleSelector = await firstSelector(page, selectors.chatTitles);
  if (!titleSelector) throw new ChatNotFoundError(`Chat not found: ${expected}`);
  const titles = page.locator(titleSelector);
  const exactIndexes: number[] = [];
  for (let index = 0; index < await titles.count(); index += 1) {
    if (normalize(await titles.nth(index).getAttribute("title") ?? "") === expected) exactIndexes.push(index);
  }
  if (exactIndexes.length === 0) throw new ChatNotFoundError(`Chat not found: ${expected}`);
  if (exactIndexes.length > 1) throw new AmbiguousChatError(exactIndexes.map(() => expected));
  await titles.nth(exactIndexes[0]!).click();
  const headerSelector = await firstSelector(page, selectors.chatHeaderTitle);
  if (!headerSelector) throw new Error("Opened chat header could not be verified");
  const actual = normalize(await page.locator(headerSelector).first().getAttribute("title") ?? await page.locator(headerSelector).first().innerText());
  if (actual !== expected) throw new Error(`Opened chat header '${actual}' did not match '${expected}'`);
}
```

- [ ] **Step 4: Add login recovery behavior**

Add:

```ts
export async function ensureLoggedIn(page: Page, timeoutMs = 120_000): Promise<void> {
  const state = await waitForWhatsAppReady(page, timeoutMs);
  if (state === "ready") return;
  process.stderr.write("WhatsApp linking is required. Scan the visible QR code with your phone.\n");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await firstSelector(page, selectors.appReady)) return;
    await page.waitForTimeout(500);
  }
  throw new Error("WhatsApp was not linked before the login timeout");
}
```

Ensure tests use short explicit timeouts and never access the public internet.

- [ ] **Step 5: Verify navigation safety and commit**

```powershell
npm.cmd test -- tests/navigator.test.ts
npm.cmd run check
git add src/whatsapp/navigator.ts tests/navigator.test.ts
git commit -m "feat: open only exact WhatsApp chats"
```

Expected: exact match opens; partial, missing, ambiguous, and header-mismatch cases fail without clicking an unrelated chat.

### Task 8: Implement incremental virtualized-history loading

**Files:**
- Create: `src/whatsapp/history.ts`
- Create: `tests/history.test.ts`

- [ ] **Step 1: Write deterministic loader tests with injected adapters**

Create `tests/history.test.ts` around an injected adapter rather than real timers or WhatsApp:

```ts
import { describe, expect, it } from "vitest";
import { loadHistory } from "../src/whatsapp/history.js";

describe("loadHistory", () => {
  it("merges overlapping windows until the message count is reached", async () => {
    const windows = [["c", "d"], ["b", "c"], ["a", "b"]];
    let index = 0;
    const result = await loadHistory({
      limit: { kind: "messages", value: 4 },
      now: new Date("2026-08-04T12:00:00+03:00"),
      maxCycles: 10,
      stallCycles: 2,
      parseWindow: async () => windows[index]!.map((id) => ({ id, timestamp: `2026-08-04T0${id.charCodeAt(0) - 96}:00:00+03:00`, sender: "A", direction: "incoming" as const, text: id, media: null, kind: "message" as const, warnings: [] })),
      scrollOlder: async () => { index = Math.min(index + 1, windows.length - 1); return true; }
    });
    expect(result.complete).toBe(true);
    expect(result.messages).toHaveLength(4);
  });

  it("returns an explicitly partial result after repeated stalls", async () => {
    const result = await loadHistory({
      limit: { kind: "messages", value: 5 },
      now: new Date(),
      maxCycles: 5,
      stallCycles: 2,
      parseWindow: async () => [],
      scrollOlder: async () => false
    });
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toContain("stopped loading");
  });
});
```

- [ ] **Step 2: Run the history test and confirm failure**

Run: `npm.cmd test -- tests/history.test.ts`

Expected: FAIL because `src/whatsapp/history.ts` does not exist.

- [ ] **Step 3: Implement the adapter-driven loop**

Create `src/whatsapp/history.ts` with the adapter contract and loop:

```ts
import type { Page } from "playwright";
import { boundaryReached, collectMessages } from "../collector.js";
import type { MessageRecord, ScrapeLimit } from "../domain.js";
import { parseRenderedMessages } from "./parser.js";
import { selectors } from "./selectors.js";

export interface HistoryAdapter {
  limit: ScrapeLimit;
  now: Date;
  maxCycles: number;
  stallCycles: number;
  parseWindow(): Promise<MessageRecord[]>;
  scrollOlder(): Promise<boolean>;
}

export interface HistoryResult {
  messages: MessageRecord[];
  complete: boolean;
  warnings: string[];
}

export async function loadHistory(adapter: HistoryAdapter): Promise<HistoryResult> {
  const windows: MessageRecord[][] = [];
  const seen = new Map<string, MessageRecord>();
  let stalls = 0;
  for (let cycle = 0; cycle < adapter.maxCycles; cycle += 1) {
    const window = await adapter.parseWindow();
    windows.push(window);
    const before = seen.size;
    for (const message of window) seen.set(message.id, message);
    if (boundaryReached(seen.values(), adapter.limit, adapter.now)) {
      const collected = collectMessages(windows, adapter.limit, adapter.now);
      return { ...collected, complete: true };
    }
    const moved = await adapter.scrollOlder();
    stalls = seen.size === before && !moved ? stalls + 1 : 0;
    if (stalls >= adapter.stallCycles) {
      const collected = collectMessages(windows, adapter.limit, adapter.now);
      return { ...collected, complete: false, warnings: [...collected.warnings, "WhatsApp stopped loading older messages before the requested boundary."] };
    }
  }
  const collected = collectMessages(windows, adapter.limit, adapter.now);
  return { ...collected, complete: false, warnings: [...collected.warnings, "Maximum history-loading cycles reached before the requested boundary."] };
}
```

- [ ] **Step 4: Add the Playwright scroll adapter**

Add this Playwright adapter to `src/whatsapp/history.ts`:

```ts
async function firstWorkingSelector(page: Page, candidates: readonly string[]): Promise<string> {
  for (const selector of candidates) if (await page.locator(selector).count()) return selector;
  throw new Error("WhatsApp message scroll container was not found");
}

export function createPlaywrightHistoryAdapter(page: Page, chat: string, limit: ScrapeLimit, now: Date): HistoryAdapter {
  return {
    limit,
    now,
    maxCycles: 500,
    stallCycles: 3,
    parseWindow: () => parseRenderedMessages(page, chat),
    async scrollOlder() {
      const selector = await firstWorkingSelector(page, selectors.scrollContainer);
      const container = page.locator(selector).first();
      const before = await container.evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        oldest: element.querySelector("[data-id]")?.getAttribute("data-id") ?? ""
      }));
      await container.evaluate((element) => element.scrollBy(0, -Math.max(element.clientHeight * 0.8, 500)));
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const after = await container.evaluate((element) => ({
          top: element.scrollTop,
          height: element.scrollHeight,
          oldest: element.querySelector("[data-id]")?.getAttribute("data-id") ?? ""
        }));
        if (after.top !== before.top || after.height !== before.height || after.oldest !== before.oldest) return true;
        await page.waitForTimeout(100);
      }
      return false;
    }
  };
}
```

- [ ] **Step 5: Verify boundaries, stalls, and commit**

```powershell
npm.cmd test -- tests/history.test.ts tests/collector.test.ts
npm.cmd run check
git add src/whatsapp/history.ts tests/history.test.ts
git commit -m "feat: load virtualized chat history incrementally"
```

Expected: count and day boundaries complete; overlapping windows deduplicate; stalls and cycle limits produce partial warnings.

### Task 9: Orchestrate diagnostics, login, scraping, and exit codes

**Files:**
- Create: `src/diagnostics.ts`
- Create: `src/app.ts`
- Create: `tests/app.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write an orchestration test with injected dependencies**

Create `tests/app.test.ts` with fake session, navigator, history, and exporter functions. Assert this order for a scrape: open session, ensure login, open exact chat, load history, write export, close session. Add a failing-path assertion proving `close` runs in `finally` and diagnostics receive the failed stage.

- [ ] **Step 2: Run the app test and confirm failure**

Run: `npm.cmd test -- tests/app.test.ts`

Expected: FAIL because `src/app.ts` does not exist.

- [ ] **Step 3: Implement bounded diagnostics**

Create `src/diagnostics.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export async function captureDiagnostic(page: Page, stage: string, includeDom: boolean): Promise<string[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = join("diagnostics", stamp);
  await mkdir(directory, { recursive: true });
  const files = [join(directory, "failure.json"), join(directory, "screen.png")];
  await writeFile(files[0]!, `${JSON.stringify({ stage, url: page.url(), timestamp: new Date().toISOString(), category: "unexpected-ui-failure" }, null, 2)}\n`, "utf8");
  await page.screenshot({ path: files[1]!, fullPage: false });
  if (includeDom) {
    const domPath = join(directory, "page.html");
    await writeFile(domPath, await page.content(), "utf8");
    files.push(domPath);
  }
  process.stderr.write(`Private diagnostic artifacts were written beneath ${directory}. Review before sharing.\n`);
  return files;
}
```

- [ ] **Step 4: Implement the application service**

Create `src/app.ts` with injectable defaults and the complete lifecycle:

```ts
import type { CliCommand, ExtractionResult, ScrapeLimit } from "./domain.js";
import { captureDiagnostic } from "./diagnostics.js";
import { writeExport } from "./exporters.js";
import { openWhatsAppSession } from "./session.js";
import { createPlaywrightHistoryAdapter, loadHistory } from "./whatsapp/history.js";
import { ensureLoggedIn, openExactChat } from "./whatsapp/navigator.js";

export interface AppDependencies {
  openSession: typeof openWhatsAppSession;
  ensureLogin: typeof ensureLoggedIn;
  openChat: typeof openExactChat;
  load: typeof loadHistory;
  createAdapter: typeof createPlaywrightHistoryAdapter;
  write: typeof writeExport;
  diagnose: typeof captureDiagnostic;
  now(): Date;
}

const defaults: AppDependencies = {
  openSession: openWhatsAppSession,
  ensureLogin: ensureLoggedIn,
  openChat: openExactChat,
  load: loadHistory,
  createAdapter: createPlaywrightHistoryAdapter,
  write: writeExport,
  diagnose: captureDiagnostic,
  now: () => new Date()
};

function extractionTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

export async function runCommand(command: CliCommand, overrides: Partial<AppDependencies> = {}): Promise<string | null> {
  const dependencies: AppDependencies = { ...defaults, ...overrides };
  const session = await dependencies.openSession({ headed: true });
  let stage = "login";
  try {
    await dependencies.ensureLogin(session.page);
    if (command.kind === "login") return null;
    stage = "chat-navigation";
    await dependencies.openChat(session.page, command.chat);
    stage = "history-loading";
    const now = dependencies.now();
    const history = await dependencies.load(dependencies.createAdapter(session.page, command.chat, command.limit as ScrapeLimit, now));
    stage = "export";
    const result: ExtractionResult = {
      chat: command.chat,
      extractedAt: extractionTimestamp(now),
      request: command.limit,
      complete: history.complete,
      warnings: history.warnings,
      messages: history.messages
    };
    return await dependencies.write(result, command.format);
  } catch (error) {
    if (stage === "chat-navigation" || stage === "history-loading") {
      await dependencies.diagnose(session.page, stage, command.kind === "scrape" && command.diagnostics).catch(() => []);
    }
    throw error;
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 5: Replace the CLI placeholder with user-facing execution**

Update `src/cli.ts`:

```ts
#!/usr/bin/env node
import { runCommand } from "./app.js";
import { parseCommand } from "./options.js";

export const CLI_NAME = "whatsapp-scrape";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const output = await runCommand(parseCommand(argv));
    if (output) process.stdout.write(`Export written to ${output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  process.exitCode = await main();
}
```

- [ ] **Step 6: Verify closure, diagnostics, build output, and commit**

```powershell
npm.cmd test -- tests/app.test.ts
npm.cmd test
npm.cmd run check
npm.cmd run build
node dist/cli.js
```

Expected: tests pass; build exits 0; invoking without arguments exits 1 with the concise usage error and does not open a browser.

Commit:

```powershell
git add src/diagnostics.ts src/app.ts src/cli.ts tests/app.test.ts
git commit -m "feat: orchestrate safe chat extraction"
```

### Task 10: Document and perform live read-only acceptance

**Files:**
- Create: `README.md`
- Create: `docs/live-acceptance-checklist.md`
- Modify: `.gitignore` only if live artifacts reveal an unignored runtime path.

- [ ] **Step 1: Write operator documentation**

Create `README.md` with exact Windows commands:

```powershell
npm.cmd install
npm.cmd exec playwright install chromium
npm.cmd run build
node dist/cli.js login
node dist/cli.js "Family Group" --days 3
node dist/cli.js "David Cohen" --messages 200 --format json
```

Explain that Markdown is default, day limits use inclusive local calendar days, the browser profile is a separate linked instance of the same WhatsApp account, QR relinking is normal recovery, exports are sensitive local data, and version 1 records media metadata without downloading media.

- [ ] **Step 2: Add the live checklist**

Create `docs/live-acceptance-checklist.md` with unchecked items for:

```markdown
- [ ] Initial QR pairing reaches the chat list.
- [ ] Full browser close and relaunch reaches the chat list without another QR scan.
- [ ] Exact named chat opens and its header is verified.
- [ ] A small `--messages` export matches visible sender, order, text, and timestamps.
- [ ] A `--days 1` export includes today's messages and excludes yesterday's.
- [ ] Export has no duplicate identifiers or obvious duplicate messages.
- [ ] Image/document/voice-note examples show the correct media type and visible metadata.
- [ ] JSON output parses with `Get-Content -Raw <file> | ConvertFrom-Json`.
- [ ] A nonexistent chat exits nonzero without opening another chat.
- [ ] No message, reaction, edit, delete, or media download occurs.
- [ ] `git status --short` shows no profile, export, or diagnostic artifacts.
```

- [ ] **Step 3: Run automated verification before touching live chat data**

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
git diff --check
```

Expected: all tests pass, TypeScript reports no errors, build exits 0, and Git reports no whitespace errors.

- [ ] **Step 4: Perform login persistence acceptance with the user**

Run `node dist/cli.js login`, allow the user to scan the QR code, close normally, and run `node dist/cli.js login` again. Mark only the first two checklist items after observing the second run reach the chat list without a QR scan. Never copy the `.whatsapp-profile` directory.

- [ ] **Step 5: Perform a minimal authorized extraction**

Ask the user for a low-sensitivity chat name and a small boundary such as `--messages 20`. Run the command, compare several records with the visible chat, inspect the export locally, and mark only the checklist items supported by direct evidence. Do not print chat contents into logs, commits, or the final report.

- [ ] **Step 6: Verify privacy boundaries and commit docs**

```powershell
git status --short
git check-ignore -v .whatsapp-profile exports diagnostics .runtime
git add README.md docs/live-acceptance-checklist.md .gitignore
git commit -m "docs: add scraper operation and acceptance guide"
```

Expected: runtime directories are ignored, no extracted content is staged, and documentation is committed.

- [ ] **Step 7: Final verification and push**

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
git diff --check
git status --short --branch
git push origin main
git rev-parse HEAD
git rev-parse origin/main
```

Expected: all automated checks pass; the working tree is clean; local `HEAD` and `origin/main` hashes match. Report any uncompleted live checklist items explicitly rather than claiming full live verification.
