import { describe, expect, it } from "vitest";
import {
  boundaryReached,
  collectMessages,
  fallbackMessageId,
  localCalendarCutoff,
} from "../src/collector.js";
import type { MessageRecord } from "../src/domain.js";

const message = (
  id: string,
  timestamp: string | null,
  overrides: Partial<MessageRecord> = {},
): MessageRecord => ({
  id,
  timestamp,
  sender: "Alice",
  direction: "incoming",
  text: id,
  media: null,
  kind: "message",
  warnings: [],
  ...overrides,
});

describe("fallbackMessageId", () => {
  it("returns a deterministic compact lowercase SHA-256 prefix", () => {
    const { id: _id, ...record } = message("ignored", "2026-08-04T09:00:00+03:00");

    const first = fallbackMessageId("Family", record);
    const second = fallbackMessageId("Family", { ...record });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{24}$/);
  });

  it.each([
    ["chat", "Friends"],
    ["sender", "Bob"],
    ["timestamp", "2026-08-04T09:01:00+03:00"],
    ["direction", "outgoing"],
    ["kind", "call"],
    ["text", "different"],
    ["media", { type: "image", caption: "photo" }],
  ] as const)("changes when %s changes", (field, replacement) => {
    const { id: _id, ...record } = message("ignored", "2026-08-04T09:00:00+03:00");
    const baseline = fallbackMessageId("Family", record);
    const changed =
      field === "chat"
        ? fallbackMessageId(replacement, record)
        : fallbackMessageId("Family", { ...record, [field]: replacement });

    expect(changed).not.toBe(baseline);
  });

  it("ignores warnings, reply metadata, and reactions", () => {
    const { id: _id, ...record } = message("ignored", "2026-08-04T09:00:00+03:00");
    const baseline = fallbackMessageId("Family", record);

    expect(
      fallbackMessageId("Family", {
        ...record,
        warnings: ["diagnostic"],
        reply: { sender: "Bob", text: "Earlier" },
        reactions: [{ emoji: "👍", count: 2 }],
      }),
    ).toBe(baseline);
  });
});

describe("localCalendarCutoff", () => {
  it("uses inclusive local calendar days", () => {
    const now = new Date(2026, 7, 4, 12, 0, 0);
    const cutoff = localCalendarCutoff(now, 3);

    expect(cutoff.getFullYear()).toBe(2026);
    expect(cutoff.getMonth()).toBe(7);
    expect(cutoff.getDate()).toBe(2);
    expect(cutoff.getHours()).toBe(0);
    expect(cutoff.getMinutes()).toBe(0);
    expect(cutoff.getSeconds()).toBe(0);
    expect(cutoff.getMilliseconds()).toBe(0);
    expect(now.getHours()).toBe(12);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid day count: %s",
    (days) => {
      expect(() => localCalendarCutoff(new Date(), days)).toThrow(
        /days.*positive integer/i,
      );
    },
  );
});

describe("boundaryReached", () => {
  it("reaches a message boundary only at the requested unique count", () => {
    const records = [
      message("a", "2026-08-04T08:00:00+03:00"),
      message("a", "2026-08-04T08:00:00+03:00"),
      message("b", "2026-08-04T09:00:00+03:00"),
    ];
    const now = new Date("2026-08-04T12:00:00+03:00");

    expect(boundaryReached(records, { kind: "messages", value: 3 }, now)).toBe(false);
    expect(boundaryReached(records, { kind: "messages", value: 2 }, now)).toBe(true);
  });

  it("reaches a day boundary only after seeing a timestamp older than cutoff", () => {
    const now = new Date(2026, 7, 4, 12, 0, 0);
    const atCutoff = new Date(2026, 7, 2, 0, 0, 0).toISOString();
    const older = new Date(2026, 7, 1, 23, 59, 59).toISOString();

    expect(
      boundaryReached(
        [message("unknown", null), message("edge", atCutoff)],
        { kind: "days", value: 3 },
        now,
      ),
    ).toBe(false);
    expect(
      boundaryReached([message("old", older)], { kind: "days", value: 3 }, now),
    ).toBe(true);
  });

  it("rejects invalid limits even when CLI validation is bypassed", () => {
    expect(() =>
      boundaryReached([], { kind: "messages", value: 0 }, new Date()),
    ).toThrow(/messages.*positive integer/i);
    expect(() =>
      boundaryReached([], { kind: "days", value: Number.NaN }, new Date()),
    ).toThrow(/days.*positive integer/i);
  });
});

describe("collectMessages", () => {
  it("deduplicates overlapping windows, retains the latest duplicate, and sorts chronologically", () => {
    const earlierDuplicate = message("b", "2026-08-04T10:00:00+03:00", {
      text: "earlier copy",
    });
    const latestDuplicate = message("b", "2026-08-04T10:00:00+03:00", {
      text: "latest copy",
    });
    const result = collectMessages(
      [
        [earlierDuplicate],
        [message("a", "2026-08-04T09:00:00+03:00"), latestDuplicate],
      ],
      { kind: "messages", value: 10 },
      new Date("2026-08-04T12:00:00+03:00"),
    );

    expect(result.messages.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(result.messages[1]?.text).toBe("latest copy");
  });

  it("keeps only the newest requested count", () => {
    const result = collectMessages(
      [[
        message("a", "2026-08-04T08:00:00+03:00"),
        message("c", "2026-08-04T10:00:00+03:00"),
        message("b", "2026-08-04T09:00:00+03:00"),
      ]],
      { kind: "messages", value: 2 },
      new Date("2026-08-04T12:00:00+03:00"),
    );

    expect(result.messages.map(({ id }) => id)).toEqual(["b", "c"]);
  });

  it("includes the day cutoff, excludes older and null timestamps, and reports the null count", () => {
    const now = new Date(2026, 7, 4, 12, 0, 0);
    const result = collectMessages(
      [[
        message("old", new Date(2026, 7, 1, 23, 59, 59).toISOString()),
        message("edge", new Date(2026, 7, 2, 0, 0, 0).toISOString()),
        message("new", new Date(2026, 7, 4, 11, 0, 0).toISOString()),
        message("unknown-1", null),
        message("unknown-2", null),
      ]],
      { kind: "days", value: 3 },
      now,
    );

    expect(result.messages.map(({ id }) => id)).toEqual(["edge", "new"]);
    expect(result.warnings).toEqual([
      "Excluded 2 message(s) with incomplete timestamps from the day boundary.",
    ]);
  });

  it("does not mutate input windows or records", () => {
    const first = message("b", "2026-08-04T10:00:00+03:00");
    const second = message("a", "2026-08-04T09:00:00+03:00");
    const window = [first, second];

    collectMessages(
      [window],
      { kind: "messages", value: 1 },
      new Date("2026-08-04T12:00:00+03:00"),
    );

    expect(window).toEqual([first, second]);
    expect(first).toEqual(message("b", "2026-08-04T10:00:00+03:00"));
  });

  it("rejects invalid limits even when CLI validation is bypassed", () => {
    expect(() =>
      collectMessages([], { kind: "days", value: 0 }, new Date()),
    ).toThrow(/days.*positive integer/i);
    expect(() =>
      collectMessages([], { kind: "messages", value: 1.5 }, new Date()),
    ).toThrow(/messages.*positive integer/i);
  });
});
