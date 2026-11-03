import { and, desc, eq } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdQueueEntries } from "../../kernel/db/schema";
import { enqueuePrintJob } from "../../kernel/printing/enqueue";
import { doctorsForChange } from "./change-doctor";
import { loadOpdConfig } from "./config";
import { getEncounter, LAB_DEPARTMENT_CODE } from "./encounters";
import { moveVisitDepartment } from "./department-move";
import { listDepartments } from "./masters";
import { OpdError } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { ChangeDoctorOption } from "./change-doctor";

/**
 * ═══ SPEC #1031 — CHANGE A PATIENT'S DEPARTMENT FROM THE VITALS SCREEN (owner 2026-11-03) ═══
 *
 * The bay's "Change doctor" sheet gains a Department picker. Same department is #1025's change of
 * doctor (`change-doctor.ts`); another department is THIS: the front desk's `moveVisitDepartment`, the
 * one server road for a department move, with three things the vitals seat adds and nothing it removes:
 *
 *  - its own narrow permission (`opd.vitals.change_department`), the patient's agreement and a reason;
 *  - NO MONEY: the seat takes none, so the move goes ahead only when nothing is collected or refunded
 *    (`collectsNothing`, read inside the move's own transaction). Otherwise: "send to billing counter";
 *  - NO PAPER: the new token's slips are not queued to the front desk's printer. The token is shown on
 *    the screen for staff to write on the old slip. A hospital setting (`opd_config.vitals_move_print_slip`,
 *    OFF) lets the mover print the new token slip on demand (`printMovedTokenSlip`).
 *
 * The rules shared with the desk — refused once the consult has begun, the old visit closed and a new
 * visit and token opened, the booking and the bill carried, the report correcting itself, the vitals
 * carried over and the queue place kept by original arrival — live in `department-move.ts` once.
 */
export type ChangeDepartmentOptions = {
  currentDepartmentId: string | null;
  departments: { id: string; name: string }[];
  doctors: ChangeDoctorOption[];
};

export async function changeDepartmentOptions(db: Db, encounterId: string, departmentId?: string): Promise<ChangeDepartmentOptions> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const departments = (await listDepartments(db, { activeOnly: true }))
    .filter((d) => d.code !== LAB_DEPARTMENT_CODE)
    .map((d) => ({ id: d.id, name: d.name }));
  return { currentDepartmentId: encounter.departmentId, departments, doctors: await doctorsForChange(db, encounterId, departmentId) };
}

export type VitalsDepartmentMoveResult = {
  encounterId: string;
  tokenNo: number | null;
  departmentName: string;
  doctorName: string;
  /** May this screen offer "print new token slip"? The hospital setting, read at the move. */
  printSlip: boolean;
};

export async function moveDepartmentFromVitals(
  db: Db, actor: Actor,
  encounterId: string, input: { departmentId: string; doctorId: string; consented: boolean; reason: string },
  now: Date = new Date(),
): Promise<VitalsDepartmentMoveResult> {
  if (input.consented !== true) throw new OpdError("invalid_transfer", "a department move from the bay needs the patient's agreement");
  const doctor = (await doctorsForChange(db, encounterId, input.departmentId)).find((d) => d.id === input.doctorId);
  if (doctor === undefined) throw new OpdError("invalid_transfer", "that doctor is not sitting in that department today");
  const moved = await moveVisitDepartment(db, actor, encounterId, {
    departmentId: input.departmentId, doctorId: input.doctorId, reason: input.reason, fromVitals: true,
  }, now);
  const [dept] = await db.select({ name: opdDepartments.name }).from(opdDepartments).where(eq(opdDepartments.id, input.departmentId));
  const cfg = await loadOpdConfig(db);
  return {
    encounterId: moved.to.encounter.id, tokenNo: moved.to.tokenNo,
    departmentName: dept?.name ?? "", doctorName: doctor.displayName, printSlip: cfg.vitalsMovePrintSlip,
  };
}

/**
 * The on-demand "print new token slip", behind the hospital setting. Only a visit still waiting in a
 * line has a token to print; the job is the ordinary token slip, deduplicated on the visit as the
 * desk's own is, so a second press queues nothing more.
 */
export async function printMovedTokenSlip(db: Db, actor: Actor, encounterId: string): Promise<{ queued: boolean }> {
  if (!(await loadOpdConfig(db)).vitalsMovePrintSlip) throw new OpdError("print_off", "printing a new token slip is switched off for this hospital");
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const [entry] = await db.select({ id: opdQueueEntries.id }).from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounterId))).orderBy(desc(opdQueueEntries.seq)).limit(1);
  if (entry === undefined) throw new OpdError("invalid_transfer", "this visit has no token to print");
  const id = await withTx(db, (tx) => enqueuePrintJob(tx, {
    document: "opd_token_slip", params: { encounterId }, dedupeKey: `token:${encounterId}`,
    patientId: encounter.patientId, encounterId, requestedBy: actor.type === "user" ? actor.id : null,
  }));
  return { queued: id !== null };
}
