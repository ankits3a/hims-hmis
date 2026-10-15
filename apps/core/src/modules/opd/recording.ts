import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { opdDepartments, opdDoctors, opdEncounters, opdPrescriptions } from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { documentsForEncounters } from "../patients";
import { LAB_DEPARTMENT_CODE } from "./encounters";
import { isCorrection } from "./report";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ReportRange } from "./report";

/**
 * ═══ IS TODAY BEING RECORDED? ═══ (owner, 2026-10-07: "Yes, show a daily count on the screens.")
 *
 * Production's last 60 days held 7 completed visits, 5 of them closed from paper, no typed paper and no
 * prescription issued in the system: the care happens on paper and the paper is not on record. This read
 * is the count that makes that visible — INTEGERS ONLY, no patient, no money.
 *
 * ═══ WHAT IS COUNTED ═══ every figure is over the SAME visits the OPD report's "Visits opened" counts
 * (OPD encounters of the day, the laboratory's walk-in department left out, a desk correction — "Wrong
 * department? Move patient", "change the doctor" — counted once, where it ended up: `isCorrection`).
 *
 *   · opened        — those visits.
 *   · consulted     — status `completed`.
 *   · onScreen      — consulted and closed by the doctor (`completed_via` null). The phone app and the
 *                     counter PC are NOT told apart: a completion does not record which screen made it.
 *   · onPaper       — consulted and closed from paper (`completed_via = 'paper'`).
 *   · photographed  — consulted visits with at least one active `consult_prescription` page.
 *   · typed         — consulted visits with an active prescription the desk typed from the paper
 *                     (`transcribed_by` set, the hospital's own doctor — not an outside prescriber).
 *   · issued        — consulted visits with an active prescription the doctor issued (`transcribed_by` null);
 *                     `issuedLines` is the medicine lines on them.
 *   · toType        — photographed, and neither typed nor issued: the scribe's list.
 *   · notRecorded   — consulted with NO record of what was prescribed: no page, nothing typed, nothing
 *                     issued. The number that matters.
 *   · stillOpen     — neither completed nor abandoned.
 */
export type RecordingCounts = {
  opened: number; consulted: number; onScreen: number; onPaper: number; photographed: number;
  typed: number; issued: number; issuedLines: number; toType: number; notRecorded: number; stillOpen: number;
};
export type RecordingRow = RecordingCounts & { id: string; name: string };
export type RecordingDay = RecordingCounts & { date: string };

export type RecordingReport = {
  from: string; to: string; period: ReportRange["period"]; anchor: string;
  /** Whose figures `totals` are. `none` — this login sees no recording figures at all. */
  scope: "hospital" | "mine" | "none";
  totals: RecordingCounts | null;
  /** The signed-in doctor's own visits, when the reader is a doctor (also when `totals` is the hospital's). */
  mine: RecordingCounts | null;
  /** One row per day, only when the period is longer than a day. */
  days: RecordingDay[];
  /** Hospital readers only. */
  departments: RecordingRow[] | null;
  /** Names a person's output: only for a reader who holds the staff figures. */
  doctors: RecordingRow[] | null;
};

const ZERO: RecordingCounts = {
  opened: 0, consulted: 0, onScreen: 0, onPaper: 0, photographed: 0, typed: 0, issued: 0, issuedLines: 0,
  toType: 0, notRecorded: 0, stillOpen: 0,
};

type Visit = {
  id: string; visitNo: string; patientId: string; departmentId: string | null; doctorId: string | null;
  status: string; visitType: string; serviceDate: string; consultCompletedAt: Date | null; openedBy: string;
  openedAt: Date; abandonedAt: Date | null; abandonReason: string | null; completedVia: string | null;
};
type Marks = { photographed: Set<string>; typed: Set<string>; issued: Map<string, number> };

export function tallyRecording(visits: readonly Visit[], marks: Marks): RecordingCounts {
  const out = { ...ZERO };
  for (const v of visits) {
    out.opened += 1;
    if (v.status === "abandoned") continue;
    if (v.status !== "completed") { out.stillOpen += 1; continue; }
    out.consulted += 1;
    if (v.completedVia === "paper") out.onPaper += 1; else out.onScreen += 1;
    const photo = marks.photographed.has(v.id);
    const typed = marks.typed.has(v.id);
    const issued = marks.issued.has(v.id);
    if (photo) out.photographed += 1;
    if (typed) out.typed += 1;
    if (issued) { out.issued += 1; out.issuedLines += marks.issued.get(v.id) ?? 0; }
    if (photo && !typed && !issued) out.toType += 1;
    if (!photo && !typed && !issued) out.notRecorded += 1;
  }
  return out;
}

/** Who may see the hospital's totals: the report's readers, and the desks whose work the count IS. */
const HOSPITAL_READERS = ["opd.reports.read", "opd.consult.paper", "opd.visits.open"] as const;

