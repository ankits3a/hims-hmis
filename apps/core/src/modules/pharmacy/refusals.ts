import type { AllergyOverride, RxCheckOutcome, RxOverride } from "../opd";

/**
 * ═══ WHAT THE CHECK REFUSES, BOOK BY BOOK — ONE DEFINITION, ASKED TWICE ═══
 *
 * `verifyDispense` refuses on these, in this order. PD-7 C3 asks the same function before anything
 * is chosen, so what the substitute sheet draws as "blocked" is what the check will refuse and
 * nothing else — the `isEquivalentMedicine` lesson: two hand-written predicates for one rule drift.
 *
 * Each book is cleared, as at issue, by the prescriber's override on that line naming that hit:
 *   · allergy — a recorded allergy the prescriber did not override (D9);
 *   · interaction — a SEVERE pair the prescriber did not override (D9);
 *   · duplicate — a HARD duplicate on a line the pharmacist READ here (PD-5b, E35): a doctor-named
 *     pair is same-prescription only and was met at issue, so only a reading can make a new one;
 *   · drug×disease — a SEVERE hit on any line (PD-5b, E36/E37): a reading's moieties, or a diagnosis
 *     coded after the issue, are rulings nobody made.
 *
 * `origIdx` maps the check's line index back to the prescription's; `readHere` is the set of
 * prescription line indexes resolved at this counter.
 */
export type Refusals = {
  allergy: { lineIdx: number; substance: string }[];
  interaction: { lineIdx: number; withLineIdx: number | null; saltPair: [string, string]; note: string }[];
  duplicate: { lineIdx: number; moiety: string }[];
  drugDisease: { lineIdx: number; moiety: string; icd10Prefix: string; icd10Title: string }[];
};

export type PrescriberOverrides = {
  allergyOverrides?: unknown; interactionOverrides?: unknown; duplicateOverrides?: unknown; drugDiseaseOverrides?: unknown;
};

const samePair = (a: readonly [string, string], b: readonly [string, string]): boolean => (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);

export function refusalsOf(outcome: RxCheckOutcome, origIdx: (checkIdx: number) => number, rx: PrescriberOverrides, readHere: ReadonlySet<number>): Refusals {
  const allergyOverrides = (rx.allergyOverrides ?? []) as AllergyOverride[];
  const interactionOverrides = (rx.interactionOverrides ?? []) as RxOverride[];
  const duplicateOverrides = (rx.duplicateOverrides ?? []) as RxOverride[];
  const drugDiseaseOverrides = (rx.drugDiseaseOverrides ?? []) as RxOverride[];

  const allergy = outcome.allergyMatches
    .filter((m) => !allergyOverrides.some((o) => o.lineIndex === origIdx(m.lineIndex) && o.substance === m.substance))
    .map((m) => ({ lineIdx: origIdx(m.lineIndex), substance: m.substance }));

  const interaction = outcome.interactions
    .filter((h) => h.severity === "severe")
    .filter((h) => !interactionOverrides.some((o) => o.lineIndex === origIdx(h.lineIndex) && o.saltPair !== undefined && samePair(o.saltPair, h.saltPair)))
    .map((h) => ({
      lineIdx: origIdx(h.lineIndex), withLineIdx: h.against.scope === "in_rx" ? origIdx(h.against.lineIndex) : null,
      saltPair: h.saltPair, note: h.note,
    }));

  const duplicates = new Map<string, { lineIdx: number; moiety: string }>();
  for (const h of outcome.duplicates) {
    if (!h.hard || duplicateOverrides.some((o) => o.lineIndex === origIdx(h.lineIndex) && o.moiety === h.moiety)) continue;
    const sides = [origIdx(h.lineIndex), ...(h.against.scope === "in_rx" ? [origIdx(h.against.lineIndex)] : [])];
    const chosen = sides.find((i) => readHere.has(i));
    if (chosen !== undefined) duplicates.set(`${String(chosen)}|${h.moiety}`, { lineIdx: chosen, moiety: h.moiety });
  }

  const drugDisease = outcome.drugDisease
    .filter((h) => h.severity === "severe")
    .filter((h) => !drugDiseaseOverrides.some((o) => o.lineIndex === origIdx(h.lineIndex) && o.moiety === h.moiety && o.icd10Prefix === h.icd10Prefix))
    .map((h) => ({ lineIdx: origIdx(h.lineIndex), moiety: h.moiety, icd10Prefix: h.icd10Prefix, icd10Title: h.icd10Title }));

  return { allergy, interaction, duplicate: [...duplicates.values()], drugDisease };
}

/** The refusals that fall on ONE prescription line — a pair counts on both of its lines. */
export function refusalsOn(r: Refusals, lineIdx: number): Refusals {
  return {
    allergy: r.allergy.filter((x) => x.lineIdx === lineIdx),
    interaction: r.interaction.filter((x) => x.lineIdx === lineIdx || x.withLineIdx === lineIdx),
    duplicate: r.duplicate.filter((x) => x.lineIdx === lineIdx),
    drugDisease: r.drugDisease.filter((x) => x.lineIdx === lineIdx),
  };
}
