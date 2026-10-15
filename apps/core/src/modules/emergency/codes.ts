import { and, asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { ER_CODE_ANYWHERE, ER_CODE_CLOCKS, ER_CODE_TEAM, ER_INTENTS, ER_OPEN_STATES, erIsInFuture, newId } from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { withTx } from "../../kernel/db/client";
import { erCodeEvents, erCodes, erEpisodes, resources, users } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { actorHoldsAnyRole, usersHoldingRole } from "../../kernel/workflow/roles";
import { getPatientSummaries } from "../patients";
import { calloutList, escalationRecipients, orgDepartmentByCode } from "../roster";
import { lockEpisode, onceEr, provenanceOf, requireErPermission } from "./core";
import { ErError, ErRefusal } from "./errors";
import { erCodeCalled, erCodeDebriefed, erCodeEnded, erCodeEvent } from "./events";
import { ER_CODES } from "./names";
import { isActiveDoctor } from "./triage";
import type { Actor, ErCodeKind, ErCodeView, ErCodes, ErIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ER lane 7 (#814) — CODES AND ACTIVATIONS (spec SPEC-emergency §3.9, §4.7; contracts `emergency/codes.ts`).
 *
 * - `callCode` pages in the call's own transaction: a bell row per person of the team, which the platform relays to their
 *   phones at once (`alert.raised` → FCM; the phone's text is the platform's content-free "open HMIS" notice — no name,
 *   ever). The team: the department on take for the code through the roster's call-out list (`ER_CODE_TEAM`), plus the ER
 *   doctor of record; Code Blue also its own ladder (`code_blue`, fallback anaesthetist); Code Grey security only
 *   (`code_grey`, fallback security guard), who alone see the location; nobody paged → the fallback role's holders.
 *   The bell's words name the code and the bay, never the patient.
 * - The record: `recordCodeEvent` appends one timed row (server time; a paper sheet's time flagged `fromPaper`); the first
 *   recorder is the scribe. A wrong bay is corrected by a `location` event, never a new code.
 * - Clocks (`ER_CODE_CLOCKS`) run from the DOOR (`door_at` = the ER gate) — snakebite's ASV and the obstetric hand-over
 *   from the activation; a `milestone` event meets one.
 * - `endCode`: the team leader (a doctor) with an outcome; `recordCodeDebrief`: that leader, once, after the end.
 */
type Input<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["input"]>;
type Output<N extends ErIntentName> = z.infer<(typeof ER_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type CodeRow = typeof erCodes.$inferSelect;
type EventRow = typeof erCodeEvents.$inferSelect;
const MIN = 60_000;
const OPEN: readonly string[] = ER_OPEN_STATES;
const CODE_WORDS: Record<ErCodeKind, string> = {
  code_blue: "Code Blue", code_grey: "Code Grey", stemi: "STEMI", stroke: "Stroke", trauma: "Trauma", sepsis: "Sepsis",
  snakebite: "Snakebite", obstetric: "Obstetric emergency",
};

/**
 * ER review 4 (2026-10-15): `er.codes` lets security, the front office and the duty manager CALL a code; a clinical code's
 * record (patient, drugs, rhythms) is the clinicians'. These roles read and write it; the rest see Code Grey only.
 */
const CLINICAL_ROLES = ["doctor", "er_nurse", "ward_nurse", "nursing_supervisor", "medical_superintendent"];
/** Code Grey ends on a doctor's, the MS's or the duty manager's word. */
const GREY_ENDERS = ["doctor", "medical_superintendent", "duty_manager"];

async function isClinical(db: Db | Tx, actor: Actor): Promise<boolean> {
  return actor.type !== "user" || await actorHoldsAnyRole(db as Tx, actor.id, CLINICAL_ROLES);
}

async function nameOf(db: Db | Tx, userId: string): Promise<string> {
  return (await (db as Db).select({ n: users.fullName }).from(users).where(eq(users.id, userId)))[0]?.n ?? userId;
}

async function bayCodeOf(db: Db | Tx, bayId: string | null): Promise<string | null> {
  if (bayId === null) return null;
  return (await (db as Db).select({ code: resources.code }).from(resources).where(eq(resources.id, bayId)))[0]?.code ?? null;
}

/** The clocks of a code: each milestone's due instant (from the door or the activation) and when it was met. */
export function codeClocks(c: Pick<CodeRow, "kind" | "doorAt" | "calledAt">, events: readonly Pick<EventRow, "kind" | "detail" | "at">[]) {
  return ER_CODE_CLOCKS[c.kind as ErCodeKind].map((d) => {
    const from = d.from === "door" ? (c.doorAt ?? c.calledAt) : c.calledAt;
    const met = events.find((e) => e.kind === "milestone" && (e.detail as { milestone?: string }).milestone === d.milestone);
    return { milestone: d.milestone, targetMin: d.targetMin, from: d.from, dueAt: new Date(from.getTime() + d.targetMin * MIN), metAt: met?.at ?? null };
  });
}

async function teamFor(tx: Tx, kind: ErCodeKind, doctorId: string | null, at: Date): Promise<string[]> {
  const ids = new Set<string>();
  const t = ER_CODE_TEAM[kind];
  if (kind !== "code_grey" && doctorId !== null) ids.add(doctorId);
  if (kind === "code_grey") {
    for (const u of (await escalationRecipients(tx, "code_grey", { fallbackRoleKey: t.fallbackRole }, at)).userIds) ids.add(u);
    return [...ids];
  }
  if (t.departmentCode !== null) {
    const dept = await orgDepartmentByCode(tx, t.departmentCode);
    if (dept !== undefined) for (const r of await calloutList(tx, dept.id, at)) if (r.userId !== null) ids.add(r.userId);
  }
  // ER review 4: the ER doctor of record first — the page is capped at 12 and must never drop them.
  if (doctorId !== null) ids.add(doctorId);
  if (kind === "code_blue") for (const u of (await escalationRecipients(tx, "code_blue", { fallbackRoleKey: t.fallbackRole }, at)).userIds) ids.add(u);
  if (ids.size === 0) for (const u of await usersHoldingRole(tx, t.fallbackRole)) ids.add(u);
  return [...ids].slice(0, 12);
}

// ═══════════════════════════════════════════ call_code ═══════════════════════════════════════════

export async function callCode(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"call_code">> {
  const input: Input<"call_code"> = ER_INTENTS.call_code.input.parse(raw);
  await requireErPermission(db, actor, ER_CODES);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "call_code", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const anywhere = ER_CODE_ANYWHERE.includes(input.kind);
    if (!anywhere && input.episodeId === undefined) throw new ErRefusal("code_needs_patient");
    const e = input.episodeId === undefined ? null : await lockEpisode(tx, input.episodeId);
    if (e !== null && !OPEN.includes(e.state)) throw new ErRefusal("episode_wrong_state", { state: e.state });
    if (e !== null) {
      const running = (await tx.select({ id: erCodes.id }).from(erCodes)
        .where(and(eq(erCodes.episodeId, e.id), eq(erCodes.kind, input.kind), isNull(erCodes.endedAt))))[0];
      if (running !== undefined) throw new ErRefusal("code_open", { codeId: running.id });
    }
    const bayId = input.bayId ?? e?.bayId ?? null;
    if (input.bayId !== undefined && (await bayCodeOf(tx, input.bayId)) === null) throw new ErRefusal("bay_not_found");
    const bay = await bayCodeOf(tx, bayId);
    const where = bay ?? input.place ?? "ER";
    const teamIds = await teamFor(tx, input.kind, e?.doctorId ?? null, at);
    const team = [];
    for (const userId of teamIds) team.push({ userId, name: await nameOf(tx, userId) });
    const id = newId();
    const incidentDraft = input.kind === "code_grey"
      ? `Code Grey at ${where}, called by ${await nameOf(tx, actor.id)}${input.note === undefined ? "" : `: ${input.note}`}. Security paged. Draft — to be completed by the duty manager.`
      : null;
    await tx.insert(erCodes).values({
      id, kind: input.kind, episodeId: e?.id ?? null, patientId: e?.patientId ?? null, bayId, place: input.place ?? null, note: input.note ?? null,
      calledBy: actor.id, calledAt: at, doorAt: e?.arrivedAt ?? null, team, incidentDraft,
    });
    // THE PAGE: a bell row per person (relayed to their phones at once). Code and bay — never the patient.
    for (const m of team) {
      await raiseNoticeIn(tx, {
        userId: m.userId, kind: input.kind === "code_grey" ? "er.code_grey" : "er.code",
        title: `${CODE_WORDS[input.kind]} · ${where}`,
        body: input.kind === "code_grey" ? `Security to ${where}` : e === null ? "Respond now" : `${e.episodeNo} · respond now`,
        refType: "er_code", refId: id, sourceKey: `er_code:${id}`, at,
      });
    }
    await appendEvent(tx, erCodeCalled.make({
      payload: { codeId: id, kind: input.kind, episodeId: e?.id ?? null, paged: team.length, provenance: provenanceOf(actor) },
      actor, correlationId: id, ...(e === null ? {} : { patientId: e.patientId }), occurredAt: at,
    }));
    const clocks = codeClocks({ kind: input.kind, doorAt: e?.arrivedAt ?? null, calledAt: at }, []);
    return {
      codeId: id, kind: input.kind, calledAt: at.toISOString(), paged: team.length,
      clocks: clocks.map((c) => ({ milestone: c.milestone, dueAt: c.dueAt.toISOString() })),
    };
  }), at);
}

// ═══════════════════════════════════════════ the record ═══════════════════════════════════════════

async function lockCode(tx: Tx, codeId: string): Promise<CodeRow> {
  const c = (await tx.select().from(erCodes).where(eq(erCodes.id, codeId)).for("update"))[0];
  if (c === undefined) throw new ErRefusal("code_not_found");
  return c;
}

export async function recordCodeEvent(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_code_event">> {
  const input: Input<"record_code_event"> = ER_INTENTS.record_code_event.input.parse(raw);
  await requireErPermission(db, actor, ER_CODES);
  const now = opts.now ?? new Date();
  if (input.at !== undefined && erIsInFuture(input.at, now)) throw new ErRefusal("time_in_future");
  const at = input.at === undefined ? now : new Date(Math.min(new Date(input.at).getTime(), now.getTime()));
  return onceEr(db, actor, "record_code_event", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const c = await lockCode(tx, input.codeId);
    if (c.kind !== "code_grey" && !(await isClinical(tx, actor))) {
      throw new ErError("er_forbidden", "a clinical code's record is the clinicians'", { role: "clinical" });
    }
    if (c.endedAt !== null && input.fromPaper !== true) throw new ErRefusal("code_ended");
    // ER review 4: nothing on the record happened before the patient arrived (or, with no patient, before the call).
    if (at.getTime() < (c.doorAt ?? c.calledAt).getTime()) throw new ErRefusal("event_before_arrival", { doorAt: (c.doorAt ?? c.calledAt).toISOString() });
    if (input.kind === "milestone" && !ER_CODE_CLOCKS[c.kind as ErCodeKind].some((d) => d.milestone === input.milestone)) {
      throw new ErRefusal("milestone_unknown", { milestones: ER_CODE_CLOCKS[c.kind as ErCodeKind].map((d) => d.milestone) });
    }
    const detail: Record<string, unknown> = {};
    for (const k of ["rhythm", "joules", "drug", "dose", "milestone", "place", "note"] as const) if (input[k] !== undefined) detail[k] = input[k];
    const id = newId();
    await tx.insert(erCodeEvents).values({
      id, codeId: c.id, kind: input.kind, detail, at, fromPaper: input.fromPaper === true, recordedBy: actor.id, recordedAt: now,
    });
    const scribeId = c.scribeId ?? actor.id;
    if (c.scribeId === null) await tx.update(erCodes).set({ scribeId }).where(eq(erCodes.id, c.id));
    if (input.kind === "location") await tx.update(erCodes).set({ place: input.place! }).where(eq(erCodes.id, c.id));
    await appendEvent(tx, erCodeEvent.make({
      payload: { codeId: c.id, eventId: id, kind: input.kind, fromPaper: input.fromPaper === true, provenance: provenanceOf(actor) },
      actor, correlationId: c.id, ...(c.patientId === null ? {} : { patientId: c.patientId }), occurredAt: now,
    }));
    return { eventId: id, at: at.toISOString(), scribeId };
  }), now);
}

export async function endCode(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"end_code">> {
  const input: Input<"end_code"> = ER_INTENTS.end_code.input.parse(raw);
  await requireErPermission(db, actor, ER_CODES);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "end_code", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const c = await lockCode(tx, input.codeId);
    if (c.endedAt !== null) throw new ErRefusal("code_ended");
    // Code Grey ends on the duty manager's or a doctor's word; every clinical code needs its team leader, a doctor.
    if (c.kind !== "code_grey" && actor.type === "user" && !(await isActiveDoctor(tx, actor.id))) throw new ErRefusal("not_a_doctor");
    if (c.kind === "code_grey" && actor.type === "user" && !(await actorHoldsAnyRole(tx, actor.id, GREY_ENDERS))) {
      throw new ErError("er_forbidden", "Code Grey ends on a doctor's or the duty manager's word", { role: "code_grey_end" });
    }
    await tx.update(erCodes).set({ endedAt: at, outcome: input.outcome, leaderId: actor.id, ...(input.note === undefined ? {} : { note: input.note }) })
      .where(eq(erCodes.id, c.id));
    await appendEvent(tx, erCodeEnded.make({
      payload: { codeId: c.id, outcome: input.outcome, provenance: provenanceOf(actor) },
      actor, correlationId: c.id, ...(c.patientId === null ? {} : { patientId: c.patientId }), occurredAt: at,
    }));
    return { codeId: c.id, endedAt: at.toISOString(), durationSec: Math.max(0, Math.round((at.getTime() - c.calledAt.getTime()) / 1000)), leaderId: actor.id };
  }), at);
}

