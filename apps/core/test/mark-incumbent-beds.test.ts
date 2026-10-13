import { formatIncumbentReport, parseIncumbentLines } from "../scripts/mark-incumbent-beds";

/** E1.1 (#718) — the cutover script's file grammar and its report. The marking itself is `modules/ipd/beds.test.ts`. */
describe("scripts/mark-incumbent-beds", () => {
  it("reads one code per line with an optional M/F, skipping blanks and comments", () => {
    expect(parseIncumbentLines("# cutover\nF05-B1\n\nF05-R3-B1, f\n")).toEqual({
      lines: [{ code: "F05-B1" }, { code: "F05-R3-B1", gender: "female" }], problems: [],
    });
  });
  it("names every bad line by number", () => {
    expect(parseIncumbentLines("F05-B1,X\nA,B,C").problems).toEqual([
      'line 1: expected "BEDCODE" or "BEDCODE,M|F", got "F05-B1,X"',
      'line 2: expected "BEDCODE" or "BEDCODE,M|F", got "A,B,C"',
    ]);
  });
  it("says a dry run wrote nothing and a run with problems wrote nothing", () => {
    expect(formatIncumbentReport({ mark: ["A"], already: [], problems: [] }, false)).toMatch(/Would mark 1 .*\nDry run: nothing written/);
    expect(formatIncumbentReport({ mark: ["A"], already: [], problems: [{ code: "B", problem: "bed is blocked" }] }, true))
      .toMatch(/PROBLEM B: bed is blocked\nNothing was written/);
    expect(formatIncumbentReport({ mark: ["A"], already: ["C"], problems: [] }, true)).toBe("Marked 1 bed(s) incumbent; already incumbent: 1.");
  });
});
