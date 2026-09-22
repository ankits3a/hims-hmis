import { THERAPEUTIC_DUPLICATE_CLASSES, allergyClassKeys, normalizeDrugName } from "../formulary";
import type {
  DrugDiseaseAlternative, DrugDiseaseRow, InteractionPair, ResolvedDrug, SaltRef,
} from "../formulary";
import type { CodedDiagnosis } from "./diagnosis-history";
import type { RxLine } from "./fhir";
import type { AllergyMatch } from "./prescriptions";

/**
 * PLAN 16a T4 — the three checks, pure.
 *
 * ONE ENGINE, TWO CALL SITES (spec §1.3): the prescription pipeline calls these at issue time and
 * 16b's snapshot card calls the same functions at the same version, so the card and the refusal
 * can never disagree about what is dangerous. That is a property of there being one copy, which is
 * why these are pure functions fed by read helpers rather than methods on anything.
 *
 * ═══ WHAT EACH LAYER IS FOR, because they look redundant and are not ═══
 *
 *   1. MOIETY SETS — the allergy and the line both resolved; compare what they are made of. This
 *      is the layer that catches Augmentin from an allergy recorded as "Augmentin".
 *   2. THE CLASS PATH — the substance text names a CLASS ("penicillin"), which is not a moiety at
 *      all, so no set intersection can find it. This is the Augmentin regression by its own name:
 *      an allergy to penicillin must catch amoxicillin, whose class is penicillin.
 *   3. THE LEGACY SUBSTRING LAYER — unchanged in spirit from the shipped `matchAllergies`, and it
 *      is what still protects a line the formulary has never heard of. Design law 1: coverage
 *      never gates prescribing, so the layer that needs no coverage cannot be removed.
 *
 * Its one change is a guard the shipped version lacks: a side shorter than four characters matches
 * only as a whole token. Without it an allergy recorded as "B" warns on every drug containing a
 * letter b, which is how a hard warning becomes wallpaper.
 */

export type RxCheckLine = { lineIndex: number; drug: string; resolution: ResolvedDrug | null };
export type PriorRx = {
  prescriptionId: string;
  issuedAt: Date;
  lines: { line: RxLine; resolution: ResolvedDrug | null }[];
};

/** Where a hit's counterpart lives: another line of this prescription, or a current prior one. */
export type HitAgainst =
  | { scope: "in_rx"; lineIndex: number }
  | { scope: "prior"; prescriptionId: string; issuedAt: Date; assumedCurrent: boolean };

export type InteractionHit = {
  severity: "severe" | "moderate";
  lineIndex: number;
  saltPair: [string, string];
  note: string;
  against: HitAgainst;
};

export type DuplicateHit = {
  moiety: string;
  lineIndex: number;
  hard: boolean;
  against: HitAgainst;
  /**
   * FORMULARY P23 — set on a CLASS duplicate: the therapeutic class both moieties share, and `with`,
   * the other moiety. Absent on a same-moiety duplicate.
   */
  drugClass?: string;
  with?: string;
};

/** A line with no duration is treated as chronic for this many days, and the hit says so. */
const ASSUMED_CURRENT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Below this length, a free-text side matches only as a whole token. */
const MIN_SUBSTRING_LENGTH = 4;

/**
 * Is a prior line still being taken?
 *
 * `assumedCurrent` is TRUE whenever the answer came from the 90-day fallback rather than from a
 * recorded duration — including when the fallback says NO. A caller rendering "prescribed N days
 * ago — may no longer be current" needs to know the currency was assumed, not measured, and a flag
 * that only appeared on positives would make an assumption look like a fact half the time.
 */
export function isCurrent(
  durationDays: number | null,
  issuedAt: Date,
  now: Date,
): { current: boolean; assumedCurrent: boolean } {
  const elapsedMs = now.getTime() - issuedAt.getTime();
  // M6 — a legacy jsonb line can carry `undefined` where the type says `number | null`, and
  // `undefined * DAY_MS` is NaN, which compares false and SKIPS the prior silently. Anything that
  // is not a usable number takes the labelled 90-day path: the failure direction must be a warning
  // a doctor can dismiss, never a check that quietly did not happen.
  if (typeof durationDays !== "number" || !Number.isFinite(durationDays)) {
    return { current: elapsedMs <= ASSUMED_CURRENT_DAYS * DAY_MS, assumedCurrent: true };
  }
  return { current: elapsedMs <= durationDays * DAY_MS, assumedCurrent: false };
}

