import { and, asc, desc, eq, gt, gte, inArray, notExists, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  MED_INCIDENT_FACTORS, MED_INCIDENT_KINDS, MED_INCIDENT_STAGES, MED_INCIDENT_TYPES, NCC_MERP_CATEGORIES, NEAR_MISS_CATEGORIES,
  pharmacyDispenseLines, pharmacyDispenses, pharmacyMedicationIncidentEvents, pharmacyMedicationIncidents,
  pharmacyRetailSaleLines, pharmacyRetailSales, roleAssignments, rolePermissions, roles, tempRoleGrants, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { itemsByIds } from "../materials";
import { getPatientSummaries } from "../patients";
import { istMonthKey, istMonthStartUtc } from "./config";
import { PharmacyError } from "./errors";
import { incidentEventRecorded, incidentRecorded } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type {
  MedIncidentEventKind, MedIncidentFactor, MedIncidentKind, MedIncidentStage, MedIncidentType, NccMerpCategory,
} from "../../kernel/db/schema";

/**
 * ═══ PHARMACY STAGE D2 — THE MEDICATION ERROR AND NEAR-MISS LOG (NABH MOM, NCC MERP A–I) ═══
 *
 * Anybody at the counter — the pharmacist, the aide, the in-charge — or a doctor records a near miss (NCC
 * MERP A–B: it did not reach the patient) or an error (C–I: it did). The in-charge or the medical
 * superintendent reviews it (root cause, action taken) and closes it. Both tables are append-only; a
 * review or a close is an event row.
 *
 * ═══ BLAME-FREE — the reporter's NAME is for the reviewer only ═══
 *
 * A near-miss log that names people stops being written. So the reporter's user id is kept for the audit
 * trail, and the READ decides who is told it: a holder of `pharmacy.incidents.review` sees the name;
 * everybody else sees only the role the reporter recorded under. The indicator and the web export carry
 * the role and never the name, whoever reads them. The decision is made HERE, on the server, per reader —
 * a screen that hides a name the API sent has not hidden it.
 *
 * ═══ THE INDICATOR ═══
 *
 * Errors per 1,000 dispensed lines per month, and near misses per month (the NABH quality indicator).
 * The denominator is every line that LEFT the pharmacy to a patient in that IST month:
 *   - `pharmacy_dispense_lines` on a dispense `handed_over` in the month (by `handed_over_at`), not
 *     declined, with its stock movement written (`ledger_entry_id`) — the prescription counter;
 *   - `pharmacy_retail_sale_lines` on a sale made in the month (by `sold_at`) — the walk-in and paper
 *     counter, where a line exists only once its stock has moved.
 * A line that was verified but never handed over was not dispensed, so it is not counted.
 */
export const INCIDENT_RECORD_PERMISSION = "pharmacy.incidents.record";
export const INCIDENT_REVIEW_PERMISSION = "pharmacy.incidents.review";
/** An unreviewed incident at category E or above (harm) is late for review after 24 hours. */
export const INCIDENT_REVIEW_HOURS = 24;
const LIST_LIMIT = 200;
const MAX_MONTHS = 24;

export const incidentNumber = (seq: number): string => `MI-${String(seq).padStart(6, "0")}`;
export const kindOfCategory = (c: string): MedIncidentKind => ((NEAR_MISS_CATEGORIES as readonly string[]).includes(c) ? "near_miss" : "error");
/** NCC MERP E–I: the error caused (or may have contributed to) harm. */
export const isHarmCategory = (c: string): boolean => c >= "E" && (NCC_MERP_CATEGORIES as readonly string[]).includes(c);

export type RecordIncidentInput = {
  kind: MedIncidentKind;
  stage: MedIncidentStage;
  type: MedIncidentType;
  category: NccMerpCategory;
  patientId?: string | null;
  /** The desk's line: the dispense and the line's index on it. The patient and the item follow from it. */
  dispenseLine?: { dispenseId: string; lineIdx: number } | null;
  itemId?: string | null;
  factors?: MedIncidentFactor[];
  whatHappened: string;
};

export type IncidentEventInput =
  | { kind: "reviewed"; rootCause: string; actionTaken: string; note?: string | null }
  | { kind: "closed"; note?: string | null };

export type IncidentPatient = { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean };

/** Who reported it. `name` is null for every reader who does not hold `pharmacy.incidents.review`. */
export type IncidentReporter = { role: string; roleTitle: string; name: string | null };

export type IncidentEventView = {
  id: string; kind: MedIncidentEventKind; rootCause: string | null; actionTaken: string | null; note: string | null;
  /** The reviewer's name, for a reader who may review; null otherwise. */
  recordedByName: string | null; recordedAt: string;
};

export type IncidentState = { reviewed: boolean; rootCause: string | null; actionTaken: string | null; closed: boolean };

export type IncidentRow = {
  id: string; no: string; kind: MedIncidentKind; stage: string; type: string; category: string; factors: string[];
  patient: IncidentPatient | null; item: { id: string; name: string } | null; dispenseNo: string | null; lineIdx: number | null;
  whatHappened: string; reporter: IncidentReporter; createdAt: string; state: IncidentState; events: IncidentEventView[];
};

const trimOrNull = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t === "" ? null : t;
};

