import { randomUUID } from "node:crypto";
import {
  link as fsLink,
  mkdir as fsMkdir,
  open as fsOpen,
  rm as fsRm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type {
  Direction,
  ExtractionResult,
  MediaInfo,
  MediaType,
  MessageKind,
  MessageRecord,
  OutputFormat,
  ReactionInfo,
  ReplyInfo,
  ScrapeLimit,
} from "./domain.js";

const directions = new Set<Direction>(["incoming", "outgoing", "system"]);
const messageKinds = new Set<MessageKind>(["message", "system", "call", "deleted", "unsupported"]);
const mediaTypes = new Set<MediaType>([
  "image", "video", "audio", "voice-note", "document", "gif", "sticker",
]);
const invalidTimestampWarning = "Invalid message timestamp was normalized to null.";

interface ExportFileSystem {
  mkdir: typeof fsMkdir;
  open: typeof fsOpen;
  link: typeof fsLink;
  rm: typeof fsRm;
  warn: (message: string) => void;
}

const defaultFileSystem: ExportFileSystem = {
  mkdir: fsMkdir,
  open: fsOpen,
  link: fsLink,
  rm: fsRm,
  warn: (message) => console.warn(message),
};
let exportFileSystem = defaultFileSystem;

export function __setExporterFileSystemForTests(
  overrides: Partial<ExportFileSystem>,
): () => void {
  const previous = exportFileSystem;
  exportFileSystem = { ...defaultFileSystem, ...overrides };
  return () => { exportFileSystem = previous; };
}

function invalid(reason: string): never {
  throw new Error(`Invalid extraction document: ${reason}`);
}

type DataDescriptors = Record<PropertyKey, PropertyDescriptor>;

function ownDataDescriptors(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  active: WeakSet<object>,
): { object: object; descriptors: DataDescriptors; done: () => void } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object`);
  if (active.has(value)) invalid(`${path} contains a cyclic reference`);
  active.add(value);

  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DataDescriptors;
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      active.delete(value);
      invalid(`${path} contains an unknown field`);
    }
    if (!("value" in descriptors[key]!)) {
      active.delete(value);
      invalid(`${path}.${key} must be an own data property`);
    }
  }
  for (const key of required) {
    if (!(key in descriptors)) {
      active.delete(value);
      invalid(`${path}.${key} must be an own data property`);
    }
  }
  return { object: value, descriptors, done: () => active.delete(value) };
}

function descriptorValue(descriptors: DataDescriptors, key: string): unknown {
  return descriptors[key]?.value;
}

function ownDenseArray(
  value: unknown,
  path: string,
  active: WeakSet<object>,
): { values: unknown[]; done: () => void } {
  if (!Array.isArray(value)) invalid(`${path} must be a dense array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid(`${path} must be a plain array`);
  if (active.has(value)) invalid(`${path} contains a cyclic reference`);
  active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as DataDescriptors;
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    active.delete(value);
    invalid(`${path} has an invalid length`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      active.delete(value);
      invalid(`${path} contains an unknown field`);
    }
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor)) {
      active.delete(value);
      invalid(`${path} must be a dense array of own data properties`);
    }
    values.push(descriptor.value);
  }
  return { values, done: () => active.delete(value) };
}

function requireString(value: unknown, path: string, nonblank = false): string {
  if (typeof value !== "string" || (nonblank && value.trim() === "")) {
    invalid(`${path} must be ${nonblank ? "a nonblank string" : "a string"}`);
  }
  return value;
}

function projectStringArray(value: unknown, path: string, active: WeakSet<object>): string[] {
  const array = ownDenseArray(value, path, active);
  try {
    return array.values.map((item, index) => requireString(item, `${path}[${index}]`));
  } finally {
    array.done();
  }
}

function isoTimestampParts(value: string): { date: string; time: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const zoneMatch = zone === "Z" ? null : /^([+-])(\d{2}):(\d{2})$/.exec(zone!);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 ||
      (zoneMatch !== null && (Number(zoneMatch[2]) > 23 || Number(zoneMatch[3]) > 59)) ||
      !Number.isFinite(Date.parse(value))) return null;
  return { date: `${yearText}-${monthText}-${dayText}`, time: `${hourText}:${minuteText}` };
}

function projectRequest(value: unknown, active: WeakSet<object>): ScrapeLimit {
  const object = ownDataDescriptors(value, "request", ["kind", "value"], ["kind", "value"], active);
  try {
    const kind = descriptorValue(object.descriptors, "kind");
    const count = descriptorValue(object.descriptors, "value");
    if ((kind !== "days" && kind !== "messages") || !Number.isInteger(count) || (count as number) <= 0) {
      invalid("request must contain a supported kind and positive integer value");
    }
    return { kind, value: count as number };
  } finally {
    object.done();
  }
}

