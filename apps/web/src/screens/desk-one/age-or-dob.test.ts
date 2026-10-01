import { ageOrDobText, parseAgeOrDob } from "./session";

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
