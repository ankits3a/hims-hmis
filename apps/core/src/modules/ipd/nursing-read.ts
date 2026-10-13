import { and, asc, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import {
  IPD_ASSESSMENT_DUE_MINUTES, ewsBandRank, ewsNextDueMinutes,
} from "@hmis/contracts";
import { listAllergies, getPatientSummaries } from "../patients";
import {
  ipdAdmissions, ipdBedReservations, ipdBedStays, ipdIntakeOutput, ipdNursingAlerts, ipdNursingAssessments, ipdNursingNotes,
  ipdShiftHandovers, ipdVitals, patients, resources, users,
} from "../../kernel/db/schema";
import { readAdmission, requireIpdPermission } from "./admission-core";
import { IpdBedAttributesSchema } from "./bed-attributes";
import { ageInYears } from "./bed-rules";
import { holdIsLive } from "./beds";
import { IPD_NURSING_STATES, ioDayStart, istClock, istDayIndex, isNightIst, lastSetAt, latestScores, scoreContextOf, shiftOf } from "./nursing";
import { SEALED_LABEL } from "./now-cards";
import { IPD_NURSING_VIEW, IPD_SHIFT_HANDOVER } from "./permissions";
import type {
  Actor, IpdEwsKind, IpdHandoverDraft, IpdMyShift, IpdNurseStation, IpdNursingChart, IpdNursingChip, IpdNursingIdentity,
  IpdShiftHandoverList, IpdShiftItem, IpdStationBed,
} from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ScoredSet } from "./nursing";

/**
 * E4.1 (#733) — THE NURSING READS: the nurse station (board C), my shift (board D1), the chart, the SBAR draft and the
 * shift handover list. Read-only (no read writes). Names pass through ONE identity rule (`identitiesOf`): alias when the
 * reader may not see a restricted patient, "Sealed patient" and no UHID for a sealed one. No money (decision 0058).
 *
 * "Next due" (DECIDED): no assessment yet → the assessment, due an hour after admission; else the next vitals set, due
 * by the last set's band (`ewsNextDueMinutes`: 12 h / 4 h / 1 h / 15 min) or an hour after admission when none.
 * A doctor-set frequency is owed to ipd-orders (MAP.md).
 */

type WardRow = { id: string; code: string; name: string };

/** Wards and halls that hold at least one IPD bed, in code order. */
async function wardsWithBeds(db: Db): Promise<{ wards: WardRow[]; beds: (typeof resources.$inferSelect & { wardId: string })[] }> {
  const places = await db.select().from(resources).where(and(inArray(resources.kind, ["ward", "hall", "room", "bed"]), ne(resources.status, "retired")));
  const byId = new Map(places.map((p) => [p.id, p] as const));
  const beds: (typeof resources.$inferSelect & { wardId: string })[] = [];
  const wardIds = new Set<string>();
  for (const b of places) {
    if (b.kind !== "bed" || !IpdBedAttributesSchema.safeParse(b.attributes).success) continue;
    let p = b.parentId === null ? undefined : byId.get(b.parentId);
    if (p?.kind === "room") p = p.parentId === null ? undefined : byId.get(p.parentId);
    if (p === undefined || (p.kind !== "ward" && p.kind !== "hall")) continue;
    wardIds.add(p.id);
    beds.push({ ...b, wardId: p.id });
  }
  const wards = [...wardIds].map((id) => byId.get(id)!).map((w) => ({ id: w.id, code: w.code, name: w.name }))
    .sort((a, b) => a.code.localeCompare(b.code));
  beds.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { wards, beds };
}

function ageSexOf(dob: Date | null, gender: string, at: Date): string {
  const age = ageInYears(dob, at);
  const sex = gender === "male" ? "M" : gender === "female" ? "F" : "O";
  return `${sex} ${age === null ? "?" : String(age)}`;
}

