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
import { whatsappSelectors, type WhatsAppSelectors } from "./selectors.js";

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

export type DateOrder = "dmy" | "mdy";
export interface MetadataContext { dateOrder: DateOrder | null; }

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function calendarIsReal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59
    || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day
    && candidate.getUTCHours() === hour
    && candidate.getUTCMinutes() === minute
    && candidate.getUTCSeconds() === second;
}

function dateOrderFromPartTypes(partTypes: readonly string[]): DateOrder | null {
  const dayIndex = partTypes.indexOf("day");
  const monthIndex = partTypes.indexOf("month");
  if (dayIndex < 0 || monthIndex < 0 || dayIndex === monthIndex) return null;
  return dayIndex < monthIndex ? "dmy" : "mdy";
}

function systemDateOrder(): DateOrder | null {
  const parts = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(new Date(2001, 10, 22, 12));
  return dateOrderFromPartTypes(parts.map(({ type }) => type));
}

export function parseDisplayedMetadata(
  metadata: string,
  context: MetadataContext = { dateOrder: systemDateOrder() },
): ParsedMetadata {
  const match = /^\[\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\]\s*(.*?)(?::\s*)?$/i.exec(metadata.trim());
  if (match === null) {
    return { timestamp: null, sender: null, warning: unsupportedMetadataWarning };
  }

  const [, hourPart, minutePart, secondPart, meridiemPart, firstDatePart, secondDatePart, yearPart, senderPart] = match;
  let hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart ?? "0");
  const firstDate = Number(firstDatePart);
  const secondDate = Number(secondDatePart);
  const year = Number(yearPart);

  if (meridiemPart !== undefined) {
    if (hour < 1 || hour > 12) {
      return { timestamp: null, sender: senderPart?.trim() || null, warning: unsupportedMetadataWarning };
    }
    hour = (hour % 12) + (meridiemPart.toUpperCase() === "PM" ? 12 : 0);
  }

  let day: number;
  let month: number;
  if (context.dateOrder === "dmy") {
    day = firstDate;
    month = secondDate;
  } else if (context.dateOrder === "mdy") {
    month = firstDate;
    day = secondDate;
  } else if (firstDate > 12 && secondDate <= 12) {
    day = firstDate;
    month = secondDate;
  } else if (secondDate > 12 && firstDate <= 12) {
    month = firstDate;
    day = secondDate;
  } else {
    return { timestamp: null, sender: senderPart?.trim() || null, warning: unsupportedMetadataWarning };
  }

  const localDate = new Date(year, month - 1, day, hour, minute, second);
  if (!calendarIsReal(year, month, day, hour, minute, second)
    || localDate.getFullYear() !== year
    || localDate.getMonth() !== month - 1
    || localDate.getDate() !== day
    || localDate.getHours() !== hour
    || localDate.getMinutes() !== minute
    || localDate.getSeconds() !== second) {
    return { timestamp: null, sender: senderPart?.trim() || null, warning: unsupportedMetadataWarning };
  }

  const timezoneOffsetMinutes = localDate.getTimezoneOffset();
  const offsetSign = timezoneOffsetMinutes <= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(timezoneOffsetMinutes);
  const offset = `${offsetSign}${twoDigits(Math.floor(absoluteOffset / 60))}:${twoDigits(absoluteOffset % 60)}`;
  return {
    timestamp: `${yearPart}-${twoDigits(month)}-${twoDigits(day)}T${twoDigits(hour)}:${twoDigits(minute)}:${twoDigits(second)}${offset}`,
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
  const reactions: ReactionInfo[] = [];
  const indexByEmoji = new Map<string, number>();
  for (const { emoji: rawEmoji, count: rawCount } of raw) {
    const emoji = rawEmoji.trim().normalize("NFC");
    const count = Number(rawCount);
    if (emoji === "" || !Number.isSafeInteger(count) || count <= 0) continue;
    const existingIndex = indexByEmoji.get(emoji);
    if (existingIndex === undefined) {
      indexByEmoji.set(emoji, reactions.length);
      reactions.push({ emoji, count });
    } else if (count > reactions[existingIndex]!.count) {
      reactions[existingIndex] = { emoji, count };
    }
  }
  return reactions.length > 0 ? reactions : undefined;
}

