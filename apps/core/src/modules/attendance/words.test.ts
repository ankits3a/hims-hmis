import { CONFIRM_REASONS, DAY_WORDS, KNOWN_STATUSES, dayWord, readRange, selfWord } from "./reads";

/** Owner 2026-10-09: Present, Absent, Leave, Off, Partial — "late days simply show as Present". */
describe("the five words a person sees of their own day", () => {
  it("every status in the guide has its word, with and without a punch", () => {
    const want: Record<(typeof KNOWN_STATUSES)[number], [punched: string, unpunched: string]> = {
      on_time: ["present", "present"], late: ["present", "present"],
      worked_on_holiday: ["present", "present"], worked_on_off_day: ["present", "present"], on_call_worked: ["present", "present"],
      below_min_full: ["partial", "partial"], below_min_half: ["partial", "partial"], single_punch: ["partial", "partial"],
      absent: ["absent", "absent"],
      approved_leave: ["leave", "leave"],
      weekly_off: ["off", "off"], holiday: ["off", "off"], on_call: ["off", "off"],
      no_shift: ["present", "off"],
    };
    expect(Object.keys(want).sort()).toEqual([...KNOWN_STATUSES].sort());
    for (const status of KNOWN_STATUSES) {
      expect([status, dayWord(status, true), dayWord(status, false)]).toEqual([status, ...want[status]]);
    }
  });

  it("a status bioattend adds later is `unknown`, never a guess — and never an object key by accident", () => {
    expect(dayWord("comp_off", true)).toBe("unknown");
    expect(dayWord("", false)).toBe("unknown");
    expect(dayWord("constructor", true)).toBe("unknown");
    expect(dayWord("toString", false)).toBe("unknown");
  });

  it("the words are five and `unknown`", () => {
    expect([...DAY_WORDS]).toEqual(["present", "absent", "leave", "off", "partial", "unknown"]);
  });
});

/** Owner 2026-10-09: a forgotten evening punch reads "Confirm" the next day, with a fixed reason. */
describe("what a person sees of their own day — the five words and `confirm`", () => {
  const TODAY = "2026-03-10";
  it("a PAST day with one punch is `confirm` with the reason `one_punch_only` — not `partial`", () => {
    expect(selfWord("single_punch", true, "2026-03-09", TODAY)).toEqual({ status: "confirm", reason: "one_punch_only" });
    expect(selfWord("single_punch", true, "2026-02-01", TODAY)).toEqual({ status: "confirm", reason: "one_punch_only" });
  });
  it("TODAY's single punch is not a forgotten one yet: it is never `confirm`", () => {
    expect(selfWord("single_punch", true, TODAY, TODAY)).toEqual({ status: "partial" });
    expect(selfWord("single_punch", true, "2026-03-11", TODAY)).toEqual({ status: "partial" });
  });
  it("every other status is its ordinary word on any date, with no reason", () => {
    for (const status of KNOWN_STATUSES) {
      if (status === "single_punch") continue;
      for (const punched of [true, false]) expect(selfWord(status, punched, "2026-03-01", TODAY)).toEqual({ status: dayWord(status, punched) });
    }
    expect(selfWord("comp_off", true, "2026-03-01", TODAY)).toEqual({ status: "unknown" });
  });
  it("ships exactly one reason code", () => {
    expect([...CONFIRM_REASONS]).toEqual(["one_punch_only"]);
  });
});

describe("a read range", () => {
  const TODAY = "2026-03-10";
  it("defaults to the last seven days", () => {
    expect(readRange({}, TODAY)).toEqual({ from: "2026-03-04", to: "2026-03-10" });
  });
  it("is at most 92 days and never reversed", () => {
    expect(readRange({ from: "2025-12-09", to: "2026-03-10" }, TODAY)).toEqual({ from: "2025-12-09", to: "2026-03-10" }); // 23 + 31 + 28 + 10 = 92
    expect(() => readRange({ from: "2025-12-08", to: "2026-03-10" }, TODAY)).toThrow("range_too_long");
    expect(() => readRange({ from: "2026-03-10", to: "2026-03-09" }, TODAY)).toThrow("range_reversed");
  });
  it("reaches fourteen days ahead for the roster and no further", () => {
    expect(readRange({ from: "2026-03-10", to: "2026-03-24" }, TODAY)).toEqual({ from: "2026-03-10", to: "2026-03-24" });
    expect(() => readRange({ from: "2026-03-10", to: "2026-03-25" }, TODAY)).toThrow("too_far_ahead");
  });
  it("refuses a date that is not a date", () => {
    expect(() => readRange({ from: "2026-02-30", to: "2026-03-01" }, TODAY)).toThrow("bad_date");
    expect(() => readRange({ from: "10-03-2026" }, TODAY)).toThrow("bad_date");
  });
});
