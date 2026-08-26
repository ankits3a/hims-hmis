import { normalizeDrugName } from "../formulary";
import type { InteractionPair, ResolvedDrug, SaltRef } from "../formulary";
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
  if (durationDays === null) {
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
  if (substance.length < MIN_SUBSTRING_LENGTH || drug.length < MIN_SUBSTRING_LENGTH) {
    return tokens(substance).includes(drug) || tokens(drug).includes(substance);
  }
  return drug.includes(substance) || substance.includes(drug);
}

/**
 * §6's allergy hard-warning, salt-aware. Returns at most one match per (line, substance): the
 * three layers are alternative REASONS for one warning, not three warnings.
 */
export function matchAllergiesSaltAware(
  lines: RxCheckLine[],
  allergies: { substance: string; resolution: ResolvedDrug | null }[],
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
      const key = normalizeDrugName(substance);
      const classHit = key !== "" && lineSalts.some((s) => (
        normalizeDrugName(s.moiety) === key
        || (s.drugClass !== null && normalizeDrugName(s.drugClass) === key)
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

    // ── against earlier lines of this same prescription ──
    for (let i = 0; i < j; i += 1) {
      const other = lines[i];
      if (other === undefined) continue;
      for (const mine of lineSalts) {
        for (const theirs of saltsOf(other.resolution)) {
          const pair = byKey.get(pairKey(mine.saltId, theirs.saltId));
          if (pair === undefined) continue;
          if (routeSuppresses(pair, line.resolution, other.resolution)) continue;
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