export async function recordCodeDebrief(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"record_code_debrief">> {
  const input: Input<"record_code_debrief"> = ER_INTENTS.record_code_debrief.input.parse(raw);
  await requireErPermission(db, actor, ER_CODES);
  const at = opts.now ?? new Date();
  return onceEr(db, actor, "record_code_debrief", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const c = await lockCode(tx, input.codeId);
    if (c.endedAt === null) throw new ErRefusal("code_not_ended");
    if (c.debriefAt !== null) throw new ErRefusal("debrief_recorded");
    if (c.leaderId !== actor.id) throw new ErRefusal("not_code_leader");
    await tx.update(erCodes).set({ debrief: { wentWell: input.wentWell, improve: input.improve, actions: input.actions ?? [] }, debriefBy: actor.id, debriefAt: at })
      .where(eq(erCodes.id, c.id));
    await appendEvent(tx, erCodeDebriefed.make({ payload: { codeId: c.id, provenance: provenanceOf(actor) }, actor, correlationId: c.id, occurredAt: at }));
    return { codeId: c.id, at: at.toISOString() };
  }), at);
}

// ═══════════════════════════════════════════ reads ═══════════════════════════════════════════

function eventWords(e: EventRow): string {
  const d = e.detail as { rhythm?: string; joules?: number; drug?: string; dose?: string; milestone?: string; place?: string; note?: string };
  switch (e.kind) {
    case "rhythm": return d.rhythm ?? "";
    case "shock": return `${String(d.joules ?? "")} J`;
    case "drug": return `${d.drug ?? ""} ${d.dose ?? ""}`.trim();
    case "milestone": return d.milestone ?? "";
    case "location": return d.place ?? "";
    default: return d.note ?? "";
  }
}

