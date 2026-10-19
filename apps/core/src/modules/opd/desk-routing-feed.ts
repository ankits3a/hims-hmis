import { newId } from "@hmis/contracts";
import { sql } from "drizzle-orm";
import { assertNoIdentifiers, maskQuestion } from "../../kernel/copilot/mask";
import { cdsDeskRoutingFeeds } from "../../kernel/db/schema";
import { chooserFor } from "../../kernel/inference/openai-decisions";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";
import { FILLER, holdoutWords, isHoldout, NEGATION, words } from "./desk-routing";
import { listDepartments } from "./masters";
import { feedFingerprint, nameTerms } from "./triage";
import type { TriageChoice, TriageDepartment } from "./triage";
import { normaliseComplaint } from "./triage-cache";
import { askChooser, handWrittenWords } from "./triage-choice";
import type { RoutingFeed } from "./triage-choice";
import { TRIAGE_EVAL_CASES, TRIAGE_EVAL_DEPTS, TRIAGE_EVAL_MUST_REFUSE } from "./triage-eval-cases";

export { feedFingerprint } from "./triage";

/**
 * ═══ #614 (PLAN P3), CHANNELS 2 AND 3 — WHAT THE DESK'S MODEL IS FED, LEARNED, AND HOW IT IS TRUSTED ═══
 *
 * Channel 1 (`desk-routing.ts`) is a rule around the ranking. These two feed the MODEL instead — the
 * chooser (`triage-choice.ts`) that reads each department's hand-written description:
 *
 *   2. A VOCABULARY TAIL, appended after (never rewriting) the description: single words seen in
 *      ≥ 10 completed adult visits, ≥ 0.8 of them in one department, at ≥ 3 different patients, and
 *      not already a word of any description. At most 12 a department.
 *   3. EXAMPLES MINED FROM CORRECTIONS: a sentence whose visit completed somewhere other than the
 *      desk's first suggestion, the same way at ≥ 2 patients, ≤ 12 words, masked with no placeholder
 *      left, passing `assertNoIdentifiers`, never a held-out sentence and never one of the 46 fixed
 *      cases. At most 3 a department.
 *
 * Built NIGHTLY from the visits' own desk complaint (`opd_encounters.desk_complaint`, already
 * stored) joined through `cds_desk_routing_outcomes`. Nothing new about a patient is stored: the
 * version row holds words and short masked sentences that several different patients said.
 *
 * ═══ THE GROWING HELD-OUT SET, AND WHAT IT GATES ═══
 *
 * A held-out visit (the triage-time flag, or the same hash over the visit's own masked words) never
 * feeds either channel; its sentence and where it completed are the evaluation set, which grows
 * with every such visit. Each night a non-empty feed is asked, through the hospital's own chooser:
 *
 *   - THE FLOOR — the 46 fixed cases with the feed must score no lower than with the descriptions
 *     alone; otherwise `refused` (`floor`).
 *   - THE WEEK — held-out visits right with the feed, in percent; more than 5 points below the best
 *     live night of the last 7 days is `refused` (`weekly_drop`).
 *
 * A refused night serves the descriptions alone, which is what "freezes channels 2 and 3" means here.
 * A night the chooser could not be reached is `failed` and changes nothing: what was live stays
 * live. Nothing learned is `empty` and costs no model call at all. Red flags and the child rule are
 * untouched — they run before (`suggestDepartments`) and after (`applyRouting`) the chooser, which
 * is the only reader of anything here.
 */

export const TAIL_MIN_N = 10;
export const TAIL_MIN_SHARE = 0.8;
export const TAIL_MIN_PATIENTS = 3;
export const TAIL_MAX = 12;
export const EXAMPLE_MAX_WORDS = 12;
export const EXAMPLE_MIN_PATIENTS = 2;
export const EXAMPLE_MIN_SHARE = 0.8;
export const EXAMPLES_MAX = 3;
export const WEEKLY_DROP_POINTS = 5;
/** The newest this many held-out sentences are evaluated a night: the calls stay bounded. */
export const EVAL_HOLDOUT_MAX = 200;
const HOLDOUT_MAX_WORDS = 20;
const LOOKBACK_DAYS = 365;
const FEED_CACHE_MS = 60_000;