function bad(message: string, detail?: Record<string, unknown>): never {
  throw new PharmacyError("invalid_incident", message, detail);
}

const inSet = (xs: readonly string[], v: unknown): boolean => typeof v === "string" && xs.includes(v);

/** Reading the log is for the people who write it or review it. Answers whether this reader may be told names. */
export async function assertIncidentReader(db: Db | Tx, actor: Actor): Promise<{ userId: string; mayName: boolean }> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "the medication incident log is read by a person");
  const reviewer = await hasPermission(db as Db, actor.id, INCIDENT_REVIEW_PERMISSION, "hospital");
  if (reviewer) return { userId: actor.id, mayName: true };
  if (await hasPermission(db as Db, actor.id, INCIDENT_RECORD_PERMISSION, "hospital")) return { userId: actor.id, mayName: false };
  throw new PharmacyError("permission_denied", `reading the medication incident log needs ${INCIDENT_RECORD_PERMISSION} or ${INCIDENT_REVIEW_PERMISSION}`);
}

/**
 * The role this person records under: one of their roles that grants `pharmacy.incidents.record`
 * (a permanent assignment first, then a live temporary grant), the first by key so the answer is stable.
 * None means they may not record — the route checks the same grant; this is the service saying it again.
 */
async function recordingRoleOf(db: Db | Tx, userId: string, now: Date): Promise<string | null> {
  const permanent = await db.select({ roleKey: roleAssignments.roleKey }).from(roleAssignments)
    .innerJoin(rolePermissions, and(eq(rolePermissions.roleKey, roleAssignments.roleKey), eq(rolePermissions.permission, INCIDENT_RECORD_PERMISSION)))
    .where(eq(roleAssignments.userId, userId));
  const temp = await db.select({ roleKey: tempRoleGrants.roleKey }).from(tempRoleGrants)
    .innerJoin(rolePermissions, and(eq(rolePermissions.roleKey, tempRoleGrants.roleKey), eq(rolePermissions.permission, INCIDENT_RECORD_PERMISSION)))
    .where(and(eq(tempRoleGrants.userId, userId), gt(tempRoleGrants.expiresAt, now)));
  const first = (xs: { roleKey: string }[]): string | null => [...new Set(xs.map((x) => x.roleKey))].sort()[0] ?? null;
  return first(permanent) ?? first(temp);
}

