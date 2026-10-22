import type { Actor, WireNextCard, WireOpdDesk, WireOpdPace } from "@hmis/contracts";
import { inArray } from "drizzle-orm";
import { users } from "../../kernel/db/schema";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { doctorDayLines, doctorPaceToday, earlierVisits, lastActiveVitals, lastPrescriptionBy, visitOfDoctor } from "../opd";
import { resultsForPatientSince } from "../lab";
import { getPatientSummaries, listAllergies, listMergedLoserIds } from "../patients";
import { DoctorDeskError } from "./errors";
import { deskScope, patientOf } from "./scope";
import { waitingOn } from "./waiting-on";
import type { DoctorDayLine } from "../opd";
import type { Db } from "../../kernel/db/client";

/**
 * DD-0.8 (#626 → #890) — THE OPD DESK (`docs/design/2026-09-18-doctor-desk/OpdDesk.dc.html`).
 *
 * Two reads. `opdDeskView` is the page: my line (counts), my pace (the queue's own facts divided —
 * never a model), the unit's colleagues in OPD and the OPD-only "Waiting on you". `nextCard` is the
 * NEXT token card for ONE of my visits: the desk's words, Bay One vitals, allergies, results since I
 * last saw the patient, and my last prescription — what four desks already entered, put in order.
 * The queue itself (tokens, Call next, In/Out/Closed) is OPD's own routes, unchanged.
 *
 * No money (decision 0058): nothing here reads a fee, payer or bypass column. The card is a read of
 * the patient's record, so it writes a PHI-access row (`doctor_desk.next`) like the consult screen.
 */
const toWire = (l: DoctorDayLine): WireOpdDesk["colleagues"][number] => ({
  userId: l.userId, name: l.displayName, session: l.session, booked: l.booked, seen: l.seen,
  waiting: l.waiting, inConsult: l.inConsult, longestWaitMinutes: l.longestWaitMinutes,
});

/** Pure: pace from the facts. `each` only once someone is seen; the line's end only while someone waits. */
export function paceOf(seen: number, firstStartedAt: Date | null, waiting: number, at: Date): WireOpdPace {
  if (firstStartedAt === null) return { seen, sinceMinutes: null, eachMinutes: null, endsAt: null };
  const since = Math.max(0, Math.round((at.getTime() - firstStartedAt.getTime()) / 60_000));
  const each = seen > 0 ? Math.round((since / seen) * 10) / 10 : null;
  const endsAt = each !== null && waiting > 0 ? new Date(at.getTime() + waiting * each * 60_000).toISOString() : null;
  return { seen, sinceMinutes: since, eachMinutes: each, endsAt };
}

const OPD_KINDS = new Set(["lab_critical", "imaging_critical", "imaging_unread", "visit_open"]);

export async function opdDeskView(db: Db, actor: Actor, at: Date): Promise<WireOpdDesk> {
  const scope = await deskScope(db, actor, at);
  const others = scope.members.map((m) => m.userId).filter((id) => id !== actor.id);
  const lines = await doctorDayLines(db, [actor.id, ...others], scope.istDate, at);
  const mine = lines.find((l) => l.userId === actor.id && l.session !== "none") ?? null;
  const pace = await doctorPaceToday(db, actor.id, scope.istDate);
  return {
    at: at.toISOString(), istDate: scope.istDate,
    you: { userId: actor.id, name: scope.name, grade: scope.grade },
    unit: scope.unit === null ? null : { teamId: scope.unit.teamId, name: scope.unit.unitName, short: scope.unit.short, departmentName: scope.unit.departmentName },
    line: mine === null ? null : toWire(mine),
    pace: paceOf(pace.seen, pace.firstStartedAt, mine?.waiting ?? 0, at),
    colleagues: lines.filter((l) => l.userId !== actor.id && l.session !== "none").map(toWire),
    waitingOn: (await waitingOn(db, actor, at, scope.istDate, scope.members)).filter((r) => OPD_KINDS.has(r.kind)),
  };
}