/** One completed adult visit the desk routed, as the nightly build reads it. */
export type LearnRow = {
  patientId: string;
  patientName: string;
  /** The desk complaint as typed. Masked here before anything else reads it. */
  text: string;
  finalDepartmentId: string;
  suggested: string[];
  /** The triage-time holdout flag. */
  holdout: boolean;
};

const PLACEHOLDER = /<<P\d+>>/i; // the sentence is lowercased by then
const WORD = /^[\p{L}\p{M}]{3,24}$/u;
const EVAL_SENTENCES = new Set([...TRIAGE_EVAL_CASES.map(([t]) => t), ...TRIAGE_EVAL_MUST_REFUSE].map(normaliseComplaint));

function maskFor(text: string, names: readonly string[]): string {
  return normaliseComplaint(maskQuestion(text, nameTerms(names), { wholeWords: true }).masked);
}

/** The same holdout `routingConcepts` takes at the desk, over the visit's own masked words. */
export function isHoldoutSentence(text: string, names: readonly string[] = []): boolean {
  return isHoldout(holdoutWords(maskFor(text, names)).join(" "));
}

type Prepared = LearnRow & { masked: string; held: boolean };

function prepare(rows: LearnRow[]): Prepared[] {
  return rows.map((r) => {
    const masked = maskFor(r.text, [r.patientName]);
    return { ...r, masked, held: r.holdout || isHoldout(holdoutWords(masked).join(" ")) };
  });
}

function identifierFree(text: string): boolean {
  if (PLACEHOLDER.test(text)) return false;
  try {
    assertNoIdentifiers(text);
    return true;
  } catch {
    return false;
  }
}

/** Channels 2 and 3 from the rows. Pure; only departments in `departments` are ever named. */
export function buildFeed(rows: LearnRow[], departments: TriageDepartment[]): RoutingFeed {
  const active = new Set(departments.map((d) => d.id));
  const usable = prepare(rows).filter((r) => !r.held && active.has(r.finalDepartmentId));
  return { tail: tailOf(usable), examples: examplesOf(usable) };
}

function tailOf(rows: Prepared[]): Record<string, string[]> {
  const known = handWrittenWords();
  const byWord = new Map<string, { depts: Map<string, number>; patients: Set<string> }>();
  for (const r of rows) {
    const ws = holdoutWords(r.masked);
    if (ws.some((w) => NEGATION.has(w))) continue; // "jalan nahi" is not evidence for jalan
    for (const w of new Set(ws)) {
      if (!WORD.test(w) || FILLER.has(w) || known.has(w)) continue;
      const e = byWord.get(w) ?? { depts: new Map<string, number>(), patients: new Set<string>() };
      e.depts.set(r.finalDepartmentId, (e.depts.get(r.finalDepartmentId) ?? 0) + 1);
      e.patients.add(r.patientId);
      byWord.set(w, e);
    }
  }
  const picked = new Map<string, { word: string; n: number }[]>();
  for (const [word, e] of byWord) {
    const n = [...e.depts.values()].reduce((a, b) => a + b, 0);
    const [dept, top] = [...e.depts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
    if (n < TAIL_MIN_N || top / n < TAIL_MIN_SHARE || e.patients.size < TAIL_MIN_PATIENTS) continue;
    picked.set(dept, [...(picked.get(dept) ?? []), { word, n }]);
  }
  const out: Record<string, string[]> = {};
  for (const [dept, list] of picked) {
    out[dept] = list.sort((a, b) => b.n - a.n || (a.word < b.word ? -1 : 1)).slice(0, TAIL_MAX).map((x) => x.word);
  }
  return out;
}

function examplesOf(rows: Prepared[]): Record<string, string[]> {
  const bySentence = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    if (r.suggested[0] === r.finalDepartmentId) continue; // the desk got it right: not a correction
    const s = r.masked;
    const n = words(s).length;
    if (n === 0 || n > EXAMPLE_MAX_WORDS || EVAL_SENTENCES.has(s) || !identifierFree(s)) continue;
    const depts = bySentence.get(s) ?? new Map<string, Set<string>>();
    depts.set(r.finalDepartmentId, (depts.get(r.finalDepartmentId) ?? new Set<string>()).add(r.patientId));
    bySentence.set(s, depts);
  }
  const picked = new Map<string, { s: string; n: number }[]>();
  for (const [s, depts] of bySentence) {
    const total = [...depts.values()].reduce((a, p) => a + p.size, 0);
    const [dept, patients] = [...depts.entries()].reduce((a, b) => (b[1].size > a[1].size ? b : a));
    if (patients.size < EXAMPLE_MIN_PATIENTS || patients.size / total < EXAMPLE_MIN_SHARE) continue;
    picked.set(dept, [...(picked.get(dept) ?? []), { s, n: patients.size }]);
  }
  const out: Record<string, string[]> = {};
  for (const [dept, list] of picked) {
    out[dept] = list.sort((a, b) => b.n - a.n || (a.s < b.s ? -1 : 1)).slice(0, EXAMPLES_MAX).map((x) => x.s);
  }
  return out;
}