/** Record a near miss or an error. The reporter is a person; the kind must agree with the NCC MERP category. */
export async function recordIncident(db: Db, actor: Actor, input: RecordIncidentInput, now: Date = new Date()): Promise<{ incidentId: string; no: string }> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "a medication incident is recorded by a person");
  if (!inSet(MED_INCIDENT_KINDS, input.kind)) bad(`"${String(input.kind)}" is not near_miss or error`);
  if (!inSet(MED_INCIDENT_STAGES, input.stage)) bad(`"${String(input.stage)}" is not a stage`);
  if (!inSet(MED_INCIDENT_TYPES, input.type)) bad(`"${String(input.type)}" is not an incident type`);
  if (!inSet(NCC_MERP_CATEGORIES, input.category)) bad(`"${String(input.category)}" is not an NCC MERP category (A–I)`);
  if (kindOfCategory(input.category) !== input.kind) {
    bad(`category ${input.category} is ${kindOfCategory(input.category) === "near_miss" ? "a near miss (A–B)" : "an error (C–I)"}, not ${input.kind === "near_miss" ? "a near miss" : "an error"}`,
      { kind: input.kind, category: input.category });
  }
  const factors = [...new Set(input.factors ?? [])];
  for (const f of factors) if (!inSet(MED_INCIDENT_FACTORS, f)) bad(`"${String(f)}" is not a contributing factor`);
  const whatHappened = input.whatHappened.trim();
  if (whatHappened === "") bad("say what happened — that is the report");

  return withTx(db, async (tx) => {
    const reporterRole = await recordingRoleOf(tx, actor.id, now);
    if (reporterRole === null) throw new PharmacyError("permission_denied", `recording a medication incident needs ${INCIDENT_RECORD_PERMISSION}`);

    let patientId = trimOrNull(input.patientId);
    let itemId = trimOrNull(input.itemId);
    let dispenseLineId: string | null = null;
    if (input.dispenseLine !== undefined && input.dispenseLine !== null) {
      const { dispenseId, lineIdx } = input.dispenseLine;
      const found = (await tx.select({ id: pharmacyDispenseLines.id, itemId: pharmacyDispenseLines.itemId, patientId: pharmacyDispenses.patientId })
        .from(pharmacyDispenseLines).innerJoin(pharmacyDispenses, eq(pharmacyDispenses.id, pharmacyDispenseLines.dispenseId))
        .where(and(eq(pharmacyDispenseLines.dispenseId, dispenseId), eq(pharmacyDispenseLines.lineIdx, lineIdx))))[0];
      if (found === undefined) bad(`dispense ${dispenseId} has no line ${String(lineIdx)}`, { dispenseId, lineIdx });
      /* The line is evidence about ONE patient; a report that names another patient beside it is contradicting itself. */
      if (patientId !== null && patientId !== found.patientId) bad("the dispense line is another patient's", { dispenseId, lineIdx });
      patientId = found.patientId;
      if (itemId !== null && found.itemId !== null && itemId !== found.itemId) bad("the item is not the one on that dispense line", { itemId });
      itemId = itemId ?? found.itemId;
      dispenseLineId = found.id;
    }
    if (patientId !== null && (await getPatientSummaries(tx as unknown as Db, actor, [patientId])).length === 0) bad(`no patient ${patientId}`, { patientId });
    if (itemId !== null && !(await itemsByIds(tx, [itemId])).has(itemId)) bad(`no item ${itemId}`, { itemId });

    const incidentId = newId();
    const inserted = await tx.insert(pharmacyMedicationIncidents).values({
      id: incidentId, kind: input.kind, stage: input.stage, type: input.type, category: input.category,
      patientId, dispenseLineId, itemId, factors, whatHappened, reportedBy: actor.id, reporterRole, createdAt: now,
    }).returning({ seq: pharmacyMedicationIncidents.seq });
    await appendEvent(tx, incidentRecorded.make({
      actor, occurredAt: now, ...(patientId === null ? {} : { patientId }),
      payload: { incidentId, kind: input.kind, category: input.category, stage: input.stage, type: input.type },
    }));
    return { incidentId, no: incidentNumber(inserted[0]!.seq) };
  });
}

function stateOf(events: readonly { kind: string; rootCause: string | null; actionTaken: string | null }[]): IncidentState {
  const out: IncidentState = { reviewed: false, rootCause: null, actionTaken: null, closed: false };
  for (const e of events) {
    if (e.kind === "reviewed") { out.reviewed = true; out.rootCause = e.rootCause; out.actionTaken = e.actionTaken; }
    if (e.kind === "closed") out.closed = true;
  }
  return out;
}