type AdmissionLite = { id: string; patientId: string; admissionNo: string | null };
async function identitiesOf(db: Db, reader: Actor, admissions: readonly AdmissionLite[], at: Date): Promise<Map<string, IpdNursingIdentity>> {
  const out = new Map<string, IpdNursingIdentity>();
  if (admissions.length === 0) return out;
  const people = new Map((await getPatientSummaries(db, reader, [...new Set(admissions.map((a) => a.patientId))])).map((p) => [p.requestedId, p] as const));
  const sealed = new Map((await db.select({ id: patients.id, alias: patients.alias, sealed: patients.sensitiveContext }).from(patients)
    .where(inArray(patients.id, [...new Set(admissions.map((a) => a.patientId))]))).filter((p) => p.sealed).map((p) => [p.id, p.alias] as const));
  for (const a of admissions) {
    const p = people.get(a.patientId);
    if (sealed.has(a.patientId)) {
      out.set(a.id, { admissionId: a.id, admissionNo: a.admissionNo, name: sealed.get(a.patientId)?.trim() || SEALED_LABEL, uhid: "", ageSex: "", sealed: true });
      continue;
    }
    out.set(a.id, {
      admissionId: a.id, admissionNo: a.admissionNo, name: (p?.restricted === true ? p.alias : p?.name) ?? "—", uhid: p?.uhid ?? "",
      ageSex: p === undefined ? "" : ageSexOf(p.dob, p.administrativeGender, at), sealed: false,
    });
  }
  return out;
}

/** "Name alert": two patients on one ward whose names share the first word (§4.10 edge 6). */
function nameAlerts(ids: Map<string, IpdNursingIdentity>): Set<string> {
  const byFirst = new Map<string, string[]>();
  for (const [admissionId, id] of ids) {
    if (id.sealed) continue;
    const first = id.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first.length < 2) continue;
    byFirst.set(first, [...(byFirst.get(first) ?? []), admissionId]);
  }
  return new Set([...byFirst.values()].filter((l) => l.length > 1).flat());
}

function trendOf(sets: readonly ScoredSet[] | undefined): "up" | "down" | "flat" | null {
  if (sets === undefined || sets.length < 2) return null;
  const [now, before] = sets as [ScoredSet, ScoredSet];
  return now.scoreValue > before.scoreValue ? "up" : now.scoreValue < before.scoreValue ? "down" : "flat";
}

export type DueFacts = { admittedAt: Date | null; assessed: boolean; lastSet: Date | null; last: ScoredSet | undefined };
/** What is due next for one admission (DECIDED above). */
export function nextDueOf(f: DueFacts, now: Date): { kind: "vitals" | "assessment"; dueAt: Date; overdue: boolean } | null {
  if (f.admittedAt === null) return null;
  if (!f.assessed) {
    const dueAt = new Date(f.admittedAt.getTime() + IPD_ASSESSMENT_DUE_MINUTES * 60_000);
    return { kind: "assessment", dueAt, overdue: now > dueAt };
  }
  const from = f.lastSet ?? f.admittedAt;
  const minutes = f.lastSet === null ? 60 : ewsNextDueMinutes(f.last === undefined ? null : { value: f.last.scoreValue, band: f.last.scoreBand });
  const dueAt = new Date(from.getTime() + minutes * 60_000);
  return { kind: "vitals", dueAt, overdue: now > dueAt };
}

type WardFacts = {
  admissions: (typeof ipdAdmissions.$inferSelect)[];
  stayByAdmission: Map<string, typeof ipdBedStays.$inferSelect>;
  assessments: Map<string, typeof ipdNursingAssessments.$inferSelect>;
  scores: Map<string, ScoredSet[]>;
  lastSets: Map<string, Date>;
  alerts: Map<string, typeof ipdNursingAlerts.$inferSelect>;
};

/** Everything about the patients on these beds that the station and the shift read, in one query per fact. */
async function factsForBeds(db: Db, bedIds: readonly string[]): Promise<WardFacts> {
  const stays = bedIds.length === 0 ? [] : await db.select().from(ipdBedStays).where(and(inArray(ipdBedStays.bedId, [...bedIds]), isNull(ipdBedStays.endedAt)));
  const admissionIds = stays.map((s) => s.admissionId);
  const admissions = admissionIds.length === 0 ? [] : (await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, admissionIds)))
    .filter((a) => (IPD_NURSING_STATES as readonly string[]).includes(a.state));
  const ids = admissions.map((a) => a.id);
  const [assessments, scores, lastSets, alerts] = await Promise.all([
    ids.length === 0 ? [] : db.select().from(ipdNursingAssessments).where(inArray(ipdNursingAssessments.admissionId, ids)),
    latestScores(db, ids),
    lastSetAt(db, ids),
    ids.length === 0 ? [] : db.select().from(ipdNursingAlerts).where(and(inArray(ipdNursingAlerts.admissionId, ids), eq(ipdNursingAlerts.kind, "ews"), isNull(ipdNursingAlerts.clearedAt))),
  ]);
  return {
    admissions,
    stayByAdmission: new Map(stays.map((s) => [s.admissionId, s] as const)),
    assessments: new Map(assessments.map((x) => [x.admissionId, x] as const)),
    scores, lastSets,
    alerts: new Map(alerts.map((x) => [x.admissionId, x] as const)),
  };
}

