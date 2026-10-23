import { createHash } from "node:crypto";
import { newId } from "@hmis/contracts";
import { sql } from "drizzle-orm";
import { maskQuestion } from "../../kernel/copilot/mask";
import { cdsDeskRoutingOutcomes } from "../../kernel/db/schema";
import { recognisedComplaintConcepts } from "./complaints";
import type { Db } from "../../kernel/db/client";
import { nameTerms } from "./triage";
import type { TriageDepartment, TriageResult, TriageSuggestion } from "./triage";

/**
 * ═══ #614 (PLAN P3) — THE FRONT DESK LEARNS WHERE VISITS END, BY RULE FIRST ═══
 *
 * `POST /opd/triage` ranks departments from the complaint (keywords, then the models). This file
 * adds three things around that ranking, in this order, and none of them ever runs before the red
 * flag — `suggestDepartments` returns on a red flag before anything here is asked:
 *
 *   1. THE CHILD RULE. Below 12 years (`cds/regimen.ts` `bandFor`) Paediatrics leads when the
 *      hospital runs it; the ranked specialty keeps slot two. The prior is not consulted for a child
 *      at all, so it can never send one to adult medicine.
 *   2. THE HOSPITAL PRIOR. P(final department | concept set), counted from earlier routings whose
 *      visit COMPLETED, holdout excluded, adults only, never a routing the prior itself led. It answers first at n ≥ 20 and p ≥ 0.8; at
 *      n 10–19 with p ≥ 0.8 it may only swap the top two. Only when the words reduce cleanly to
 *      known concepts (≥ 80 % of the words) and carry no negation — "no fever" is not "fever".
 *   3. THE LINK. Each answer carries a `triageId`; the walk-in or booking that follows sends it back
 *      and `recordRoutingOutcome` writes one row. That row is the prior's evidence.
 *
 * The vocabulary tail and the few-shot channel of P3 feed the MODEL, not these rules, and live in
 * `desk-routing-feed.ts`: built nightly from the same rows, live only after an evaluation.
 *
 * Nothing here stores words. The concept set is the hospital's own concept keys, found in the
 * MASKED complaint, and the holdout hash is computed and thrown away.
 */

/** Below this age the child rule runs. Same cut as `cds/regimen.ts` `bandFor`. */
export const CHILD_UNDER_YEARS = 12;
export const PRIOR_LEAD_N = 20;
export const PRIOR_RERANK_N = 10;
export const PRIOR_MIN_SHARE = 0.8;
export const PRIOR_MIN_COVERAGE = 0.8;

export type RoutingBand = "adult" | "pediatric" | "unknown";
export type RoutingSource = TriageResult["source"];

export function bandForAge(ageYears: number | null): RoutingBand {
  if (ageYears === null) return "unknown";
  return ageYears < CHILD_UNDER_YEARS ? "pediatric" : "adult";
}

/* Words that carry no complaint: they would lower the coverage of every ordinary sentence. */
export const FILLER: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "with", "since", "from", "is", "has", "have",
  "days", "day", "weeks", "week", "months", "month", "years", "year", "patient", "pt", "c", "o", "h",
  "ko", "ka", "ki", "ke", "se", "me", "mein", "mai", "hai", "he", "h", "ho", "raha", "rahi", "rahe", "aur", "bhi",
  "din", "hafte", "hafta", "mahine", "saal", "ek", "do", "teen", "char", "ji", "kuch", "bahut", "zyada",
  "है", "में", "से", "को", "का", "की", "के", "और", "दिन",
]);

/* A negation in the sentence makes the concept set a lie ("no fever" holds `fever`). */
export const NEGATION: ReadonlySet<string> = new Set(["no", "not", "without", "denies", "nil", "nahi", "nahin", "na", "नहीं", "ना"]);

export type RoutingConcepts = {
  /** Sorted concept keys joined by '|'; null when the set is unusable for the prior. */
  key: string | null;
  holdout: boolean;
};

const PLACEHOLDER = /<<P\d+>>/gi; // case-blind: a normalised (lowercased) sentence carries <<p1>>

export function words(text: string): string[] {
  return text.toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w !== "");
}

/** The words the holdout hash is taken over: the MASKED text, placeholders and bare numbers dropped. */
export function holdoutWords(masked: string): string[] {
  return words(masked.replace(PLACEHOLDER, " ")).filter((w) => !/^\p{N}+$/u.test(w));
}

/**
 * Holdout: a stable hash of the normalised MASKED words, mod 10 < 3. The same sentence lands on the
 * same side every time, so a held-out phrasing can never leak into what the prior counts.
 */
export function isHoldout(normalised: string): boolean {
  const h = createHash("sha256").update(normalised).digest();
  return h.readUInt32BE(0) % 10 < 3;
}

export async function routingConcepts(db: Db, text: string, names: readonly string[]): Promise<RoutingConcepts> {
  const masked = maskQuestion(text, nameTerms(names), { wholeWords: true }).masked.replace(PLACEHOLDER, " ");
  const all = holdoutWords(masked);
  const holdout = isHoldout(all.join(" "));
  if (all.length === 0 || all.some((w) => NEGATION.has(w))) return { key: null, holdout };
  const content = all.filter((w) => !FILLER.has(w));
  if (content.length === 0) return { key: null, holdout };
  const found = await recognisedComplaintConcepts(db, masked);
  if (found.length === 0) return { key: null, holdout };
  const covered = found.reduce((n, f) => n + words(f.matched).filter((w) => !FILLER.has(w)).length, 0);
  if (covered / content.length < PRIOR_MIN_COVERAGE) return { key: null, holdout };
  return { key: [...new Set(found.map((f) => f.conceptKey))].sort().join("|"), holdout };
}

