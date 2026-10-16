import { asc, desc, eq, inArray } from "drizzle-orm";
import { ER_ESI_INFO } from "@hmis/contracts";
import {
  erDoses, erEpisodes, erMedIssues, erMlcAddenda, erNotes, erProcedures, erTriageEntries, orderItems, orders, resources, services, users,
} from "../../kernel/db/schema";
import { maskForModel, unverifiedWords, verifyFreeText } from "../ipd";
import { getPatientSummaries } from "../patients";
import { askErModel } from "./copilot-model";
import { istHm } from "./copilot-since";
import { requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { mlcOfEpisode } from "./mlc";
import { ER_DISPOSITION, ER_MLC } from "./names";
import type { Actor, ErDraft, ErDraftKind, ErEsiLevel, ErVitals } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ErFallback, ErModel } from "./copilot-model";

/**
 * ER lane 9 (#816) — THE ER DRAFTS (spec §4.9; autonomy ladder: "ER summary, MLC narrative, referral letter — T2 draft,
 * never auto-sign, never MLC auto-file"). A draft is a READ: it writes no record and moves no state. The doctor edits it in
 * the form of the act that owns it — `discharge_from_er` (diagnosis, treatment given), `refer_out` (the referral note),
 * `add_mlc_addendum` (the narrative) — and only that act, signed by a person, makes a record. Every answer says "Draft".
 *
 *  - SUMMARY: the treatment given from the record (doses, procedures, tests), and the course in the ER — one model sentence
 *    over the masked notes when a model is up and the patient is not barred, verified (every number in the notes, no
 *    proposal, no money, no name), else the notes quoted. Medicines to take home are NEVER drafted (doses and orders:
 *    "None, ever").
 *  - REFERRAL: template only (DECIDED, lane 9: the receiving hospital reads the record's own words).
 *  - MLC NARRATIVE: template only, ALWAYS — an MLC patient never reaches a model (spec §3.7, IPD rule). Injuries from the
 *    record (the body-diagram entries), the alleged cause in the informant's words, quoted.
 * No money (decision 0058).
 */

export const ER_DRAFT_BUDGET_MS = 3000;
export const ER_SUMMARY_PROMPT_VERSION = "er-summary-v1";
const COURSE_SYSTEM = [
  "You summarise an emergency department course for a discharge summary draft that a doctor will check and sign.",
  "Use ONLY the notes given. At most two plain English sentences. Keep every number exactly as written.",
  "Never advise, never propose a medicine, dose, test or plan. Never mention money. Placeholders like <<P0>> stay hidden: never write them.",
].join(" ");

type Opts = { now?: Date; model?: ErModel | null };

async function episodeOf(db: Db, episodeId: string) {
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  return e;
}

/** Medicines given, procedures and tests, from the record — the summary's "treatment given" and the referral's. */
async function treatmentWords(db: Db, episodeId: string, episodeNo: string): Promise<string[]> {
  const meds = await db.select().from(erMedIssues).where(eq(erMedIssues.episodeId, episodeId)).orderBy(asc(erMedIssues.issuedAt));
  const doses = meds.length === 0 ? [] : await db.select().from(erDoses).where(inArray(erDoses.issueId, meds.map((m) => m.id)));
  const given = new Map(doses.filter((d) => d.outcome === "given").map((d) => [d.issueId, d] as const));
  const procs = await db.select().from(erProcedures).where(eq(erProcedures.episodeId, episodeId)).orderBy(asc(erProcedures.performedAt));
  const tests = await db.select({ name: services.name }).from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(services, eq(services.id, orderItems.serviceId)).where(eq(orders.encounterNo, episodeNo)).orderBy(asc(orders.placedAt));
  const visible = tests.map((t) => t.name);
  const out: string[] = [];
  const g = meds.filter((m) => given.has(m.id));
  if (g.length > 0) out.push(`Medicines given: ${g.map((m) => `${m.name} ${m.doseWords} ${m.route} at ${istHm(given.get(m.id)!.recordedAt)}`).join("; ")}.`);
  if (procs.length > 0) out.push(`Procedures: ${procs.map((p) => `${p.name} at ${istHm(p.performedAt)}`).join("; ")}.`);
  if (visible.length > 0) out.push(`Tests: ${[...new Set(visible)].join(", ")}.`);
  return out;
}