function saltsOf(resolution: ResolvedDrug | null): SaltRef[] {
  return resolution?.salts ?? [];
}

/** Whole-token split of a normalized string. */
function tokens(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t !== "");
}

/**
 * The legacy layer, with the short-string guard. Bidirectional, exactly as shipped: an allergy to
 * "sulfa" must catch "Sulfamethoxazole", and one recorded as "Penicillin G" must catch a line that
 * says only "penicillin".
 */
function legacySubstringMatch(substanceRaw: string, drugRaw: string): boolean {
  const substance = substanceRaw.trim().toLowerCase();
  const drug = drugRaw.trim().toLowerCase();
  if (substance === "" || drug === "") return false;
  /**
   * M1 — THE GUARD IS THE SUBSTANCE SIDE'S, and applying it to the DRUG side was a regression.
   * Its justification is that an allergy recorded as "B" must not warn on every drug containing a
   * letter b. A short DRUG string carries no such risk: allergy "ASA" against a line reading
   * "Tab ASA75" matched under the shipped matcher and stopped matching under this one. A miss is
   * the wrong direction for an allergy check, so the guard now applies only where it was argued for.
   */
  if (substance.length < MIN_SUBSTRING_LENGTH) {
    return tokens(drug).includes(substance) || drug === substance;
  }
  return drug.includes(substance) || substance.includes(drug);
}

/**
 * §6's allergy hard-warning, salt-aware. Returns at most one match per (line, substance): the
 * three layers are alternative REASONS for one warning, not three warnings.
 */
export function matchAllergiesSaltAware(
  lines: RxCheckLine[],
  allergies: { substance: string; resolution: ResolvedDrug | null; allergenClass?: string | null }[],
): AllergyMatch[] {
  const matches: AllergyMatch[] = [];
  for (const line of lines) {
    const lineSalts = saltsOf(line.resolution);
    const lineSaltIds = new Set(lineSalts.map((s) => s.saltId));
    for (const allergy of allergies) {
      const substance = allergy.substance;
      if (substance.trim() === "") continue;

      // 1. Both sides resolved: do they share a moiety?
      const shared = saltsOf(allergy.resolution).some((s) => lineSaltIds.has(s.saltId));

      // 2. The class path: the substance text names a moiety or a whole class the line contains.
      //    P22: or the allergy names an allergy class (picked, or typed as the class itself) that
      //    one of the line's moieties belongs to.
      const key = normalizeDrugName(substance);
      const classKeys: readonly string[] = allergyClassKeys(substance, allergy.allergenClass);
      const classHit = key !== "" && lineSalts.some((s) => (
        normalizeDrugName(s.moiety) === key
        || (s.drugClass !== null && normalizeDrugName(s.drugClass) === key)
        || (s.allergyClasses ?? []).some((c) => classKeys.includes(c))
      ));

      // 3. The layer that needs no formulary coverage at all.
      const legacy = legacySubstringMatch(substance, line.drug);

      if (shared || classHit || legacy) matches.push({ lineIndex: line.lineIndex, substance });
    }
  }
  return matches;
}

/** Canonical key for a moiety pair, matching the schema's `salt_a_id < salt_b_id` ordering. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * A `systemic_only` pair does not apply when either side is topical — a diclofenac gel is not the
 * bleeding risk a diclofenac tablet is. An UNRESOLVED route (`null`) counts as systemic: the pair
 * applies, because suppressing a severe warning on a guess is the wrong direction to guess in.
 */
function routeSuppresses(pair: InteractionPair, a: ResolvedDrug | null, b: ResolvedDrug | null): boolean {
  if (pair.routeScope !== "systemic_only") return false;
  return a?.routeClass === "topical" || b?.routeClass === "topical";
}

/**
 * Pairwise over the prescription's moieties and against the patient's CURRENT prior prescriptions.
 *
 * SAME-LINE PAIRS ARE SKIPPED ENTIRELY (DD8). A fixed-dose combination whose own salts interact is
 * a marketed product; the prescriber can do nothing about it, and the place that pair IS actionable
 * is admission, where `addMedicine` refuses it without an explicit acknowledgement.
 *
 * `lineIndex` is the LATER line of an in-rx pair and `against.lineIndex` the earlier one, so a hit
 * reads as "this line conflicts with one already on the prescription".
 */
