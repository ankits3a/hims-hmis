import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import { cdsAliases } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { assertNoIdentifiers, IdentifierLeak, maskQuestion } from "../../kernel/copilot/mask";
import { chooserFor } from "../../kernel/inference/openai-decisions";
import type { ChoiceClient } from "../../kernel/inference/types";
import { SECOND_TARGET_SHARE, normaliseTerm } from "./alias-pipeline";
import type { AliasRunCaps, AliasRunReport } from "./alias-runner";
import { MIN_TIMES_TYPED, RETRY_REFUSED_AFTER_DAYS } from "./alias-runner";
import { aliasRunCompleted } from "./events";
import { istDate, istDateTimeToUtc } from "./time";

/**
 * ═══ #613 — COMPLAINT NORMALISATION THROUGH THE CHOOSER (plan P2; decisions 0050, 0051, 0055) ═══
 *
 * A phrase doctors commit as a complaint that no person has mapped ("pet me marod") is filed under ONE
 * of the hospital's EXISTING complaint concepts, or under none. Nothing new is ever invented: the
 * chooser is handed a closed set — the concepts and "none" — and may only pick from it.
 *
 * RULES FIRST, THE MODEL LAST (decision 0009's ladder):
 *   1. a phrase carrying an identifier is refused before anything is read or asked;
 *   2. the SAME WORDS as one concept's known phrasing, in another order ("pain, chest" ↔ "chest pain"),
 *      is that concept — no model is asked (`SAME_WORDS_RULE`);
 *   3. otherwise the chooser, at the strict line (default 0.95, decision 0055); "none", a second concept
 *      holding more than a fifth of the belief, or a chooser that is down or absent, changes nothing.
 *
 * What it produces is a SUGGESTION only: offered to doctors as a marked chip and read by no machine
 * until doctors' use has made it TRUSTED (`applyAliasUse`: ≥ 3 doctors, ≥ 10 taps). The owner's list
 * shows it with a one-tap undo; three crosses by two doctors demote it. A person-mapped phrase
 * (`opd_complaint_terms`) is never asked about and never changed.
 */
export const SAME_WORDS_RULE = "rule:same-words";

export type ComplaintConcept = { key: string; label: string; terms: string[] };

export type ComplaintAliasDeps = {
  /** The alias pipeline's switch (`ALIAS_PIPELINE_ENABLED`). False: nothing is read and no model is asked. */
  enabled: boolean;
  /** The existing concepts near a phrase, each with its known phrasings — the chooser's closed set. */
  concepts: (phrase: string) => Promise<ComplaintConcept[]>;
  chooser: ChoiceClient | null;
  /** `ALIAS_CHOOSER_MIN_CONFIDENCE`, default 0.95 (decision 0055). */
  chooserLine: number;
};

export type ComplaintAliasRefusal = "identifier_in_term" | "chooser_unavailable" | "chooser_none" | "chooser_below_line" | "multiple_targets";

export type ComplaintAliasProposal =
  | { outcome: "off" }
  | {
    outcome: "ran";
    term: string;
    state: "proposed" | "suggestion";
    conceptKey: string | null;
    refusal: ComplaintAliasRefusal | null;
    ruleResult: "pass" | "not_run" | "multiple_targets";
    /** Which rung answered: the same-words rule, the chooser, or neither. */
    rung: "rule" | "chooser" | null;
    chooser: { model: string; confidence: number } | null;
  };

/** The phrase's words, case-folded and sorted, punctuation dropped: "Pain, chest" and "chest pain" are one key. */
export function wordsKey(phrase: string): string {
  return phrase.toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w !== "").sort().join(" ");
}

const INSTRUCTIONS = "`phrase` is how a doctor in India wrote a patient's presenting complaint (English, Hindi or Hinglish). Choose the ONE complaint it means. Choose `none` when it is not a complaint, when it names more than one of them, or when none of them is what it means.";

