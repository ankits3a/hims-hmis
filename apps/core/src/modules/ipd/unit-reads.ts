import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import {
  ipdAdmissions, ipdBedStays, ipdDischarges, ipdNursingAlerts, ipdNursingAssessments, ipdRounds, ipdUnitTransfers, ipdVitals,
  orgDepartments, resources, rosterBedAllotments, rosterTeams,
} from "../../kernel/db/schema";
import { doctorUnitsOn, istDateOfInstant, istMidnightUtc, istMinutesOfInstant } from "../roster";
import { buildFactSet } from "./copilot-facts";
import { isAbnormal, renderLine } from "./copilot-lines";
import { dayOfStay } from "./daily-totals";
import { lastSetAt, latestScores } from "./nursing";
import { nextDueOf, wardsWithBeds } from "./nursing-read";
import { onTeam, treatingTeamOf } from "./rounds-team";
import { unitsOfAt } from "./unit-stamp";
import type { IpdCopilotSource } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { AdmissionRow } from "./admission-core";

/**
 * #962 (spec docs/specs/962-doctor-desk-ward.md; plan §4.1 I3, I4, I5, I12, I13) — THE READS KEYED BY UNIT, for the
 * Doctor Desk (which reads IPD only through `index.ts` and writes nothing here). The unit of an admission at an instant
 * is `unit-stamp.ts`'s rule: the newest unit-transfer row, else the stamp, else (before #962) the consultant's unit.
 *
 * THE TAKE DAY (roster V12): a take runs 08:00 → 08:00 IST, half-open. The take day of an instant is its IST date, or
 * the day before when the instant is before 08:00 IST. Times come from the roster's clock helpers, never a local offset.
 *
 * ABSENT, NOT ZERO: a figure these reads cannot give is null (the midnight census before that midnight has come; the
 * unit's bed total when the roster allots it no beds). Read-only; no money (decision 0058).
 */

const TAKE_START_MINUTES = 8 * 60;
const HOUR_MS = 3_600_000;

/** The IST date of the take day containing `at`. */
export function takeDayOf(at: Date): string {
  const day = istDateOfInstant(at);
  if (istMinutesOfInstant(at) >= TAKE_START_MINUTES) return day;
  return istDateOfInstant(new Date(istMidnightUtc(day).getTime() - HOUR_MS));
}

/** [08:00 IST of `takeDay`, 08:00 IST of the next day). */
export function takeWindow(takeDay: string): { from: Date; to: Date } {
  const from = new Date(istMidnightUtc(takeDay).getTime() + 8 * HOUR_MS);
  return { from, to: new Date(from.getTime() + 24 * HOUR_MS) };
}

type Candidate = Pick<AdmissionRow, "id" | "patientId" | "consultantId" | "admittedUnderTeamId" | "admittedAt" | "endedAt" | "state">;

/**
 * Every admission that could have been the unit's at some instant in [from, to): stamped to it, moved into or out of
 * it, or (an unstamped, pre-#962 row) admitted under a consultant who was in it on a day of the window.
 */
async function candidates(exec: Db | Tx, teamId: string, from: Date, to: Date): Promise<AdmissionRow[]> {
  const moved = await (exec as Db).select({ admissionId: ipdUnitTransfers.admissionId }).from(ipdUnitTransfers)
    .where(or(eq(ipdUnitTransfers.toTeamId, teamId), eq(ipdUnitTransfers.fromTeamId, teamId)));
  const days = [...new Set([istDayString(from), istDayString(new Date(to.getTime() - 1))])];
  const members = new Set<string>();
  for (const d of days) for (const u of await doctorUnitsOn(exec, d)) if (u.teamId === teamId) members.add(u.userId);
  const who = [eq(ipdAdmissions.admittedUnderTeamId, teamId)];
  if (moved.length > 0) who.push(inArray(ipdAdmissions.id, [...new Set(moved.map((m) => m.admissionId))]));
  if (members.size > 0) who.push(and(isNull(ipdAdmissions.admittedUnderTeamId), inArray(ipdAdmissions.consultantId, [...members]))!);
  return (exec as Db).select().from(ipdAdmissions).where(and(
    isNotNull(ipdAdmissions.admittedAt), lt(ipdAdmissions.admittedAt, to),
    or(isNull(ipdAdmissions.endedAt), gte(ipdAdmissions.endedAt, from)),
    or(...who),
  ));
}

