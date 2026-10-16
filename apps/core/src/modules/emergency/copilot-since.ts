import { Logger } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { ER_ESI_INFO, ER_SINCE_MAX_LINES, erIstHm, renderSinceLine } from "@hmis/contracts";
import {
  erDoses, erEpisodes, erMedIssues, erMlcs, erNotes, erProcedures, erSpecialtyCalls, erTriageEntries, orderItems, orders, services, users,
} from "../../kernel/db/schema";
import { quantitiesIn } from "../ipd";
import { openCriticalsForEncounters } from "../lab";
import { requireErPermission } from "./core";
import { ErRefusal } from "./errors";
import { mlcOfEpisode } from "./mlc";
import { ER_CARE } from "./names";
import type { Actor, ErEsiLevel, ErSinceArrival, ErSinceFact, ErSinceLine, ErSinceRef, ErSinceSource, ErVitals } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ER lane 9 (#816) — "SINCE ARRIVAL" (spec §4.9, §5 D: the ER doctor's patient view opens on it). Four to six lines, each
 * with its SOURCE chip and the records it was read from. Deterministic: no model call, no write (DECIDED, lane 9).
 *
 * THE NUMBER RULE (done means: "a since-arrival line whose number differs from its source fails the suite"), review #894:
 * a line is a TEMPLATE plus TYPED FACTS — `{kind, field, value, ref}`, `ref` naming the stored column the value was read
 * from — and its text is `renderSinceLine(template, facts)` and nothing else. `verifyErSinceLine` re-reads EVERY fact from
 * its column, recomputes every derived minute count from the stored instants, checks an excerpt is a word-boundary prefix
 * of the stored text, and re-renders the text. A line that fails is dropped from the answer and logged — never shown.
 *
 * No money (decision 0058). A restricted test (HIV, PCPNDT-class) is never named; a critical on one shows its urgency
 * without content unless the reader ordered it or holds `orders.read.restricted` (the lab's rule, review #894).
 */

const MIN = 60_000;
const logger = new Logger("er-since");
/** Excerpts (a complaint, a note, a call's answer) are cut at a word boundary within this many characters. */
export const ER_SINCE_EXCERPT_MAX = { complaint: 80, note: 120, answer: 60 } as const;

/** "14:06", IST, from a server instant. */
export const istHm = (d: Date): string => erIstHm(d);

type Candidate = ErSinceLine & { rank: number };
export type SinceCtx = { now: Date; episodeNo: string; viewer: Actor };

const ref = (table: string, id: string, column: string): ErSinceRef => ({ table, id, column });

/** The start of a stored text, cut at a word boundary (never inside a word or a number). */
export function excerptOf(text: string, max: number): { value: string; cut: boolean } {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return { value: t, cut: false };
  const head = t.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return { value: (at > 0 ? head.slice(0, at) : t.slice(0, max)).trimEnd(), cut: true };
}

/** Builds a line's template and facts together, so the two can never disagree about the order of the slots. */
function build() {
  let template = "";
  const facts: ErSinceFact[] = [];
  const b = {
    w(words: string) { template += words; return b; },
    f(kind: ErSinceFact["kind"], field: string, value: string | number, r: ErSinceRef, to?: ErSinceRef | "now") {
      template += `{${String(facts.length)}}`;
      facts.push({ kind, field, value, ref: r, ...(to === undefined ? {} : { to }) });
      return b;
    },
    /** An excerpt fact, with "…" after it when it was cut (a constant, not part of the fact). */
    x(field: string, text: string, max: number, r: ErSinceRef) {
      const e = excerptOf(text, max);
      b.f("excerpt", field, e.value, r);
      if (e.cut) template += "…";
      return b;
    },
    done() { return { template, facts, text: renderSinceLine(template, facts) }; },
  };
  return b;
}

const minutesBetween = (from: Date, to: Date): number => Math.max(0, Math.floor((to.getTime() - from.getTime()) / MIN));
const vitalsLabel = (v: ErVitals): string => Object.entries(v).map(([k, x]) => `${k} ${String(x)}`).join("; ");

/** Every candidate line for one episode (unchosen), each with its facts and records. Exported for the acceptance suite. */
export async function sinceCandidates(db: Db, episodeId: string, now: Date, viewer: Actor): Promise<{ arrivedAt: Date; episodeNo: string; lines: Candidate[] }> {
  const e = (await db.select().from(erEpisodes).where(eq(erEpisodes.id, episodeId)))[0];
  if (e === undefined) throw new ErRefusal("episode_not_found");
  const out: Candidate[] = [];
  const push = (rank: number, key: string, source: ErSinceSource, at: Date | null, abnormal: boolean, line: ReturnType<ReturnType<typeof build>["done"]>, records: ErSinceLine["records"]): void => {
    out.push({ rank, key, source, at: at?.toISOString() ?? null, abnormal, ...line, records });
  };
  const rec = (id: string, at: Date | null, label: string): ErSinceLine["records"][number] => ({ id, at: at?.toISOString() ?? null, label });
  const E = (column: string): ErSinceRef => ref("er_episodes", e.id, column);

  // ── arrival ──
  {
    const b = build().w("Arrived ").f("time", "arrivedAt", e.arrivedAt.toISOString(), E("arrivedAt")).w(" · ").f("mode", "arrivalMode", e.arrivalMode, E("arrivalMode"));
    if (e.complaint !== null && e.complaint.trim() !== "") b.w(" · ").x("complaint", e.complaint, ER_SINCE_EXCERPT_MAX.complaint, E("complaint"));
    push(90, "arrival", "arrival", e.arrivedAt, false, b.done(), [rec(e.id, e.arrivedAt, `arrived; mode ${e.arrivalMode}`)]);
  }

  // ── triage and vitals ──
  const entries = await db.select().from(erTriageEntries).where(eq(erTriageEntries.episodeId, e.id)).orderBy(asc(erTriageEntries.recordedAt));
  const levels = entries.filter((t) => t.level !== null);
  const last = levels.at(-1);
  if (last !== undefined) {
    const lv = last.level as ErEsiLevel;
    const prev = levels.at(-2);
    const T = (id: string, c: string): ErSinceRef => ref("er_triage_entries", id, c);
    const b = build().w("ESI ").f("number", "level", lv, T(last.id, "level")).w(" ").f("esi_word", "level", lv, T(last.id, "level"))
      .w(" at ").f("time", "recordedAt", last.recordedAt.toISOString(), T(last.id, "recordedAt"));
    if (prev !== undefined && prev.level !== lv) b.w(" (was ESI ").f("number", "level", prev.level!, T(prev.id, "level")).w(")");
    push(30, "triage", "triage", last.recordedAt, lv <= 2, b.done(),
      [last, ...(prev === undefined ? [] : [prev])].map((t) => rec(t.id, t.recordedAt, `${t.kind}; level ${String(t.level)}`)));
  }
  const lastVitals = [...entries].reverse().find((t) => t.vitals !== null && Object.keys(t.vitals).length > 0);
  if (lastVitals !== undefined) {
    const v = lastVitals.vitals as ErVitals;
    const T = (c: string): ErSinceRef => ref("er_triage_entries", lastVitals.id, c);
    const b = build().w("Vitals ").f("time", "takenAt", lastVitals.takenAt.toISOString(), T("takenAt")).w(":");
    const parts: (() => void)[] = [];
    if (v.pulse !== undefined) parts.push(() => b.w(" P ").f("number", "pulse", v.pulse!, T("vitals.pulse")));
    if (v.systolic !== undefined) {
      parts.push(() => {
        b.w(v.diastolic === undefined ? " SBP " : " BP ").f("number", "systolic", v.systolic!, T("vitals.systolic"));
        if (v.diastolic !== undefined) b.w("/").f("number", "diastolic", v.diastolic, T("vitals.diastolic"));
      });
    }
    if (v.respRate !== undefined) parts.push(() => b.w(" RR ").f("number", "respRate", v.respRate!, T("vitals.respRate")));
    if (v.spo2 !== undefined) parts.push(() => { b.w(" SpO2 ").f("number", "spo2", v.spo2!, T("vitals.spo2")).w(v.onOxygen === true ? "% on O2" : "%"); });
    if (v.temperatureC !== undefined) parts.push(() => b.w(" T ").f("number", "temperatureC", v.temperatureC!, T("vitals.temperatureC")));
    if (v.consciousness !== undefined && v.consciousness !== "alert") parts.push(() => b.w(" ").f("text", "consciousness", v.consciousness!, T("vitals.consciousness")));
    parts.forEach((p, i) => { if (i > 0) b.w(" ·"); p(); });
    if (lastVitals.ewsKind !== null && lastVitals.ewsValue !== null) {
      b.w(" · ").f("text", "ewsKind", lastVitals.ewsKind.toUpperCase(), T("ewsKind")).w(" ").f("number", "ewsValue", lastVitals.ewsValue, T("ewsValue"));
      if (lastVitals.ewsBand !== null) b.w(" ").f("text", "ewsBand", lastVitals.ewsBand, T("ewsBand"));
    }
    const abnormal = lastVitals.ewsBand === "high" || lastVitals.ewsBand === "medium";
    push(abnormal ? 15 : 35, "vitals", "vitals", lastVitals.takenAt, abnormal, b.done(), [rec(lastVitals.id, lastVitals.takenAt, `vitals; ${vitalsLabel(v)}`)]);
  }

  // ── the doctor ──
  const level = (e.esi ?? null) as ErEsiLevel | null;
  if (e.seenAt !== null) {
    const doc = e.doctorId === null ? undefined : (await db.select({ n: users.fullName }).from(users).where(eq(users.id, e.doctorId)))[0]?.n;
    const b = build().w("Seen by ");
    if (doc !== undefined) b.f("text", "doctor", doc, ref("users", e.doctorId!, "fullName")); else b.w("the ER doctor");
    b.w(" at ").f("time", "seenAt", e.seenAt.toISOString(), E("seenAt")).w(", ")
      .f("minutes", "doorToDoctor", minutesBetween(e.arrivedAt, e.seenAt), E("arrivedAt"), E("seenAt")).w(" min after arrival");
    push(40, "doctor", "doctor", e.seenAt, false, b.done(), [rec(e.id, e.seenAt, "seen by the ER doctor")]);
  } else if (level !== null && e.departedAt === null) {
    const waited = minutesBetween(e.arrivedAt, now);
    const target = ER_ESI_INFO[level].doctorWithinMin; // ranks the line; not stated in it (a constant is not a fact)
    const b = build().w("No doctor yet · waiting ").f("minutes", "waited", waited, E("arrivedAt"), "now").w(" min (ESI ")
      .f("number", "esi", level, E("esi")).w(")");
    push(waited > target ? 12 : 45, "doctor", "doctor", null, waited > target, b.done(), [rec(e.id, e.arrivedAt, "waiting for the ER doctor")]);
  }

  // ── specialty calls ──
  const calls = await db.select().from(erSpecialtyCalls).where(eq(erSpecialtyCalls.episodeId, e.id)).orderBy(desc(erSpecialtyCalls.calledAt)).limit(3);
  for (const c of calls) {
    const C = (col: string): ErSinceRef => ref("er_specialty_calls", c.id, col);
    const open = c.answeredAt === null;
    const b = build().f("text", "departmentCode", c.departmentCode, C("departmentCode")).w(" called ").f("time", "calledAt", c.calledAt.toISOString(), C("calledAt"));
    let waited = 0;
    if (open) {
      waited = minutesBetween(c.calledAt, now);
      b.w(" · not answered, ").f("minutes", "waited", waited, C("calledAt"), "now").w(" min");
    } else {
      b.w(" · answered ").f("time", "answeredAt", c.answeredAt!.toISOString(), C("answeredAt"));
      if (c.answerNote !== null && c.answerNote.trim() !== "") b.w(": ").x("answerNote", c.answerNote, ER_SINCE_EXCERPT_MAX.answer, C("answerNote"));
    }
    push(open && waited >= 15 ? 14 : 50, `call:${c.id}`, "call", c.calledAt, open && waited >= 15, b.done(), [rec(c.id, c.calledAt, `call ${c.departmentCode}`)]);
  }

  // ── criticals (the lab's open ones, its restricted-test rule applied for the reader) and tests ──
  for (const c of await openCriticalsForEncounters(db, [e.episodeNo], viewer)) {
    const K = (col: string): ErSinceRef => ref("lab_critical", c.callId, col);
    const b = build();
    if (c.masked) b.w("Critical result (restricted test)");
    else {
      b.w("Critical: ").f("text", "analyteCode", c.analyteCode, K("analyteCode")).w(" ").f("text", "value", c.value, K("value"));
      if (c.unit !== null) b.w(" ").f("text", "unit", c.unit, K("unit"));
    }
    b.w(" at ").f("time", "openedAt", c.openedAt.toISOString(), K("openedAt")).w(" · not yet read back");
    push(10, `critical:${c.callId}`, "critical", c.openedAt, true, b.done(), [rec(c.callId, c.openedAt, "critical result call")]);
  }
  const items = await db.select({ id: orderItems.id, completedAt: orderItems.completedAt, name: services.name, placedAt: orders.placedAt })
    .from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).innerJoin(services, eq(services.id, orderItems.serviceId))
    .where(and(eq(orders.encounterNo, e.episodeNo), eq(orderItems.restricted, false), isNull(orderItems.cancelledAt)))
    .orderBy(desc(orders.placedAt)).limit(6);
  if (items.length > 0) {
    const shown = items.slice(0, 4);
    const b = build().w("Tests: ");
    shown.forEach((i, n) => {
      if (n > 0) b.w("; ");
      b.f("text", "name", i.name, ref("order_items", i.id, "name"));
      if (i.completedAt === null) b.w(" pending"); else b.w(" done ").f("time", "completedAt", i.completedAt.toISOString(), ref("order_items", i.id, "completedAt"));
    });
    if (items.length > shown.length) b.w("; and more");
    push(55, "results", "results", items[0]!.placedAt, false, b.done(), shown.map((i) => rec(i.id, i.completedAt ?? i.placedAt, `test ${i.name}`)));
  }

  // ── medicines and procedures ──
  const meds = await db.select().from(erMedIssues).where(eq(erMedIssues.episodeId, e.id)).orderBy(desc(erMedIssues.issuedAt)).limit(6);
  const doses = meds.length === 0 ? [] : await db.select().from(erDoses).where(inArray(erDoses.issueId, meds.map((m) => m.id)));
  const doseOf = new Map(doses.map((d) => [d.issueId, d] as const));
  const recorded = meds.filter((m) => doseOf.has(m.id)).slice(0, 3);
  if (recorded.length > 0) {
    const b = build().w("Medicines: ");
    recorded.forEach((m, n) => {
      const d = doseOf.get(m.id)!;
      if (n > 0) b.w("; ");
      b.f("text", "name", m.name, ref("er_med_issues", m.id, "name")).w(" ").f("text", "doseWords", m.doseWords, ref("er_med_issues", m.id, "doseWords"))
        .w(" ").f("text", "outcome", d.outcome, ref("er_doses", d.id, "outcome")).w(" ").f("time", "recordedAt", d.recordedAt.toISOString(), ref("er_doses", d.id, "recordedAt"));
    });
    push(60, "meds", "meds", doseOf.get(recorded[0]!.id)!.recordedAt, false, b.done(), recorded.map((m) => rec(doseOf.get(m.id)!.id, doseOf.get(m.id)!.recordedAt, `dose ${m.name}`)));
  }
  const procs = await db.select().from(erProcedures).where(eq(erProcedures.episodeId, e.id)).orderBy(desc(erProcedures.performedAt)).limit(3);
  if (procs.length > 0) {
    const b = build().w("Procedures: ");
    procs.forEach((p, n) => {
      if (n > 0) b.w("; ");
      b.f("text", "name", p.name, ref("er_procedures", p.id, "name")).w(" ").f("time", "performedAt", p.performedAt.toISOString(), ref("er_procedures", p.id, "performedAt"));
    });
    push(65, "procedures", "procedure", procs[0]!.performedAt, false, b.done(), procs.map((p) => rec(p.id, p.performedAt, `procedure ${p.name}`)));
  }

  // ── the MLC, the disposition, the last note ──
  const mlc = await mlcOfEpisode(db, e.id);
  if (mlc !== undefined) {
    const b = build().w("MLC ").f("text", "mlcNo", mlc.mlcNo, ref("er_mlcs", mlc.id, "mlcNo")).w(" opened ").f("time", "openedAt", mlc.openedAt.toISOString(), ref("er_mlcs", mlc.id, "openedAt"));
    push(70, "mlc", "mlc", mlc.openedAt, false, b.done(), [rec(mlc.id, mlc.openedAt, "medico-legal case")]);
  }
  if (e.disposition !== null && e.dispositionAt !== null) {
    const b = build().w("Decision: ").f("text", "disposition", e.disposition, E("disposition")).w(" at ").f("time", "dispositionAt", e.dispositionAt.toISOString(), E("dispositionAt"));
    if (e.boardingSince !== null && e.state === "disposition_decided") b.w(" · boarding since ").f("time", "boardingSince", e.boardingSince.toISOString(), E("boardingSince"));
    push(25, "disposition", "disposition", e.dispositionAt, false, b.done(), [rec(e.id, e.dispositionAt, "disposition")]);
  }
  const note = (await db.select().from(erNotes).where(eq(erNotes.episodeId, e.id)).orderBy(desc(erNotes.recordedAt)).limit(1))[0];
  if (note !== undefined) {
    const N = (c: string): ErSinceRef => ref("er_notes", note.id, c);
    const b = build().w("Note ").f("time", "recordedAt", note.recordedAt.toISOString(), N("recordedAt")).w(note.status === "draft" ? " (draft): " : ": ")
      .x("text", note.text, ER_SINCE_EXCERPT_MAX.note, N("text"));
    push(75, "note", "note", note.recordedAt, false, b.done(), [rec(note.id, note.recordedAt, `${note.kind} note`)]);
  }
  return { arrivedAt: e.arrivedAt, episodeNo: e.episodeNo, lines: out };
}

// ═══════════════════════════════════════════ the verifier ═══════════════════════════════════════════

type Row = Record<string, unknown>;

/**
 * Review #894 — WHICH FIELD EACH STORED COLUMN MAY BE SHOWN AS (fixed): a fact whose `field` is not its column's is
 * refused, so a value cannot be presented as another measurement (a pulse as a systolic).
 */
export const SINCE_FACT_FIELDS: Readonly<Record<string, string>> = {
  "er_episodes.arrivedAt": "arrivedAt", "er_episodes.arrivalMode": "arrivalMode", "er_episodes.complaint": "complaint",
  "er_episodes.seenAt": "seenAt", "er_episodes.esi": "esi", "er_episodes.disposition": "disposition",
  "er_episodes.dispositionAt": "dispositionAt", "er_episodes.boardingSince": "boardingSince",
  "er_triage_entries.level": "level", "er_triage_entries.recordedAt": "recordedAt", "er_triage_entries.takenAt": "takenAt",
  "er_triage_entries.vitals.pulse": "pulse", "er_triage_entries.vitals.systolic": "systolic", "er_triage_entries.vitals.diastolic": "diastolic",
  "er_triage_entries.vitals.respRate": "respRate", "er_triage_entries.vitals.spo2": "spo2", "er_triage_entries.vitals.temperatureC": "temperatureC",
  "er_triage_entries.vitals.consciousness": "consciousness", "er_triage_entries.ewsKind": "ewsKind", "er_triage_entries.ewsValue": "ewsValue",
  "er_triage_entries.ewsBand": "ewsBand",
  "users.fullName": "doctor",
  "er_specialty_calls.departmentCode": "departmentCode", "er_specialty_calls.calledAt": "calledAt", "er_specialty_calls.answeredAt": "answeredAt",
  "er_specialty_calls.answerNote": "answerNote",
  "lab_critical.analyteCode": "analyteCode", "lab_critical.value": "value", "lab_critical.unit": "unit", "lab_critical.openedAt": "openedAt",
  "order_items.name": "name", "order_items.completedAt": "completedAt",
  "er_med_issues.name": "name", "er_med_issues.doseWords": "doseWords", "er_doses.outcome": "outcome", "er_doses.recordedAt": "recordedAt",
  "er_procedures.name": "name", "er_procedures.performedAt": "performedAt",
  "er_mlcs.mlcNo": "mlcNo", "er_mlcs.openedAt": "openedAt",
  "er_notes.recordedAt": "recordedAt", "er_notes.text": "text",
};

/** Review #894 — the instants each derived minute count may be computed between (`to` on the same row, or the read's now). */
export const SINCE_MINUTES_PAIRS: Readonly<Record<string, readonly { from: string; to: string }[]>> = {
  doorToDoctor: [{ from: "er_episodes.arrivedAt", to: "er_episodes.seenAt" }],
  waited: [{ from: "er_episodes.arrivedAt", to: "now" }, { from: "er_specialty_calls.calledAt", to: "now" }],
};

const SLOT_RE = /\{(\d+)\}/g;

/** The stored row behind a reference, read fresh (never from the line). An unknown table reads as missing. */
async function storedRow(db: Db, r: ErSinceRef, ctx: SinceCtx): Promise<Row | undefined> {
  const one = async (q: Promise<Row[]>): Promise<Row | undefined> => (await q)[0];
  switch (r.table) {
    case "er_episodes": return one(db.select().from(erEpisodes).where(eq(erEpisodes.id, r.id)));
    case "er_triage_entries": return one(db.select().from(erTriageEntries).where(eq(erTriageEntries.id, r.id)));
    case "er_specialty_calls": return one(db.select().from(erSpecialtyCalls).where(eq(erSpecialtyCalls.id, r.id)));
    case "er_med_issues": return one(db.select().from(erMedIssues).where(eq(erMedIssues.id, r.id)));
    case "er_doses": return one(db.select().from(erDoses).where(eq(erDoses.id, r.id)));
    case "er_procedures": return one(db.select().from(erProcedures).where(eq(erProcedures.id, r.id)));
    case "er_mlcs": return one(db.select().from(erMlcs).where(eq(erMlcs.id, r.id)));
    case "er_notes": return one(db.select().from(erNotes).where(eq(erNotes.id, r.id)));
    case "users": return one(db.select({ fullName: users.fullName }).from(users).where(eq(users.id, r.id)));
    case "order_items": return one(db.select({ name: services.name, completedAt: orderItems.completedAt }).from(orderItems)
      .innerJoin(services, eq(services.id, orderItems.serviceId)).where(and(eq(orderItems.id, r.id), eq(orderItems.restricted, false))));
    case "lab_critical": {
      const c = (await openCriticalsForEncounters(db, [ctx.episodeNo], ctx.viewer)).find((x) => x.callId === r.id);
      return c === undefined || c.masked ? (c === undefined ? undefined : { openedAt: c.openedAt }) : { ...c };
    }
    default: return undefined;
  }
}

/** A column of a stored row; `vitals.pulse` reads inside a JSON column. */
function columnOf(row: Row, column: string): unknown {
  return column.split(".").reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Row)[k] : undefined), row);
}

