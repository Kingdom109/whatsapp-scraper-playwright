import type { CliCommand, ExtractionResult } from "./domain.js";
import { captureDiagnostic } from "./diagnostics.js";
import { writeExport } from "./exporters.js";
import { openWhatsAppSession } from "./session.js";
import {
  createPlaywrightHistoryAdapter,
  loadHistory,
} from "./whatsapp/history.js";
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
  now: () => new Date(),
};

function extractionTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${local}${sign}${hours}:${minutes}`;
}

export async function runCommand(
  command: CliCommand,
  overrides: Partial<AppDependencies> = {},
): Promise<string | null> {
  const dependencies: AppDependencies = { ...defaults, ...overrides };
  const session = await dependencies.openSession({ headed: true });
  let stage: "login" | "chat-navigation" | "history-loading" | "export" = "login";
  let output: string | null = null;
  let primaryFailure: unknown;

  try {
    await dependencies.ensureLogin(session.page);
    if (command.kind === "scrape") {
      stage = "chat-navigation";
      await dependencies.openChat(session.page, command.chat);
      stage = "history-loading";
      const now = dependencies.now();
      const adapter = dependencies.createAdapter(
        session.page,
        command.chat,
        command.limit,
        now,
      );
      const history = await dependencies.load(adapter);
      stage = "export";
      const result: ExtractionResult = {
        chat: command.chat,
        extractedAt: extractionTimestamp(now),
        request: command.limit,
        complete: history.complete,
        warnings: history.warnings,
        messages: history.messages,
      };
      output = await dependencies.write(result, command.format);
    }
  } catch (error) {
    primaryFailure = error;
    if (stage === "chat-navigation" || stage === "history-loading") {
      const includeDom = command.kind === "scrape" && command.diagnostics;
      try {
        await dependencies.diagnose(session.page, stage, includeDom);
      } catch {
        // Diagnostics are best-effort and must never replace the UI failure.
      }
    }
  }

  try {
    await session.close();
  } catch (closeFailure) {
    if (primaryFailure !== undefined) {
      const message = primaryFailure instanceof Error
        ? primaryFailure.message
        : "WhatsApp extraction failed";
      throw new AggregateError([primaryFailure, closeFailure], message);
    }
    throw closeFailure;
  }

  if (primaryFailure !== undefined) throw primaryFailure;
  return output;
}
