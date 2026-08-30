import { describe, expect, it } from "vitest";
import { parseBatchCommands, parseCommand } from "../src/options.js";

describe("parseBatchCommands", () => {
  it("builds multiple exact-chat scrapes with shared options", () => {
    expect(parseBatchCommands(["Events A", "Events B", "--days", "7", "--format", "json"])).toEqual([
      { kind: "scrape", chat: "Events A", limit: { kind: "days", value: 7 }, format: "json", diagnostics: false },
      { kind: "scrape", chat: "Events B", limit: { kind: "days", value: 7 }, format: "json", diagnostics: false },
    ]);
  });
});

describe("parseCommand", () => {
  it("parses login when it is the sole argument", () => {
    expect(parseCommand(["login"])).toEqual({ kind: "login" });
  });

  it("parses a days-limited scrape with defaults", () => {
    expect(parseCommand(["Family Group", "--days", "3"])).toEqual({
      kind: "scrape",
      chat: "Family Group",
      limit: { kind: "days", value: 3 },
      format: "md",
      diagnostics: false,
    });
  });

  it("trims the chat name", () => {
    expect(parseCommand(["  Family Group  ", "--days", "3"])).toMatchObject({
      chat: "Family Group",
    });
  });

  it("parses a message-limited JSON scrape", () => {
    expect(
      parseCommand(["David", "--messages", "200", "--format", "json"]),
    ).toEqual({
      kind: "scrape",
      chat: "David",
      limit: { kind: "messages", value: 200 },
      format: "json",
      diagnostics: false,
    });
  });

  it("enables diagnostics when requested", () => {
    expect(parseCommand(["David", "--days", "1", "--diagnostics"])).toMatchObject({
      kind: "scrape",
      diagnostics: true,
    });
  });

  it.each([
    { args: [], reason: /chat/i },
    { args: ["David"], reason: /--days|--messages/i },
  ])("rejects a missing chat or limit: $args", ({ args, reason }) => {
    expect(() => parseCommand(args)).toThrow(reason);
  });

  it("rejects both limit options", () => {
    expect(() =>
      parseCommand(["David", "--days", "3", "--messages", "200"]),
    ).toThrow(/exactly one.*--days.*--messages/i);
  });

  it.each(["0", "-1", "1.5", "abc"])(
    "rejects an invalid --days limit: %s",
    (value) => {
      expect(() => parseCommand(["David", "--days", value])).toThrow(
        /--days.*positive integer/i,
      );
    },
  );

  it.each(["0", "-1", "1.5", "abc"])(
    "rejects an invalid --messages limit: %s",
    (value) => {
      expect(() => parseCommand(["David", "--messages", value])).toThrow(
        /--messages.*positive integer/i,
      );
    },
  );

  it("rejects an invalid output format", () => {
    expect(() =>
      parseCommand(["David", "--days", "3", "--format", "csv"]),
    ).toThrow(/--format.*md.*json/i);
  });

  it.each([
    ["", "--days", "3"],
    ["   ", "--days", "3"],
    ["David", "extra", "--days", "3"],
  ])("rejects empty or extra chat positionals: %j", (...args) => {
    expect(() => parseCommand(args)).toThrow(/exactly one nonblank chat/i);
  });

  it("rejects login with additional arguments", () => {
    expect(() => parseCommand(["login", "--days", "1"])).toThrow(
      /login.*sole argument/i,
    );
  });

  it("rejects unknown flags", () => {
    expect(() => parseCommand(["David", "--days", "3", "--unknown"])).toThrow(
      /unknown|option/i,
    );
  });
});