const stamp = (episodeId: string, kind: ErDraftKind, at: Date, fields: Record<string, string>, model: { id: string } | null, fallback: ErDraft["fallback"], unverified: string[] = []): ErDraft => ({
  episodeId, kind, label: "Draft", source: model === null ? "template" : "model", modelId: model?.id ?? null, fallback, builtAt: at.toISOString(), fields, unverified,
});

/** Every person and place the episode's record knows, for the masker: patient, alias, UHID, ER no, staff, bringer, bay. */
async function maskTerms(db: Db, e: Awaited<ReturnType<typeof episodeOf>>, staffIds: readonly string[]): Promise<{ names: string[]; places: string[] }> {
  const [p] = await getPatientSummaries(db, { type: "system", id: "er-copilot" }, [e.patientId]);
  const staff = staffIds.length === 0 ? [] : (await db.select({ n: users.fullName }).from(users).where(inArray(users.id, [...new Set(staffIds)]))).map((u) => u.n);
  const bringer = e.broughtBy as { name?: string; phone?: string } | null;
  const bay = e.bayId === null ? undefined : (await db.select({ code: resources.code }).from(resources).where(eq(resources.id, e.bayId)))[0]?.code;
  const clean = (xs: (string | null | undefined)[]): string[] => xs.flatMap((x) => (typeof x === "string" && x.trim() !== "" ? [x.trim()] : []));
  return { names: clean([p?.name, p?.alias, p?.uhid, e.alias, e.episodeNo, ...staff, bringer?.name, bringer?.phone]), places: clean([bay]) };
}

export async function buildErSummaryDraft(db: Db, actor: Actor, episodeId: string, opts: Opts = {}): Promise<ErDraft> {
  await requireErPermission(db, actor, ER_DISPOSITION);
  const now = opts.now ?? new Date();
  const e = await episodeOf(db, episodeId);
  const treatment = await treatmentWords(db, e.id, e.episodeNo);
  const notes = await db.select().from(erNotes).where(eq(erNotes.episodeId, e.id)).orderBy(asc(erNotes.recordedAt)).limit(30);
  const quoted = notes.filter((n) => n.kind !== "nursing").slice(-3).map((n) => `${istHm(n.recordedAt)}: ${n.text.replace(/\s+/g, " ").trim()}`);
  const base = { diagnosis: e.dispositionReason ?? "", treatmentGiven: [...treatment, ...(quoted.length === 0 ? [] : [`Course: ${quoted.join(" / ")}`])].join("\n") };
  if (notes.length === 0) return stamp(e.id, "summary", now, base, null, "no_text");

  const terms = await maskTerms(db, e, notes.map((n) => n.authorId));
  const masked = notes.map((n) => maskForModel(n.text, terms.names, terms.places));
  const answer = await askErModel(db, actor, opts.model, e.id, {
    intent: "emergency.summary_draft", system: COURSE_SYSTEM, user: masked.map((m, i) => `Note ${String(i + 1)}: ${m}`).join("\n"),
    budgetMs: ER_DRAFT_BUDGET_MS, maxTokens: 400,
  }, now);
  if (answer.text === null) return stamp(e.id, "summary", now, base, null, answer.reason satisfies ErFallback);
  const sentence = answer.text.replace(/\s+/g, " ").trim();
  const verdict = verifyFreeText(sentence, masked, { numbers: [], times: [] }, 600, terms.names);
  if (!verdict.ok) return stamp(e.id, "summary", now, base, null, "rejected");
  const fields = { diagnosis: base.diagnosis, treatmentGiven: [...treatment, `Course: ${sentence}`].join("\n") };
  return stamp(e.id, "summary", now, fields, { id: answer.modelId }, null, unverifiedWords(sentence, masked));
}