export type RoutingPrior = { departmentId: string; n: number; share: number };

/** The prior for one concept set: completed adult visits, holdout and prior-led routings excluded, final department. */
export async function priorFor(db: Db, conceptKey: string): Promise<RoutingPrior | null> {
  const rows = (await db.execute(sql`
    select e.department_id as "departmentId", count(*)::int as n
      from cds_desk_routing_outcomes o
      join opd_encounters e
        on e.id = o.encounter_id or (o.encounter_id is null and e.appointment_id = o.appointment_id)
     where o.concept_key = ${conceptKey}
       and o.holdout = false
       and o.band = 'adult'
       -- only routings the desk chose from keywords or the model: one the prior led would feed it back to itself
       and o.source <> 'prior'
       and e.status = 'completed'
       and e.department_id is not null
     group by e.department_id
  `)).rows as { departmentId: string; n: number }[];
  if (rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.n, 0);
  const top = rows.reduce((a, b) => (b.n > a.n ? b : a));
  return { departmentId: top.departmentId, n: total, share: top.n / total };
}

const PAEDIATRICS = /\bpa?ediatric/i;

/**
 * The rules around the ranking. Pure: the caller supplies the prior it read. Never returns an empty
 * list when it was given a non-empty one, and only ever names departments in `departments` (the
 * active list the route read).
 */
export function applyRouting(
  result: TriageResult,
  input: { departments: TriageDepartment[]; ageYears: number | null; prior: RoutingPrior | null },
): TriageResult {
  if (result.redFlag !== undefined) return result;
  const active = new Set(input.departments.map((d) => d.id));
  const ranked = result.suggestions.filter((s) => active.has(s.departmentId));

  if (bandForAge(input.ageYears) === "pediatric") {
    const paeds = input.departments.find((d) => PAEDIATRICS.test(d.name));
    if (paeds === undefined) return { ...result, suggestions: ranked };
    const lead: TriageSuggestion = { departmentId: paeds.id, reason: "child — Paediatrics first" };
    return { ...result, suggestions: [lead, ...ranked.filter((s) => s.departmentId !== paeds.id)] };
  }

  /* The prior is for adults the desk has aged. An unknown age may be a child. */
  const prior = input.prior;
  if (bandForAge(input.ageYears) !== "adult" || prior === null) return { ...result, suggestions: ranked };
  if (!active.has(prior.departmentId) || prior.share < PRIOR_MIN_SHARE) return { ...result, suggestions: ranked };

  const lead: TriageSuggestion = { departmentId: prior.departmentId, reason: "where these visits ended" };
  if (prior.n >= PRIOR_LEAD_N) {
    return { ...result, source: "prior", suggestions: [lead, ...ranked.filter((s) => s.departmentId !== prior.departmentId)] };
  }
  if (prior.n >= PRIOR_RERANK_N && ranked.length >= 2 && ranked[1]!.departmentId === prior.departmentId) {
    return { ...result, source: "prior", suggestions: [ranked[1]!, ranked[0]!, ...ranked.slice(2)] };
  }
  return { ...result, suggestions: ranked };
}

/* ═══ THE triageId HAND-OFF ═══
   In-process and short-lived on purpose: the desk books within minutes of asking, and an id the
   server no longer holds simply records nothing — the visit opens exactly as before. The client
   sends ONLY the id; what was suggested is the server's own copy, so a client cannot write a
   routing it was never shown. */

export type TriageMemo = {
  suggested: string[];
  source: RoutingSource;
  conceptKey: string | null;
  band: RoutingBand;
  holdout: boolean;
  at: number;
};

const MEMO_TTL_MS = 2 * 60 * 60 * 1000;
const MEMO_MAX = 5000;

export function createTriageMemo(now: () => number = Date.now) {
  const map = new Map<string, TriageMemo>();
  return {
    issue(memo: Omit<TriageMemo, "at">): string {
      const id = newId();
      map.set(id, { ...memo, at: now() });
      while (map.size > MEMO_MAX) map.delete(map.keys().next().value!);
      return id;
    },
    take(id: string): TriageMemo | null {
      const memo = map.get(id);
      if (memo === undefined) return null;
      map.delete(id);
      return now() - memo.at > MEMO_TTL_MS ? null : memo;
    },
  };
}
export type TriageMemoStore = ReturnType<typeof createTriageMemo>;
export const defaultTriageMemo: TriageMemoStore = createTriageMemo();

/** One row per routing that became a visit or a booking. A replay writes nothing twice. */
export async function recordRoutingOutcome(
  db: Db,
  memo: TriageMemo,
  link: { triageId: string; encounterId?: string; appointmentId?: string; pickedDepartmentId: string },
): Promise<void> {
  await db.insert(cdsDeskRoutingOutcomes).values({
    id: newId(),
    triageId: link.triageId,
    encounterId: link.encounterId ?? null,
    appointmentId: link.appointmentId ?? null,
    conceptKey: memo.conceptKey,
    band: memo.band,
    holdout: memo.holdout,
    suggested: memo.suggested,
    source: memo.source,
    pickedDepartmentId: link.pickedDepartmentId,
  }).onConflictDoNothing();
}