async function views(db: Db, actor: Actor, rows: CodeRow[]): Promise<ErCodeView[]> {
  if (rows.length === 0) return [];
  const evs = await db.select().from(erCodeEvents).where(inArray(erCodeEvents.codeId, rows.map((r) => r.id))).orderBy(asc(erCodeEvents.at));
  const eps = new Map((await db.select({ id: erEpisodes.id, no: erEpisodes.episodeNo }).from(erEpisodes)
    .where(inArray(erEpisodes.id, rows.flatMap((r) => (r.episodeId === null ? [] : [r.episodeId])).concat(["-"])))).map((r) => [r.id, r.no] as const));
  const people = new Map((await getPatientSummaries(db, actor, [...new Set(rows.flatMap((r) => (r.patientId === null ? [] : [r.patientId])))]))
    .map((p) => [p.requestedId, p] as const));
  const names = new Map<string, string>();
  const nm = async (id: string | null) => {
    if (id === null) return null;
    if (!names.has(id)) names.set(id, await nameOf(db, id));
    return names.get(id)!;
  };
  const out: ErCodeView[] = [];
  for (const c of rows) {
    const mine = evs.filter((e) => e.codeId === c.id);
    const p = c.patientId === null ? undefined : people.get(c.patientId);
    const events = [];
    for (const e of mine) {
      events.push({ eventId: e.id, kind: e.kind as ErCodeView["events"][number]["kind"], words: eventWords(e), at: e.at.toISOString(), by: (await nm(e.recordedBy))!, fromPaper: e.fromPaper });
    }
    out.push({
      codeId: c.id, kind: c.kind as ErCodeKind, episodeId: c.episodeId, episodeNo: c.episodeId === null ? null : eps.get(c.episodeId) ?? null,
      patientLabel: p === undefined ? null : (p.restricted ? p.alias : p.name) ?? p.uhid,
      where: (await bayCodeOf(db, c.bayId)) ?? c.place ?? "ER", calledAt: c.calledAt.toISOString(), doorAt: c.doorAt?.toISOString() ?? null,
      endedAt: c.endedAt?.toISOString() ?? null, outcome: c.outcome, team: c.team,
      scribe: await nm(c.scribeId), leader: await nm(c.leaderId),
      clocks: codeClocks(c, mine).map((k) => ({ ...k, dueAt: k.dueAt.toISOString(), metAt: k.metAt?.toISOString() ?? null })),
      events, debriefed: c.debriefAt !== null, backfilled: mine.some((e) => e.fromPaper),
    });
  }
  return out;
}