/** A review (root cause, action taken) or the close. The in-charge's or the MS's (`pharmacy.incidents.review`). */
export async function addIncidentEvent(db: Db, actor: Actor, incidentId: string, input: IncidentEventInput, now: Date = new Date()): Promise<{ eventId: string }> {
  if (actor.type !== "user") throw new PharmacyError("permission_denied", "an act on a medication incident is a person's");
  if (!(await hasPermission(db, actor.id, INCIDENT_REVIEW_PERMISSION, "hospital"))) {
    throw new PharmacyError("permission_denied", `reviewing a medication incident needs ${INCIDENT_REVIEW_PERMISSION}`);
  }
  return withTx(db, async (tx) => {
    const incident = (await tx.select({ id: pharmacyMedicationIncidents.id, patientId: pharmacyMedicationIncidents.patientId })
      .from(pharmacyMedicationIncidents).where(eq(pharmacyMedicationIncidents.id, incidentId)))[0];
    if (incident === undefined) throw new PharmacyError("unknown_incident", `medication incident ${incidentId} not found`);
    const prior = await tx.select().from(pharmacyMedicationIncidentEvents).where(eq(pharmacyMedicationIncidentEvents.incidentId, incidentId))
      .orderBy(asc(pharmacyMedicationIncidentEvents.recordedAt));
    const state = stateOf(prior);
    if (state.closed) throw new PharmacyError("incident_closed", "this incident is closed — a closed incident takes no further act");

    const note = trimOrNull(input.note);
    const row = { id: newId(), incidentId, kind: input.kind, rootCause: null as string | null, actionTaken: null as string | null, note, recordedBy: actor.id, recordedAt: now };
    if (input.kind === "reviewed") {
      row.rootCause = trimOrNull(input.rootCause);
      row.actionTaken = trimOrNull(input.actionTaken);
      if (row.rootCause === null || row.actionTaken === null) bad("a review names the root cause and the action taken");
    } else if (input.kind === "closed") {
      /* DECIDED: an incident is closed only after it has been reviewed — the close is the review's sign-off, not a way round it. */
      if (!state.reviewed) bad("review the incident (root cause, action taken) before closing it");
    } else {
      bad("unknown act");
    }
    await tx.insert(pharmacyMedicationIncidentEvents).values(row);
    await appendEvent(tx, incidentEventRecorded.make({
      actor, occurredAt: now, ...(incident.patientId === null ? {} : { patientId: incident.patientId }),
      payload: { incidentId, eventId: row.id, kind: input.kind },
    }));
    return { eventId: row.id };
  });
}

async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const u = [...new Set(ids)];
  if (u.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, u));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function roleTitlesOf(db: Db, keys: string[]): Promise<Map<string, string>> {
  const u = [...new Set(keys)];
  if (u.length === 0) return new Map();
  const rows = await db.select({ key: roles.key, title: roles.title }).from(roles).where(inArray(roles.key, u));
  return new Map(rows.map((r) => [r.key, r.title]));
}