export function checkInteractions(
  lines: RxCheckLine[],
  priors: PriorRx[],
  pairs: InteractionPair[],
  now: Date,
): InteractionHit[] {
  const byKey = new Map(pairs.map((p) => [pairKey(p.saltAId, p.saltBId), p]));
  if (byKey.size === 0) return [];
  const hits: InteractionHit[] = [];

  for (let j = 0; j < lines.length; j += 1) {
    const line = lines[j];
    if (line === undefined) continue;
    const lineSalts = saltsOf(line.resolution);
    if (lineSalts.length === 0) continue;
    const seenInRx = new Set<string>();
    const seenPrior = new Set<string>();

    // ── against earlier lines of this same prescription ──
    for (let i = 0; i < j; i += 1) {
      const other = lines[i];
      if (other === undefined) continue;
      for (const mine of lineSalts) {
        for (const theirs of saltsOf(other.resolution)) {
          const pair = byKey.get(pairKey(mine.saltId, theirs.saltId));
          if (pair === undefined) continue;
          if (routeSuppresses(pair, line.resolution, other.resolution)) continue;
          // M2 — two FDCs sharing the pair {A,B} cross-produce it twice (A×B and B×A). One fact,
          // one warning, one reason to type: emitting it twice means two dialog rows and two KPI
          // counts for one decision.
          const seenKey = `${String(other.lineIndex)}|${pairKey(pair.saltAId, pair.saltBId)}`;
          if (seenInRx.has(seenKey)) continue;
          seenInRx.add(seenKey);
          hits.push({
            severity: pair.severity, lineIndex: line.lineIndex,
            saltPair: [pair.saltAId, pair.saltBId], note: pair.note,
            against: { scope: "in_rx", lineIndex: other.lineIndex },
          });
        }
      }
    }

    // ── against what the patient is already taking ──
    for (const prior of priors) {
      for (const priorLine of prior.lines) {
        const currency = isCurrent(priorLine.line.durationDays, prior.issuedAt, now);
        if (!currency.current) continue;
        for (const mine of lineSalts) {
          for (const theirs of saltsOf(priorLine.resolution)) {
            const pair = byKey.get(pairKey(mine.saltId, theirs.saltId));
            if (pair === undefined) continue;
            if (routeSuppresses(pair, line.resolution, priorLine.resolution)) continue;
            const priorKey = `${prior.prescriptionId}|${pairKey(pair.saltAId, pair.saltBId)}`;
            if (seenPrior.has(priorKey)) continue;
            seenPrior.add(priorKey);
            hits.push({
              severity: pair.severity, lineIndex: line.lineIndex,
              saltPair: [pair.saltAId, pair.saltBId], note: pair.note,
              against: {
                scope: "prior", prescriptionId: prior.prescriptionId,
                issuedAt: prior.issuedAt, assumedCurrent: currency.assumedCurrent,
              },
            });
          }
        }
      }
    }
  }
  return hits;
}

/**
 * The same moiety twice.
 *
 * WITHIN one prescription and at the same route class → HARD: that is the brand-confusion double
 * dose, two names for one drug on one slip. Against a PRIOR prescription → soft, always: a refill
 * is the normal case and a hard warning on every refill trains doctors to click through. A
 * different route class → soft as well; a gel plus a tablet is often deliberate.
 *
 * An UNKNOWN route class (an unresolved or moiety-only line) does NOT downgrade the warning: the
 * hit stays hard unless the two routes are known to differ. Guessing "probably different routes"
 * to soften a double-dose warning is the one guess with a patient on the other end of it.
 */
