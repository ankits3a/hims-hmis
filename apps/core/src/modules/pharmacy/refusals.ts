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
 *
 * PD-9 (owner ruling 2026-09-19) adds the second way a refusal is cleared: the PRESCRIBER's
 * authorisation, asked for from the counter. `authorised` holds `authorisationKey(line, book, key)`
 * for every authorised request on this dispense; a refusal whose key is in it is not a refusal. The
 * key is the hit's identity — the allergy's substance, the pair's salt ids, the moiety, the ruling —
 * so it binds to the SUBSTANCE on the LINE, not to one brand.
 */
export type RefusalBook = "allergy" | "interaction" | "duplicate" | "drug_disease";

/** The canonical identity of a hit within its book — what an authorisation names. */
export function refusalKey(book: "allergy", hit: { substance: string }): string;
export function refusalKey(book: "interaction", hit: { saltPair: readonly [string, string] }): string;
export function refusalKey(book: "duplicate", hit: { moiety: string }): string;
export function refusalKey(book: "drug_disease", hit: { moiety: string; icd10Prefix: string }): string;
export function refusalKey(book: RefusalBook, hit: { substance?: string; saltPair?: readonly [string, string]; moiety?: string; icd10Prefix?: string }): string {
  switch (book) {
    case "allergy": return hit.substance!;
    case "interaction": return [...hit.saltPair!].sort().join("|");
    case "duplicate": return hit.moiety!;
    case "drug_disease": return `${hit.icd10Prefix!}:${hit.moiety!}`;
  }
}

export function authorisationKey(lineIdx: number, book: RefusalBook, key: string): string {
  return `${String(lineIdx)}|${book}|${key}`;
}
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

export function refusalsOf(
  outcome: RxCheckOutcome, origIdx: (checkIdx: number) => number, rx: PrescriberOverrides, readHere: ReadonlySet<number>,
  authorised: ReadonlySet<string> = new Set(),
): Refusals {
  const cleared = (lineIdx: number, book: RefusalBook, key: string): boolean => authorised.has(authorisationKey(lineIdx, book, key));
  const allergyOverrides = (rx.allergyOverrides ?? []) as AllergyOverride[];
  const interactionOverrides = (rx.interactionOverrides ?? []) as RxOverride[];
  const duplicateOverrides = (rx.duplicateOverrides ?? []) as RxOverride[];
  const drugDiseaseOverrides = (rx.drugDiseaseOverrides ?? []) as RxOverride[];

  const allergy = outcome.allergyMatches
    .filter((m) => !allergyOverrides.some((o) => o.lineIndex === origIdx(m.lineIndex) && o.substance === m.substance))
    .map((m) => ({ lineIdx: origIdx(m.lineIndex), substance: m.substance }))
    .filter((m) => !cleared(m.lineIdx, "allergy", refusalKey("allergy", m)));

  const interaction = outcome.interactions
    .filter((h) => h.severity === "severe")
    .filter((h) => !interactionOverrides.some((o) => o.lineIndex === origIdx(h.lineIndex) && o.saltPair !== undefined && samePair(o.saltPair, h.saltPair)))
    .map((h) => ({
      lineIdx: origIdx(h.lineIndex), withLineIdx: h.against.scope === "in_rx" ? origIdx(h.against.lineIndex) : null,
      saltPair: h.saltPair, note: h.note,
    }))
    /* A pair is asked about from either of its lines; an authorisation on either clears it. */
    .filter((h) => !cleared(h.lineIdx, "interaction", refusalKey("interaction", h))
      && (h.withLineIdx === null || !cleared(h.withLineIdx, "interaction", refusalKey("interaction", h))));

  const duplicates = new Map<string, { lineIdx: number; moiety: string }>();
  for (const h of outcome.duplicates) {
    if (!h.hard || duplicateOverrides.some((o) => o.lineIndex === origIdx(h.lineIndex) && o.moiety === h.moiety)) continue;
    const sides = [origIdx(h.lineIndex), ...(h.against.scope === "in_rx" ? [origIdx(h.against.lineIndex)] : [])];
    const chosen = sides.find((i) => readHere.has(i));
    if (chosen !== undefined && !cleared(chosen, "duplicate", refusalKey("duplicate", h))) {
      duplicates.set(`${String(chosen)}|${h.moiety}`, { lineIdx: chosen, moiety: h.moiety });
    }
  }

  const drugDisease = outcome.drugDisease
    .filter((h) => h.severity === "severe")
    .filter((h) => !drugDiseaseOverrides.some((o) => o.lineIndex === origIdx(h.lineIndex) && o.moiety === h.moiety && o.icd10Prefix === h.icd10Prefix))
    .map((h) => ({ lineIdx: origIdx(h.lineIndex), moiety: h.moiety, icd10Prefix: h.icd10Prefix, icd10Title: h.icd10Title }))
    .filter((h) => !cleared(h.lineIdx, "drug_disease", refusalKey("drug_disease", h)));

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
