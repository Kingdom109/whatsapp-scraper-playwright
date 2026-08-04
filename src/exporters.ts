import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtractionResult,
  MediaInfo,
  MessageRecord,
  OutputFormat,
} from "./domain.js";

const directions = new Set(["incoming", "outgoing", "system"]);
const messageKinds = new Set(["message", "system", "call", "deleted", "unsupported"]);
const mediaTypes = new Set([
  "image",
  "video",
  "audio",
  "voice-note",
  "document",
  "gif",
  "sticker",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalid(reason: string): never {
  throw new Error(`Invalid extraction document: ${reason}`);
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function assertMedia(value: unknown, index: number): void {
  if (!isRecord(value) || typeof value.type !== "string" || !mediaTypes.has(value.type)) {
    invalid(`messages[${index}].media is invalid`);
  }
  for (const field of ["caption", "filename", "duration", "size"] as const) {
    if (!validOptionalString(value[field])) invalid(`messages[${index}].media.${field} must be a string`);
  }
}

function assertMessage(value: unknown, index: number): void {
  if (!isRecord(value)) invalid(`messages[${index}] must be an object`);
  if (typeof value.id !== "string" || value.id.trim() === "") invalid(`messages[${index}].id must be nonblank`);
  if (value.timestamp !== null && typeof value.timestamp !== "string") invalid(`messages[${index}].timestamp must be a string or null`);
  if (typeof value.sender !== "string" || value.sender.trim() === "") invalid(`messages[${index}].sender must be nonblank`);
  if (typeof value.direction !== "string" || !directions.has(value.direction)) invalid(`messages[${index}].direction is invalid`);
  if (value.text !== null && typeof value.text !== "string") invalid(`messages[${index}].text must be a string or null`);
  if (value.media !== null) assertMedia(value.media, index);
  if (typeof value.kind !== "string" || !messageKinds.has(value.kind)) invalid(`messages[${index}].kind is invalid`);
  if (!isStringArray(value.warnings)) invalid(`messages[${index}].warnings must be an array of strings`);

  if (value.reply !== undefined) {
    if (!isRecord(value.reply) || !validOptionalString(value.reply.sender) || !validOptionalString(value.reply.text)) {
      invalid(`messages[${index}].reply is invalid`);
    }
  }
  if (value.reactions !== undefined) {
    if (!Array.isArray(value.reactions) || value.reactions.some((reaction) =>
      !isRecord(reaction) || typeof reaction.emoji !== "string" ||
      !Number.isInteger(reaction.count) || (reaction.count as number) < 0)) {
      invalid(`messages[${index}].reactions is invalid`);
    }
  }
}

function assertExportDocument(value: unknown): asserts value is ExtractionResult {
  if (!isRecord(value)) invalid("document must be an object");
  if (typeof value.chat !== "string" || value.chat.trim() === "") invalid("chat must be nonblank");
  if (typeof value.extractedAt !== "string" || !Number.isFinite(Date.parse(value.extractedAt))) {
    invalid("extractedAt must be a valid date-time string");
  }
  if (!isRecord(value.request) ||
      (value.request.kind !== "days" && value.request.kind !== "messages") ||
      !Number.isInteger(value.request.value) || (value.request.value as number) <= 0) {
    invalid("request must contain a supported kind and positive integer value");
  }
  if (typeof value.complete !== "boolean") invalid("complete must be boolean");
  if (!isStringArray(value.warnings)) invalid("warnings must be an array of strings");
  if (!Array.isArray(value.messages)) invalid("messages must be an array");
  value.messages.forEach(assertMessage);
}

function timestampParts(timestamp: string | null): { date: string; time: string } | null {
  if (timestamp === null || !Number.isFinite(Date.parse(timestamp))) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(timestamp);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  return { date: `${yearText}-${monthText}-${dayText}`, time: `${hourText}:${minuteText}` };
}

function mediaLabel(media: MediaInfo): string {
  return `[${[media.type, media.filename, media.caption, media.duration, media.size]
    .filter((field): field is string => typeof field === "string" && field.length > 0)
    .join(" - ")}]`;
}

function messageContent(message: MessageRecord): string {
  const fields: string[] = [];
  if (message.text !== null && message.text.length > 0) fields.push(message.text);
  if (message.media !== null) fields.push(mediaLabel(message.media));
  return fields.length > 0 ? fields.join("\n") : `[${message.kind}]`;
}

export function renderMarkdown(result: ExtractionResult): string {
  const lines = [
    `# ${result.chat}`,
    "",
    `- Extracted: ${result.extractedAt}`,
    `- Requested range: ${result.request.kind === "days"
      ? `Last ${result.request.value} local calendar day(s)`
      : `Newest ${result.request.value} message(s)`}`,
    `- Messages: ${result.messages.length}`,
    `- Complete: ${result.complete ? "Yes" : "No"}`,
  ];

  const groups = new Map<string, Array<{ message: MessageRecord; time: string }>>();
  for (const message of result.messages) {
    const parts = timestampParts(message.timestamp);
    const date = parts?.date ?? "Unknown date";
    const group = groups.get(date) ?? [];
    group.push({ message, time: parts?.time ?? "??:??" });
    groups.set(date, group);
  }

  for (const [date, messages] of groups) {
    lines.push("", `## ${date}`);
    for (const { message, time } of messages) {
      lines.push("", `**${time} - ${message.sender}:** ${messageContent(message)}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join("\n").replace(/[\r\n]+$/g, "")}\n`;
}

function safeChatName(value: string): string {
  let cleaned = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  cleaned = Array.from(cleaned || "chat").slice(0, 80).join("").replace(/[. ]+$/g, "") || "chat";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

function safeTimestamp(value: string): string {
  return value.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "-").replace(/[. ]+$/g, "");
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

export async function writeExport(
  result: ExtractionResult,
  format: OutputFormat,
  directory = "exports",
): Promise<string> {
  assertExportDocument(result);
  if (format !== "md" && format !== "json") throw new Error(`Unsupported export format: ${String(format)}`);

  const body = format === "md" ? renderMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`;
  const base = `${safeChatName(result.chat)}-${safeTimestamp(result.extractedAt)}`;
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    for (let suffix = 0; ; suffix += 1) {
      const finalPath = join(directory, `${base}${suffix === 0 ? "" : `-${suffix}`}.${format}`);
      try {
        await link(temporaryPath, finalPath);
        await rm(temporaryPath, { force: true });
        return finalPath;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
