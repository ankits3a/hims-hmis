import { assertFormulaParses, evaluateFormula } from "./formula";
import { LabError } from "./errors";

/**
 * PLAN 17a T3 — THE FORMULA EVALUATOR. Assertion Book rows **A3, A4 and A9**.
 *
 * Fail-first is discharged by the mutants (see `ranges.test.ts`'s header for why a red run on a
 * brand-new pure module is an unresolved-import error and proves nothing — §2.5).
 */
const LDL = {
  code: "LDL",
  formula: "TC - HDL - TG / 5",
  formulaGuard: "TG < 400",
};

describe("the guarded formula evaluator (17a T3)", () => {
  it("computes Friedewald LDL when the guard holds", () => {
    expect(evaluateFormula(LDL, { TC: 200, HDL: 40, TG: 150 })).toEqual({ computed: true, value: 130 });
  });

  /**
   * ═══ A3 — A FAILED GUARD YIELDS TEXT, NAMING THE GUARD, AND NEVER A NUMBER ═══
   *
   * Friedewald stops describing the patient above a triglyceride of 400. The mutant ignores the
   * guard and returns `70` — a plausible LDL, on a report a cardiologist will act on, for a patient
   * whose real LDL is unknown. The shipped evaluator returns text that says which guard failed, so
   * the clinician knows the number is missing rather than normal.
   */
  it("A3: TG 450 yields 'not calculable (TG < 400)' — text, with the guard named", () => {
    const out = evaluateFormula(LDL, { TC: 200, HDL: 40, TG: 450 });
    expect(out).toEqual({ computed: false, reason: "not calculable (TG < 400)" });
    // The reason NAMES the guard. "not calculable" alone tells a clinician nothing about why.
    expect(out.computed === false && out.reason).toContain("TG < 400");
  });

  /**
   * ═══ A4 — SIBLINGS ARE THE SAME SPECIMEN'S, AND A MISSING ONE IS NAMED ═══
   *
   * The caller builds the sibling map from ONE specimen. This assertion pins the consequence: with
   * TG absent — because it was run on a different tube — the answer is text naming TG, not a
   * computation against whatever TG the patient last had. The mutant supplies the patient's latest
   * TG from any specimen and returns a number composed of two different draws.
   */
  it("A4: a missing sibling is named in the reason, never substituted", () => {
    expect(evaluateFormula(LDL, { TC: 200, HDL: 40 })).toEqual({
      computed: false, reason: "not calculable (TG missing)",
    });
    // The guard is evaluated FIRST and it needs TG too — so the missing-sibling reason wins over
    // the guard's, which is the right order: you cannot know a guard failed on a value you lack.
    expect(evaluateFormula({ ...LDL, formulaGuard: "TG < 400" }, { TC: 200, HDL: 40 }).computed).toBe(false);
  });

  it("an analyte with no formula is not calculable rather than an error", () => {
    expect(evaluateFormula({ code: "HB", formula: null, formulaGuard: null }, {}))
      .toEqual({ computed: false, reason: "not calculable (no formula)" });
  });

  /**
   * ═══ A9 — THE PARSER ACCEPTS ONLY ITS GRAMMAR, AND THIS IS THE ROW THAT MATTERS MOST ═══
   *
   * A formula is CATALOGUE DATA typed by a human and stored in a column. The one-line
   * implementation — `new Function("return " + formula)` — passes every other test in this file and
   * also executes whatever the column happens to contain, on a server holding every patient record
   * in the hospital. **The mutant IS that one-liner**, and its discriminating input is a formula
   * that runs: against the shipped parser it is `catalogue_invalid`; against the mutant it executes.
   */
  it("A9: refuses anything outside the grammar — at UPSERT, where a human can still fix it", () => {
    for (const bad of [
      "process.exit(1)",
      "require('fs').readFileSync('/etc/passwd')",
      "TC - HDL - (TG/5",          // unbalanced
      "TC - HDL)",                  // trailing junk
      "TC ** 2",                    // an operator this grammar does not have
      "TC; DROP TABLE lab_results", // a statement separator
      "",                           // empty
    ]) {
      expect(() => assertFormulaParses(bad, null)).toThrow(LabError);
    }
    // And the legal ones parse, so the refusal is a grammar rather than a blanket.
    expect(() => assertFormulaParses("TC - HDL - TG / 5", "TG < 400")).not.toThrow();
    expect(() => assertFormulaParses("(A + B) * 2 - -3", null)).not.toThrow();
  });

  it("A9b: a guard with no comparison is refused — a bare expression is not a precondition", () => {
    expect(() => assertFormulaParses("TC - HDL", "TG")).toThrow(/has no comparison/);
    for (const op of ["<", "<=", ">", ">="]) {
      expect(() => assertFormulaParses("TC - HDL", `TG ${op} 400`)).not.toThrow();
    }
  });

  it("division by zero is a refusal, not Infinity printed as a result", () => {
    expect(() => evaluateFormula({ code: "X", formula: "TC / Z", formulaGuard: null }, { TC: 1, Z: 0 }))
      .toThrow(/division by zero/);
  });

  it("the four operators bind as arithmetic does, and parentheses override", () => {
    const f = (formula: string): unknown => evaluateFormula({ code: "X", formula, formulaGuard: null }, { A: 10, B: 4, C: 2 });
    expect(f("A - B / C")).toEqual({ computed: true, value: 8 });   // not 3
    expect(f("(A - B) / C")).toEqual({ computed: true, value: 3 });
    expect(f("-B + A")).toEqual({ computed: true, value: 6 });
  });
});
