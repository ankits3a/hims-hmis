import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { IpdSummaryContentSchema, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { ipdCopilotDrafts, ipdNursingNotes, ipdOrders, ipdRounds, orderItems, patients, services } from "../../kernel/db/schema";
import { resolveDrugTexts } from "../formulary";
import { getPatientSummaries } from "../patients";
import { readAdmission, requireIpdPermission } from "./admission-core";
import { userNames } from "./admissions";
import { IPD_SYSTEM_ACTOR } from "./beds";
import { latestDraft } from "./copilot-drafts";
import { buildFacts, factsHash } from "./copilot-facts";
import { applyRewordings, chooseLines, renderLine, verifyFreeText, wordsOf } from "./copilot-lines";
import { askIpdModel, jsonIn, maskForModel } from "./copilot-model";
import { dayOfStay } from "./daily-totals";
import { medicineFlagsOf } from "./discharge-medicines";
import { IpdRefusal } from "./errors";
import { istClock, istDayIndex, shiftOf } from "./nursing";
import { readNursingChart } from "./nursing-read";
import { IPD_DISCHARGE_DECLARE, IPD_ROUND_SIGN, IPD_SHIFT_HANDOVER } from "./permissions";
import { onTeam, treatingTeamOf } from "./rounds-team";
import type {
  Actor, IpdCopilotRecord, IpdCopilotSource, IpdDischargeDraft, IpdDraftStamp, IpdEwsKind, IpdHandoverDraft, IpdMedicineFlag,
  IpdSinceLine, IpdSinceYesterday, IpdSummaryContent,
} from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";
import type { DraftRow } from "./copilot-drafts";
import type { Fact, FactRecord, Line, Quantities } from "./copilot-lines";
import type { FallbackReason, IpdModel } from "./copilot-model";
import type { IpdOrderRow } from "./orders";

/**
 * E5.3 (#740) "SINCE YESTERDAY" AND E5.4 (#741) THE SBAR AND DISCHARGE DRAFTERS (spec §4.8, §4.9 E, §4.10 edge 13, §4.11).
 *
 * The deterministic layer carries the safety (`copilot-facts.ts`, `copilot-lines.ts`); a model is optional polish behind
 * `copilot-model.ts` (the staff copilot's own client, mask, halt switch, cap and ledger). In one place:
 *  - SINCE YESTERDAY: four to six lines over what was recorded since the doctor's own last round (24 h when none), each
 *    with its source and its records. The read never calls a model and never writes; `polish` asks one inside 1 s and
 *    keeps the reworded lines per admission, doctor and IST day. A kept rewording is verified against TODAY's records on
 *    every read, so a line whose source changed after drafting falls back to the record's own line.
 *  - SBAR: the shift's facts under Situation / Background / Assessment / Recommendation, every line with its source; one
 *    model sentence over the shift's nursing notes when a model is up. The nurse edits and gives it (the existing
 *    `give_shift_handover`); the handover keeps the draft's id. Never auto-accepted.
 *  - DISCHARGE: diagnosis, results and medicines from the record; medicines only from ACTIVE drug orders; the course in
 *    hospital from the round notes (a template that quotes them, or a model's summary of them). The doctor edits, saves
 *    and signs through the existing summary acts. Never auto-signed.
 * A sealed patient gets no model call at all. No money anywhere (decision 0058). Nothing here proposes a dose or an order.
 */

export const SINCE_PROMPT_VERSION = "ipd-since-v1";
export const SBAR_PROMPT_VERSION = "ipd-sbar-v1";
export const DISCHARGE_PROMPT_VERSION = "ipd-discharge-v1";
/** "Since yesterday" loads in ≤ 1 s (spec §4.9 E): the model's whole share of it. */
export const SINCE_BUDGET_MS = 1000;
/** A draft is asked for with a tap; the nurse or doctor waits at most this long for a model's sentence (DECIDED). */
export const DRAFT_BUDGET_MS = 3000;
const DAY_MS = 86_400_000;

export type CopilotOpts = { now?: Date; model?: IpdModel | null };

const recordOf = (r: FactRecord): IpdCopilotRecord => ({ id: r.id, at: r.at?.toISOString() ?? null, label: r.label });

async function isSealed(db: Db | Tx, patientId: string): Promise<boolean> {
  return (await db.select({ sealed: patients.sensitiveContext }).from(patients).where(eq(patients.id, patientId)))[0]?.sealed === true;
}

const stampOf = (source: "template" | "model", modelId: string | null, promptVersion: string, builtAt: Date): IpdDraftStamp =>
  ({ label: "Draft", source, modelId: source === "model" ? modelId : null, promptVersion, builtAt: builtAt.toISOString() });

/** The names a free text may hold: the patient's, the staff who wrote the records, the UHID and the admission number. */
async function namesToMask(db: Db, a: AdmissionRow, staffIds: readonly string[]): Promise<string[]> {
  const p = (await getPatientSummaries(db, IPD_SYSTEM_ACTOR, [a.patientId]))[0];
  const staff = [...(await userNames(db, [...new Set([a.consultantId, ...staffIds])])).values()];
  return [p?.name, p?.alias, p?.uhid, a.admissionNo, ...staff].flatMap((n) => (typeof n === "string" && n.trim() !== "" ? [n] : []));
}

// ═══════════════════════════════════════════ since yesterday ═══════════════════════════════════════════

type SinceBase = { a: AdmissionRow; since: Date; basis: "last_round" | "24h"; facts: Fact[]; lines: Line[]; sealed: boolean; hash: string; scopeKey: string };

async function sinceBase(db: Db, actor: Actor, admissionId: string, now: Date): Promise<SinceBase> {
  await requireIpdPermission(db, actor, IPD_ROUND_SIGN);
  const a = await readAdmission(db, admissionId);
  // The round page's own rule (`readRoundPatient`): the treating team, nobody else.
  if (!onTeam(await treatingTeamOf(db, a, now), actor.id)) throw new IpdRefusal("not_treating_team");
  const last = (await db.select({ seenAt: ipdRounds.seenAt }).from(ipdRounds)
    .where(and(eq(ipdRounds.admissionId, a.id), eq(ipdRounds.authorId, actor.id), lte(ipdRounds.seenAt, now)))
    .orderBy(desc(ipdRounds.seenAt)).limit(1))[0];
  const since = last?.seenAt ?? new Date(now.getTime() - DAY_MS);
  const facts = await buildFacts(db, a, { since, until: now }, { actorId: actor.id });
  return {
    a, since, basis: last === undefined ? "24h" : "last_round", facts, lines: chooseLines(facts), sealed: await isSealed(db, a.patientId),
    hash: factsHash(facts), scopeKey: `${istDayString(now)}:${actor.id}`,
  };
}

const NOTHING_KEY = "nothing";

function sinceView(b: SinceBase, now: Date, lines: readonly (Line & { by: "template" | "model" })[], stamp: IpdDraftStamp | null, polishable: boolean): IpdSinceYesterday {
  const shownLines: IpdSinceLine[] = lines.map((l) => ({ key: l.key, text: l.text, source: l.source, abnormal: l.abnormal, by: l.by, records: l.fact.records.map(recordOf) }));
  if (shownLines.length === 0) {
    shownLines.push({ key: NOTHING_KEY, text: `No change: nothing recorded since ${istClock(b.since)}`, source: "round", abnormal: false, by: "template", records: [] });
  }
  return {
    admissionId: b.a.id, asOf: now.toISOString(), since: b.since.toISOString(), sinceBasis: b.basis,
    mode: lines.some((l) => l.by === "model") ? "model" : "timeline", lines: shownLines, stamp, polishable,
  };
}

const RewordedSchema = z.object({ lines: z.array(z.object({ key: z.string().max(80), text: z.string().max(400) })).max(12) });

/** A kept rewording, re-verified against the records as they are NOW; what fails keeps the record's own line. */
function withKept(b: SinceBase, row: DraftRow | undefined): { lines: (Line & { by: "template" | "model" })[]; stamp: IpdDraftStamp | null } {
  const template = b.lines.map((l) => ({ ...l, by: "template" as const }));
  if (row === undefined || row.source !== "model" || b.sealed) return { lines: template, stamp: null };
  const kept = RewordedSchema.safeParse(row.content);
  if (!kept.success) return { lines: template, stamp: null };
  const merged = applyRewordings(b.lines, kept.data.lines);
  return merged.accepted === 0 ? { lines: template, stamp: null } : { lines: merged.lines, stamp: stampOf("model", row.modelId, row.promptVersion, row.builtAt) };
}

/** The rounds patient page's first block. Deterministic: no model call, no write. */
export async function readSinceYesterday(db: Db, actor: Actor, admissionId: string, opts: CopilotOpts = {}): Promise<IpdSinceYesterday> {
  const now = opts.now ?? new Date();
  const b = await sinceBase(db, actor, admissionId, now);
  const row = await latestDraft(db, b.a.id, "since_yesterday", b.scopeKey);
  const { lines, stamp } = withKept(b, row);
  const configured = opts.model != null && opts.model.clientFor(SINCE_BUDGET_MS) !== null;
  return sinceView(b, now, lines, stamp, configured && !b.sealed && b.lines.length > 0 && row?.factsHash !== b.hash);
}

const SINCE_SYSTEM = [
  "You reword lines of a hospital inpatient timeline for a doctor on rounds.",
  "You are given JSON lines, each with a key and a text. Reword each text into plain clinical English and put the most important first.",
  "Rules: keep every number, unit and clock time exactly as written; add no number; keep every medicine and test name exactly;",
  "do not add a medicine, a diagnosis, advice or a plan; do not change what happened; one short line each; no patient names.",
  'Reply with JSON only: {"lines":[{"key":"<the same key>","text":"<the reworded line>"}]}',
].join(" ");

/**
 * Ask a model to reword the lines, inside the 1 s budget, and keep what passes the verifier. Model off, down, slow,
 * halted or capped, or a sealed patient: the plain timeline comes back, labelled as one. Never a second call for the
 * same records.
 */
export async function polishSinceYesterday(db: Db, actor: Actor, admissionId: string, opts: CopilotOpts = {}): Promise<IpdSinceYesterday> {
  const now = opts.now ?? new Date();
  const b = await sinceBase(db, actor, admissionId, now);
  const row = await latestDraft(db, b.a.id, "since_yesterday", b.scopeKey);
  if (b.lines.length === 0 || row?.factsHash === b.hash) {
    const kept = withKept(b, row);
    return sinceView(b, now, kept.lines, kept.stamp, false);
  }
  const answer = await askIpdModel(db, actor, opts.model, b.sealed, {
    intent: "ipd.since_yesterday", kind: "read", system: SINCE_SYSTEM, budgetMs: SINCE_BUDGET_MS, maxTokens: 700,
    user: JSON.stringify({ lines: b.lines.map((l) => ({ key: l.key, text: l.text })) }),
  }, now);
  const template = b.lines.map((l) => ({ ...l, by: "template" as const }));
  if (answer.text === null) return sinceView(b, now, template, null, false);
  const parsed = RewordedSchema.safeParse(jsonIn(answer.text));
  const merged = parsed.success ? applyRewordings(b.lines, parsed.data.lines) : { lines: template, accepted: 0, rejected: [{ key: "*", reason: "not_json" }] };
  const accepted = merged.lines.filter((l) => l.by === "model").map((l) => ({ key: l.key, text: l.text }));
  // Kept so the same records never cost a second call — also when every line was refused (`rejected`).
  await db.insert(ipdCopilotDrafts).values({
    id: newId(), admissionId: b.a.id, patientId: b.a.patientId, kind: "since_yesterday", scopeKey: b.scopeKey,
    source: accepted.length > 0 ? "model" : "template", modelId: accepted.length > 0 ? answer.modelId : null, promptVersion: SINCE_PROMPT_VERSION,
    factsHash: b.hash, content: { lines: accepted, rejected: merged.rejected }, fallbackReason: accepted.length > 0 ? null : "rejected",
    builtBy: actor.id, builtAt: now, modelMs: answer.ms,
  });
  return sinceView(b, now, merged.lines, accepted.length > 0 ? stampOf("model", answer.modelId, SINCE_PROMPT_VERSION, now) : null, false);
}

// ═══════════════════════════════════════════ medicine names in free text ═══════════════════════════════════════════

/**
 * Medicines a free text names that no ACTIVE order of the stay carries. A word (or "word 500") is a medicine when the
 * formulary knows it by moiety, alias or exact brand name (`resolveDrugTexts`), or when one of the stay's own orders
 * carries it. `model_invented`: a model wrote it and it is neither on any order nor in the notes it was given.
 */
export async function medicinesNamedWithoutOrder(
  db: Db, text: string, drugOrders: readonly IpdOrderRow[], by: "template" | "model", sources: readonly string[] = [],
): Promise<IpdMedicineFlag[]> {
  const namesOf = (rows: readonly IpdOrderRow[]): Set<string> => new Set(rows.flatMap((o) => wordsOf(o.medicineName ?? "")));
  const active = namesOf(drugOrders.filter((o) => o.status === "active"));
  const ended = namesOf(drugOrders.filter((o) => o.status !== "active"));
  const given = new Set(sources.flatMap((s) => wordsOf(s)));
  const tokens = text.toLowerCase().match(/[a-z][a-z-]{3,}|\d+(?:\.\d+)?/g) ?? [];
  const candidates = new Map<string, string>();
  tokens.forEach((tok, i) => {
    if (/^\d/.test(tok) || active.has(tok)) return;
    candidates.set(tok, tok);
    const next = tokens[i + 1];
    if (next !== undefined && /^\d/.test(next)) candidates.set(`${tok} ${next}`, tok);
  });
  if (candidates.size === 0) return [];
  const resolved = await resolveDrugTexts(db, [...candidates.keys()]);
  const flags = new Map<string, IpdMedicineFlag>();
  for (const [asked, word] of candidates) {
    const known = resolved.get(asked) != null || ended.has(word);
    if (!known || flags.has(word)) continue;
    const reason: IpdMedicineFlag["reason"] = ended.has(word) ? "order_stopped" : by === "model" && !given.has(word) ? "model_invented" : "no_active_order";
    flags.set(word, { name: word, where: "course", index: null, reason });
  }
  return [...flags.values()];
}

// ═══════════════════════════════════════════ the SBAR draft ═══════════════════════════════════════════

const KIND_WORD: Record<IpdEwsKind, string> = { news2: "NEWS2", meows: "MEOWS", pews: "PEWS" };
type SbarLine = IpdHandoverDraft["situation"][number];
const sbarLine = (text: string, source: IpdCopilotSource, records: readonly FactRecord[] = [], by: "template" | "model" = "template"): SbarLine =>
  ({ text, source, by, records: records.map(recordOf) });
const factLine = (f: Fact): SbarLine => sbarLine(renderLine(f), f.source, f.records);

type SbarBase = { a: AdmissionRow; draft: Omit<IpdHandoverDraft, "draftId" | "stamp">; facts: Fact[]; shiftKey: string; shiftStart: Date };

/**
 * The shift handover's SBAR, DRAFTED FROM RECORDS (spec §0A principle 6): every line is built from a row and carries
 * its source; numbers come from the rows, never from a model. The shift's events come from the same fact builder as
 * "Since yesterday", over the window of the giving nurse's shift.
 */
async function sbarBase(db: Db, actor: Actor, admissionId: string, now: Date): Promise<SbarBase> {
  await requireIpdPermission(db, actor, IPD_SHIFT_HANDOVER);
  const chart = await readNursingChart(db, actor, admissionId, { now });
  const a = await readAdmission(db, admissionId);
  const shift = shiftOf(now);
  const facts = await buildFacts(db, a, { since: shift.startsAt, until: now });
  const by = (kind: Fact["kind"]): Fact[] => facts.filter((f) => f.kind === kind);

  const situation: SbarLine[] = [];
  const lastScored = chart.vitals.find((v) => v.score !== null);
  const ews = by("ews")[0];
  if (ews !== undefined) situation.push(factLine(ews));
  else if (lastScored?.score != null) {
    situation.push(sbarLine(`${KIND_WORD[lastScored.score.kind]} ${String(lastScored.score.value)} at ${istClock(new Date(lastScored.observedAt))}`, "vitals",
      [{ id: lastScored.id, at: new Date(lastScored.observedAt), label: `${KIND_WORD[lastScored.score.kind]} ${String(lastScored.score.value)}` }]));
  }
  if (chart.alert !== null) situation.push(sbarLine(chart.alert.acknowledgedAt === null ? "Early-warning alert open — not acknowledged" : "Early-warning alert open — acknowledged", "ews"));
  for (const f of facts) if (f.kind === "vital" && f.abnormal) situation.push(factLine(f));
  for (const f of by("emar_exceptions")) if (f.kind === "emar_exceptions" && f.missed + f.refused + f.held > 0) situation.push(factLine(f));

  const background: SbarLine[] = [];
  if (a.provisionalDiagnosis !== null) background.push(sbarLine(a.provisionalDiagnosis, "admission"));
  if (a.admittedAt !== null) background.push(sbarLine(`Admitted day ${String(istDayIndex(now) - istDayIndex(a.admittedAt) + 1)}`, "admission"));
  for (const f of [...by("npo"), ...by("diet"), ...by("orders_new"), ...by("orders_stopped")]) background.push(factLine(f));

  const assessment: SbarLine[] = [];
  if (chart.assessment !== null) {
    assessment.push(sbarLine(`Morse ${String(chart.assessment.morse)} (${chart.assessment.morseRisk}) · Braden ${String(chart.assessment.braden)} (${chart.assessment.bradenRisk})`, "assessment"));
    if (chart.assessment.allergies.length > 0) assessment.push(sbarLine(`Allergies: ${chart.assessment.allergies.join(", ")}`, "assessment"));
    if (chart.assessment.linesDevices.length > 0) assessment.push(sbarLine(`Lines: ${chart.assessment.linesDevices.map((l) => l.kind.replace(/_/g, " ")).join(", ")}`, "assessment"));
  } else {
    assessment.push(sbarLine("Admission assessment not recorded", "assessment"));
  }
  assessment.push(sbarLine(`I/O since 08:00: in ${String(chart.io.inMl)} ml, out ${String(chart.io.outMl)} ml`, "io",
    chart.io.entries.map((e) => ({ id: e.id, at: new Date(e.observedAt), label: `${e.direction === "in" ? "In" : "Out"} ${String(e.volumeMl)} ml` }))));
  for (const f of [...by("emar_prn"), ...by("notes")]) assessment.push(factLine(f));

  const recommendation: SbarLine[] = [];
  if (chart.next !== null) recommendation.push(sbarLine(`${chart.next.kind === "assessment" ? "Assessment" : "Vitals"} due ${istClock(new Date(chart.next.dueAt))}${chart.next.overdue ? " — overdue" : ""}`, chart.next.kind === "assessment" ? "assessment" : "vitals"));
  for (const f of [...by("results"), ...by("consults")]) recommendation.push(factLine(f));

  return { a, draft: { admissionId, situation, background, assessment, recommendation }, facts, shiftKey: `${istDayString(shift.startsAt)}:${shift.key}`, shiftStart: shift.startsAt };
}

/** The template's stand-in for a model sentence: the latest note of the chart, quoted. */
async function latestNoteLine(db: Db, a: AdmissionRow): Promise<SbarLine | null> {
  const n = (await db.select().from(ipdNursingNotes).where(eq(ipdNursingNotes.admissionId, a.id)).orderBy(desc(ipdNursingNotes.observedAt)).limit(1))[0];
  return n === undefined ? null : sbarLine(n.text.slice(0, 200), "note", [{ id: n.id, at: n.observedAt, label: n.text.slice(0, 160) }]);
}

/** The plain read: the structured SBAR, not kept (no draft id). Deterministic. */
export async function readHandoverDraft(db: Db, actor: Actor, admissionId: string, opts: { now?: Date } = {}): Promise<IpdHandoverDraft> {
  const now = opts.now ?? new Date();
  const b = await sbarBase(db, actor, admissionId, now);
  const note = await latestNoteLine(db, b.a);
  if (note !== null) b.draft.assessment.push(note);
  return { ...b.draft, draftId: null, stamp: stampOf("template", null, SBAR_PROMPT_VERSION, now) };
}

const SBAR_SYSTEM = [
  "You write one or two sentences for the Assessment part of a nurse's shift handover (SBAR) in an Indian hospital.",
  "Summarise ONLY the nursing notes given. Do not add any number, time, medicine, dose, diagnosis or advice that is not in the notes.",
  "Do not recommend or propose anything. Names are replaced by placeholders like <<P1>>: never write a placeholder or a name.",
  'Reply with JSON only: {"assessment":"<one or two sentences>"}',
].join(" ");
const SBAR_FREE_MAX = 400;
const allQuantities = (facts: readonly Fact[]): Quantities => ({ numbers: facts.flatMap((f) => f.numbers), times: facts.flatMap((f) => f.times) });

/**
 * Build and KEEP the nurse's SBAR draft: the structured lines, plus one sentence over the shift's nursing notes — a
 * model's when one is up and its sentence passes the checks, else the latest note quoted. Stamped "Draft · model id ·
 * prompt version · built at". The nurse edits and gives it with `draftId`; nothing here hands over.
 */
export async function buildSbarDraft(db: Db, actor: Actor, admissionId: string, opts: CopilotOpts = {}): Promise<IpdHandoverDraft> {
  const now = opts.now ?? new Date();
  const b = await sbarBase(db, actor, admissionId, now);
  const notes = await db.select().from(ipdNursingNotes)
    .where(and(eq(ipdNursingNotes.admissionId, b.a.id), lte(ipdNursingNotes.observedAt, now))).orderBy(desc(ipdNursingNotes.observedAt)).limit(40);
  const shiftNotes = notes.filter((n) => n.observedAt.getTime() > b.shiftStart.getTime()).reverse();
  let reason: FallbackReason | null = shiftNotes.length === 0 ? "no_text" : null;
  let modelId: string | null = null;
  let modelMs = 0;
  let sentence: SbarLine | null = null;
  if (shiftNotes.length > 0) {
    const sealed = await isSealed(db, b.a.patientId);
    const names = sealed ? [] : await namesToMask(db, b.a, shiftNotes.map((n) => n.recordedBy));
    const user = sealed ? "" : shiftNotes.map((n) => `${istClock(n.observedAt)} ${n.category}: ${maskForModel(n.text, names)}`).join("\n");
    const answer = await askIpdModel(db, actor, opts.model, sealed, { intent: "ipd.sbar_draft", kind: "draft", system: SBAR_SYSTEM, user, budgetMs: DRAFT_BUDGET_MS, maxTokens: 400 }, now);
    modelMs = answer.ms;
    if (answer.text === null) reason = answer.reason;
    else {
      const said = z.object({ assessment: z.string() }).safeParse(jsonIn(answer.text));
      const text = said.success ? said.data.assessment.trim() : "";
      const drugOrders = await db.select().from(ipdOrders).where(and(eq(ipdOrders.admissionId, b.a.id), eq(ipdOrders.kind, "drug")));
      const ok = said.success && verifyFreeText(text, [user], allQuantities(b.facts), SBAR_FREE_MAX).ok
        && !(await medicinesNamedWithoutOrder(db, text, drugOrders, "model", [user])).some((f) => f.reason === "model_invented");
      if (ok) {
        sentence = sbarLine(text, "note", shiftNotes.map((n) => ({ id: n.id, at: n.observedAt, label: n.text.slice(0, 160) })), "model");
        modelId = answer.modelId;
      } else reason = "rejected";
    }
  }
  const draft = { ...b.draft, assessment: [...b.draft.assessment] };
  const fallback = sentence ?? await latestNoteLine(db, b.a);
  if (fallback !== null) draft.assessment.push(fallback);
  const source = sentence === null ? "template" as const : "model" as const;
  const draftId = newId();
  await db.insert(ipdCopilotDrafts).values({
    id: draftId, admissionId: b.a.id, patientId: b.a.patientId, kind: "sbar", scopeKey: b.shiftKey, source, modelId: source === "model" ? modelId : null,
    promptVersion: SBAR_PROMPT_VERSION, factsHash: factsHash(b.facts), content: draft as unknown as Record<string, unknown>, fallbackReason: reason,
    builtBy: actor.id, builtAt: now, modelMs,
  });
  return { ...draft, draftId, stamp: stampOf(source, modelId, SBAR_PROMPT_VERSION, now) };
}

// ═══════════════════════════════════════════ the discharge drafter (T2) ═══════════════════════════════════════════

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "11 Mar 2026", the hospital's calendar day. */
function istDate(at: Date): string {
  const [y, m, d] = istDayString(at).split("-");
  return `${String(Number(d))} ${MONTHS[Number(m) - 1]!} ${y!}`;
}

const DISCHARGE_SYSTEM = [
  "You write the 'course in hospital' paragraph of a discharge summary DRAFT that a doctor will edit and sign.",
  "Summarise ONLY the doctors' round notes and nursing notes given, in past tense, in at most six sentences.",
  "Do not add any medicine, dose, number, date, test result, diagnosis or advice that is not in the notes. Do not recommend or propose anything.",
  "Names are replaced by placeholders like <<P1>>: never write a placeholder or a name.",
  'Reply with JSON only: {"course":"<the paragraph>"}',
].join(" ");
const COURSE_MAX = 1200;

function medicineRows(drugOrders: readonly IpdOrderRow[]): IpdSummaryContent["medicines"] {
  return drugOrders.filter((o) => o.status === "active").slice(0, 40).map((o) => ({
    name: (o.medicineName ?? "Medicine").slice(0, 160),
    ...(o.doseValue !== null && o.doseUnit !== null ? { dose: `${String(o.doseValue)} ${o.doseUnit}` } : {}),
    ...(o.frequency !== null ? { frequency: o.frequency } : {}),
    ...(o.stopAt !== null ? { duration: `until ${istDate(o.stopAt)}` } : o.durationDays !== null ? { duration: `${String(o.durationDays)} days` } : {}),
    source: "order" as const, orderId: o.id,
  }));
}

/**
 * Build and KEEP a discharge summary draft. STRUCTURED PARTS COME FROM THE RECORD, NEVER FROM A MODEL: the diagnosis (the
 * admission's), results reported and awaited (the stay's lab and imaging orders), and the medicines — one row per
 * ACTIVE drug order, each naming its order. Procedures have no record this module can read (the theatre's), so the
 * field is left for the doctor. The course in hospital is the round notes quoted in order (template), or a model's
 * summary of the masked notes when one is up and its text passes the checks; a text that names a medicine on no order
 * and in no note is dropped and flagged. A sealed patient gets the template only. The doctor edits and signs through
 * the existing summary acts; nothing here saves or signs a summary.
 */
export async function buildDischargeDraft(db: Db, actor: Actor, admissionId: string, opts: CopilotOpts = {}): Promise<IpdDischargeDraft> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_DECLARE);
  const now = opts.now ?? new Date();
  const a = await readAdmission(db, admissionId);
  const orders = await db.select().from(ipdOrders).where(eq(ipdOrders.admissionId, a.id)).orderBy(asc(ipdOrders.orderedAt)).limit(400);
  const drugOrders = orders.filter((o) => o.kind === "drug");
  const rounds = (await db.select().from(ipdRounds).where(and(eq(ipdRounds.admissionId, a.id), eq(ipdRounds.status, "signed")))
    .orderBy(desc(ipdRounds.seenAt)).limit(12)).reverse();
  const notes = (await db.select().from(ipdNursingNotes).where(eq(ipdNursingNotes.admissionId, a.id)).orderBy(desc(ipdNursingNotes.observedAt)).limit(30)).reverse();

  // Results: reported and awaited items of the stay's own lab / imaging orders (restricted items never named — DD11).
  const placed = orders.flatMap((o) => (o.departmentOrderId !== null && o.kind !== "drug" ? [o.departmentOrderId] : []));
  const items = placed.length === 0 ? [] : await db.select({ id: orderItems.id, at: orderItems.completedAt, cancelledAt: orderItems.cancelledAt, name: services.name })
    .from(orderItems).innerJoin(services, eq(services.id, orderItems.serviceId))
    .where(and(inArray(orderItems.orderId, placed), eq(orderItems.restricted, false), isNull(orderItems.cancelledAt))).limit(400);
  const reported = items.filter((i) => i.at !== null);
  const awaited = items.filter((i) => i.at === null);

  const said = (r: (typeof rounds)[number]): string => [r.soap.assessment, r.soap.plan === undefined ? undefined : `plan: ${r.soap.plan}`]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "").join("; ");
  const quoted = rounds.filter((r) => said(r) !== "").slice(-6).map((r) => `${istDate(r.seenAt)} — ${said(r)}.`);
  const opening = a.admittedAt === null ? "" : `Admitted ${istDate(a.admittedAt)}; day ${String(Math.max(1, dayOfStay(a.admittedAt, istDayString(now))))} of stay.`;
  const tests = reported.length === 0 ? "" : `Reported: ${[...new Set(reported.map((i) => i.name))].join(", ")}.`;
  const templateCourse = [opening, ...quoted, tests].filter((s) => s !== "").join(" ").slice(0, 4000);

  let course = templateCourse;
  let source: "template" | "model" = "template";
  let modelId: string | null = null;
  let modelMs = 0;
  let reason: FallbackReason | null = null;
  const flags: IpdMedicineFlag[] = [];
  if (rounds.length + notes.length === 0) reason = "no_text";
  else {
    const sealed = await isSealed(db, a.patientId);
    const names = sealed ? [] : await namesToMask(db, a, [...rounds.map((r) => r.authorId), ...notes.map((n) => n.recordedBy)]);
    const user = sealed ? "" : [
      ...rounds.map((r) => `Round ${istDate(r.seenAt)}: ${maskForModel(Object.values(r.soap).filter((s) => typeof s === "string").join(" | "), names)}`),
      ...notes.map((n) => `Nursing ${istDate(n.observedAt)} ${n.category}: ${maskForModel(n.text, names)}`),
    ].join("\n").slice(0, 12_000);
    const answer = await askIpdModel(db, actor, opts.model, sealed, { intent: "ipd.discharge_draft", kind: "draft", system: DISCHARGE_SYSTEM, user, budgetMs: DRAFT_BUDGET_MS, maxTokens: 900 }, now);
    modelMs = answer.ms;
    if (answer.text === null) reason = answer.reason;
    else {
      const got = z.object({ course: z.string() }).safeParse(jsonIn(answer.text));
      const text = got.success ? got.data.course.trim() : "";
      const named = got.success ? await medicinesNamedWithoutOrder(db, text, drugOrders, "model", [user]) : [];
      const invented = named.filter((f) => f.reason === "model_invented");
      if (got.success && invented.length === 0 && verifyFreeText(text, [user], { numbers: [], times: [] }, COURSE_MAX).ok) {
        course = text; source = "model"; modelId = answer.modelId;
      } else {
        // The model's text is dropped; what it invented is shown to the doctor as a flag, never as a medicine.
        reason = "rejected";
        flags.push(...invented);
      }
    }
  }
  flags.push(...(await medicinesNamedWithoutOrder(db, course, drugOrders, source, [])).filter((f) => f.reason !== "model_invented"));

  const medicines = medicineRows(drugOrders);
  flags.push(...medicineFlagsOf(medicines, drugOrders));
  const content = IpdSummaryContentSchema.parse({
    diagnosis: { text: (a.provisionalDiagnosis ?? "").trim() === "" ? "To be completed" : a.provisionalDiagnosis },
    course, medicines, pendingResults: [...new Set(awaited.map((i) => i.name))].join(", ").slice(0, 1000),
  });
  const sources: IpdDischargeDraft["sources"] = [
    { field: "diagnosis", source: "admission", records: [{ id: a.id, at: a.admittedAt?.toISOString() ?? null, label: "Diagnosis at admission" }] },
    { field: "course", source: "round", records: rounds.map((r) => ({ id: r.id, at: r.seenAt.toISOString(), label: `Round ${istDate(r.seenAt)} ${istClock(r.seenAt)}` })) },
    { field: "medicines", source: "order", records: drugOrders.filter((o) => o.status === "active").map((o) => ({ id: o.id, at: o.orderedAt.toISOString(), label: o.medicineName ?? "Medicine" })) },
    { field: "pendingResults", source: "lab", records: awaited.map((i) => ({ id: i.id, at: null, label: i.name })) },
  ];
  const draftId = newId();
  await db.insert(ipdCopilotDrafts).values({
    id: draftId, admissionId: a.id, patientId: a.patientId, kind: "discharge", scopeKey: "", source, modelId: source === "model" ? modelId : null,
    promptVersion: DISCHARGE_PROMPT_VERSION, factsHash: factsHash([]), content: { content, flags } as unknown as Record<string, unknown>,
    fallbackReason: reason, builtBy: actor.id, builtAt: now, modelMs,
  });
  return { draftId, admissionId: a.id, stamp: stampOf(source, modelId, DISCHARGE_PROMPT_VERSION, now), content, sources, flags };
}