export async function proposeComplaintAlias(deps: ComplaintAliasDeps, rawPhrase: string): Promise<ComplaintAliasProposal> {
  if (!deps.enabled) return { outcome: "off" };
  const term = normaliseTerm(rawPhrase);
  const result = (over: Partial<Extract<ComplaintAliasProposal, { outcome: "ran" }>>): ComplaintAliasProposal => ({
    outcome: "ran", term, state: "proposed", conceptKey: null, refusal: null, ruleResult: "not_run", rung: null, chooser: null, ...over,
  });

  /* A complaint phrase with a phone number or a UHID in it is somebody's sentence: refused, never masked into a row. */
  if (maskQuestion(term).masked !== term) return result({ refusal: "identifier_in_term" });
  try { assertNoIdentifiers(term); } catch (e) { if (e instanceof IdentifierLeak) return result({ refusal: "identifier_in_term" }); throw e; }

  const concepts = await deps.concepts(term);

  // RULE FIRST — the same words as exactly one concept's known phrasing.
  const key = wordsKey(term);
  const same = [...new Set(concepts.filter((c) => c.terms.some((t) => wordsKey(t) === key)).map((c) => c.key))];
  if (same.length === 1) {
    return result({ state: "suggestion", conceptKey: same[0]!, ruleResult: "pass", rung: "rule", chooser: { model: SAME_WORDS_RULE, confidence: 1 } });
  }

  if (deps.chooser === null || concepts.length === 0) return result({ refusal: "chooser_unavailable" });
  const keyOf = (i: number): string => `k${String(i + 1)}`;
  const options: Record<string, unknown> = Object.fromEntries(concepts.map((c, i) => [keyOf(i), `${c.label} — ${c.terms.join(", ")}`]));
  options.none = "none of these, not a complaint, or more than one of these";
  let answer;
  let model: string;
  try {
    const out = await deps.chooser.choose({ state: { phrase: term }, questions: { concept: { instructions: INSTRUCTIONS, options } } });
    answer = out.answers.concept;
    model = out.model;
  } catch {
    return result({ refusal: "chooser_unavailable" });
  }
  if (answer === undefined || !Object.hasOwn(options, answer.choice)) return result({ refusal: "chooser_unavailable" });
  const chooser = { model, confidence: answer.confidence };
  const index = concepts.findIndex((_, i) => keyOf(i) === answer.choice);
  const target = concepts[index];
  if (target === undefined) return result({ refusal: "chooser_none", rung: "chooser", chooser });

  const second = Math.max(0, ...concepts.map((_, i) => (i === index ? 0 : answer.probabilities[keyOf(i)] ?? 0)));
  if (second > SECOND_TARGET_SHARE) {
    return result({ conceptKey: target.key, refusal: "multiple_targets", ruleResult: "multiple_targets", rung: "chooser", chooser });
  }
  if (answer.confidence < deps.chooserLine) return result({ conceptKey: target.key, refusal: "chooser_below_line", ruleResult: "pass", rung: "chooser", chooser });
  return result({ state: "suggestion", conceptKey: target.key, ruleResult: "pass", rung: "chooser", chooser });
}

/** The concepts a chooser is shown: the 40 nearest active concepts to the phrase, each with its known phrasings. */
export const CONCEPTS_SHOWN = 40;

export async function complaintConceptsNear(db: Db, phrase: string): Promise<ComplaintConcept[]> {
  const p = phrase.trim().toLowerCase();
  const res = await db.execute(sql`
    select c.key, c.label, array_agg(lower(t.term) order by t.term) as terms
      from opd_complaint_concepts c
      join opd_complaint_terms t on t.concept_key = c.key
     where c.active
     group by c.key, c.label
     order by max(similarity(lower(t.term), ${p})) desc, c.label asc
     limit ${CONCEPTS_SHOWN}
  `);
  return (res.rows as Record<string, unknown>[]).map((r) => ({ key: String(r["key"]), label: String(r["label"]), terms: (r["terms"] as string[]) ?? [] }));
}