export type EvalCase = { text: string; accept: string[]; visits: number };

/** The growing held-out set: each held-out sentence, masked, with every department it completed in. */
export function holdoutCases(rows: LearnRow[]): EvalCase[] {
  const byText = new Map<string, { accept: Set<string>; visits: number }>();
  for (const r of prepare(rows)) {
    if (!r.held) continue;
    const n = words(r.masked).length;
    if (n === 0 || n > HOLDOUT_MAX_WORDS || !identifierFree(r.masked)) continue;
    const e = byText.get(r.masked) ?? { accept: new Set<string>(), visits: 0 };
    e.accept.add(r.finalDepartmentId);
    e.visits += 1;
    byText.set(r.masked, e);
  }
  return [...byText.entries()].slice(0, EVAL_HOLDOUT_MAX).map(([text, e]) => ({ text, accept: [...e.accept], visits: e.visits }));
}

/** Completed adult routings with a desk complaint, newest first. Never a routing the prior led. */
async function readLearningRows(db: Db, now: Date): Promise<LearnRow[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  return (await db.execute(sql`
    select p.id as "patientId", p.name as "patientName", e.desk_complaint as "text",
           e.department_id as "finalDepartmentId", o.suggested as "suggested", o.holdout as "holdout"
      from cds_desk_routing_outcomes o
      join opd_encounters e
        on e.id = o.encounter_id or (o.encounter_id is null and e.appointment_id = o.appointment_id)
      join patients p on p.id = e.patient_id
     where o.band = 'adult'
       and o.source <> 'prior'
       and e.status = 'completed'
       and e.department_id is not null
       and e.desk_complaint is not null and btrim(e.desk_complaint) <> ''
       and o.created_at > ${since.toISOString()}
     order by o.created_at desc
     limit 20000
  `)).rows as LearnRow[];
}

/** Percent of `cases` whose first suggestion is acceptable, weighted by visits. A provider failure throws. */
async function score(chooser: TriageChoice, departments: TriageDepartment[], feed: RoutingFeed | null, cases: EvalCase[]): Promise<number> {
  let right = 0;
  let total = 0;
  for (const c of cases) {
    const out = await askChooser(c.text, departments, chooser.client, chooser.minConfidence, feed);
    total += c.visits;
    if (Array.isArray(out) && out[0] !== undefined && c.accept.includes(out[0].departmentId)) right += c.visits;
  }
  return total === 0 ? 0 : (100 * right) / total;
}

/** The hospital's feed moved onto the fixed cases' departments, matched by name. */
function feedForFloor(feed: RoutingFeed, departments: TriageDepartment[]): RoutingFeed {
  const evalId = new Map(TRIAGE_EVAL_DEPTS.map((d) => [d.name.toLowerCase(), d.id]));
  const move = (r: Record<string, string[]>) => {
    const out: Record<string, string[]> = {};
    for (const d of departments) {
      const id = evalId.get(d.name.trim().toLowerCase());
      const v = r[d.id];
      if (id !== undefined && v !== undefined) out[id] = v;
    }
    return out;
  };
  return { tail: move(feed.tail), examples: move(feed.examples) };
}

export type LearningReport = {
  status: "off" | "live" | "refused" | "failed" | "empty";
  reason: string | null;
  fingerprint: string;
};

/**
 * The nightly build (rides `sweepAppointmentNoShows`, `kernel/worker/jobs.ts`). Off: nothing runs.
 * Every outcome is one version row, so the history of what the desk's model was fed is kept.
 */
