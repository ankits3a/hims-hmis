import { evaluateFormula, formulaInputCodes } from "../../../../packages/contracts/src/lab-formula";
import { previewFlag, type QuickAnalyte, type QuickCatalogue, type QuickChosenTest, type QuickLine, type QuickRange } from "./api";

/**
 * THE BENCH FORM'S RULES — the web `ResultsPanel`'s (apps/web/src/screens/lab-quick.tsx), kept out of
 * the screen so they read alone. Calculated parameters (LDL, ACR …) fill themselves with the
 * server's own parser (shared from contracts, no imports); the server drops anything sent for them
 * and computes them again on save, so the save never carries them.
 */
export type Row = { analyteId: string; value: string };

export const isCalc = (a: QuickAnalyte | undefined): boolean => a?.resultType === "formula";

export function calculatedValues(rows: readonly Row[], byId: ReadonlyMap<string, QuickAnalyte>): Map<string, string> {
  const out = new Map<string, string>();
  const siblings: Record<string, number | undefined> = {};
  for (const r of rows) {
    const a = byId.get(r.analyteId);
    const n = Number(r.value);
    if (a && !isCalc(a) && r.value.trim() !== "" && Number.isFinite(n)) siblings[a.code] = n;
  }
  const formulas = rows.map((r) => byId.get(r.analyteId)).filter((a): a is QuickAnalyte => isCalc(a) && (a?.formula ?? null) !== null);
  for (let pass = 0; pass < formulas.length; pass += 1) {
    let progressed = false;
    for (const a of formulas) {
      if (out.has(a.analyteId)) continue;
      if (!formulaInputCodes(a.formula ?? null, a.formulaGuard ?? null).every((c) => siblings[c] !== undefined)) continue;
      let value: string;
      try {
        const o = evaluateFormula({ code: a.code, formula: a.formula ?? null, formulaGuard: a.formulaGuard ?? null }, siblings);
        value = o.computed ? o.value.toFixed(Math.max(0, Math.min(6, a.decimals))) : o.reason;
      } catch { value = "not calculable"; }
      if (Number.isFinite(Number(value))) siblings[a.code] = Number(value);
      out.set(a.analyteId, value);
      progressed = true;
    }
    if (!progressed) break;
  }
  return out;
}

/** What the form shows per row: a typed value, or the calculated one. */
export function shownValue(r: Row, byId: ReadonlyMap<string, QuickAnalyte>, calc: ReadonlyMap<string, string>): string {
  return isCalc(byId.get(r.analyteId)) ? calc.get(r.analyteId) ?? "" : r.value;
}

export function previewLines(rows: readonly Row[], byId: ReadonlyMap<string, QuickAnalyte>, calc: ReadonlyMap<string, string>, ranges: ReadonlyMap<string, QuickRange>): QuickLine[] {
  return rows.flatMap((r0) => {
    const a = byId.get(r0.analyteId);
    if (!a) return [];
    const value = shownValue(r0, byId, calc);
    const range = ranges.get(r0.analyteId);
    return [{
      analyteId: a.analyteId, code: a.code, nameEn: a.nameEn, unit: a.unit, value,
      low: range?.low ?? null, high: range?.high ?? null, refText: range?.text ?? null,
      flag: a.resultType === "numeric" || a.resultType === "formula" ? previewFlag(value, range) : null,
    }];
  });
}

/** The save's lines: typed values only — never a calculated row, never an empty one. */
export function saveLines(rows: readonly Row[], byId: ReadonlyMap<string, QuickAnalyte>): Row[] {
  return rows.filter((r) => r.value.trim() !== "" && !isCalc(byId.get(r.analyteId))).map((r) => ({ analyteId: r.analyteId, value: r.value }));
}

/** The rows under each chosen test's name, as the web groups them; anything left goes under `other`. */
export function groupByTest(tests: readonly QuickChosenTest[], catalogue: QuickCatalogue | undefined, ids: readonly string[], other: string): { title: string; ids: string[] }[] {
  const left = new Set(ids);
  const groups: { title: string; ids: string[] }[] = [];
  for (const t of tests) {
    const mine = (catalogue?.tests.find((c) => c.serviceId === t.serviceId)?.analyteIds ?? []).filter((id) => left.has(id));
    mine.forEach((id) => left.delete(id));
    if (mine.length > 0) groups.push({ title: t.nameEn, ids: ids.filter((id) => mine.includes(id)) });
  }
  if (left.size > 0) groups.push({ title: other, ids: ids.filter((id) => left.has(id)) });
  return groups;
}