/** The scribe tablet's list: the codes running now, then the last 24 hours' ended ones. */
export async function readErCodes(db: Db, actor: Actor, opts: Opts = {}): Promise<ErCodes> {
  await requireErPermission(db, actor, ER_CODES);
  const now = opts.now ?? new Date();
  const clinical = await isClinical(db, actor);
  const mine = (rows: CodeRow[]) => (clinical ? rows : rows.filter((r) => r.kind === "code_grey"));
  const active = mine(await db.select().from(erCodes).where(isNull(erCodes.endedAt)).orderBy(asc(erCodes.calledAt)).limit(50));
  const recent = mine(await db.select().from(erCodes).where(gte(erCodes.calledAt, new Date(now.getTime() - 24 * 60 * MIN))).orderBy(desc(erCodes.calledAt)).limit(50));
  return { active: await views(db, actor, active), recent: await views(db, actor, recent.filter((r) => r.endedAt !== null)), serverNow: now.toISOString() };
}

export async function readErCode(db: Db, actor: Actor, codeId: string): Promise<ErCodeView> {
  await requireErPermission(db, actor, ER_CODES);
  const c = (await db.select().from(erCodes).where(eq(erCodes.id, codeId)))[0];
  if (c === undefined) throw new ErRefusal("code_not_found");
  if (c.kind !== "code_grey" && !(await isClinical(db, actor))) throw new ErError("er_forbidden", "a clinical code's record is the clinicians'", { role: "clinical" });
  return (await views(db, actor, [c]))[0]!;
}

