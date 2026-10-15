import { LabError } from "./errors";
import {
  assertFormulaParses as parsesShared, evaluateFormula as evaluateShared, formulaInputCodes, FormulaError,
} from "@hmis/contracts";
import type { FormulaOutcome, Siblings } from "@hmis/contracts";

/**
 * PLAN 17a T3 / DD3 — THE FORMULA EVALUATOR. The parser itself lives in `packages/contracts`
 * (`lab-formula.ts`, owner 2026-10-11) so the Quick Bench screen previews a calculated parameter with
 * the same grammar; read the WHY there. This file is the lab's door to it: a malformed formula or a
 * division by zero leaves as `catalogue_invalid`, the refusal a curator and a bench have always seen.
 */
export { formulaInputCodes };
export type { FormulaOutcome, Siblings };

function asLab<T>(f: () => T): T {
  try { return f(); } catch (e) {
    if (e instanceof FormulaError) throw new LabError("catalogue_invalid", e.message);
    throw e;
  }
}

export function evaluateFormula(
  analyte: { code: string; formula: string | null; formulaGuard: string | null },
  siblings: Siblings,
): FormulaOutcome {
  return asLab(() => evaluateShared(analyte, siblings));
}

export function assertFormulaParses(formula: string, guard: string | null): void {
  asLab(() => parsesShared(formula, guard));
}
