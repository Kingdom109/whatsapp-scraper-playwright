import {
  sanitizeOutcomeWarnings,
  type CliCommand,
  type CommandOutcome,
  type ExtractionResult,
  OperationalFailure,
} from "./domain.js";
import { captureDiagnostic } from "./diagnostics.js";
import { writeExport } from "./exporters.js";
import {
  openWhatsAppSession,
  ProfileInUseError,
  type WhatsAppSession,
} from "./session.js";
import {
  createPlaywrightHistoryAdapter,
  loadHistory,
} from "./whatsapp/history.js";
import {
  AmbiguousChatError,
  ChatNotFoundError,
  ensureLoggedIn,
  openExactChat,
  waitForChatContent,
} from "./whatsapp/navigator.js";
import { join } from "node:path";

export interface AppDependencies {
  openSession: typeof openWhatsAppSession;
  ensureLogin: typeof ensureLoggedIn;
  openChat: typeof openExactChat;
  waitForContent: typeof waitForChatContent;
  load: typeof loadHistory;
  createAdapter: typeof createPlaywrightHistoryAdapter;
  write: typeof writeExport;
  diagnose: typeof captureDiagnostic;
  registerSignal: SignalRegistrar;
  now(): Date;
}

type SignalName = "SIGINT" | "SIGTERM";
export type SignalRegistrar = (signal: SignalName, handler: () => void) => () => void;

function registerProcessSignal(signal: SignalName, handler: () => void): () => void {
  process.once(signal, handler);
  return () => process.off(signal, handler);
}

const defaults: AppDependencies = {
  openSession: openWhatsAppSession,
  ensureLogin: ensureLoggedIn,
  openChat: openExactChat,
  waitForContent: waitForChatContent,
  load: loadHistory,
  createAdapter: createPlaywrightHistoryAdapter,
  write: writeExport,
  diagnose: captureDiagnostic,
  registerSignal: registerProcessSignal,
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

function mediaDirectory(chat: string): string {
  const safe = Array.from(chat.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "chat")
    .slice(0, 80)
    .join("");
  return join("exports", "media", safe);
}

function operationalFailure(
  stage: "session" | "login" | "chat-navigation" | "history-loading" | "export",
  error: unknown,
): OperationalFailure {
  if (error instanceof OperationalFailure) return error;
  if (error instanceof ProfileInUseError) return new OperationalFailure("profile-in-use");
  if (error instanceof ChatNotFoundError) return new OperationalFailure("chat-not-found");
  if (error instanceof AmbiguousChatError) return new OperationalFailure("ambiguous-chat");
  if (stage === "login") return new OperationalFailure("login-timeout");
  if (stage === "chat-navigation" || stage === "history-loading") {
    return new OperationalFailure("ui-drift");
  }
  if (stage === "export") return new OperationalFailure("export-failure");
  return new OperationalFailure("unexpected");
}

interface RunController {
  waitFor<T>(operation: Promise<T>): Promise<T>;
  close(): Promise<void>;
  drain(): Promise<void>;
  dispose(): void;
  closeFailure(): unknown;
  interruptedSignal(): SignalName | undefined;
}

function createRunController(session: WhatsAppSession, registerSignal: SignalRegistrar): RunController {
  let interrupted: SignalName | undefined;
  let observeInterruption!: (signal: SignalName) => void;
  const interruption = new Promise<SignalName>((resolve) => { observeInterruption = resolve; });
  let closePromise: Promise<void> | undefined;
  let failureWhileClosing: unknown;
  const inFlight = new Set<Promise<void>>();
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    let settleClose!: () => void;
    closePromise = new Promise<void>((resolve) => { settleClose = resolve; });
    try {
      void session.close().then(
        () => settleClose(),
        (error: unknown) => {
          failureWhileClosing = error;
          settleClose();
        },
      );
    } catch (error) {
      failureWhileClosing = error;
      settleClose();
    }
    return closePromise;
  };
  const interrupt = (signal: SignalName): void => {
    if (interrupted !== undefined) return;
    interrupted = signal;
    observeInterruption(signal);
    void close();
  };
  const removers = (["SIGINT", "SIGTERM"] as const).map((signal) =>
    registerSignal(signal, () => interrupt(signal)),
  );
  return {
    async waitFor<T>(operation: Promise<T>): Promise<T> {
      const settled = operation.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const tracked = settled.then(() => undefined);
      inFlight.add(tracked);
      void tracked.then(() => inFlight.delete(tracked));
      const result = await Promise.race([
        settled,
        interruption.then((signal) => ({ kind: "interrupted" as const, signal })),
      ]);
      if (result.kind === "error") throw result.error;
      if (result.kind === "interrupted") {
        throw new OperationalFailure("interrupted", result.signal);
      }
      if (interrupted !== undefined) throw new OperationalFailure("interrupted", interrupted);
      return result.value;
    },
    close,
    async drain(): Promise<void> {
      await Promise.all([...inFlight]);
    },
    dispose(): void {
      for (const remove of removers) remove();
    },
    closeFailure: () => failureWhileClosing,
    interruptedSignal: () => interrupted,
  };
}