/** One row per phrase; a live row, or one somebody took back, is never overwritten here. */
async function saveComplaintAlias(db: Db, p: Extract<ComplaintAliasProposal, { outcome: "ran" }>, now: Date): Promise<void> {
  const values = {
    conceptKey: p.conceptKey, medicineId: null, termKey: null, state: p.state,
    chooserName: p.chooser?.model ?? null, chooserConfidence: p.chooser?.confidence ?? null,
    reviewerName: null, reviewerAnswer: null, reviewerProbability: null, reasonCode: null,
    ruleResult: p.ruleResult, refusal: p.refusal, lasaGuard: false, updatedAt: now, auditedAt: now,
  };
  await db.transaction(async (tx) => {
    const where = and(eq(cdsAliases.kind, "complaint"), eq(cdsAliases.term, p.term));
    const [had] = await tx.select({ id: cdsAliases.id, state: cdsAliases.state }).from(cdsAliases).where(where).for("update");
    if (had === undefined) {
      await tx.insert(cdsAliases).values({ id: newId(), kind: "complaint", term: p.term, createdAt: now, ...values }).onConflictDoNothing();
      return;
    }
    if (had.state === "proposed") await tx.update(cdsAliases).set(values).where(eq(cdsAliases.id, had.id));
  });
}

const RUNNER: Actor = { type: "system", id: "opd-alias-runner" };
const STOP_AFTER_FAILURES = 3;

/**
 * The hourly runner's complaint half. Phrases doctors COMMITTED (`opd_complaint_term_usage`) at least
 * twice, that no person mapped and that have no alias row (a refused one is retried after 30 days),
 * most used first, within the run's and the IST day's caps. Ends with ONE event of counts.
 */
export async function runComplaintAliasProposals(db: Db, deps: ComplaintAliasDeps, caps: AliasRunCaps, now: Date = new Date()): Promise<AliasRunReport> {
  if (!deps.enabled) return { ran: false };
  const dayStart = istDateTimeToUtc(istDate(now), "00:00");
  const today = await db.execute(sql`select count(*)::int as n from cds_aliases where kind = 'complaint' and audited_at >= ${dayStart.toISOString()}`);
  const room = Math.min(caps.perRun, caps.perDay - Number(today.rows[0]?.["n"] ?? 0));
  if (room <= 0) return { ran: true, proposed: 0, suggestion: 0, refused: 0, failed: 0 };

  const retryBefore = new Date(now.getTime() - RETRY_REFUSED_AFTER_DAYS * 86_400_000);
  const due = await db.execute(sql`
    with used as (
      select normalize(u.term, NFC) as term, sum(u.uses) as uses
        from opd_complaint_term_usage u
       group by 1
    )
    select x.term
      from used x
     where x.uses >= ${MIN_TIMES_TYPED}
       and char_length(x.term) between 2 and 60
       and not exists (select 1 from opd_complaint_terms t where lower(t.term) = x.term)
       and not exists (
         select 1 from cds_aliases a
          where a.kind = 'complaint' and a.term = x.term
            and (a.state <> 'proposed' or a.audited_at is null or a.audited_at > ${retryBefore.toISOString()})
       )
     order by x.uses desc, x.term asc
     limit ${room}
  `);

  const report = { ran: true as const, proposed: 0, suggestion: 0, refused: 0, failed: 0 };
  let failuresInARow = 0;
  for (const r of due.rows) {
    const p = await proposeComplaintAlias(deps, String(r["term"]));
    if (p.outcome === "off") break;
    report.proposed += 1;
    if (p.refusal === "chooser_unavailable") {
      report.failed += 1;
      failuresInARow += 1;
      if (failuresInARow >= STOP_AFTER_FAILURES) break;
      continue;
    }
    failuresInARow = 0;
    await saveComplaintAlias(db, p, now);
    if (p.state === "suggestion") report.suggestion += 1; else report.refused += 1;
  }
  if (report.proposed > 0) {
    await db.transaction(async (tx) => {
      await appendEvent(tx, aliasRunCompleted.make({ actor: RUNNER, payload: { kind: "complaint", proposed: report.proposed, suggestion: report.suggestion, refused: report.refused, failed: report.failed } }));
    });
  }
  return report;
}

/** The complaint half's dependencies from the server's settings — no model client is built while the switch is off. */
export function complaintAliasDepsFrom(db: Db, config: AppConfig): ComplaintAliasDeps {
  const { enabled, chooserLine, chooserOrder } = config.aliases;
  return {
    enabled,
    concepts: (phrase) => complaintConceptsNear(db, phrase),
    chooser: !enabled ? null : chooserFor({
      order: chooserOrder, typesafe: config.triageChoice, decisions: config.decisions, openaiKeyFile: config.openaiKeyFile, minConfidence: chooserLine,
    }),
    chooserLine,
  };
}