function projectMedia(value: unknown, path: string, active: WeakSet<object>): MediaInfo {
  const allowed = ["type", "caption", "filename", "duration", "size", "localPath"] as const;
  const object = ownDataDescriptors(value, path, allowed, ["type"], active);
  try {
    const type = descriptorValue(object.descriptors, "type");
    if (typeof type !== "string" || !mediaTypes.has(type as MediaType)) invalid(`${path}.type is invalid`);
    const media: MediaInfo = { type: type as MediaType };
    for (const key of ["caption", "filename", "duration", "size", "localPath"] as const) {
      if (key in object.descriptors) media[key] = requireString(descriptorValue(object.descriptors, key), `${path}.${key}`);
    }
    return media;
  } finally {
    object.done();
  }
}

function projectReply(value: unknown, path: string, active: WeakSet<object>): ReplyInfo {
  const object = ownDataDescriptors(value, path, ["sender", "text"], [], active);
  try {
    const reply: ReplyInfo = {};
    if ("sender" in object.descriptors) reply.sender = requireString(descriptorValue(object.descriptors, "sender"), `${path}.sender`);
    if ("text" in object.descriptors) reply.text = requireString(descriptorValue(object.descriptors, "text"), `${path}.text`);
    return reply;
  } finally {
    object.done();
  }
}

function projectReaction(value: unknown, path: string, active: WeakSet<object>): ReactionInfo {
  const object = ownDataDescriptors(value, path, ["emoji", "count"], ["emoji", "count"], active);
  try {
    const emoji = requireString(descriptorValue(object.descriptors, "emoji"), `${path}.emoji`);
    const count = descriptorValue(object.descriptors, "count");
    if (!Number.isInteger(count) || (count as number) < 0) invalid(`${path}.count must be a nonnegative integer`);
    return { emoji, count: count as number };
  } finally {
    object.done();
  }
}

function projectReactions(value: unknown, path: string, active: WeakSet<object>): ReactionInfo[] {
  const array = ownDenseArray(value, path, active);
  try {
    return array.values.map((reaction, index) => projectReaction(reaction, `${path}[${index}]`, active));
  } finally {
    array.done();
  }
}

function projectMessage(value: unknown, index: number, active: WeakSet<object>): MessageRecord {
  const path = `messages[${index}]`;
  const allowed = ["id", "timestamp", "sender", "direction", "text", "media", "kind", "reply", "reactions", "warnings"];
  const required = ["id", "timestamp", "sender", "direction", "text", "media", "kind", "warnings"];
  const object = ownDataDescriptors(value, path, allowed, required, active);
  try {
    const id = requireString(descriptorValue(object.descriptors, "id"), `${path}.id`, true);
    const sender = requireString(descriptorValue(object.descriptors, "sender"), `${path}.sender`, true);
    const direction = descriptorValue(object.descriptors, "direction");
    if (typeof direction !== "string" || !directions.has(direction as Direction)) invalid(`${path}.direction is invalid`);
    const kind = descriptorValue(object.descriptors, "kind");
    if (typeof kind !== "string" || !messageKinds.has(kind as MessageKind)) invalid(`${path}.kind is invalid`);
    const textValue = descriptorValue(object.descriptors, "text");
    if (textValue !== null && typeof textValue !== "string") invalid(`${path}.text must be a string or null`);
    const mediaValue = descriptorValue(object.descriptors, "media");
    const media = mediaValue === null ? null : projectMedia(mediaValue, `${path}.media`, active);
    const warnings = projectStringArray(descriptorValue(object.descriptors, "warnings"), `${path}.warnings`, active);
    const timestampValue = descriptorValue(object.descriptors, "timestamp");
    if (timestampValue !== null && typeof timestampValue !== "string") invalid(`${path}.timestamp must be a string or null`);
    const timestamp = timestampValue !== null && isoTimestampParts(timestampValue) !== null ? timestampValue : null;
    if (timestampValue !== null && timestamp === null && !warnings.includes(invalidTimestampWarning)) {
      warnings.push(invalidTimestampWarning);
    }

    const message: MessageRecord = {
      id,
      timestamp,
      sender,
      direction: direction as Direction,
      text: textValue,
      media,
      kind: kind as MessageKind,
      warnings,
    };
    if ("reply" in object.descriptors) message.reply = projectReply(descriptorValue(object.descriptors, "reply"), `${path}.reply`, active);
    if ("reactions" in object.descriptors) message.reactions = projectReactions(descriptorValue(object.descriptors, "reactions"), `${path}.reactions`, active);
    return message;
  } finally {
    object.done();
  }
}

function projectMessages(value: unknown, active: WeakSet<object>): MessageRecord[] {
  const array = ownDenseArray(value, "messages", active);
  try {
    return array.values.map((message, index) => projectMessage(message, index, active));
  } finally {
    array.done();
  }
}