/** The admissions among `list` that are the unit's at `at` (one roster read per instant). */
async function oursAt(exec: Db | Tx, teamId: string, list: readonly Candidate[], at: Date): Promise<Set<string>> {
  const units = await unitsOfAt(exec, list, at);
  return new Set(list.filter((a) => units.get(a.id) === teamId).map((a) => a.id));
}

/** In a bed at `t`: admitted at or before it and not yet ended (a cancelled request was never admitted). */
const inBedAt = (a: Candidate, t: Date): boolean =>
  a.admittedAt !== null && a.admittedAt <= t && (a.endedAt === null || a.endedAt > t) && a.state !== "cancelled";

export type UnitCensus = {
  teamId: string;
  takeDay: string;
  from: Date;
  to: Date;
  admitted: number;
  discharged: number;
  /** LAMA (the `lama` end state; a DAMA is recorded as a LAMA exit kind). */
  lama: number;
  absconded: number;
  deaths: number;
  transfersIn: number;
  transfersOut: number;
  /** In the unit's beds at the end of the take day, or now while it runs. */
  occupied: number;
  /** In the unit's beds at the midnight inside the take day; null until that midnight has come. */
  bedsAtMidnight: number | null;
};

/**
 * I4 — the take-day census of one unit. Each movement counts for the unit the admission was in AT that movement: an
 * admission for its unit at the admitted instant, an end (discharge, LAMA, abscond, death) for its unit at the end.
 */
export async function unitCensus(db: Db | Tx, teamId: string, takeDay: string, now: Date = new Date()): Promise<UnitCensus> {
  const { from, to } = takeWindow(takeDay);
  const list = await candidates(db, teamId, from, to);
  const inWindow = (t: Date | null): t is Date => t !== null && t >= from && t < to;

  let admitted = 0;
  for (const a of list) if (inWindow(a.admittedAt) && (await oursAt(db, teamId, [a], a.admittedAt)).has(a.id)) admitted += 1;
  const ends = { discharged: 0, lama: 0, absconded: 0, deaths: 0 };
  for (const a of list) {
    if (!inWindow(a.endedAt) || !(await oursAt(db, teamId, [a], a.endedAt)).has(a.id)) continue;
    if (a.state === "discharged") ends.discharged += 1;
    else if (a.state === "lama") ends.lama += 1;
    else if (a.state === "absconded") ends.absconded += 1;
    else if (a.state === "deceased") ends.deaths += 1;
  }
  const moves = await (db as Db).select().from(ipdUnitTransfers).where(and(
    gte(ipdUnitTransfers.at, from), lt(ipdUnitTransfers.at, to), or(eq(ipdUnitTransfers.toTeamId, teamId), eq(ipdUnitTransfers.fromTeamId, teamId)),
  ));
  const occupiedAt = async (t: Date): Promise<number> => {
    const here = list.filter((a) => inBedAt(a, t));
    return (await oursAt(db, teamId, here, t)).size;
  };
  const end = now < to ? now : to;
  const midnight = istMidnightUtc(istDayString(new Date(from.getTime() + 24 * HOUR_MS)));
  return {
    teamId, takeDay, from, to, admitted, ...ends,
    transfersIn: moves.filter((m) => m.toTeamId === teamId).length,
    transfersOut: moves.filter((m) => m.fromTeamId === teamId).length,
    occupied: await occupiedAt(end),
    bedsAtMidnight: midnight > now ? null : await occupiedAt(midnight),
  };
}