export async function runCommand(
  command: CliCommand,
  overrides: Partial<AppDependencies> = {},
): Promise<CommandOutcome> {
  const dependencies: AppDependencies = { ...defaults, ...overrides };
  let session: WhatsAppSession;
  try {
    session = await dependencies.openSession({ headed: true });
  } catch (error) {
    throw operationalFailure("session", error);
  }
  const controller = createRunController(session, dependencies.registerSignal);
  let stage: "login" | "chat-navigation" | "history-loading" | "export" = "login";
  let output: CommandOutcome = { path: null, complete: true, warnings: [] };
  let primaryFailure: unknown;

  try {
    await controller.waitFor(dependencies.ensureLogin(session.page));
    if (command.kind === "scrape") {
      stage = "chat-navigation";
      await controller.waitFor(dependencies.openChat(session.page, command.chat, {
        searchTimeoutMs: 5_000,
        headerTimeoutMs: 5_000,
      }));
      stage = "history-loading";
      const now = dependencies.now();
      const adapter = dependencies.createAdapter(
        session.page,
        command.chat,
        command.limit,
        now,
        { mediaDirectory: mediaDirectory(command.chat) },
      );
      const contentState = await controller.waitFor(dependencies.waitForContent(session.page));
      const history = contentState === "unavailable"
        ? {
            messages: [],
            complete: false,
            warnings: ["No message history is available in this linked WhatsApp Web instance."],
          }
        : await controller.waitFor(dependencies.load(adapter));
      stage = "export";
      const result: ExtractionResult = {
        chat: command.chat,
        extractedAt: extractionTimestamp(now),
        request: command.limit,
        complete: history.complete,
        warnings: history.warnings,
        messages: history.messages,
      };
      output = {
        path: await controller.waitFor(dependencies.write(result, command.format)),
        complete: history.complete,
        warnings: sanitizeOutcomeWarnings(history.complete, history.warnings),
      };
    }
  } catch (error) {
    primaryFailure = operationalFailure(stage, error);
    if (
      primaryFailure instanceof OperationalFailure
      && primaryFailure.kind !== "interrupted"
      && controller.interruptedSignal() === undefined
      && (stage === "chat-navigation" || stage === "history-loading")
    ) {
      const includeDom = command.kind === "scrape" && command.diagnostics;
      try {
        await controller.waitFor(dependencies.diagnose(session.page, stage, includeDom));
      } catch {
        // Diagnostics are best-effort and must never replace the UI failure.
      }
    }
  }

  await controller.close();
  await controller.drain();
  controller.dispose();
  if (controller.closeFailure() !== undefined) {
    primaryFailure = new OperationalFailure("shutdown-failure");
  } else if (controller.interruptedSignal() !== undefined) {
    primaryFailure = new OperationalFailure("interrupted", controller.interruptedSignal());
  }

  if (primaryFailure !== undefined) throw primaryFailure;
  return output;
}

export interface BatchScrapeResult {
  chat: string;
  outcome?: CommandOutcome;
  failure?: OperationalFailure;
}

type ScrapeCommand = Extract<CliCommand, { kind: "scrape" }>;

export async function runBatchScrapes(
  commands: readonly ScrapeCommand[],
  overrides: Partial<AppDependencies> = {},
): Promise<BatchScrapeResult[]> {
  const dependencies: AppDependencies = { ...defaults, ...overrides };
  let session: WhatsAppSession;
  try {
    session = await dependencies.openSession({ headed: true });
  } catch (error) {
    throw operationalFailure("session", error);
  }
  const controller = createRunController(session, dependencies.registerSignal);
  const results: BatchScrapeResult[] = [];
  let terminalFailure: OperationalFailure | undefined;
  try {
    await controller.waitFor(dependencies.ensureLogin(session.page));
    for (const command of commands) {
      let stage: "chat-navigation" | "history-loading" | "export" = "chat-navigation";
      try {
        await controller.waitFor(dependencies.openChat(session.page, command.chat, {
          searchTimeoutMs: 5_000,
          headerTimeoutMs: 5_000,
        }));
        stage = "history-loading";
        const now = dependencies.now();
        const adapter = dependencies.createAdapter(
          session.page,
          command.chat,
          command.limit,
          now,
          { mediaDirectory: mediaDirectory(command.chat) },
        );
        const contentState = await controller.waitFor(dependencies.waitForContent(session.page));
        const history = contentState === "unavailable"
          ? {
              messages: [],
              complete: false,
              warnings: ["No message history is available in this linked WhatsApp Web instance."],
            }
          : await controller.waitFor(dependencies.load(adapter));
        stage = "export";
        const extraction: ExtractionResult = {
          chat: command.chat,
          extractedAt: extractionTimestamp(now),
          request: command.limit,
          complete: history.complete,
          warnings: history.warnings,
          messages: history.messages,
        };
        const outcome: CommandOutcome = {
          path: await controller.waitFor(dependencies.write(extraction, command.format)),
          complete: history.complete,
          warnings: sanitizeOutcomeWarnings(history.complete, history.warnings),
        };
        results.push({ chat: command.chat, outcome });
      } catch (error) {
        const failure = operationalFailure(stage, error);
        if (failure.kind === "interrupted" || controller.interruptedSignal() !== undefined) {
          terminalFailure = new OperationalFailure("interrupted", controller.interruptedSignal() ?? failure.signal);
          break;
        }
        if (stage === "chat-navigation" || stage === "history-loading") {
          try {
            await controller.waitFor(dependencies.diagnose(
              session.page,
              stage,
              command.diagnostics,
            ));
          } catch {
            // Per-chat diagnostics remain best-effort in a continuing batch.
          }
        }
        results.push({ chat: command.chat, failure });
      }
    }
  } catch (error) {
    terminalFailure = operationalFailure("login", error);
  }

  await controller.close();
  await controller.drain();
  controller.dispose();
  if (controller.closeFailure() !== undefined) throw new OperationalFailure("shutdown-failure");
  if (controller.interruptedSignal() !== undefined) {
    throw new OperationalFailure("interrupted", controller.interruptedSignal());
  }
  if (terminalFailure !== undefined) throw terminalFailure;
  return results;
}