function ageOn(dob: Date | null, istDate: string): number | null {
  if (dob === null) return null;
  const [y, m, d] = istDate.split("-").map(Number) as [number, number, number];
  let age = y - dob.getUTCFullYear();
  if (m < dob.getUTCMonth() + 1 || (m === dob.getUTCMonth() + 1 && d < dob.getUTCDate())) age -= 1;
  return age;
}

export async function nextCard(db: Db, actor: Actor, encounterId: string, at: Date): Promise<WireNextCard> {
  const visit = await visitOfDoctor(db, actor.id, encounterId);
  if (visit === null) throw new DoctorDeskError("unknown_visit", "No such visit in your OPD.");
  const [summary] = await getPatientSummaries(db, actor, [visit.patientId]);
  if (summary === undefined) throw new DoctorDeskError("unknown_visit", "No such visit in your OPD.");
  const p = patientOf(summary, visit.patientId);
  // A merged patient's earlier records live under the ids merged into this one (`listMergedLoserIds`).
  const chain = [p.id, ...(await listMergedLoserIds(db, p.id))];
  await recordPhiAccess(db, { actor, patientId: p.id, surface: "doctor_desk.next", encounterId: visit.id, sealed: p.restricted, now: at });

  const earlier = await earlierVisits(db, chain, visit.serviceDate);
  const lastWithMe = earlier.find((e) => e.doctorUserId === actor.id) ?? earlier[0] ?? null;
  const vitals = await lastActiveVitals(db, p.id);
  const allergies = (await listAllergies(db, p.id)).filter((a) => a.status === "active").map((a) => a.substance);
  const since = lastWithMe === null ? [] : await resultsForPatientSince(db, actor, chain, new Date(`${lastWithMe.serviceDate}T00:00:00+05:30`));
  const rx = await lastPrescriptionBy(db, actor.id, chain, visit.serviceDate);
  const nameIds = [visit.deskComplaintBy, vitals?.recordedBy].filter((x): x is string => x !== null && x !== undefined);
  const names = nameIds.length === 0 ? new Map<string, string>()
    : new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, nameIds))).map((u) => [u.id, u.name] as const));
  const istOf = (d: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const lines = Array.isArray(rx?.lines) ? (rx.lines as { drug?: unknown; dose?: unknown; frequency?: unknown }[]) : [];

  return {
    encounterId: visit.id, visitNo: visit.visitNo, visitType: visit.visitType,
    patient: {
      ...p,
      ageYears: p.restricted ? null : ageOn(summary?.dob ?? null, visit.serviceDate),
      sex: p.restricted ? null : summary?.administrativeGender ?? null,
    },
    ordinal: earlier.length + 1,
    complaint: visit.deskComplaint === null || visit.deskComplaint.trim() === "" ? null : {
      text: visit.deskComplaint, byName: visit.deskComplaintBy === null ? null : names.get(visit.deskComplaintBy) ?? null,
      at: visit.deskComplaintAt?.toISOString() ?? null,
    },
    vitals: vitals === null ? null : {
      recordedAt: vitals.recordedAt.toISOString(), byName: names.get(vitals.recordedBy) ?? null, today: istOf(vitals.recordedAt) === visit.serviceDate,
      sbp: num(vitals.sbp), dbp: num(vitals.dbp), pulse: num(vitals.pulse), weightKg: num(vitals.weightKg), glucoseMgDl: num(vitals.glucoseMgDl), spo2: num(vitals.spo2),
    },
    allergies,
    lastSeen: lastWithMe?.serviceDate ?? null,
    since: since.map((s) => ({ analyte: s.analyte, value: s.value, unit: s.unit, flag: s.flag, previous: s.previous, at: s.verifiedAt.toISOString() })),
    lastRx: rx === null ? null : {
      issuedAt: rx.issuedAt.toISOString(),
      lines: lines.map((l) => ({ drug: String(l.drug ?? ""), dose: String(l.dose ?? ""), frequency: String(l.frequency ?? "") })),
    },
  };
}