export type UnitAdmission = {
  admissionId: string;
  patientId: string;
  admissionNo: string | null;
  source: string;
  /** The ER gate instant (ER admissions only). */
  arrivedAt: Date | null;
  requestedAt: Date;
  admittedAt: Date;
  dayOfStay: number;
  provisionalDiagnosis: string | null;
  consultantId: string;
  mlc: boolean;
  state: string;
};

/** I3 — the admissions the unit took in [from, to): its unit at the admitted instant was `teamId`. */
export async function admissionsUnder(db: Db | Tx, teamId: string, from: Date, to: Date, now: Date = new Date()): Promise<UnitAdmission[]> {
  const list = await candidates(db, teamId, from, to);
  const out: UnitAdmission[] = [];
  for (const a of list) {
    if (a.admittedAt === null || a.admittedAt < from || a.admittedAt >= to) continue;
    if (!(await oursAt(db, teamId, [a], a.admittedAt)).has(a.id)) continue;
    out.push({
      admissionId: a.id, patientId: a.patientId, admissionNo: a.admissionNo, source: a.source, arrivedAt: a.erArrivedAt,
      requestedAt: a.requestedAt, admittedAt: a.admittedAt, dayOfStay: Math.max(1, dayOfStay(a.admittedAt, istDayString(now))),
      provisionalDiagnosis: a.provisionalDiagnosis, consultantId: a.consultantId, mlc: a.mlc, state: a.state,
    });
  }
  return out.sort((x, y) => x.admittedAt.getTime() - y.admittedAt.getTime() || x.admissionId.localeCompare(y.admissionId));
}

export type UnitBedFlag = "critical" | "owed" | "could_go_home" | "none";
export type UnitEws = { kind: string; value: number; band: string };
export type UnitBed = {
  bedId: string;
  bedCode: string;
  wardId: string;
  wardCode: string;
  wardName: string;
  status: "occupied" | "free";
  /** The bed is allotted to this unit (roster) at the instant. */
  allotted: boolean;
  occupant: null | {
    admissionId: string;
    patientId: string;
    /** The occupant is this unit's patient (an allotted bed may hold another unit's lodger). */
    ours: boolean;
    admittedAt: Date | null;
    consultantId: string;
    provisionalDiagnosis: string | null;
    mlc: boolean;
    ews: UnitEws | null;
  };
  /** red critical (an open early-warning breach) · amber owed (assessment or vitals overdue) · green fit declared. */
  flag: UnitBedFlag;
  /** This unit's patient on a bed outside its ward (not allotted to it, and another unit's or department's ward). */
  outlier: boolean;
};

/**
 * I5 — the unit's beds at `at`: every bed the roster allots to the unit (free or not), plus every bed one of its
 * patients lies on, wherever. Walk order: ward code, then bed code (numeric).
 *
 * "In your ward" (DECIDED): a bed allotted to the unit; failing any allotment of that bed, a bed in a ward whose
 * department is the unit's department. Anything else holding the unit's patient is an OUTLIER (lodged elsewhere).
 */
