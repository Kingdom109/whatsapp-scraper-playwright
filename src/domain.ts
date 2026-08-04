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