export function checkDuplicateSalt(lines: RxCheckLine[], priors: PriorRx[], now: Date): DuplicateHit[] {
  const hits: DuplicateHit[] = [];

  for (let j = 0; j < lines.length; j += 1) {
    const line = lines[j];
    if (line === undefined) continue;
    const lineSalts = saltsOf(line.resolution);
    if (lineSalts.length === 0) continue;
    const lineRoute = line.resolution?.routeClass ?? null;

    for (let i = 0; i < j; i += 1) {
      const other = lines[i];
      if (other === undefined) continue;
      const otherRoute = other.resolution?.routeClass ?? null;
      const routesKnownToDiffer = lineRoute !== null && otherRoute !== null && lineRoute !== otherRoute;
      for (const mine of lineSalts) {
        if (!saltsOf(other.resolution).some((s) => s.saltId === mine.saltId)) continue;
        hits.push({
          moiety: mine.moiety, lineIndex: line.lineIndex, hard: !routesKnownToDiffer,
          against: { scope: "in_rx", lineIndex: other.lineIndex },
        });
      }
    }

    for (const prior of priors) {
      for (const priorLine of prior.lines) {
        const currency = isCurrent(priorLine.line.durationDays, prior.issuedAt, now);
        if (!currency.current) continue;
        for (const mine of lineSalts) {
          if (!saltsOf(priorLine.resolution).some((s) => s.saltId === mine.saltId)) continue;
          hits.push({
            moiety: mine.moiety, lineIndex: line.lineIndex, hard: false,
            against: {
              scope: "prior", prescriptionId: prior.prescriptionId,
              issuedAt: prior.issuedAt, assumedCurrent: currency.assumedCurrent,
            },
          });
        }
      }
    }
  }
  return hits;
}

/**
 * FORMULARY P23 — the classes of which a patient should be on ONE agent, from the owner's clinical
 * master (`therapeutic_subclass_groups`, `max_allowed_agents = 1`): proton pump inhibitors, ACE
 * inhibitors, angiotensin receptor blockers, statins and systemic NSAIDs (the formulary module owns
 * the list). A moiety's class is its `drug_class`, adopted by resolution
 * (`scripts/data/therapeutic-classes-*.ts`).
 */
const DUPLICATE_THERAPY_CLASSES: readonly string[] = THERAPEUTIC_DUPLICATE_CLASSES;

/**
 * Low-dose aspirin is an antiplatelet here, not the analgesic the NSAID group is about; an NSAID
 * beside it is the interaction book's question, not a duplicate. Its `drug_class` stays `nsaid`,
 * which the allergy path needs.
 */
const NOT_A_CLASS_DUPLICATE = new Set(["aspirin"]);

/**
 * FORMULARY P23 — a second agent of the same therapeutic class, against another line of this
 * prescription or a current prior one. ALWAYS SOFT: a planned switch overlaps on purpose, and the
 * source's "duplicate therapy alert" is advice rather than a stop. The same moiety twice is
 * `checkDuplicateSalt`'s hit and is not repeated here. A topical line beside a systemic one is not
 * a duplicate (a diclofenac gel with an oral coxib).
 */
export function checkDuplicateClass(lines: RxCheckLine[], priors: PriorRx[], now: Date): DuplicateHit[] {
  const hits: DuplicateHit[] = [];
  const classed = (salts: SaltRef[]): SaltRef[] => salts.filter((s) => s.drugClass !== null
    && DUPLICATE_THERAPY_CLASSES.includes(s.drugClass) && !NOT_A_CLASS_DUPLICATE.has(s.moiety));
  const clash = (mine: SaltRef, theirs: SaltRef[]): SaltRef | undefined =>
    theirs.find((t) => t.drugClass === mine.drugClass && t.saltId !== mine.saltId && t.moiety !== mine.moiety);
  const routesDiffer = (a: ResolvedDrug | null, b: ResolvedDrug | null): boolean =>
    a?.routeClass != null && b?.routeClass != null && a.routeClass !== b.routeClass;

  for (let j = 0; j < lines.length; j += 1) {
    const line = lines[j];
    if (line === undefined) continue;
    const mineAll = classed(saltsOf(line.resolution));
    if (mineAll.length === 0) continue;
    for (let i = 0; i < j; i += 1) {
      const other = lines[i];
      if (other === undefined || routesDiffer(line.resolution, other.resolution)) continue;
      const theirs = classed(saltsOf(other.resolution));
      for (const mine of mineAll) {
        const hit = clash(mine, theirs);
        if (hit === undefined) continue;
        hits.push({
          moiety: mine.moiety, drugClass: mine.drugClass!, with: hit.moiety, lineIndex: line.lineIndex, hard: false,
          against: { scope: "in_rx", lineIndex: other.lineIndex },
        });
      }
    }
    for (const prior of priors) {
      for (const priorLine of prior.lines) {
        const currency = isCurrent(priorLine.line.durationDays, prior.issuedAt, now);
        if (!currency.current || routesDiffer(line.resolution, priorLine.resolution)) continue;
        const theirs = classed(saltsOf(priorLine.resolution));
        for (const mine of mineAll) {
          const hit = clash(mine, theirs);
          if (hit === undefined) continue;
          hits.push({
            moiety: mine.moiety, drugClass: mine.drugClass!, with: hit.moiety, lineIndex: line.lineIndex, hard: false,
            against: { scope: "prior", prescriptionId: prior.prescriptionId, issuedAt: prior.issuedAt, assumedCurrent: currency.assumedCurrent },
          });
        }
      }
    }
  }
  return hits;
}