export async function bedsOf(db: Db, teamId: string, at: Date): Promise<UnitBed[]> {
  const team = (await db.select({ departmentId: rosterTeams.departmentId }).from(rosterTeams).where(eq(rosterTeams.id, teamId)))[0];
  if (team === undefined) return [];
  const deptCode = (await db.select({ code: orgDepartments.code }).from(orgDepartments).where(eq(orgDepartments.id, team.departmentId)))[0]?.code ?? null;
  const allotments = await db.select({ teamId: rosterBedAllotments.teamId, resourceId: rosterBedAllotments.resourceId }).from(rosterBedAllotments)
    .where(and(lte(rosterBedAllotments.startsAt, at), or(isNull(rosterBedAllotments.endsAt), gt(rosterBedAllotments.endsAt, at))));
  const mineAllotted = new Set(allotments.filter((x) => x.teamId === teamId).map((x) => x.resourceId));
  const allottedElsewhere = new Set(allotments.filter((x) => x.teamId !== teamId).map((x) => x.resourceId));

  // The unit's patients in a bed at `at`, and whoever lies on a bed allotted to the unit (perhaps another unit's lodger).
  const list = (await candidates(db, teamId, at, new Date(at.getTime() + 1))).filter((a) => inBedAt(a, at));
  const ours = await oursAt(db, teamId, list, at);
  const holders = [
    ...(ours.size > 0 ? [inArray(ipdBedStays.admissionId, [...ours])] : []),
    ...(mineAllotted.size > 0 ? [inArray(ipdBedStays.bedId, [...mineAllotted])] : []),
  ];
  const stays = holders.length === 0 ? [] : await db.select().from(ipdBedStays).where(and(
    lte(ipdBedStays.startedAt, at), or(isNull(ipdBedStays.endedAt), gt(ipdBedStays.endedAt, at)), or(...holders),
  ));
  const stayByBed = new Map(stays.map((s) => [s.bedId, s] as const));
  const occupantIds = [...new Set(stays.map((s) => s.admissionId))];
  const occupants = new Map((occupantIds.length === 0 ? [] : await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, occupantIds)))
    .map((a) => [a.id, a] as const));

  const flags = await flagsOf(db, [...ours].filter((id) => occupants.has(id)), at);
  const scores = await latestScores(db, [...ours]);
  const { beds } = await wardsWithBeds(db);
  const wardOf = new Map<string, { id: string; code: string; name: string; department: string | null }>();
  const wards = await wardRows(db, [...new Set(beds.map((b) => b.wardId))]);
  for (const b of beds) { const w = wards.get(b.wardId); if (w !== undefined) wardOf.set(b.id, w); }

  const bedIds = new Set<string>([...mineAllotted, ...stays.filter((s) => ours.has(s.admissionId)).map((s) => s.bedId)]);
  const out: UnitBed[] = [];
  for (const b of beds) {
    if (!bedIds.has(b.id)) continue;
    const w = wardOf.get(b.id);
    if (w === undefined) continue;
    const stay = stayByBed.get(b.id);
    const a = stay === undefined ? undefined : occupants.get(stay.admissionId);
    const isOurs = a !== undefined && ours.has(a.id);
    const inOurWard = mineAllotted.has(b.id) || (!allottedElsewhere.has(b.id) && deptCode !== null && w.department !== null && w.department.toUpperCase() === deptCode.toUpperCase());
    const s = a === undefined ? undefined : scores.get(a.id)?.[0];
    out.push({
      bedId: b.id, bedCode: b.code, wardId: w.id, wardCode: w.code, wardName: w.name,
      status: a === undefined ? "free" : "occupied", allotted: mineAllotted.has(b.id),
      occupant: a === undefined ? null : {
        admissionId: a.id, patientId: a.patientId, ours: isOurs, admittedAt: a.admittedAt, consultantId: a.consultantId,
        provisionalDiagnosis: a.provisionalDiagnosis, mlc: a.mlc,
        ews: s === undefined ? null : { kind: s.scoreKind, value: s.scoreValue, band: s.scoreBand },
      },
      flag: isOurs ? (flags.get(a.id) ?? "none") : "none",
      outlier: isOurs && !inOurWard,
    });
  }
  return out.sort((x, y) => x.wardCode.localeCompare(y.wardCode, "en", { numeric: true }) || x.bedCode.localeCompare(y.bedCode, "en", { numeric: true }));
}

async function wardRows(db: Db, ids: readonly string[]): Promise<Map<string, { id: string; code: string; name: string; department: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: resources.id, code: resources.code, name: resources.name, attributes: resources.attributes }).from(resources)
    .where(inArray(resources.id, [...ids]));
  return new Map(rows.map((r) => [r.id, { id: r.id, code: r.code, name: r.name, department: ((r.attributes ?? {}) as { department?: string }).department ?? null }] as const));
}