/** The log, newest first. `open` keeps incidents not yet closed; `id` reads one. */
export async function listIncidents(db: Db, actor: Actor, opts: { open?: boolean; id?: string } = {}): Promise<IncidentRow[]> {
  const { mayName } = await assertIncidentReader(db, actor);
  const where = opts.id === undefined ? undefined : eq(pharmacyMedicationIncidents.id, opts.id);
  const rows = await db.select({
    r: pharmacyMedicationIncidents, dispenseNo: pharmacyDispenses.dispenseNo, lineIdx: pharmacyDispenseLines.lineIdx,
  }).from(pharmacyMedicationIncidents)
    .leftJoin(pharmacyDispenseLines, eq(pharmacyDispenseLines.id, pharmacyMedicationIncidents.dispenseLineId))
    .leftJoin(pharmacyDispenses, eq(pharmacyDispenses.id, pharmacyDispenseLines.dispenseId))
    .where(where).orderBy(desc(pharmacyMedicationIncidents.seq)).limit(LIST_LIMIT);
  if (rows.length === 0) return [];
  const ids = rows.map((x) => x.r.id);
  const events = await db.select().from(pharmacyMedicationIncidentEvents).where(inArray(pharmacyMedicationIncidentEvents.incidentId, ids))
    .orderBy(asc(pharmacyMedicationIncidentEvents.recordedAt));
  const patientIds = [...new Set(rows.map((x) => x.r.patientId).filter((p): p is string => p !== null))];
  const itemIds = [...new Set(rows.map((x) => x.r.itemId).filter((p): p is string => p !== null))];
  const [people, itemRows, titles] = await Promise.all([
    getPatientSummaries(db, actor, patientIds),
    itemsByIds(db, itemIds),
    roleTitlesOf(db, rows.map((x) => x.r.reporterRole)),
  ]);
  /* Names are READ only for a reader who may be told them: nothing to leak if a later edit drops the gate below. */
  const names = mayName ? await namesOf(db, [...rows.map((x) => x.r.reportedBy), ...events.map((e) => e.recordedBy)]) : new Map<string, string>();
  const patientOf = new Map(people.map((s) => [s.requestedId, { id: s.id, uhid: s.uhid, name: s.name, alias: s.alias, restricted: s.restricted }]));
  const out = rows.map(({ r, dispenseNo, lineIdx }): IncidentRow => {
    const mine = events.filter((e) => e.incidentId === r.id);
    const item = r.itemId === null ? undefined : itemRows.get(r.itemId);
    return {
      id: r.id, no: incidentNumber(r.seq), kind: r.kind as MedIncidentKind, stage: r.stage, type: r.type, category: r.category, factors: r.factors,
      patient: r.patientId === null ? null : (patientOf.get(r.patientId) ?? null),
      item: item === undefined ? null : { id: item.id, name: item.name },
      dispenseNo: dispenseNo ?? null, lineIdx: lineIdx ?? null, whatHappened: r.whatHappened,
      reporter: { role: r.reporterRole, roleTitle: titles.get(r.reporterRole) ?? r.reporterRole, name: mayName ? (names.get(r.reportedBy) ?? null) : null },
      createdAt: r.createdAt.toISOString(), state: stateOf(mine),
      events: mine.map((e) => ({
        id: e.id, kind: e.kind as MedIncidentEventKind, rootCause: e.rootCause, actionTaken: e.actionTaken, note: e.note,
        recordedByName: mayName ? (names.get(e.recordedBy) ?? null) : null, recordedAt: e.recordedAt.toISOString(),
      })),
    };
  });
  return opts.open === true ? out.filter((r) => !r.state.closed) : out;
}

export async function getIncident(db: Db, actor: Actor, id: string): Promise<IncidentRow> {
  const row = (await listIncidents(db, actor, { id }))[0];
  if (row === undefined) throw new PharmacyError("unknown_incident", `medication incident ${id} not found`);
  return row;
}

/** The office's LAW side: incidents with no review and no close. Codes only — no patient, no narrative, no person. */
export type IncidentAwaitingReview = { id: string; no: string; kind: MedIncidentKind; category: string; stage: string; type: string; createdAt: string };

export async function incidentsAwaitingReview(db: Db, actor: Actor): Promise<IncidentAwaitingReview[]> {
  await assertIncidentReader(db, actor);
  const open = await db.select({
    id: pharmacyMedicationIncidents.id, seq: pharmacyMedicationIncidents.seq, kind: pharmacyMedicationIncidents.kind, category: pharmacyMedicationIncidents.category,
    stage: pharmacyMedicationIncidents.stage, type: pharmacyMedicationIncidents.type, createdAt: pharmacyMedicationIncidents.createdAt,
  }).from(pharmacyMedicationIncidents)
    .where(notExists(db.select({ one: sql`1` }).from(pharmacyMedicationIncidentEvents).where(eq(pharmacyMedicationIncidentEvents.incidentId, pharmacyMedicationIncidents.id))))
    .orderBy(asc(pharmacyMedicationIncidents.seq)).limit(LIST_LIMIT);
  return open.map((r) => ({
    id: r.id, no: incidentNumber(r.seq), kind: r.kind as MedIncidentKind, category: r.category, stage: r.stage, type: r.type, createdAt: r.createdAt.toISOString(),
  }));
}