export async function runDeskRoutingLearning(
  db: Db,
  opts: { enabled: boolean; chooser: TriageChoice | null; now: Date },
): Promise<LearningReport> {
  if (!opts.enabled) return { status: "off", reason: null, fingerprint: "" };
  const departments = (await listDepartments(db, { activeOnly: true })).map((d) => ({ id: d.id, name: d.name }));
  const rows = await readLearningRows(db, opts.now);
  const feed = buildFeed(rows, departments);
  const fingerprint = feedFingerprint(feed);

  const write = async (status: LearningReport["status"], reason: string | null, scores: {
    floorScore?: number; baselineFloorScore?: number; holdoutScore?: number | null; holdoutVisits?: number;
  } = {}): Promise<LearningReport> => {
    await db.insert(cdsDeskRoutingFeeds).values({
      id: newId(), builtAt: opts.now, status, reason, tail: feed.tail, examples: feed.examples, fingerprint,
      floorScore: scores.floorScore ?? null, baselineFloorScore: scores.baselineFloorScore ?? null,
      holdoutScore: scores.holdoutScore ?? null, holdoutVisits: scores.holdoutVisits ?? 0,
    });
    clearRoutingFeedCache();
    return { status, reason, fingerprint };
  };

  if (fingerprint === "") return write("empty", null);
  if (opts.chooser === null) return write("failed", "no_chooser");

  const floorCases: EvalCase[] = TRIAGE_EVAL_CASES.map(([text, accept]) => ({ text, accept, visits: 1 }));
  const cases = holdoutCases(rows);
  const holdoutVisits = cases.reduce((n, c) => n + c.visits, 0);
  let baselineFloorScore: number;
  let floorScore: number;
  let holdoutScore: number | null;
  try {
    baselineFloorScore = await score(opts.chooser, TRIAGE_EVAL_DEPTS, null, floorCases);
    floorScore = await score(opts.chooser, TRIAGE_EVAL_DEPTS, feedForFloor(feed, departments), floorCases);
    holdoutScore = cases.length === 0 ? null : await score(opts.chooser, departments, feed, cases);
  } catch {
    return write("failed", "provider_failed");
  }
  const scores = { floorScore, baselineFloorScore, holdoutScore, holdoutVisits };
  if (floorScore < baselineFloorScore) return write("refused", "floor", scores);

  if (holdoutScore !== null) {
    const since = new Date(opts.now.getTime() - 7 * 24 * 3600 * 1000);
    const best = (await db.execute(sql`
      select max(holdout_score) as best from cds_desk_routing_feeds
       where status = 'live' and holdout_score is not null
         and built_at > ${since.toISOString()} and built_at <= ${opts.now.toISOString()}
    `)).rows[0] as { best: number | null } | undefined;
    if (best?.best !== null && best?.best !== undefined && holdoutScore < Number(best.best) - WEEKLY_DROP_POINTS) {
      return write("refused", "weekly_drop", scores);
    }
  }
  return write("live", null, scores);
}

/* ═══ WHAT THE DESK SERVES ═══ */

let cached: { at: number; feed: RoutingFeed | null } | null = null;

export function clearRoutingFeedCache(): void {
  cached = null;
}

/**
 * The feed the desk's chooser is handed: the newest version that is not `failed`, when it is `live`;
 * otherwise none. Read at most once a minute per process. Switched off, always none.
 */
export async function activeRoutingFeed(db: Db, enabled: boolean, now: () => number = Date.now): Promise<RoutingFeed | null> {
  if (!enabled) return null;
  if (cached !== null && now() - cached.at < FEED_CACHE_MS) return cached.feed;
  const row = (await db.execute(sql`
    select status, tail, examples from cds_desk_routing_feeds
     where status <> 'failed'
     order by built_at desc, created_at desc
     limit 1
  `)).rows[0] as { status: string; tail: Record<string, string[]>; examples: Record<string, string[]> } | undefined;
  const feed = row?.status === "live" ? { tail: row.tail, examples: row.examples } : null;
  cached = { at: now(), feed };
  return feed;
}

/** The desk's own chooser, built the way the triage route builds it, for the nightly evaluation. */
export function routingChooserFor(config: AppConfig): TriageChoice | null {
  const client = chooserFor({
    order: config.triageChooserOrder, typesafe: config.triageChoice, decisions: config.decisions,
    openaiKeyFile: config.openaiKeyFile, minConfidence: config.triageChoice.minConfidence,
  });
  return client === null ? null : { client, minConfidence: config.triageChoice.minConfidence };
}