/** critical > owed > could_go_home > none, per admission at `at`. */
async function flagsOf(db: Db, admissionIds: readonly string[], at: Date): Promise<Map<string, UnitBedFlag>> {
  const out = new Map<string, UnitBedFlag>();
  if (admissionIds.length === 0) return out;
  const ids = [...admissionIds];
  const [alerts, fits, assessed, scores, lastSets, rows] = await Promise.all([
    db.select({ admissionId: ipdNursingAlerts.admissionId, kind: ipdNursingAlerts.kind }).from(ipdNursingAlerts)
      .where(and(inArray(ipdNursingAlerts.admissionId, ids), lte(ipdNursingAlerts.raisedAt, at), or(isNull(ipdNursingAlerts.clearedAt), gt(ipdNursingAlerts.clearedAt, at)))),
    db.select({ admissionId: ipdDischarges.admissionId }).from(ipdDischarges)
      .where(and(inArray(ipdDischarges.admissionId, ids), eq(ipdDischarges.status, "active"))),
    db.select({ admissionId: ipdNursingAssessments.admissionId }).from(ipdNursingAssessments).where(inArray(ipdNursingAssessments.admissionId, ids)),
    latestScores(db, ids),
    lastSetAt(db, ids),
    db.select({ id: ipdAdmissions.id, admittedAt: ipdAdmissions.admittedAt }).from(ipdAdmissions).where(inArray(ipdAdmissions.id, ids)),
  ]);
  const ews = new Set(alerts.filter((x) => x.kind === "ews").map((x) => x.admissionId));
  const assessmentOverdue = new Set(alerts.filter((x) => x.kind === "assessment_overdue").map((x) => x.admissionId));
  const fit = new Set(fits.map((f) => f.admissionId));
  const done = new Set(assessed.map((x) => x.admissionId));
  for (const r of rows) {
    const due = nextDueOf({ admittedAt: r.admittedAt, assessed: done.has(r.id), lastSet: lastSets.get(r.id) ?? null, last: scores.get(r.id)?.[0] }, at);
    out.set(r.id, ews.has(r.id) ? "critical" : (assessmentOverdue.has(r.id) || due?.overdue === true) ? "owed" : fit.has(r.id) ? "could_go_home" : "none");
  }
  return out;
}

/** I13 — the last round this user signed on this admission (seen-at instant, at or before `at`); null when never. */
export async function lastSeenBy(db: Db | Tx, admissionId: string, userId: string, at: Date = new Date()): Promise<Date | null> {
  const r = (await (db as Db).select({ seenAt: ipdRounds.seenAt }).from(ipdRounds)
    .where(and(eq(ipdRounds.admissionId, admissionId), eq(ipdRounds.authorId, userId), lte(ipdRounds.seenAt, at)))
    .orderBy(desc(ipdRounds.seenAt)).limit(1))[0];
  return r?.seenAt ?? null;
}

/** The same, for many admissions in one read. */
export async function lastSeenByMany(db: Db | Tx, admissionIds: readonly string[], userId: string, at: Date): Promise<Map<string, Date>> {
  if (admissionIds.length === 0) return new Map();
  const rows = await (db as Db).select({ admissionId: ipdRounds.admissionId, seenAt: ipdRounds.seenAt }).from(ipdRounds)
    .where(and(inArray(ipdRounds.admissionId, [...admissionIds]), eq(ipdRounds.authorId, userId), lte(ipdRounds.seenAt, at)))
    .orderBy(desc(ipdRounds.seenAt));
  const out = new Map<string, Date>();
  for (const r of rows) if (!out.has(r.admissionId)) out.set(r.admissionId, r.seenAt);
  return out;
}

export type SourcedChange = {
  key: string;
  text: string;
  source: IpdCopilotSource;
  abnormal: boolean;
  /** The newest record behind the line inside the window. */
  at: Date | null;
  records: { id: string; at: Date | null; label: string }[];
};

/**
 * I12 — what was recorded on the admission in (since, until], as sourced lines: the copilot's deterministic fact
 * builder (`buildFactSet`) — every line names its records; no model. A fact whose records all lie outside the window
 * (a standing count) is not a change and is left out. Abnormal first, then newest.
 */