/**
 * ═══ THE FOURTH AXIS: WHAT THE PATIENT'S DIAGNOSIS FORBIDS (P24) ═══
 *
 * The other three checks ask about the prescription. This one asks about the PATIENT, which is why
 * it takes diagnoses rather than priors, and why it is the only check whose severity can be
 * softened by the calendar.
 *
 * ═══ A CODE OVER A YEAR OLD MAY NOTICE, BUT MAY NOT GATE ═══
 *
 * There is no problem list, so nothing ever retires a diagnosis: a code typed once is on the record
 * for good. Gating on one forever would mean a patient coded `J45` in error in 2026 can never be
 * given a beta-blocker without an override, for the rest of their life, by every doctor who ever
 * sees them. That is how a safety system becomes a formality.
 *
 * So the ruling (phase doc D2): a code recorded within a year gates at the book's severity; an
 * older one is downgraded to a notice and carries `stale`, and the alert names the date either way.
 * The prescriber can see a 2019 diagnosis for what it is. The check does not pretend to know.
 */
export type DrugDiseaseHit = {
  /** The book's severity, DOWNGRADED to 'moderate' when the diagnosis is older than a year. */
  severity: "severe" | "moderate";
  lineIndex: number;
  /** The moiety in this line that the rule names. */
  moiety: string;
  /** The rule's prefix and the catalogue's title for it: which ruling fired, `N18` or `N18.4`. */
  icd10Prefix: string;
  icd10Title: string;
  /** The patient's own diagnosis that matched it — the doctor's words, the code, and the date. */
  diagnosis: { code: string; text: string; codedOn: string };
  note: string;
  alternatives: DrugDiseaseAlternative[];
  /** True when the diagnosis is over a year old, which is WHY a severe rule came back moderate. */
  stale: boolean;
};

/** A diagnosis older than this may raise a notice but may never gate. Phase doc D2. */
export const DIAGNOSIS_GATES_FOR_DAYS = 365;

export function checkDrugDisease(
  lines: RxCheckLine[],
  diagnoses: readonly CodedDiagnosis[],
  rules: readonly DrugDiseaseRow[],
  now: Date,
): DrugDiseaseHit[] {
  if (rules.length === 0 || diagnoses.length === 0) return [];
  const bySalt = new Map<string, DrugDiseaseRow[]>();
  for (const r of rules) {
    const held = bySalt.get(r.saltId);
    if (held === undefined) bySalt.set(r.saltId, [r]);
    else held.push(r);
  }

  const cutoff = now.getTime() - DIAGNOSIS_GATES_FOR_DAYS * 24 * 60 * 60 * 1000;
  const hits: DrugDiseaseHit[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (line.resolution === null) continue;
    // A `systemic_only` rule does not apply to a gel or a drop. An UNRESOLVED route counts as
    // systemic, for `routeSuppresses`'s reason: suppressing on a guess is the wrong way to guess.
    const topical = line.resolution.routeClass === "topical";
    for (const salt of line.resolution.salts) {
      for (const rule of bySalt.get(salt.saltId) ?? []) {
        if (rule.routeScope === "systemic_only" && topical) continue;
        for (const dx of diagnoses) {
          if (!dx.code.startsWith(rule.icd10Prefix)) continue;
          // One hit per line, moiety and rule: two visits carrying the same code say nothing new.
          const key = `${String(line.lineIndex)}|${salt.saltId}|${rule.icd10Prefix}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const stale = Date.parse(`${dx.codedOn}T00:00:00Z`) < cutoff;
          hits.push({
            severity: stale ? "moderate" : rule.severity,
            lineIndex: line.lineIndex,
            moiety: salt.moiety,
            icd10Prefix: rule.icd10Prefix,
            icd10Title: rule.icd10Title,
            diagnosis: { code: dx.code, text: dx.text, codedOn: dx.codedOn },
            note: rule.note,
            alternatives: rule.alternatives,
            stale,
          });
        }
      }
    }
  }
  return hits;
}
