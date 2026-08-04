import { createHash } from "node:crypto";
import type { MessageRecord, ScrapeLimit } from "./domain.js";

function requirePositiveInteger(value: number, label: "days" | "messages"): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function fallbackMessageId(
  chat: string,
  record: Omit<MessageRecord, "id">,
): string {
  const media = record.media === null
    ? null
    : [
        record.media.type,
        record.media.caption ?? null,
        record.media.filename ?? null,
        record.media.duration ?? null,
        record.media.size ?? null,
      ];

  return createHash("sha256")
    .update(
      JSON.stringify([
        chat,
        record.sender,
        record.timestamp,
        record.direction,
        record.kind,
        record.text,
        media,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

export function localCalendarCutoff(now: Date, days: number): Date {
  requirePositiveInteger(days, "days");
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return cutoff;
}

export function boundaryReached(
  records: Iterable<MessageRecord>,
  limit: ScrapeLimit,
  now: Date,
): boolean {
  requirePositiveInteger(limit.value, limit.kind);

  if (limit.kind === "messages") {
    const uniqueIds = new Set<string>();
    for (const record of records) uniqueIds.add(record.id);
    return uniqueIds.size >= limit.value;
  }

  const cutoff = localCalendarCutoff(now, limit.value).getTime();
  for (const record of records) {
    if (record.timestamp !== null && Date.parse(record.timestamp) < cutoff) {
      return true;
    }
  }
  return false;
}

export function collectMessages(
  windows: MessageRecord[][],
  limit: ScrapeLimit,
  now: Date,
): { messages: MessageRecord[]; warnings: string[] } {
  requirePositiveInteger(limit.value, limit.kind);

  const byId = new Map<string, MessageRecord>();
  for (const window of windows) {
    for (const record of window) byId.set(record.id, record);
  }

  const sorted = [...byId.values()].sort((left, right) => {
    const leftTime = left.timestamp === null ? Number.NEGATIVE_INFINITY : Date.parse(left.timestamp);
    const rightTime = right.timestamp === null ? Number.NEGATIVE_INFINITY : Date.parse(right.timestamp);
    return leftTime - rightTime;
  });

  if (limit.kind === "messages") {
    return { messages: sorted.slice(-limit.value), warnings: [] };
  }

  const cutoff = localCalendarCutoff(now, limit.value).getTime();
  const messages = sorted.filter(
    ({ timestamp }) => timestamp !== null && Date.parse(timestamp) >= cutoff,
  );
  const missing = sorted.filter(({ timestamp }) => timestamp === null).length;
  return {
    messages,
    warnings:
      missing === 0
        ? []
        : [
            `Excluded ${missing} message(s) with incomplete timestamps from the day boundary.`,
          ],
  };
}
