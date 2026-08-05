import type { Page } from "playwright";
import { fallbackMessageId } from "../collector.js";
import type {
  Direction,
  MediaInfo,
  MediaType,
  MessageKind,
  MessageRecord,
  ReactionInfo,
  ReplyInfo,
} from "../domain.js";
import { whatsappSelectors } from "./selectors.js";

const unsupportedMetadataWarning = "Unsupported metadata; timestamp is unavailable.";
const unsupportedMessageWarning = "Unsupported message card has no extractable text or media.";

interface RawMedia {
  type: MediaType;
  caption: string | null;
  filename: string | null;
  duration: string | null;
  size: string | null;
}

interface RawMessage {
  id: string | null;
  rowClass: string;
  metadata: string | null;
  text: string | null;
  deletedText: string | null;
  systemText: string | null;
  callText: string | null;
  media: RawMedia | null;
  reply: { sender: string | null; text: string | null } | null;
  reactions: Array<{ emoji: string; count: string | null }>;
}

export interface ParsedMetadata {
  timestamp: string | null;
  sender: string | null;
  warning: string | null;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function calendarIsReal(year: number, month: number, day: number, hour: number, minute: number): boolean {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day
    && candidate.getUTCHours() === hour
    && candidate.getUTCMinutes() === minute;
}

export function parseDisplayedMetadata(metadata: string, timezoneOffsetMinutes: number): ParsedMetadata {
  const match = /^\[\s*(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\]\s*(.*?)(?::\s*)?$/.exec(metadata.trim());
  if (match === null || !Number.isFinite(timezoneOffsetMinutes) || !Number.isInteger(timezoneOffsetMinutes)) {
    return { timestamp: null, sender: null, warning: unsupportedMetadataWarning };
  }

  const [, hourPart, minutePart, dayPart, monthPart, yearPart, senderPart] = match;
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const day = Number(dayPart);
  const month = Number(monthPart);
  const year = Number(yearPart);
  if (!calendarIsReal(year, month, day, hour, minute)) {
    return { timestamp: null, sender: senderPart?.trim() || null, warning: unsupportedMetadataWarning };
  }

  const offsetSign = timezoneOffsetMinutes <= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(timezoneOffsetMinutes);
  const offset = `${offsetSign}${twoDigits(Math.floor(absoluteOffset / 60))}:${twoDigits(absoluteOffset % 60)}`;
  return {
    timestamp: `${yearPart}-${twoDigits(month)}-${twoDigits(day)}T${twoDigits(hour)}:${twoDigits(minute)}:00${offset}`,
    sender: senderPart?.trim() || null,
    warning: null,
  };
}

function visibleValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mediaFromRaw(raw: RawMedia | null): MediaInfo | null {
  if (raw === null) return null;
  const media: MediaInfo = { type: raw.type };
  const caption = visibleValue(raw.caption);
  const filename = visibleValue(raw.filename);
  const duration = visibleValue(raw.duration);
  const size = visibleValue(raw.size);
  if (caption !== null) media.caption = caption;
  if (filename !== null) media.filename = filename;
  if (duration !== null) media.duration = duration;
  if (size !== null) media.size = size;
  return media;
}

function replyFromRaw(raw: RawMessage["reply"]): ReplyInfo | undefined {
  if (raw === null) return undefined;
  const sender = visibleValue(raw.sender);
  const text = visibleValue(raw.text);
  if (sender === null && text === null) return undefined;
  const reply: ReplyInfo = {};
  if (sender !== null) reply.sender = sender;
  if (text !== null) reply.text = text;
  return reply;
}

function reactionsFromRaw(raw: RawMessage["reactions"]): ReactionInfo[] | undefined {
  const reactions = raw.flatMap(({ emoji: rawEmoji, count: rawCount }) => {
    const emoji = rawEmoji.trim();
    const count = Number(rawCount);
    return emoji !== "" && Number.isFinite(count) && Number.isInteger(count) && count > 0
      ? [{ emoji, count }]
      : [];
  });
  return reactions.length > 0 ? reactions : undefined;
}

function mapRawMessage(raw: RawMessage, chat: string, timezoneOffsetMinutes: number): MessageRecord {
  const metadata = parseDisplayedMetadata(raw.metadata ?? "", timezoneOffsetMinutes);
  const rowClass = raw.rowClass.toLowerCase();
  const isSystem = raw.systemText !== null || rowClass.includes("system-message");
  const direction: Direction = isSystem
    ? "system"
    : rowClass.includes("message-out")
      ? "outgoing"
      : "incoming";
  const sender = direction === "outgoing" ? "Me" : direction === "system" ? chat : metadata.sender ?? chat;
  const media = mediaFromRaw(raw.media);

  let kind: MessageKind;
  let text: string | null;
  if (raw.deletedText !== null) {
    kind = "deleted";
    text = null;
  } else if (isSystem) {
    kind = "system";
    text = visibleValue(raw.systemText);
  } else if (raw.callText !== null) {
    kind = "call";
    text = visibleValue(raw.callText);
  } else {
    text = visibleValue(raw.text);
    kind = text === null && media === null ? "unsupported" : "message";
  }

  const warnings: string[] = [];
  if (metadata.warning !== null) warnings.push(metadata.warning);
  if (kind === "unsupported") warnings.push(unsupportedMessageWarning);

  const withoutId: Omit<MessageRecord, "id"> = {
    timestamp: metadata.timestamp,
    sender,
    direction,
    text,
    media,
    kind,
    warnings,
  };
  const reply = replyFromRaw(raw.reply);
  const reactions = reactionsFromRaw(raw.reactions);
  if (reply !== undefined) withoutId.reply = reply;
  if (reactions !== undefined) withoutId.reactions = reactions;

  return {
    id: visibleValue(raw.id) ?? fallbackMessageId(chat, withoutId),
    ...withoutId,
  };
}

async function firstMatchingRowSelector(page: Page): Promise<string | null> {
  for (const selector of whatsappSelectors.messageRows) {
    if (await page.locator(selector).count() > 0) return selector;
  }
  return null;
}

export async function parseRenderedMessages(page: Page, chat: string): Promise<MessageRecord[]> {
  const rowSelector = await firstMatchingRowSelector(page);
  if (rowSelector === null) return [];

  const [timezoneOffsetMinutes, rawMessages] = await Promise.all([
    page.evaluate(() => new Date().getTimezoneOffset()),
    page.locator(rowSelector).evaluateAll((rows, selectors): RawMessage[] => {
      const firstMatch = (root: Element, candidates: readonly string[]): Element | null => {
        for (const candidate of candidates) {
          const found = root.querySelector(candidate);
          if (found !== null) return found;
        }
        return null;
      };
      const text = (element: Element | null): string | null => {
        if (element === null) return null;
        return element instanceof HTMLElement ? element.innerText : element.textContent;
      };
      const excluded = [...selectors.reply, ...selectors.reactions].join(",");
      const primaryText = (row: Element): string | null => {
        for (const candidate of selectors.messageText) {
          for (const element of row.querySelectorAll(candidate)) {
            if (excluded === "" || element.closest(excluded) === null) return text(element);
          }
        }
        return null;
      };
      const mediaType = (row: Element): MediaType | null => {
        const ordered: Array<[MediaType, readonly string[]]> = [
          ["gif", selectors.media.gif],
          ["sticker", selectors.media.sticker],
          ["document", selectors.media.document],
          ["voice-note", selectors.media.voiceNote],
          ["audio", selectors.media.audio],
          ["video", selectors.media.video],
          ["image", selectors.media.image],
        ];
        return ordered.find(([, candidates]) => firstMatch(row, candidates) !== null)?.[0] ?? null;
      };

      return rows.map((row) => {
        const metadataElement = firstMatch(row, selectors.metadata);
        const replyElement = firstMatch(row, selectors.reply);
        const reactionsElement = firstMatch(row, selectors.reactions);
        const type = mediaType(row);
        const media = type === null ? null : {
          type,
          caption: text(row.querySelector('[data-testid="media-caption"]')),
          filename: text(row.querySelector('[data-testid="document-filename"]')),
          duration: text(row.querySelector('[data-testid="media-duration"]')),
          size: text(row.querySelector('[data-testid="document-size"]')),
        };
        return {
          id: row.getAttribute("data-id"),
          rowClass: row.getAttribute("class") ?? "",
          metadata: metadataElement?.getAttribute("data-pre-plain-text") ?? text(metadataElement),
          text: primaryText(row),
          deletedText: text(firstMatch(row, selectors.deleted)),
          systemText: text(firstMatch(row, selectors.system)),
          callText: text(firstMatch(row, selectors.call)),
          media,
          reply: replyElement === null ? null : {
            sender: text(replyElement.querySelector('[data-testid="quoted-sender"]')),
            text: text(firstMatch(replyElement, selectors.messageText)),
          },
          reactions: reactionsElement === null
            ? []
            : [...reactionsElement.querySelectorAll('[data-testid="reaction"]')].map((reaction) => ({
                emoji: text(reaction) ?? "",
                count: reaction.getAttribute("data-count"),
              })),
        };
      });
    }, whatsappSelectors),
  ]);

  return rawMessages.map((raw) => mapRawMessage(raw, chat, timezoneOffsetMinutes));
}
