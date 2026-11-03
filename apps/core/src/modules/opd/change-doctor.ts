import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { opdDoctorLeaves, opdDoctorSchedules, opdDoctors, opdQueueEntries } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import { LIVE_ENTRY_STATUSES, getEncounter, transferQueue } from "./encounters";
import { istWeekday } from "./time";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER 2026-11-02, spec #1025 — the bay changes one patient's doctor. It is `transferQueue` for one
 * token: same department, same token, same place, consent and a reason. What this file adds is the
 * patient-sized door a vitals seat may hold, and the list of doctors who can actually see them today.
 */
export type ChangeDoctorOption = { id: string; displayName: string };

/** `departmentId` — spec #1031: the doctors of ANOTHER department sitting today, for the vitals seat's department move. */
export async function doctorsForChange(db: Db, encounterId: string, departmentId?: string): Promise<ChangeDoctorOption[]> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) throw new OpdError("invalid_transfer", `visit ${encounterId} not found`);
  const [from] = encounter.doctorId === null ? [] : await db.select().from(opdDoctors).where(eq(opdDoctors.id, encounter.doctorId));
  if (from === undefined) throw new OpdError("invalid_transfer", "unknown doctor");
  const date = encounter.serviceDate;
  const peers = (await db.select().from(opdDoctors)
    .where(and(eq(opdDoctors.departmentId, departmentId ?? from.departmentId), eq(opdDoctors.active, true))).orderBy(opdDoctors.displayName))
    .filter((d) => d.id !== from.id);
  if (peers.length === 0) return [];
  const ids = peers.map((d) => d.id);
  const sitting = await db.select({ doctorId: opdDoctorSchedules.doctorId }).from(opdDoctorSchedules).where(and(
    inArray(opdDoctorSchedules.doctorId, ids), eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, istWeekday(date)),
    lte(opdDoctorSchedules.validFrom, date), or(isNull(opdDoctorSchedules.validTo), gte(opdDoctorSchedules.validTo, date)),
  ));
  const away = await db.select({ doctorId: opdDoctorLeaves.doctorId }).from(opdDoctorLeaves).where(and(
    inArray(opdDoctorLeaves.doctorId, ids), eq(opdDoctorLeaves.status, "scheduled"),
    lte(opdDoctorLeaves.fromDate, date), gte(opdDoctorLeaves.toDate, date),
  ));
  const here = new Set(sitting.map((s) => s.doctorId));
  const onLeave = new Set(away.map((l) => l.doctorId));
  return peers.filter((d) => here.has(d.id) && !onLeave.has(d.id)).map((d) => ({ id: d.id, displayName: d.displayName }));
}

export async function changeVisitDoctor(
  db: Db, actor: Actor, encounterId: string, input: { toDoctorId: string; consented: boolean; reason: string }, now: Date = new Date(),
): Promise<{ toSessionId: string }> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null || encounter.doctorId === null) throw new OpdError("invalid_transfer", `visit ${encounterId} has no doctor to change`);
  const entries = await db.select({ id: opdQueueEntries.id }).from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])));
  if (entries.length === 0) throw new OpdError("invalid_transfer", "this patient is no longer waiting: the consultation has begun or the visit has ended");
  if (!(await doctorsForChange(db, encounterId)).some((d) => d.id === input.toDoctorId)) {
    throw new OpdError("invalid_transfer", "that doctor is not sitting in this department today");
  }
  const out = await transferQueue(db, actor, {
    fromDoctorId: encounter.doctorId, toDoctorId: input.toDoctorId, serviceDate: encounter.serviceDate,
    entryIds: entries.map((e) => e.id), consented: input.consented, reason: input.reason,
  }, now);
  if (out.transferred === 0) throw new OpdError("invalid_transfer", "this patient moved while the change was being made");
  return { toSessionId: out.toSessionId };
}