function canonicalizeExtractionResult(value: unknown): ExtractionResult {
  const active = new WeakSet<object>();
  const allowed = ["chat", "extractedAt", "request", "complete", "warnings", "messages"];
  const object = ownDataDescriptors(value, "document", allowed, allowed, active);
  try {
    const chat = requireString(descriptorValue(object.descriptors, "chat"), "chat", true);
    const extractedAt = requireString(descriptorValue(object.descriptors, "extractedAt"), "extractedAt");
    if (isoTimestampParts(extractedAt) === null) invalid("extractedAt must be a valid normalized ISO-8601 date-time with a timezone");
    const complete = descriptorValue(object.descriptors, "complete");
    if (typeof complete !== "boolean") invalid("complete must be boolean");
    return {
      chat,
      extractedAt,
      request: projectRequest(descriptorValue(object.descriptors, "request"), active),
      complete,
      warnings: projectStringArray(descriptorValue(object.descriptors, "warnings"), "warnings", active),
      messages: projectMessages(descriptorValue(object.descriptors, "messages"), active),
    };
  } finally {
    object.done();
  }
}

function escapeInline(value: string): string {
  return value
    .replace(/\r\n|[\r\n]/g, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/([\\`*_{}\[\]()<>#+\-!|])/g, "\\$1");
}

function mediaLabel(media: MediaInfo): string {
  const fields = [media.type, media.filename, media.caption, media.duration, media.size, media.localPath]
    .filter((field): field is string => typeof field === "string" && field.length > 0)
    .map(escapeInline);
  return `[${fields.join(" - ")}]`;
}

function messageLines(message: MessageRecord): string[] {
  const lines: string[] = [];
  if (message.text !== null && message.text.length > 0) lines.push(...message.text.split(/\r\n|[\r\n]/));
  if (message.media !== null) lines.push(mediaLabel(message.media));
  return lines.length > 0 ? lines : [`[${message.kind}]`];
}

function renderCanonicalMarkdown(result: ExtractionResult): string {
  const lines = [
    `# ${escapeInline(result.chat)}`,
    "",
    `- Extracted: ${result.extractedAt}`,
    `- Requested range: ${result.request.kind === "days"
      ? `Last ${result.request.value} local calendar day(s)`
      : `Newest ${result.request.value} message(s)`}`,
    `- Messages: ${result.messages.length}`,
    `- Complete: ${result.complete ? "Yes" : "No"}`,
  ];

  let previousDate: string | undefined;
  for (const message of result.messages) {
    const parts = message.timestamp === null ? null : isoTimestampParts(message.timestamp);
    const date = parts?.date ?? "Unknown date";
    if (date !== previousDate) {
      lines.push("", `## ${date}`);
      previousDate = date;
    }
    lines.push("", `**${parts?.time ?? "??:??"} - ${escapeInline(message.sender)}:**`);
    for (const line of messageLines(message)) lines.push(line.length === 0 ? ">" : `> ${line}`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...result.warnings.map((warning) => `- ${escapeInline(warning)}`));
  }
  return `${lines.join("\n").replace(/[\r\n]+$/g, "")}\n`;
}

export function renderMarkdown(result: ExtractionResult): string {
  return renderCanonicalMarkdown(canonicalizeExtractionResult(result));
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
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function removeBestEffort(fileSystem: ExportFileSystem, path: string): Promise<void> {
  try {
    await fileSystem.rm(path, { force: true });
  } catch {
    // Cleanup must not change the outcome of the operation being finalized.
  }
}

async function closeBestEffort(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // A prior write/sync/close failure remains the primary error.
  }
}

export async function writeExport(
  result: ExtractionResult,
  format: OutputFormat,
  directory = "exports",
): Promise<string> {
  const canonical = canonicalizeExtractionResult(result);
  if (format !== "md" && format !== "json") throw new Error(`Unsupported export format: ${String(format)}`);

  const body = format === "md" ? renderCanonicalMarkdown(canonical) : `${JSON.stringify(canonical, null, 2)}\n`;
  const canonicalTimestamp = new Date(canonical.extractedAt).toISOString();
  const base = `${safeChatName(canonical.chat)}-${safeTimestamp(canonicalTimestamp)}`;
  const fileSystem = exportFileSystem;
  await fileSystem.mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await fileSystem.open(temporaryPath, "wx");
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    for (let suffix = 0; ; suffix += 1) {
      const finalPath = join(directory, `${base}${suffix === 0 ? "" : `-${suffix}`}.${format}`);
      try {
        await fileSystem.link(temporaryPath, finalPath);
        published = true;
        try {
          await fileSystem.rm(temporaryPath, { force: true });
        } catch {
          try { fileSystem.warn("Export published, but temporary file cleanup required a retry."); } catch { /* publication already committed */ }
          await removeBestEffort(fileSystem, temporaryPath);
        }
        return finalPath;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
  } finally {
    if (handle !== undefined) await closeBestEffort(handle);
    if (!published) await removeBestEffort(fileSystem, temporaryPath);
  }
}