export async function buildErReferralDraft(db: Db, actor: Actor, episodeId: string, opts: Opts = {}): Promise<ErDraft> {
  await requireErPermission(db, actor, ER_DISPOSITION);
  const now = opts.now ?? new Date();
  const e = await episodeOf(db, episodeId);
  const lines: string[] = [];
  lines.push(`Emergency referral. Arrived ${istHm(e.arrivedAt)}${e.complaint === null ? "" : ` with ${e.complaint}`}.`);
  const level = (e.esi ?? null) as ErEsiLevel | null;
  if (level !== null) lines.push(`Triage: ESI ${String(level)} ${ER_ESI_INFO[level].word}.`);
  const v = (await db.select({ vitals: erTriageEntries.vitals, takenAt: erTriageEntries.takenAt }).from(erTriageEntries)
    .where(eq(erTriageEntries.episodeId, e.id)).orderBy(desc(erTriageEntries.takenAt)).limit(10)).find((r) => r.vitals !== null && Object.keys(r.vitals).length > 0);
  if (v !== undefined) {
    const x = v.vitals as ErVitals;
    const parts = [
      x.pulse === undefined ? null : `pulse ${String(x.pulse)}`, x.systolic === undefined ? null : `BP ${String(x.systolic)}${x.diastolic === undefined ? "" : `/${String(x.diastolic)}`}`,
      x.respRate === undefined ? null : `RR ${String(x.respRate)}`, x.spo2 === undefined ? null : `SpO2 ${String(x.spo2)}%`, x.temperatureC === undefined ? null : `temperature ${String(x.temperatureC)}`,
    ].filter((p): p is string => p !== null);
    if (parts.length > 0) lines.push(`Last vitals at ${istHm(v.takenAt)}: ${parts.join(", ")}.`);
  }
  lines.push(...(await treatmentWords(db, e.id, e.episodeNo)));
  if (e.stabilisedAt !== null) lines.push(`Stabilised at ${istHm(e.stabilisedAt)}.`);
  return stamp(e.id, "referral", now, { note: lines.join("\n") }, null, "template_only");
}

/** The MLC narrative: the record's injuries and the informant's words, quoted. NEVER a model call (spec §3.7). */
export async function buildMlcNarrativeDraft(db: Db, actor: Actor, episodeId: string, opts: Opts = {}): Promise<ErDraft> {
  await requireErPermission(db, actor, ER_MLC);
  const now = opts.now ?? new Date();
  const e = await episodeOf(db, episodeId);
  const m = await mlcOfEpisode(db, e.id);
  if (m === undefined) throw new ErRefusal("mlc_not_found");
  const addenda = await db.select().from(erMlcAddenda).where(eq(erMlcAddenda.mlcId, m.id)).orderBy(asc(erMlcAddenda.at));
  const injuries = [...m.injuries, ...addenda.flatMap((a) => a.injuries)];
  const category = [...addenda].reverse().find((a) => a.category !== null)?.category ?? m.category;
  const lines = [
    `Medico-legal case ${m.mlcNo}, opened ${istHm(m.openedAt)}. Category: ${category.replace(/_/g, " ")}.`,
    m.informant === null ? "Informant: not recorded." : `Alleged cause, in the informant's words (${m.informant.relation}): "${m.informant.words}".`,
    injuries.length === 0 ? "Injuries: none recorded."
      : `Injuries:\n${injuries.map((i, n) => `${String(n + 1)}. ${i.site}: ${i.kind}${i.sizeCm === undefined ? "" : `, ${i.sizeCm} cm`}${i.description === undefined ? "" : `, ${i.description}`}`).join("\n")}`,
  ];
  if (addenda.some((a) => a.examinationRefused)) lines.push("Examination refused by the patient (recorded).");
  return stamp(e.id, "mlc_narrative", now, { text: lines.join("\n") }, null, "barred");
}

export async function buildErDraft(db: Db, actor: Actor, episodeId: string, kind: ErDraftKind, opts: Opts = {}): Promise<ErDraft> {
  if (kind === "summary") return buildErSummaryDraft(db, actor, episodeId, opts);
  if (kind === "referral") return buildErReferralDraft(db, actor, episodeId, opts);
  return buildMlcNarrativeDraft(db, actor, episodeId, opts);
}