export type IncidentIndicatorMonth = {
  /** `YYYY-MM`, the IST calendar month. */
  month: string;
  errors: number;
  nearMisses: number;
  /** Lines dispensed that month: the prescription counter's hand-overs plus the walk-in counter's sale lines. */
  dispensedLines: number;
  counterLines: number;
  walkInLines: number;
  /** Errors per 1,000 dispensed lines, to two places; null in a month that dispensed nothing. */
  errorsPer1000: number | null;
};

/** The NABH indicator: errors per 1,000 dispensed lines per month, and near misses per month. Oldest month first. */
export async function incidentIndicator(db: Db, actor: Actor, opts: { months?: number } = {}, now: Date = new Date()): Promise<{ months: IncidentIndicatorMonth[] }> {
  await assertIncidentReader(db, actor);
  const n = Math.min(Math.max(Math.trunc(opts.months ?? 6), 1), MAX_MONTHS);
  const from = istMonthStartUtc(now, n - 1);
  const istMonth = (col: unknown) => sql<string>`to_char(${col} at time zone 'Asia/Kolkata', 'YYYY-MM')`;

  const incidentMonth = istMonth(pharmacyMedicationIncidents.createdAt);
  const incidents = await db.select({
    month: incidentMonth,
    errors: sql<number>`count(*) filter (where ${pharmacyMedicationIncidents.kind} = 'error')::int`,
    nearMisses: sql<number>`count(*) filter (where ${pharmacyMedicationIncidents.kind} = 'near_miss')::int`,
  }).from(pharmacyMedicationIncidents).where(gte(pharmacyMedicationIncidents.createdAt, from)).groupBy(incidentMonth);

  const counterMonth = istMonth(pharmacyDispenses.handedOverAt);
  const counter = await db.select({ month: counterMonth, n: sql<number>`count(*)::int` })
    .from(pharmacyDispenseLines).innerJoin(pharmacyDispenses, eq(pharmacyDispenses.id, pharmacyDispenseLines.dispenseId))
    .where(and(
      eq(pharmacyDispenses.status, "handed_over"), gte(pharmacyDispenses.handedOverAt, from),
      eq(pharmacyDispenseLines.status, "open"), sql`${pharmacyDispenseLines.ledgerEntryId} is not null`,
    )).groupBy(counterMonth);

  const walkInMonth = istMonth(pharmacyRetailSales.soldAt);
  const walkIn = await db.select({ month: walkInMonth, n: sql<number>`count(*)::int` })
    .from(pharmacyRetailSaleLines).innerJoin(pharmacyRetailSales, eq(pharmacyRetailSales.id, pharmacyRetailSaleLines.saleId))
    .where(gte(pharmacyRetailSales.soldAt, from)).groupBy(walkInMonth);

  const months: IncidentIndicatorMonth[] = [];
  for (let k = n - 1; k >= 0; k -= 1) {
    const month = istMonthKey(istMonthStartUtc(now, k));
    const i = incidents.find((x) => x.month === month);
    const counterLines = counter.find((x) => x.month === month)?.n ?? 0;
    const walkInLines = walkIn.find((x) => x.month === month)?.n ?? 0;
    const dispensedLines = counterLines + walkInLines;
    const errors = i?.errors ?? 0;
    months.push({
      month, errors, nearMisses: i?.nearMisses ?? 0, dispensedLines, counterLines, walkInLines,
      errorsPer1000: dispensedLines === 0 ? null : Math.round((errors * 1000 * 100) / dispensedLines) / 100,
    });
  }
  return { months };
}
