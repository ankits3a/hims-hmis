import { agePartsOf, ageOrDobText, ageReadingText, formAgeYears, formNeedsGuardian, parseAgeOrDob } from "./session";
import { ageOf } from "./model";

/**
 * OWNER, 2026-10-01 — "our system should be smart enough to understand if it's date of birth or
 * simple age in number." One box; what is typed decides. `TODAY` is fixed so the two-digit-year and
 * future-date rules are about the rule, not about the day the suite runs.
 */
const TODAY = new Date(2026, 9, 1); // 1 Oct 2026, local

describe("parseAgeOrDob — one box reads an age or a date of birth", () => {
  it.each([
    ["34", { kind: "age", years: 34 }],
    ["0", { kind: "age", years: 0 }],
    [" 130 ", { kind: "age", years: 130 }],
    ["14/03/1986", { kind: "dob", iso: "1986-03-14" }],
    ["14-3-1986", { kind: "dob", iso: "1986-03-14" }],
    ["14.03.1986", { kind: "dob", iso: "1986-03-14" }],
    ["14 3 1986", { kind: "dob", iso: "1986-03-14" }],
    ["14031986", { kind: "dob", iso: "1986-03-14" }],
    ["1986-03-14", { kind: "dob", iso: "1986-03-14" }],
    ["5/7/86", { kind: "dob", iso: "1986-07-05" }], // a two-digit year ahead of this one is last century
    ["5/7/19", { kind: "dob", iso: "2019-07-05" }], // …and one that is not is this century
    ["01/10/2026", { kind: "dob", iso: "2026-10-01" }], // born today
  ])("%s", (typed, expected) => {
    expect(parseAgeOrDob(typed, TODAY)).toEqual(expected);
  });

  it.each([
    "", "131", "14/03", "14/03/198", "31/02/1990", "13/13/1990", "02/10/2026", "01/01/1890", "1986", "abc", "14/03/1986x", "3403",
  ])("reads nothing from %j", (typed) => {
    expect(parseAgeOrDob(typed, TODAY)).toBeNull();
  });

  it("day comes first, as India writes it: 03/04/1990 is the third of April", () => {
    expect(parseAgeOrDob("03/04/1990", TODAY)).toEqual({ kind: "dob", iso: "1990-04-03" });
  });

  it("a form that already holds a date of birth shows it day-first; one holding an age shows the number", () => {
    expect(ageOrDobText({ ageMode: "dob", dob: "1986-03-14", age: "" })).toBe("14/03/1986");
    expect(ageOrDobText({ ageMode: "age", dob: "", age: "34" })).toBe("34");
    expect(parseAgeOrDob(ageOrDobText({ ageMode: "dob", dob: "1986-03-14", age: "" }), TODAY)).toEqual({ kind: "dob", iso: "1986-03-14" });
  });
});

/**
 * A THREE-MONTH-OLD COULD ONLY BE TYPED AS 0 OR 1, and a baby's exact date of birth read back
 * "0 y". The box now takes a baby's age in months, weeks or days, and says it back the same way.
 */
describe("a baby's age in the same box", () => {
  it.each([
    ["3m", { kind: "age", years: 0, months: 3 }],
    ["3 months", { kind: "age", years: 0, months: 3 }],
    ["3 Mo", { kind: "age", years: 0, months: 3 }],
    ["45d", { kind: "age", years: 0, days: 45 }],
    ["10 days", { kind: "age", years: 0, days: 10 }],
    ["6w", { kind: "age", years: 0, days: 42 }],
    ["2m 10d", { kind: "age", years: 0, months: 2, days: 10 }],
    ["1y 6m", { kind: "age", years: 1, months: 6 }],
    ["1y6m", { kind: "age", years: 1, months: 6 }],
    ["2 yrs, 3 months", { kind: "age", years: 2, months: 3 }],
    ["18m", { kind: "age", years: 1, months: 6 }], // months alone roll into years
    ["34y", { kind: "age", years: 34 }],
    ["0d", { kind: "age", years: 0 }],
  ])("%s", (typed, expected) => {
    expect(parseAgeOrDob(typed, TODAY)).toEqual(expected);
  });

  it.each(["m", "3x", "1y 12m", "2m 31d", "400d", "131y", "3m 2y", "3 m 4", "14/03/86y"])("reads nothing from %j", (typed) => {
    expect(parseAgeOrDob(typed, TODAY)).toBeNull();
  });

  it("an age is written back in the form it reads again — a plain age stays a plain number", () => {
    for (const typed of ["34", "3m", "45d", "1y 6m", "2m 10d"]) {
      const read = parseAgeOrDob(typed, TODAY);
      if (read?.kind !== "age") throw new Error(typed);
      expect(ageReadingText(read)).toBe(typed);
      expect(parseAgeOrDob(ageReadingText(read), TODAY)).toEqual(read);
    }
    expect(ageOrDobText({ ageMode: "age", dob: "", age: "3m" })).toBe("3m");
  });

  it("a three-month-old is 0 whole years, so the guardian rule still holds; a typed baby age is never unknown", () => {
    expect(formAgeYears({ ageMode: "age", age: "3m", dob: "" })).toBe(0);
    expect(formNeedsGuardian({ ageMode: "age", age: "3m", dob: "" })).toBe(true);
    expect(formAgeYears({ ageMode: "age", age: "3x", dob: "" })).toBeNull();
  });
});

describe("agePartsOf / ageOf — completed years, months and days in the IST calendar", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a baby born on 14 Jul is 3 m 9 d on 23 Oct, labelled 3m — not 0", () => {
    const at = new Date("2026-10-23T06:30:00Z"); // 12:00 IST
    expect(agePartsOf("2026-07-14", at)).toEqual({ years: 0, months: 3, days: 9 });
    expect(agePartsOf("2026-10-23", at)).toEqual({ years: 0, months: 0, days: 0 });
    expect(agePartsOf("2026-09-30", at)).toEqual({ years: 0, months: 0, days: 23 }); // borrows September's 30 days
    expect(agePartsOf("1986-03-14", at)).toEqual({ years: 40, months: 7, days: 9 });
    expect(agePartsOf("2026-10-24", at)).toBeNull();
    vi.setSystemTime(at);
    expect(ageOf("2026-07-14")).toBe("3m");
    expect(ageOf("2026-10-11")).toBe("12d");
    expect(ageOf("1986-03-14")).toBe("40");
  });

  it("days borrow from the month before today, at 02:00 IST on the first of the month too", () => {
    const at = new Date("2026-02-28T20:30:00Z"); // 02:00 IST, 1 Mar — UTC still says 28 Feb
    expect(agePartsOf("2026-01-31", at)).toEqual({ years: 0, months: 1, days: 1 });
  });
});
