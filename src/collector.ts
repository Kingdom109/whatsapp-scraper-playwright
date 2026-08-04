import { createHash } from "node:crypto";
import type { MessageRecord, ScrapeLimit } from "./domain.js";

function requirePositiveInteger(value: number, label: "days" | "messages"): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function timestampMillis(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
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

  const byId = new Map<string, MessageRecord>();
  for (const record of records) byId.set(record.id, record);

  if (limit.kind === "messages") {
    return byId.size >= limit.value;
  }

  const cutoff = localCalendarCutoff(now, limit.value).getTime();
  for (const record of byId.values()) {
    const timestamp = timestampMillis(record.timestamp);
    if (timestamp !== null && timestamp < cutoff) return true;
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
  let fallbackCollisions = 0;
  for (const window of windows) {
    const fallbackIdsInWindow = new Set<string>();
    for (const record of window) {
      if (/^[0-9a-f]{24}$/.test(record.id)) {
        if (fallbackIdsInWindow.has(record.id)) fallbackCollisions += 1;
        fallbackIdsInWindow.add(record.id);
      }
      byId.set(record.id, record);
    }
  }

  const sorted = [...byId.values()].sort((left, right) => {
    const leftTime = timestampMillis(left.timestamp);
    const rightTime = timestampMillis(right.timestamp);
    return (leftTime ?? Number.NEGATIVE_INFINITY) - (rightTime ?? Number.NEGATIVE_INFINITY);
  });

  const warnings = fallbackCollisions === 0
    ? []
    : [
        `Detected ${fallbackCollisions} ambiguous fallback message ID collision(s) within a single window.`,
      ];

  if (limit.kind === "messages") {
    const uncertain = sorted.filter(
      ({ timestamp }) => timestampMillis(timestamp) === null,
    ).length;
    if (uncertain > 0) {
      warnings.push(
        `Found ${uncertain} message(s) with incomplete or invalid timestamps; newest-message selection and chronological ordering may be incomplete.`,
      );
    }
    return { messages: sorted.slice(-limit.value), warnings };
  }

  const cutoff = localCalendarCutoff(now, limit.value).getTime();
  const messages = sorted.filter(({ timestamp }) => {
    const parsed = timestampMillis(timestamp);
    return parsed !== null && parsed >= cutoff;
  });
  const missing = sorted.filter(
    ({ timestamp }) => timestampMillis(timestamp) === null,
  ).length;
  if (missing > 0) {
    warnings.push(
      `Excluded ${missing} message(s) with incomplete or invalid timestamps from the day boundary.`,
    );
  }
  return {
    messages,
    warnings,
  };
}