function mapRawMessage(raw: RawMessage, chat: string, context: MetadataContext): MessageRecord {
  const metadata = parseDisplayedMetadata(raw.metadata ?? "", context);
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

type BrowserRowExtractor = (
  rows: Element[],
  selectors: WhatsAppSelectors,
) => RawMessage[];

// Constructed from static JavaScript so tsx/esbuild cannot inject Node-only helpers
// such as `__name` into the function Playwright serializes into the browser realm.
const extractBrowserRows = new Function("rows", "selectors", String.raw`
  const text = (element) => {
    if (element === null) return null;
    return element instanceof HTMLElement ? element.innerText : element.textContent;
  };
  const isExcluded = (element, excluded) =>
    excluded.length > 0 && element.closest(excluded.join(",")) !== null;
  const firstMatch = (root, candidates, excluded = []) => {
    for (const candidate of candidates) {
      if (root.matches(candidate) && !isExcluded(root, excluded)) return root;
      for (const element of root.querySelectorAll(candidate)) {
        if (!isExcluded(element, excluded)) return element;
      }
    }
    return null;
  };
  const allMatches = (root, candidates) => {
    const descendants = [...root.querySelectorAll(candidates.join(","))];
    return candidates.some((candidate) => root.matches(candidate))
      ? [root, ...descendants]
      : descendants;
  };
  const mediaContainers = [
    ...selectors.media.gif,
    ...selectors.media.sticker,
    ...selectors.media.document,
    ...selectors.media.voiceNote,
    ...selectors.media.audio,
    ...selectors.media.video,
    ...selectors.media.image,
  ];
  const mediaChrome = [
    ...selectors.mediaCaption,
    ...selectors.mediaFilename,
    ...selectors.mediaDuration,
    ...selectors.mediaSize,
  ];
  const quotedOrReaction = [...selectors.reply, ...selectors.reactions];
  const primaryTextExcluded = [...quotedOrReaction, ...mediaChrome, ...mediaContainers];
  const quotedTextExcluded = [...selectors.reactions, ...mediaChrome, ...mediaContainers];
  const mediaType = (row) => {
    const ordered = [
      ["gif", selectors.media.gif],
      ["sticker", selectors.media.sticker],
      ["document", selectors.media.document],
      ["voice-note", selectors.media.voiceNote],
      ["audio", selectors.media.audio],
      ["video", selectors.media.video],
      ["image", selectors.media.image],
    ];
    return ordered.find(([, candidates]) =>
      firstMatch(row, candidates, quotedOrReaction) !== null)?.[0] ?? null;
  };

  return rows.map((row) => {
    const metadataElement = firstMatch(row, selectors.metadata);
    const replyElement = firstMatch(row, selectors.reply);
    const reactionsElement = firstMatch(row, selectors.reactions);
    const type = mediaType(row);
    const media = type === null ? null : {
      type,
      caption: text(firstMatch(row, selectors.mediaCaption, quotedOrReaction)),
      filename: text(firstMatch(row, selectors.mediaFilename, quotedOrReaction)),
      duration: text(firstMatch(row, selectors.mediaDuration, quotedOrReaction)),
      size: text(firstMatch(row, selectors.mediaSize, quotedOrReaction)),
    };
    return {
      id: row.getAttribute("data-id"),
      rowClass: row.getAttribute("class") ?? "",
      metadata: metadataElement?.getAttribute("data-pre-plain-text") ?? text(metadataElement),
      text: text(firstMatch(row, selectors.messageText, primaryTextExcluded)),
      deletedText: text(firstMatch(row, selectors.deleted, quotedOrReaction)),
      systemText: text(firstMatch(row, selectors.system, quotedOrReaction)),
      callText: text(firstMatch(row, selectors.call, quotedOrReaction)),
      media,
      reply: replyElement === null ? null : {
        sender: text(firstMatch(replyElement, selectors.quotedSender)),
        text: text(firstMatch(replyElement, selectors.quotedText, quotedTextExcluded)),
      },
      reactions: reactionsElement === null
        ? []
        : allMatches(reactionsElement, selectors.reactionItems).map((reaction) => {
            const emojiAttributeElement = firstMatch(reaction, selectors.reactionEmojiAttribute);
            const emojiTextElement = firstMatch(reaction, selectors.reactionEmojiText);
            const emojiAccessibleElement = firstMatch(reaction, selectors.reactionEmojiAccessible);
            const countAttributeElement = firstMatch(reaction, selectors.reactionCountAttribute);
            const countTextElement = firstMatch(reaction, selectors.reactionCountText);
            const attributeEmoji = emojiAttributeElement?.getAttribute("data-emoji")?.trim();
            const accessibleEmoji = emojiAccessibleElement?.getAttribute("aria-label")?.trim();
            const attributeCount = countAttributeElement?.getAttribute("data-count")?.trim();
            return {
              emoji: attributeEmoji || text(emojiTextElement) || accessibleEmoji || text(reaction) || "",
              count: attributeCount || text(countTextElement),
            };
          }),
    };
  });
`) as BrowserRowExtractor;

export async function parseRenderedMessages(page: Page, chat: string): Promise<MessageRecord[]> {
  const rowSelector = await firstMatchingRowSelector(page);
  if (rowSelector === null) return [];

  const [rawMessages, datePartTypes] = await Promise.all([
    page.locator(rowSelector).evaluateAll(extractBrowserRows, whatsappSelectors),
    page.evaluate<string[]>(String.raw`Intl.DateTimeFormat(undefined, {
      day: "numeric", month: "numeric", year: "numeric"
    }).formatToParts(new Date(2001, 10, 22, 12)).map((part) => part.type)`),
  ]);
  const context: MetadataContext = { dateOrder: dateOrderFromPartTypes(datePartTypes) };

  return rawMessages.map((raw) => mapRawMessage(raw, chat, context));
}