const alertView = (r: typeof ipdNursingAlerts.$inferSelect | undefined) => r === undefined ? null : {
  alertId: r.id, band: r.band as "low" | "low_medium" | "medium" | "high", raisedAt: (r.escalatedAt ?? r.raisedAt).toISOString(),
  acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
};

function pickWard(wards: WardRow[], wardId: string | undefined): WardRow | null {
  if (wardId !== undefined) return wards.find((w) => w.id === wardId) ?? null;
  return wards[0] ?? null;
}

// ═══════════════════════════════════════════ board C — the nurse station ═══════════════════════════════════════════

export async function readNurseStation(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdNurseStation> {
  await requireIpdPermission(db, actor, IPD_NURSING_VIEW);
  const now = opts.now ?? new Date();
  const shift = shiftOf(now);
  const { wards, beds: allBeds } = await wardsWithBeds(db);
  const ward = pickWard(wards, opts.wardId);
  const beds = ward === null ? [] : allBeds.filter((b) => b.wardId === ward.id);
  const f = await factsForBeds(db, beds.map((b) => b.id));
  const byBed = new Map(f.admissions.map((a) => [f.stayByAdmission.get(a.id)!.bedId, a] as const));
  const ids = await identitiesOf(db, actor, f.admissions, now);
  const alertNames = nameAlerts(ids);
  const consultants = new Map((f.admissions.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName }).from(users)
    .where(inArray(users.id, [...new Set(f.admissions.map((a) => a.consultantId))]))).map((u) => [u.id, u.name] as const));
  const reservations = beds.length === 0 ? [] : (await db.select().from(ipdBedReservations).where(and(inArray(ipdBedReservations.bedId, beds.map((b) => b.id)), eq(ipdBedReservations.status, "active"))))
    .filter((r) => holdIsLive(r, now));
  const reserved = new Set(reservations.map((r) => r.bedId));
  const allergyAdmissions = new Set<string>();
  for (const a of f.admissions) {
    const assessed = f.assessments.get(a.id);
    if ((assessed?.allergies.length ?? 0) > 0) { allergyAdmissions.add(a.id); continue; }
    if ((await listAllergies(db, a.patientId)).some((r) => r.status === "active")) allergyAdmissions.add(a.id);
  }
  const out: IpdStationBed[] = [];
  let overdue = 0;
  for (const b of beds) {
    const attrs = IpdBedAttributesSchema.parse(b.attributes);
    const a = byBed.get(b.id);
    const incumbent = b.attributes.incumbent === true && b.occupantType === "incumbent";
    const status: IpdStationBed["status"] = incumbent ? "incumbent" : b.occupantRef !== null ? "occupied" : b.status === "blocked" ? "blocked"
      : reserved.has(b.id) ? "reserved" : b.status === "cleaning" ? "cleaning" : "available";
    if (a === undefined) {
      out.push({
        bedId: b.id, code: b.code, status, since: b.since?.toISOString() ?? null, patient: null, consultant: null, dayOfStay: null, chips: [],
        score: null, scoreKind: null, next: null, alert: null, discharge: null, transferring: false, needs: 0,
      });
      continue;
    }
    const id = ids.get(a.id)!;
    const assessment = f.assessments.get(a.id);
    const sets = f.scores.get(a.id);
    const last = sets?.[0];
    const next = nextDueOf({ admittedAt: a.admittedAt, assessed: assessment !== undefined, lastSet: f.lastSets.get(a.id) ?? null, last }, now);
    if (next?.overdue === true) overdue += 1;
    const chips: IpdNursingChip[] = [];
    if (allergyAdmissions.has(a.id)) chips.push("allergy");
    if (assessment !== undefined && assessment.morse >= 45) chips.push("fall_risk");
    if (assessment !== undefined && assessment.braden <= 12) chips.push("pressure_risk");
    if (a.isolation !== "none" || attrs.isolation !== "none") chips.push("isolation");
    if (alertNames.has(a.id)) chips.push("name_alert");
    if (assessment?.obstetric === "pregnant" || assessment?.obstetric === "postpartum") chips.push("obstetric");
    const alert = f.alerts.get(a.id);
    const trend = trendOf(sets);
    const kind = last?.scoreKind ?? (await scoreContextOf(db, a, now)).kind;
    const needs = (alert !== undefined ? 100 + ewsBandRank(alert.band as "low") * 10 : 0) + (trend === "up" ? 20 : 0) + (next?.overdue === true ? 10 : 0)
      + (last !== undefined ? ewsBandRank(last.scoreBand) : 0);
    out.push({
      bedId: b.id, code: b.code, status, since: b.since?.toISOString() ?? null, patient: id,
      consultant: consultants.get(a.consultantId) ?? null,
      dayOfStay: a.admittedAt === null ? null : istDayIndex(now) - istDayIndex(a.admittedAt) + 1,
      chips, scoreKind: kind,
      score: last === undefined ? null : { kind: last.scoreKind, value: last.scoreValue, band: last.scoreBand, complete: last.scoreComplete, trend, at: last.observedAt.toISOString() },
      next: next === null ? null : { kind: next.kind, dueAt: next.dueAt.toISOString(), overdue: next.overdue },
      alert: alertView(alert),
      discharge: a.state === "fit_declared" || a.state === "discharging" ? a.state : null,
      transferring: a.state === "transferring", needs,
    });
  }
  const handoversWaiting = ward === null ? 0 : (await db.select({ id: ipdShiftHandovers.id }).from(ipdShiftHandovers)
    .where(and(eq(ipdShiftHandovers.status, "given"), eq(ipdShiftHandovers.wardId, ward.id)))).length;
  return {
    asOf: now.toISOString(), wards, ward, night: isNightIst(now),
    shift: { key: shift.key, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString() },
    top: {
      census: out.filter((b) => b.patient !== null || b.status === "incumbent").length,
      beds: out.length,
      free: out.filter((b) => b.status === "available").length,
      expected: out.filter((b) => b.status === "reserved").length,
      dischargesToday: out.filter((b) => b.discharge !== null).length,
      overdue,
      alerts: out.filter((b) => b.alert !== null).length,
      handoversWaiting,
    },
    beds: out,
  };
}