export async function loadRecording(db: Db, actor: Actor, range: ReportRange): Promise<RecordingReport> {
  const base = { from: range.from, to: range.to, period: range.period, anchor: range.anchor };
  const none: RecordingReport = { ...base, scope: "none", totals: null, mine: null, days: [], departments: null, doctors: null };
  if (actor.type !== "user") return none;

  let hospital = false;
  for (const p of HOSPITAL_READERS) if (await hasPermission(db, actor.id, p, "hospital")) { hospital = true; break; }
  const staffFigures = hospital && await hasPermission(db, actor.id, "staff.reports.read", "hospital");
  const myDoctor = (await db.select({ id: opdDoctors.id }).from(opdDoctors).where(eq(opdDoctors.userId, actor.id)))[0]?.id ?? null;
  if (!hospital && myDoctor === null) return none;

  const [depts, encounters] = await Promise.all([
    db.select({ id: opdDepartments.id, name: opdDepartments.name, code: opdDepartments.code }).from(opdDepartments),
    db.select({
      id: opdEncounters.id, visitNo: opdEncounters.visitNo, patientId: opdEncounters.patientId,
      departmentId: opdEncounters.departmentId, doctorId: opdEncounters.doctorId, status: opdEncounters.status,
      visitType: opdEncounters.visitType, serviceDate: opdEncounters.serviceDate,
      consultCompletedAt: opdEncounters.consultCompletedAt, openedBy: opdEncounters.openedBy,
      openedAt: opdEncounters.openedAt, abandonedAt: opdEncounters.abandonedAt,
      abandonReason: opdEncounters.abandonReason, completedVia: opdEncounters.completedVia,
    }).from(opdEncounters).where(and(
      gte(opdEncounters.serviceDate, range.from), lte(opdEncounters.serviceDate, range.to), eq(opdEncounters.type, "opd"),
    )),
  ]);
  const lab = new Set(depts.filter((d) => d.code === LAB_DEPARTMENT_CODE).map((d) => d.id));
  const clinical: Visit[] = encounters.filter((e) => e.departmentId === null || !lab.has(e.departmentId));
  const visits = clinical.filter((e) => !isCorrection(e, clinical));

  const completedIds = visits.filter((v) => v.status === "completed").map((v) => v.id);
  const marks: Marks = { photographed: new Set(), typed: new Set(), issued: new Map() };
  if (completedIds.length > 0) {
    const [docs, rx] = await Promise.all([
      documentsForEncounters(db, completedIds),
      db.select({
        encounterId: opdPrescriptions.encounterId, transcribedBy: opdPrescriptions.transcribedBy,
        outside: opdPrescriptions.outsidePrescriberName, lines: opdPrescriptions.lines,
      }).from(opdPrescriptions).where(and(inArray(opdPrescriptions.encounterId, completedIds), eq(opdPrescriptions.status, "active"))),
    ]);
    for (const d of docs) if (d.kind === "consult_prescription") marks.photographed.add(d.encounterId);
    for (const p of rx) {
      if (p.outside !== null) continue; // an outside prescriber's paper is not this hospital's consultation
      if (p.transcribedBy !== null) { marks.typed.add(p.encounterId); continue; }
      const n = Array.isArray(p.lines) ? p.lines.length : 0;
      marks.issued.set(p.encounterId, (marks.issued.get(p.encounterId) ?? 0) + n);
    }
  }

  const mine = myDoctor === null ? null : tallyRecording(visits.filter((v) => v.doctorId === myDoctor), marks);
  const seen = hospital ? visits : visits.filter((v) => v.doctorId === myDoctor);
  const totals = tallyRecording(seen, marks);
  const days: RecordingDay[] = range.period === "day" ? [] : [...new Set(seen.map((v) => v.serviceDate))].sort()
    .map((date) => ({ date, ...tallyRecording(seen.filter((v) => v.serviceDate === date), marks) }));

  let departments: RecordingRow[] | null = null;
  let doctors: RecordingRow[] | null = null;
  if (hospital) {
    departments = depts.filter((d) => !lab.has(d.id))
      .map((d) => ({ id: d.id, name: d.name, ...tallyRecording(visits.filter((v) => v.departmentId === d.id), marks) }))
      .filter((r) => r.opened > 0).sort((a, b) => b.consulted - a.consulted || a.name.localeCompare(b.name));
  }
  if (staffFigures) {
    const ids = [...new Set(visits.map((v) => v.doctorId).filter((x): x is string => x !== null))];
    const names = ids.length === 0 ? [] : await db.select({ id: opdDoctors.id, name: opdDoctors.displayName }).from(opdDoctors).where(inArray(opdDoctors.id, ids));
    doctors = names.map((d) => ({ id: d.id, name: d.name, ...tallyRecording(visits.filter((v) => v.doctorId === d.id), marks) }))
      .sort((a, b) => b.notRecorded - a.notRecorded || b.consulted - a.consulted || a.name.localeCompare(b.name));
  }
  return { ...base, scope: hospital ? "hospital" : "mine", totals, mine, days, departments, doctors };
}
