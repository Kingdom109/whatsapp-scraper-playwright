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
  localPath?: string;
}
export interface ReplyInfo { sender?: string; text?: string; }
export interface ReactionInfo { emoji: string; count: number; }
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

export interface CommandOutcome {
  path: string | null;
  complete: boolean;
  warnings: string[];
}

export const INCOMPLETE_WARNING = "The requested boundary was not reached; review the local export for details.";
export const QUALIFICATIONS_WARNING = "The export includes extraction qualifications; review the local export for details.";

export function sanitizeOutcomeWarnings(complete: boolean, warnings: readonly string[]): string[] {
  if (!complete) return [INCOMPLETE_WARNING];
  return warnings.length === 0 ? [] : [QUALIFICATIONS_WARNING];
}

export type OperationalFailureKind =
  | "profile-in-use"
  | "login-timeout"
  | "chat-not-found"
  | "ambiguous-chat"
  | "ui-drift"
  | "export-failure"
  | "interrupted"
  | "shutdown-failure"
  | "unexpected";

const operationalFailureMessages: Record<OperationalFailureKind, string> = {
  "profile-in-use": "The dedicated WhatsApp browser profile is already in use. Close the other scraper run and retry.",
  "login-timeout": "WhatsApp login or QR pairing did not complete in time. Scan the visible QR code and retry.",
  "chat-not-found": "The requested chat was not found. Check the exact displayed chat name and retry.",
  "ambiguous-chat": "More than one visible chat exactly matches the requested name. Use the exact displayed name and retry.",
  "ui-drift": "WhatsApp's selected-chat, history, or interface state could not be verified. Retry; if it persists, rerun the scrape with --diagnostics and review private artifacts locally.",
  "export-failure": "The export could not be written. Check local export storage and retry.",
  interrupted: "The run was interrupted. The browser session was closed.",
  "shutdown-failure": "WhatsApp shutdown could not be confirmed. Close the visible browser before retrying.",
  unexpected: "WhatsApp extraction could not be completed. Retry; if it persists, review private diagnostics locally.",
};

export class OperationalFailure extends Error {
  readonly kind: OperationalFailureKind;
  readonly signal: "SIGINT" | "SIGTERM" | undefined;

  constructor(kind: OperationalFailureKind, signal?: "SIGINT" | "SIGTERM") {
    super(operationalFailureMessages[kind]);
    this.name = "OperationalFailure";
    this.kind = kind;
    this.signal = signal;
  }
}
