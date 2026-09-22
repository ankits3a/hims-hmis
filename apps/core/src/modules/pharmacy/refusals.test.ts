import { authorisationKey, refusalKey, refusalsOf, refusalsOn } from "./refusals";
import type { RxCheckOutcome } from "../opd";

/**
 * The one definition of what the check refuses (verify, and PD-7 C3 before anything is chosen).
 * Pure: an outcome in, the refusals out, with the check's line indexes mapped back through `origIdx`.
 */
const none: RxCheckOutcome = { allergyMatches: [], interactions: [], duplicates: [], drugDisease: [], unresolvedLineIndexes: [], unreviewedLineIndexes: [] };
const ident = (i: number): number => i;
const DX = { code: "K72.90", text: "Hepatic failure", codedOn: "2026-08-01", encounterId: "e" };

describe("refusalsOf — the four books, as the check acts on them", () => {
  it("an allergy or a severe pair is refused unless the prescriber overrode THAT hit on THAT line", () => {
    const outcome: RxCheckOutcome = {
      ...none,
      allergyMatches: [{ lineIndex: 0, substance: "Paracetamol" }],
      interactions: [
        { severity: "severe", lineIndex: 1, saltPair: ["a", "b"], note: "QT", against: { scope: "in_rx", lineIndex: 0 } },
        { severity: "moderate", lineIndex: 1, saltPair: ["a", "c"], note: "mild", against: { scope: "in_rx", lineIndex: 0 } },
      ],
    };
    expect(refusalsOf(outcome, ident, {}, new Set())).toMatchObject({
      allergy: [{ lineIdx: 0, substance: "Paracetamol" }],
      interaction: [{ lineIdx: 1, withLineIdx: 0, note: "QT" }],
    });
    const overridden = refusalsOf(outcome, ident, {
      allergyOverrides: [{ lineIndex: 0, substance: "Paracetamol", reason: "tolerated before" }],
      interactionOverrides: [{ lineIndex: 1, saltPair: ["b", "a"], reason: "monitored" }],
    }, new Set());
    expect(overridden).toMatchObject({ allergy: [], interaction: [] });
  });

  it("a severe pair counts on BOTH its lines — the pre-check of line 0 must see a pair flagged on line 1", () => {
    const r = refusalsOf({ ...none, interactions: [{ severity: "severe", lineIndex: 1, saltPair: ["a", "b"], note: "QT", against: { scope: "in_rx", lineIndex: 0 } }] }, ident, {}, new Set());
    expect(refusalsOn(r, 0).interaction).toHaveLength(1);
    expect(refusalsOn(r, 1).interaction).toHaveLength(1);
    expect(refusalsOn(r, 2).interaction).toHaveLength(0);
  });

  it("a hard duplicate is refused only where a line was READ here, and lands on that line", () => {
    const outcome: RxCheckOutcome = { ...none, duplicates: [{ moiety: "Paracetamol", lineIndex: 1, hard: true, against: { scope: "in_rx", lineIndex: 0 } }] };
    expect(refusalsOf(outcome, ident, {}, new Set()).duplicate).toEqual([]); // doctor-named pair: met at issue
    expect(refusalsOf(outcome, ident, {}, new Set([0])).duplicate).toEqual([{ lineIdx: 0, moiety: "Paracetamol" }]);
    expect(refusalsOf({ ...outcome, duplicates: [{ ...outcome.duplicates[0]!, hard: false }] }, ident, {}, new Set([0])).duplicate).toEqual([]);
  });

  it("a severe drug×disease hit is refused on any line unless its ruling was overridden; a moderate one never", () => {
    const hit = { severity: "severe" as const, lineIndex: 0, moiety: "Paracetamol", icd10Prefix: "K72", icd10Title: "Hepatic failure", diagnosis: DX, note: "n", alternatives: [], stale: false };
    const outcome = { ...none, drugDisease: [hit] } as RxCheckOutcome;
    expect(refusalsOf(outcome, ident, {}, new Set()).drugDisease).toEqual([{ lineIdx: 0, moiety: "Paracetamol", icd10Prefix: "K72", icd10Title: "Hepatic failure" }]);
    expect(refusalsOf(outcome, ident, { drugDiseaseOverrides: [{ lineIndex: 0, moiety: "Paracetamol", icd10Prefix: "K72", reason: "r" }] }, new Set()).drugDisease).toEqual([]);
    expect(refusalsOf(outcome, ident, { drugDiseaseOverrides: [{ lineIndex: 0, moiety: "Paracetamol", icd10Prefix: "K72.9", reason: "r" }] }, new Set()).drugDisease).toHaveLength(1);
    expect(refusalsOf({ ...none, drugDisease: [{ ...hit, severity: "moderate" }] } as RxCheckOutcome, ident, {}, new Set()).drugDisease).toEqual([]);
  });

  it("maps the check's indexes back to the prescription's (declined lines are not in the check)", () => {
    const r = refusalsOf({ ...none, allergyMatches: [{ lineIndex: 0, substance: "X" }] }, (i) => [2, 5][i]!, {}, new Set());
    expect(r.allergy).toEqual([{ lineIdx: 2, substance: "X" }]);
  });

  it("PD-9 — a prescriber's authorisation clears exactly its key on its line; a pair from either of its lines", () => {
    const outcome: RxCheckOutcome = {
      ...none,
      allergyMatches: [{ lineIndex: 0, substance: "Paracetamol" }, { lineIndex: 1, substance: "Paracetamol" }],
      interactions: [{ severity: "severe", lineIndex: 1, saltPair: ["b", "a"], note: "QT", against: { scope: "in_rx", lineIndex: 0 } }],
    };
    const ok = (...keys: string[]) => refusalsOf(outcome, ident, {}, new Set(), new Set(keys));
    expect(ok(authorisationKey(0, "allergy", "Paracetamol")).allergy).toEqual([{ lineIdx: 1, substance: "Paracetamol" }]);
    expect(ok(authorisationKey(0, "allergy", "Ibuprofen")).allergy).toHaveLength(2);
    expect(refusalKey("interaction", { saltPair: ["b", "a"] })).toBe("a|b");
    expect(ok(authorisationKey(0, "interaction", "a|b")).interaction).toEqual([]);
    expect(ok(authorisationKey(1, "interaction", "a|b")).interaction).toEqual([]);
    expect(ok(authorisationKey(2, "interaction", "a|b")).interaction).toHaveLength(1);
  });
});
