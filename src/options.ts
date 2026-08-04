import { parseArgs } from "node:util";
import type { CliCommand, ScrapeLimit } from "./domain.js";

function parsePositiveInteger(option: "--days" | "--messages", value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${option} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }

  return parsed;
}

export function parseCommand(args: string[]): CliCommand {
  if (args[0] === "login") {
    if (args.length !== 1) {
      throw new Error("login must be the sole argument");
    }
    return { kind: "login" };
  }

  const normalizedArgs = args.flatMap((arg, index) => {
    const previous = args[index - 1];
    if ((previous === "--days" || previous === "--messages") && /^-\d/.test(arg)) {
      return [];
    }
    if ((arg === "--days" || arg === "--messages") && /^-\d/.test(args[index + 1] ?? "")) {
      return [`${arg}=${args[index + 1]}`];
    }
    return [arg];
  });

  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    strict: true,
    allowPositionals: true,
    options: {
      days: { type: "string" },
      messages: { type: "string" },
      format: { type: "string" },
      diagnostics: { type: "boolean" },
    },
  });

  const chat = positionals[0];
  if (positionals.length !== 1 || chat === undefined || chat.trim() === "") {
    throw new Error("exactly one nonblank chat is required");
  }

  const hasDays = values.days !== undefined;
  const hasMessages = values.messages !== undefined;
  if (hasDays === hasMessages) {
    throw new Error("exactly one of --days or --messages is required");
  }

  let limit: ScrapeLimit;
  if (values.days !== undefined) {
    limit = { kind: "days", value: parsePositiveInteger("--days", values.days) };
  } else {
    limit = {
      kind: "messages",
      value: parsePositiveInteger("--messages", values.messages!),
    };
  }

  const format = values.format ?? "md";
  if (format !== "md" && format !== "json") {
    throw new Error("--format must be md or json");
  }

  return {
    kind: "scrape",
    chat: chat.trim(),
    limit,
    format,
    diagnostics: values.diagnostics ?? false,
  };
}