// ═══════════════════════════════════════════ board D1 — my shift ═══════════════════════════════════════════

/**
 * The phone's Now list for one ward (DECIDED: no nurse-to-patient assignment exists yet, so "my patients" are the ward's
 * patients; a roster assignment narrows it later). Time order: overdue first by how late, then due soonest.
 */
export async function readMyShift(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdMyShift> {
  const station = await readNurseStation(db, actor, opts);
  const now = opts.now ?? new Date();
  const items: IpdShiftItem[] = [];
  const patients: IpdMyShift["patients"] = [];
  for (const b of station.beds) {
    if (b.patient === null) continue;
    patients.push({ identity: b.patient, bedCode: b.patient.sealed ? null : b.code, scoreKind: b.scoreKind ?? "news2" });
    const bedCode = b.patient.sealed ? null : b.code;
    if (b.alert !== null && b.alert.acknowledgedAt === null) {
      items.push({ kind: "ews", admissionId: b.patient.admissionId, bedCode, name: b.patient.name, dueAt: b.alert.raisedAt, overdue: true, refId: b.alert.alertId, band: b.alert.band });
    }
    if (b.next !== null && new Date(b.next.dueAt).getTime() <= now.getTime() + 60 * 60_000) {
      items.push({ kind: b.next.kind, admissionId: b.patient.admissionId, bedCode, name: b.patient.name, dueAt: b.next.dueAt, overdue: b.next.overdue, refId: null, band: b.score?.band ?? null });
    }
  }
  const handovers = station.ward === null ? [] : await db.select().from(ipdShiftHandovers)
    .where(and(eq(ipdShiftHandovers.status, "given"), eq(ipdShiftHandovers.wardId, station.ward.id), ne(ipdShiftHandovers.givenBy, actor.id)));
  for (const h of handovers) {
    const bed = station.beds.find((b) => b.patient?.admissionId === h.admissionId);
    if (bed?.patient == null) continue;
    items.push({ kind: "handover", admissionId: h.admissionId, bedCode: bed.patient.sealed ? null : bed.code, name: bed.patient.name, dueAt: h.givenAt.toISOString(), overdue: false, refId: h.id, band: null });
  }
  const rank = (i: IpdShiftItem): number => (i.kind === "ews" ? 0 : i.overdue ? 1 : 2);
  items.sort((x, y) => rank(x) - rank(y) || new Date(x.dueAt).getTime() - new Date(y.dueAt).getTime() || x.admissionId.localeCompare(y.admissionId));
  return { asOf: station.asOf, night: station.night, ward: station.ward, wards: station.wards, shift: station.shift, patients, now: items };
}

// ═══════════════════════════════════════════ the chart ═══════════════════════════════════════════

const morseRisk = (m: number): "low" | "moderate" | "high" => (m >= 45 ? "high" : m >= 25 ? "moderate" : "low");
const bradenRisk = (b: number): "none" | "mild" | "moderate" | "high" | "very_high" =>
  (b <= 9 ? "very_high" : b <= 12 ? "high" : b <= 14 ? "moderate" : b <= 18 ? "mild" : "none");

export async function readNursingChart(db: Db, actor: Actor, admissionId: string, opts: { now?: Date } = {}): Promise<IpdNursingChart> {
  await requireIpdPermission(db, actor, IPD_NURSING_VIEW);
  const now = opts.now ?? new Date();
  const a = await readAdmission(db, admissionId);
  const id = (await identitiesOf(db, actor, [a], now)).get(a.id)!;
  const stay = (await db.select({ bedId: ipdBedStays.bedId }).from(ipdBedStays).where(and(eq(ipdBedStays.admissionId, a.id), isNull(ipdBedStays.endedAt))))[0];
  const bedCode = stay === undefined || id.sealed ? null : (await db.select({ code: resources.code }).from(resources).where(eq(resources.id, stay.bedId)))[0]?.code ?? null;
  const ctx = await scoreContextOf(db, a, now);
  const vitals = await db.select().from(ipdVitals).where(eq(ipdVitals.admissionId, a.id)).orderBy(desc(ipdVitals.observedAt), desc(ipdVitals.id)).limit(48);
  const assessment = (await db.select().from(ipdNursingAssessments).where(eq(ipdNursingAssessments.admissionId, a.id)))[0];
  const since = ioDayStart(now);
  const io = await db.select().from(ipdIntakeOutput).where(and(eq(ipdIntakeOutput.admissionId, a.id), gte(ipdIntakeOutput.observedAt, since))).orderBy(asc(ipdIntakeOutput.observedAt));
  const notes = await db.select().from(ipdNursingNotes).where(eq(ipdNursingNotes.admissionId, a.id)).orderBy(desc(ipdNursingNotes.observedAt)).limit(30);
  const alert = (await db.select().from(ipdNursingAlerts).where(and(eq(ipdNursingAlerts.admissionId, a.id), eq(ipdNursingAlerts.kind, "ews"), isNull(ipdNursingAlerts.clearedAt))))[0];
  const scores = await latestScores(db, [a.id]);
  const next = (IPD_NURSING_STATES as readonly string[]).includes(a.state)
    ? nextDueOf({ admittedAt: a.admittedAt, assessed: assessment !== undefined, lastSet: vitals[0]?.observedAt ?? null, last: scores.get(a.id)?.[0] }, now)
    : null;
  return {
    asOf: now.toISOString(), identity: id, bedCode, scoreKind: ctx.kind as IpdEwsKind,
    vitals: vitals.map((v) => ({
      id: v.id, observedAt: v.observedAt.toISOString(), recordedAt: v.recordedAt.toISOString(), lateEntry: v.lateEntry,
      source: v.source as "person", recordedBy: v.recordedBy, refused: v.refused,
      values: {
        temperatureC: v.temperatureC, pulse: v.pulse, respRate: v.respRate, systolic: v.systolic, diastolic: v.diastolic, spo2: v.spo2,
        onOxygen: v.onOxygen, consciousness: v.consciousness as "alert" | null, painScore: v.painScore, capRefillSec: v.capRefillSec,
      },
      score: v.scoreKind === null ? null : { kind: v.scoreKind as IpdEwsKind, value: v.scoreValue!, band: v.scoreBand as "low", complete: v.scoreComplete === true },
    })),
    assessment: assessment === undefined ? null : {
      id: assessment.id, happenedAt: assessment.happenedAt.toISOString(), recordedAt: assessment.recordedAt.toISOString(),
      lateEntry: assessment.lateEntry, recordedBy: assessment.recordedBy, morse: assessment.morse, morseRisk: morseRisk(assessment.morse),
      braden: assessment.braden, bradenRisk: bradenRisk(assessment.braden), painScore: assessment.painScore, nutrition: assessment.nutrition,
      allergies: assessment.allergies, linesDevices: assessment.linesDevices.map((l) => ({ kind: l.kind, site: l.site ?? null })),
      obstetric: assessment.obstetric as "none" | null,
    },
    assessmentDueAt: assessment === undefined && a.admittedAt !== null ? new Date(a.admittedAt.getTime() + IPD_ASSESSMENT_DUE_MINUTES * 60_000).toISOString() : null,
    io: {
      since: since.toISOString(),
      inMl: io.filter((e) => e.direction === "in").reduce((s, e) => s + e.volumeMl, 0),
      outMl: io.filter((e) => e.direction === "out").reduce((s, e) => s + e.volumeMl, 0),
      entries: io.map((e) => ({
        id: e.id, observedAt: e.observedAt.toISOString(), direction: e.direction as "in", kind: e.kind as "oral", volumeMl: e.volumeMl,
        recordedBy: e.recordedBy, source: e.source as "person",
      })),
    },
    notes: notes.map((n) => ({
      id: n.id, observedAt: n.observedAt.toISOString(), recordedAt: n.recordedAt.toISOString(), category: n.category as "general",
      text: n.text, source: n.source as "person", recordedBy: n.recordedBy, lateEntry: n.lateEntry,
    })),
    alert: alertView(alert),
    next: next === null ? null : { kind: next.kind, dueAt: next.dueAt.toISOString(), overdue: next.overdue },
  };
}

// ═══════════════════════════════════════════ the SBAR draft ═══════════════════════════════════════════

const KIND_WORD: Record<IpdEwsKind, string> = { news2: "NEWS2", meows: "MEOWS", pews: "PEWS" };

/**
 * The shift handover's SBAR, DRAFTED FROM RECORDS (spec §0A principle 6): every line is built from a row and carries its
 * source; numbers come from the rows, never from a model. The nurse edits and gives it; the next nurse accepts.
 */
export async function readHandoverDraft(db: Db, actor: Actor, admissionId: string, opts: { now?: Date } = {}): Promise<IpdHandoverDraft> {
  await requireIpdPermission(db, actor, IPD_SHIFT_HANDOVER);
  const now = opts.now ?? new Date();
  const chart = await readNursingChart(db, actor, admissionId, { now });
  const a = await readAdmission(db, admissionId);
  const lastScored = chart.vitals.find((v) => v.score !== null);
  const situation: IpdHandoverDraft["situation"] = [];
  if (lastScored?.score != null) {
    situation.push({ text: `${KIND_WORD[lastScored.score.kind]} ${String(lastScored.score.value)} at ${istClock(new Date(lastScored.observedAt))}`, source: "vitals" });
  }
  if (chart.alert !== null) situation.push({ text: chart.alert.acknowledgedAt === null ? "Early-warning alert open — not acknowledged" : "Early-warning alert open — acknowledged", source: "vitals" });
  const background: IpdHandoverDraft["background"] = [];
  if (a.provisionalDiagnosis !== null) background.push({ text: a.provisionalDiagnosis, source: "admission" });
  if (a.admittedAt !== null) background.push({ text: `Admitted day ${String(istDayIndex(now) - istDayIndex(a.admittedAt) + 1)}`, source: "admission" });
  const assessment: IpdHandoverDraft["assessment"] = [];
  if (chart.assessment !== null) {
    assessment.push({ text: `Morse ${String(chart.assessment.morse)} (${chart.assessment.morseRisk}) · Braden ${String(chart.assessment.braden)} (${chart.assessment.bradenRisk})`, source: "assessment" });
    if (chart.assessment.allergies.length > 0) assessment.push({ text: `Allergies: ${chart.assessment.allergies.join(", ")}`, source: "assessment" });
    if (chart.assessment.linesDevices.length > 0) assessment.push({ text: `Lines: ${chart.assessment.linesDevices.map((l) => l.kind.replace(/_/g, " ")).join(", ")}`, source: "assessment" });
  } else {
    assessment.push({ text: "Admission assessment not recorded", source: "assessment" });
  }
  assessment.push({ text: `I/O since 08:00: in ${String(chart.io.inMl)} ml, out ${String(chart.io.outMl)} ml`, source: "io" });
  const lastNote = chart.notes[0];
  if (lastNote !== undefined) assessment.push({ text: lastNote.text.slice(0, 200), source: "note" });
  const recommendation: IpdHandoverDraft["recommendation"] = [];
  if (chart.next !== null) recommendation.push({ text: `${chart.next.kind === "assessment" ? "Assessment" : "Vitals"} due ${istClock(new Date(chart.next.dueAt))}${chart.next.overdue ? " — overdue" : ""}`, source: chart.next.kind === "assessment" ? "assessment" : "vitals" });
  return { admissionId, situation, background, assessment, recommendation };
}

// ═══════════════════════════════════════════ shift handovers waiting ═══════════════════════════════════════════

export async function listShiftHandovers(db: Db, actor: Actor, opts: { wardId?: string; now?: Date } = {}): Promise<IpdShiftHandoverList> {
  await requireIpdPermission(db, actor, IPD_SHIFT_HANDOVER);
  const now = opts.now ?? new Date();
  const where = opts.wardId === undefined ? eq(ipdShiftHandovers.status, "given") : and(eq(ipdShiftHandovers.status, "given"), eq(ipdShiftHandovers.wardId, opts.wardId));
  const rows = await db.select().from(ipdShiftHandovers).where(where).orderBy(asc(ipdShiftHandovers.givenAt)).limit(200);
  if (rows.length === 0) return { asOf: now.toISOString(), handovers: [] };
  const admissions = await db.select({ id: ipdAdmissions.id, patientId: ipdAdmissions.patientId, admissionNo: ipdAdmissions.admissionNo })
    .from(ipdAdmissions).where(inArray(ipdAdmissions.id, rows.map((r) => r.admissionId)));
  const ids = await identitiesOf(db, actor, admissions, now);
  const stays = await db.select({ admissionId: ipdBedStays.admissionId, code: resources.code }).from(ipdBedStays)
    .innerJoin(resources, eq(resources.id, ipdBedStays.bedId))
    .where(and(inArray(ipdBedStays.admissionId, rows.map((r) => r.admissionId)), isNull(ipdBedStays.endedAt)));
  const bedOf = new Map(stays.map((s) => [s.admissionId, s.code] as const));
  const wardIds = [...new Set(rows.flatMap((r) => (r.wardId === null ? [] : [r.wardId])))];
  const wardNames = new Map((wardIds.length === 0 ? [] : await db.select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, wardIds))).map((w) => [w.id, w.name] as const));
  const givers = new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.givenBy))]))).map((u) => [u.id, u.name] as const));
  return {
    asOf: now.toISOString(),
    handovers: rows.flatMap((r) => {
      const identity = ids.get(r.admissionId);
      if (identity === undefined) return [];
      return [{
        handoverId: r.id, identity, bedCode: identity.sealed ? null : bedOf.get(r.admissionId) ?? null, wardId: r.wardId,
        wardName: r.wardId === null ? null : wardNames.get(r.wardId) ?? null, shift: r.shift as "morning",
        sbar: { situation: r.situation, background: r.background, assessment: r.assessment, recommendation: r.recommendation },
        givenAt: r.givenAt.toISOString(), givenBy: { id: r.givenBy, name: givers.get(r.givenBy) ?? r.givenBy }, givenByViewer: r.givenBy === actor.id,
      }];
    }),
  };
}