const asComparable = (v: unknown): string | number | null => (v instanceof Date ? v.toISOString() : typeof v === "number" || typeof v === "string" ? v : null);

/**
 * May this line stand? Every fact equals its stored column (an instant, a number, a word); an excerpt is a word-boundary
 * prefix of the stored text; a derived minute count equals the minutes recomputed from the stored instants (to `now`,
 * the read's instant, when it runs to the present); and the text is exactly the template rendered from those facts.
 */
export async function verifyErSinceLine(db: Db, line: Pick<ErSinceLine, "text" | "template" | "facts" | "records">, ctx: SinceCtx): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (line.records.length === 0) return { ok: false, reason: "no_records" };
  // The template's own words state no quantity: every number, number word, Devanagari digit and clock time is a slot.
  const constant = quantitiesIn(line.template.replace(SLOT_RE, " "));
  if (constant.numbers.length > 0 || constant.times.length > 0) return { ok: false, reason: "template_states_a_number" };
  const slots = [...line.template.matchAll(SLOT_RE)].map((m) => Number(m[1]));
  if (slots.some((i) => i >= line.facts.length)) return { ok: false, reason: "slot_without_fact" };
  if (line.facts.some((_f, i) => !slots.includes(i))) return { ok: false, reason: "fact_without_slot" };
  for (const f of line.facts) {
    const col = `${f.ref.table}.${f.ref.column}`;
    if (f.kind === "minutes") {
      const to = f.to === undefined ? null : f.to === "now" ? "now" : `${f.to.table}.${f.to.column}`;
      const ok = (SINCE_MINUTES_PAIRS[f.field] ?? []).some((p) => p.from === col && p.to === to)
        && (f.to === "now" || (f.to !== undefined && f.to.table === f.ref.table && f.to.id === f.ref.id));
      if (!ok) return { ok: false, reason: `minutes_pair_not_allowed:${f.field}` };
    } else if (SINCE_FACT_FIELDS[col] !== f.field) return { ok: false, reason: `field_not_column:${f.field}` };
  }
  const rows = new Map<string, Row | undefined>();
  const read = async (r: ErSinceRef): Promise<Row | undefined> => {
    const k = `${r.table}:${r.id}`;
    if (!rows.has(k)) rows.set(k, await storedRow(db, r, ctx));
    return rows.get(k);
  };
  for (const f of line.facts) {
    const row = await read(f.ref);
    if (row === undefined) return { ok: false, reason: `source_missing:${f.ref.table}.${f.ref.column}` };
    const stored = columnOf(row, f.ref.column);
    if (f.kind === "minutes") {
      const from = stored instanceof Date ? stored : null;
      let to: Date | null = null;
      if (f.to === "now") to = ctx.now;
      else if (f.to !== undefined) { const r2 = await read(f.to); const t = r2 === undefined ? null : columnOf(r2, f.to.column); to = t instanceof Date ? t : null; }
      if (from === null || to === null) return { ok: false, reason: `minutes_without_instants:${f.field}` };
      if (minutesBetween(from, to) !== Number(f.value)) return { ok: false, reason: `minutes_differ:${f.field}` };
      continue;
    }
    if (f.kind === "excerpt") {
      const full = typeof stored === "string" ? stored.replace(/\s+/g, " ").trim() : null;
      const v = String(f.value);
      if (full === null || !full.startsWith(v) || (full.length > v.length && full[v.length] !== " ")) return { ok: false, reason: `excerpt_differs:${f.field}` };
      continue;
    }
    const s = asComparable(stored);
    const same = typeof f.value === "number" ? s !== null && Number(s) === f.value : f.ref.column === "ewsKind" ? String(s).toUpperCase() === f.value : s === f.value;
    if (!same) return { ok: false, reason: `value_differs:${f.field}` };
  }
  if (renderSinceLine(line.template, line.facts) !== line.text) return { ok: false, reason: "text_not_from_facts" };
  return { ok: true };
}

/** The doctor's "since arrival": the six most telling lines (critical and abnormal first), each verified, none written. */
export async function readSinceArrival(db: Db, actor: Actor, episodeId: string, opts: { now?: Date } = {}): Promise<ErSinceArrival> {
  await requireErPermission(db, actor, ER_CARE);
  const now = opts.now ?? new Date();
  const { arrivedAt, episodeNo, lines } = await sinceCandidates(db, episodeId, now, actor);
  const kept: Candidate[] = [];
  for (const l of lines) {
    const v = await verifyErSinceLine(db, l, { now, episodeNo, viewer: actor });
    if (v.ok) kept.push(l); else logger.warn(`since-arrival line ${l.key} dropped: ${v.reason}`);
  }
  const chosen = kept.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).slice(0, ER_SINCE_MAX_LINES)
    .map((l): ErSinceLine => ({ key: l.key, text: l.text, template: l.template, facts: l.facts, source: l.source, at: l.at, abnormal: l.abnormal, records: l.records }));
  return { episodeId, asOf: now.toISOString(), arrivedAt: arrivedAt.toISOString(), lines: chosen };
}