/** The board's activation clocks per episode: every running clinical code's clocks, the nearest due first. */
export async function activationClocksFor(db: Db | Tx, episodeIds: readonly string[]): Promise<Map<string, { kind: string; milestone: string; dueAt: string; metAt: string | null }[]>> {
  const out = new Map<string, { kind: string; milestone: string; dueAt: string; metAt: string | null }[]>();
  if (episodeIds.length === 0) return out;
  const rows = await (db as Db).select().from(erCodes).where(and(inArray(erCodes.episodeId, [...episodeIds]), isNull(erCodes.endedAt)));
  if (rows.length === 0) return out;
  const evs = await (db as Db).select().from(erCodeEvents).where(and(inArray(erCodeEvents.codeId, rows.map((r) => r.id)), eq(erCodeEvents.kind, "milestone")));
  for (const c of rows) {
    const list = out.get(c.episodeId!) ?? [];
    for (const k of codeClocks(c, evs.filter((e) => e.codeId === c.id))) {
      list.push({ kind: c.kind, milestone: k.milestone, dueAt: k.dueAt.toISOString(), metAt: k.metAt?.toISOString() ?? null });
    }
    out.set(c.episodeId!, list.sort((a, b) => a.dueAt.localeCompare(b.dueAt)));
  }
  return out;
}