export async function changesSince(
  db: Db, a: Pick<AdmissionRow, "id" | "patientId">, since: Date, until: Date, opts: { actorId?: string } = {},
): Promise<SourcedChange[]> {
  const { facts } = await buildFactSet(db, a, { since, until }, opts.actorId === undefined ? {} : { actorId: opts.actorId });
  const out: SourcedChange[] = [];
  for (const f of facts) {
    const records = f.records.filter((r) => r.at !== null && r.at > since && r.at <= until);
    if (records.length === 0) continue;
    const at = records.reduce<Date | null>((m, r) => (m === null || (r.at !== null && r.at > m) ? r.at : m), null);
    out.push({ key: f.key, text: renderLine(f), source: f.source, abnormal: isAbnormal(f), at, records: records.map((r) => ({ id: r.id, at: r.at, label: r.label })) });
  }
  return out.sort((x, y) => Number(y.abnormal) - Number(x.abnormal) || (y.at?.getTime() ?? 0) - (x.at?.getTime() ?? 0) || x.key.localeCompare(y.key));
}

export type LatestVitals = {
  observedAt: Date; systolic: number | null; diastolic: number | null; pulse: number | null; temperatureC: number | null; spo2: number | null;
  respRate: number | null; ews: UnitEws | null;
};

/** The newest charted (not refused) vitals set of each admission, at or before `at`. */
export async function latestVitalsOf(db: Db, admissionIds: readonly string[], at: Date): Promise<Map<string, LatestVitals>> {
  const out = new Map<string, LatestVitals>();
  if (admissionIds.length === 0) return out;
  const rows = await db.select().from(ipdVitals)
    .where(and(inArray(ipdVitals.admissionId, [...admissionIds]), eq(ipdVitals.refused, false), lte(ipdVitals.observedAt, at)))
    .orderBy(desc(ipdVitals.observedAt), desc(ipdVitals.id));
  for (const v of rows) {
    if (out.has(v.admissionId)) continue;
    out.set(v.admissionId, {
      observedAt: v.observedAt, systolic: v.systolic, diastolic: v.diastolic, pulse: v.pulse, temperatureC: v.temperatureC, spo2: v.spo2,
      respRate: v.respRate,
      ews: v.scoreKind === null || v.scoreValue === null || v.scoreBand === null ? null : { kind: v.scoreKind, value: v.scoreValue, band: v.scoreBand },
    });
  }
  return out;
}

/** Is `userId` on the admission's treating team at `at` (the round page's own rule)? */
export async function onTreatingTeam(db: Db, admissionId: string, userId: string, at: Date): Promise<boolean> {
  const a = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (a === undefined) return false;
  return onTeam(await treatingTeamOf(db, a, at), userId);
}

/** The admissions' own rows (state, consultant, diagnosis, day of stay) for a reader that has their ids. */
export async function admissionFacts(db: Db, admissionIds: readonly string[]): Promise<Map<string, AdmissionRow>> {
  if (admissionIds.length === 0) return new Map();
  return new Map((await db.select().from(ipdAdmissions).where(inArray(ipdAdmissions.id, [...admissionIds]))).map((a) => [a.id, a] as const));
}

/** One doctor's rounds on an admission, newest first: signed (the phone's seen-at) and received (the server's write). */
export async function roundsBy(db: Db, admissionId: string, userId: string): Promise<{ roundId: string; seenAt: Date; createdAt: Date; status: string }[]> {
  return (await db.select({ roundId: ipdRounds.id, seenAt: ipdRounds.seenAt, createdAt: ipdRounds.createdAt, status: ipdRounds.status }).from(ipdRounds)
    .where(and(eq(ipdRounds.admissionId, admissionId), eq(ipdRounds.authorId, userId)))
    .orderBy(desc(ipdRounds.seenAt), desc(ipdRounds.id)));
}
