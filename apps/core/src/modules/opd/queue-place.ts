import { and, asc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { getPatient, listMergedLoserIds } from "../patients";
import { loadOpdConfig } from "./config";
import { OpdError } from "./errors";
import { orderQueue } from "./queue-engine";
import { istDate } from "./time";
import type { QueueEntryRow } from "./encounters";
import type { QueueEntryState } from "./queue-engine";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ #657 — "WHERE IN LINE IS THIS PATIENT?" FOR THE PROFILE'S TODAY BAND ═══
 *
 * Board (`docs/design/2026-09-29-patient-profile/`): "In the Cardiology queue · token C-14 · 2nd in
 * line for Dr. A. Mathur". One row per queue entry the patient holds TODAY (IST) that is still
 * live: waiting for vitals, waiting, called, or in consultation. For a WAITING row, `position` is
 * its place in the doctor's line under the same ordering the doctor's queue uses (`orderQueue`,
 * `listQueue`'s call), and `ahead` is how many are in front of it. Counts only — no other patient's
 * id, name or token crosses this read.
 *
 * Gated by `getPatient` (the sealed-record decision), spans the merge chain like the timeline, and
 * a refusal is the same `patient_not_found` an absent id answers.
 */
export type QueuePlaceState = "waiting_vitals" | "waiting" | "called" | "in_consult";

export type QueuePlace = {
  encounterId: string;
  /** `MED-4`: the department's code and the token, the grammar the slip prints. */
  token: string;
  tokenNo: number;
  doctorName: string;
  departmentName: string | null;
  state: QueuePlaceState;
  /** 1-based place among the doctor's waiting tokens; null unless `state` is `waiting`. */
  position: number | null;
  ahead: number | null;
};

const LIVE: readonly QueuePlaceState[] = ["waiting_vitals", "waiting", "called", "in_consult"];

function toState(row: QueueEntryRow): QueueEntryState {
  return {
    id: row.id, tokenNo: row.tokenNo, kind: row.kind === "appointment" ? "appointment" : "walk_in",
    appointmentAt: row.appointmentAt, eligibleAt: row.eligibleAt ?? row.createdAt, seq: row.seq,
    danger: row.danger, reEntry: row.reEntry, perk: row.perk, skips: row.skips,
  };
}

function tokenLabel(code: string | null, tokenNo: number): string {
  return code === null || code.trim() === "" ? String(tokenNo) : `${code.trim().toUpperCase()}-${String(tokenNo)}`;
}

export async function patientQueueToday(db: Db, actor: Actor, patientId: string, now: Date = new Date()): Promise<QueuePlace[]> {
  const visible = await getPatient(db, actor, patientId);
  if (!visible) throw new OpdError("patient_not_found", `unknown patient ${patientId}`);
  const ids = [visible.patient.id, ...await listMergedLoserIds(db, visible.patient.id)];
  const today = istDate(now);

  const mine = await db
    .select({ entry: opdQueueEntries, session: opdQueueSessions, encounter: opdEncounters })
    .from(opdQueueEntries)
    .innerJoin(opdQueueSessions, eq(opdQueueSessions.id, opdQueueEntries.sessionId))
    .innerJoin(opdEncounters, eq(opdEncounters.id, opdQueueEntries.encounterId))
    .where(and(
      inArray(opdEncounters.patientId, ids),
      eq(opdQueueSessions.serviceDate, today),
      inArray(opdQueueEntries.status, [...LIVE]),
    ))
    .orderBy(asc(opdQueueEntries.seq));
  if (mine.length === 0) return [];

  const cfg = await loadOpdConfig(db);
  const doctorIds = [...new Set(mine.map((m) => m.session.doctorId))];
  const doctors = await db.select({ id: opdDoctors.id, displayName: opdDoctors.displayName }).from(opdDoctors).where(inArray(opdDoctors.id, doctorIds));
  const deptIds = [...new Set(mine.map((m) => m.encounter.departmentId).filter((d): d is string => d !== null))];
  const depts = deptIds.length === 0 ? [] : await db.select({ id: opdDepartments.id, code: opdDepartments.code, name: opdDepartments.name }).from(opdDepartments).where(inArray(opdDepartments.id, deptIds));

  const out: QueuePlace[] = [];
  for (const m of mine) {
    const state = m.entry.status as QueuePlaceState;
    let position: number | null = null;
    if (state === "waiting") {
      // The doctor's whole waiting line, ordered exactly as `listQueue` orders it; only the index is kept.
      const waiting = await db.select().from(opdQueueEntries)
        .where(and(eq(opdQueueEntries.sessionId, m.session.id), eq(opdQueueEntries.status, "waiting")));
      const ordered = orderQueue(waiting.map(toState), now, { perkEveryNth: cfg.perkEveryNth }, m.session.callsMade);
      const i = ordered.findIndex((s) => s.id === m.entry.id);
      position = i < 0 ? null : i + 1;
    }
    const dept = depts.find((d) => d.id === m.encounter.departmentId);
    out.push({
      encounterId: m.encounter.id,
      token: tokenLabel(dept?.code ?? null, m.entry.tokenNo),
      tokenNo: m.entry.tokenNo,
      doctorName: doctors.find((d) => d.id === m.session.doctorId)?.displayName ?? "",
      departmentName: dept?.name ?? null,
      state,
      position,
      ahead: position === null ? null : position - 1,
    });
  }
  return out;
}
