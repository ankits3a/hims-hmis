import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import {
  KNOWN_STATUSES, WORD_TONE, addMonths, clampToToday, clockOf, confirmSummary, countWords, dayWord, managerDay, monthDays, monthGrid, reasonKey, selfWord,
  sortToday, todayCounts, todayPlace, weekOf, weekdayOf, wordKey,
} from "../src/attendance/rules";
import { translate } from "../src/i18n";

const person = (name: string, status: string | null, firstIn: string | null, over: Partial<{ lastOut: string | null; onDuty: boolean }> = {}) =>
  ({ name, status, firstIn, lastOut: over.lastOut ?? null, onDuty: over.onDuty ?? false });

describe("attendance, as the phone and the server both read it", () => {
  it("a person's own day is one of five words; late is Present; a past single punch is Confirm", () => {
    expect(KNOWN_STATUSES.map((s) => dayWord(s, true))).toEqual([
      "present", "present", "partial", "partial", "partial", "absent", "leave", "off", "off", "present", "present", "off", "present", "present",
    ]);
    expect(dayWord("no_shift", false)).toBe("off");
    expect(dayWord("something_new", true)).toBe("unknown");
    expect(dayWord("constructor", true)).toBe("unknown");
    expect(selfWord("single_punch", true, "2026-10-13", "2026-10-14")).toEqual({ status: "confirm", reason: "one_punch_only" });
    expect(selfWord("single_punch", true, "2026-10-14", "2026-10-14")).toEqual({ status: "partial" });
    expect(selfWord("late", true, "2026-10-13", "2026-10-14")).toEqual({ status: "present" });
  });

  it("green present, amber partial, red absent, blue leave, grey off — and Confirm is the warning", () => {
    expect(WORD_TONE).toEqual({ present: "green", partial: "amber", absent: "red", leave: "blue", off: "grey", confirm: "warn", unknown: "none" });
    expect(wordKey("leave")).toBe("attendance.word.leave");
    expect(reasonKey("one_punch_only")).toBe("attendance.reason.one_punch_only");
    expect(reasonKey("a_reason_added_next_year")).toBe("attendance.reason.other");
  });

  it("a manager sees the same word, plus Late and One punch", () => {
    expect(managerDay("late", true)).toEqual({ word: "present", late: true, onePunch: false });
    expect(managerDay("single_punch", true)).toEqual({ word: "partial", late: false, onePunch: true });
    expect(managerDay("on_time", true)).toEqual({ word: "present", late: false, onePunch: false });
  });

  it("today's list: Not in leads, then who came (latest first), then leave, then off; the counts add up", () => {
    const people = [
      person("Chandan", "on_time", "08:51"), person("Pooja", "late", "09:34"), person("Kishore", "absent", null), person("Singh", "approved_leave", null),
      person("Mishra", null, null), person("Verma", "weekly_off", null), person("Night", null, null, { onDuty: true }),
    ];
    expect(people.map(todayPlace)).toEqual(["in", "in", "not_in", "leave", "not_in", "off", "in"]);
    expect(sortToday(people).map((p) => p.name)).toEqual(["Kishore", "Mishra", "Pooja", "Chandan", "Night", "Singh", "Verma"]);
    expect(todayCounts(people)).toEqual({ in: 3, notIn: 2, late: 1, leave: 1, total: 7 });
  });

  it("weeks run Monday to Sunday; a month is rows of seven, Monday first", () => {
    expect(weekdayOf("2026-10-14")).toBe(2); // a Wednesday
    expect(weekOf("2026-10-14")).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(weekOf("2026-11-01")[0]).toBe("2026-10-26"); // a Sunday belongs to the week that began the Monday before
    const grid = monthGrid("2026-10");
    expect(grid).toHaveLength(5);
    expect(grid[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(grid[4]).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", null]);
    expect(monthDays("2028-02")).toHaveLength(29);
    expect(monthGrid("2027-02")).toHaveLength(4); // 1 Feb 2027 is a Monday: four full rows
    expect([addMonths("2026-12", 1), addMonths("2026-01", -1), addMonths("2026-10", 0)]).toEqual(["2027-01", "2025-12", "2026-10"]);
  });

  it("nothing is asked for after today", () => {
    expect(clampToToday("2026-10-12", "2026-10-18", "2026-10-14")).toEqual({ from: "2026-10-12", to: "2026-10-14" });
    expect(clampToToday("2026-10-05", "2026-10-11", "2026-10-14")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(clampToToday("2026-10-19", "2026-10-25", "2026-10-14")).toBeNull();
  });

  it("counts, the Confirm summary and the clock", () => {
    expect(countWords(["present", "present", "partial", "leave", "off", "absent", "confirm", "unknown"])).toEqual({ present: 2, partial: 1, absent: 1, leave: 1, off: 1, confirm: 1, days: 5 });
    expect(confirmSummary([])).toBeNull();
    expect(confirmSummary(["2026-10-09"])).toEqual({ date: "2026-10-09", more: 0 });
    expect(confirmSummary(["2026-10-09", "2026-09-30", "2026-10-02"])).toEqual({ date: "2026-10-09", more: 2 });
    expect([clockOf("2026-10-14 08:58:12"), clockOf("08:58"), clockOf("08:58:12"), clockOf(null), clockOf("soon")]).toEqual(["08:58", "08:58", "08:58", null, null]);
  });
});

/**
 * THE LABEL BUDGET (the brief): every attendance label is ONE line at 360 px — at most 34
 * characters with its longest plausible values filled in — and is a label, not a sentence.
 */
describe("attendance labels — one line at 360 px, in English and Hindi", () => {
  const leaves = (o: unknown, prefix: string): string[] =>
    o !== null && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [`${prefix}.${k}`] : leaves(v, `${prefix}.${k}`))) : [];
  const keys = leaves((en as { attendance: unknown }).attendance, "attendance");
  /** The longest thing each variable is ever filled with. */
  const LONGEST: Record<"en" | "hi", Record<string, string | number>> = {
    en: { day: "Wed 30", dow: "Wed", d: 30, month: "September", n: 999, of: 999, time: "23:59" },
    hi: { day: "शुक्र 30", dow: "शुक्र", d: 30, month: "अक्टूबर", n: 999, of: 999, time: "23:59" },
  };

  it("has a non-trivial set of labels, the same keys in both languages", () => {
    expect(keys.length).toBeGreaterThan(90);
    expect(leaves((hi as { attendance: unknown }).attendance, "attendance").sort()).toEqual([...keys].sort());
  });

  it.each(["en", "hi"] as const)("%s: no label is over 34 characters, breaks a line, or is a sentence", (lang) => {
    const over: string[] = [];
    for (const key of keys) {
      const text = translate(lang, key, LONGEST[lang]);
      expect(text).not.toBe(key);
      expect(text).not.toMatch(/\{\{/); // every variable was filled: the budget is measured on what is drawn
      if ([...text].length > 34 || /\n/.test(text) || /[.।!?]$/.test(text) || /[.।!?]\s/.test(text)) over.push(`${key} = "${text}" (${String([...text].length)})`);
    }
    expect(over).toEqual([]);
  });

  it("Hindi says something of its own for every word a person reads (not the English left in)", () => {
    for (const key of keys.filter((k) => !/\.(of|dayLabel|dateLabel|confirmMore|unknown)$/.test(k))) {
      expect([key, translate("hi", key)]).not.toEqual([key, translate("en", key)]);
    }
  });
});
