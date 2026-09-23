import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { opdDepartments, opdDoctors } from "../../kernel/db/schema";
import { requireTreatingDoctor, saveConsultNote } from "./consultation";
import { getEncounter, openVisit } from "./encounters";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ CONSULT V2 — AN INTERNAL REFERRAL PUTS THE PATIENT IN THE OTHER LINE (owner, 2026-09-23) ═══
 *
 * The doctor refers the patient to another department's doctor with a reason. The patient is NOT
 * registered again: a new visit is opened for the same person through `openVisit`, the one door every
 * visit enters by, so the token, the queue, the visit type and the fee all follow the rules they follow
 * for anybody else. THE FEE IS NOT DECIDED HERE — whether a same-day internal referral is charged is an
 * open owner ruling (money), so this adds no special case: the tariff applies and the front desk sees
 * the visit as it sees every other.
 *
 * What the receiving doctor reads first is the referral itself: it rides the new visit's desk-complaint
 * field, stamped with the REFERRING doctor as its author, so the brief says who sent the patient and why.
 * The referring visit records `referralTo` / `referralNote` through the consult note, so its own
 * completion appends the existing `referral.issued` event.
 *
 * Only the treating doctor, in an open consultation — the note's own guards.
 */
export type ReferInput = { departmentId: string; doctorId: string; reason: string; note?: string | null };

export async function referInternally(
  db: Db, actor: Actor, encounterId: string, input: ReferInput, now: Date = new Date(),
): Promise<{ encounterId: string; tokenNo: number; visitNo: string; visitType: string }> {
  const enc = await getEncounter(db, encounterId);
  if (!enc) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const from = await requireTreatingDoctor(db, actor, enc);
  if (enc.status !== "in_consultation") throw new OpdError("encounter_state_conflict", `a referral needs in_consultation, not ${enc.status}`);
  const [to] = await db.select().from(opdDoctors).where(eq(opdDoctors.id, input.doctorId));
  if (!to) throw new OpdError("unknown_doctor", `unknown doctor ${input.doctorId}`);
  if (to.departmentId !== input.departmentId) throw new OpdError("doctor_department_mismatch", "that doctor is not in that department");
  if (to.id === from.id) throw new OpdError("invalid_transfer", "a referral goes to another doctor");
  const [dept] = await db.select().from(opdDepartments).where(eq(opdDepartments.id, input.departmentId));
  if (!dept) throw new OpdError("unknown_department", `unknown department ${input.departmentId}`);

  const reason = input.reason.trim();
  const note = (input.note ?? "").trim();
  const words = `Referred by ${from.displayName}: ${reason}${note === "" ? "" : ` — ${note}`}`;
  const opened = await openVisit(db, actor, {
    patientId: enc.patientId, departmentId: input.departmentId, doctorId: input.doctorId,
    referralSource: "internal_doctor", referrerName: from.displayName, deskComplaint: words,
  }, now);
  await saveConsultNote(db, actor, encounterId, {
    referralTo: `${dept.name} · ${to.displayName}`.slice(0, 200),
    referralNote: `${reason}${note === "" ? "" : ` — ${note}`}`.slice(0, 2000),
  }, now);
  return { encounterId: opened.encounter.id, tokenNo: opened.tokenNo, visitNo: opened.encounter.visitNo, visitType: opened.visitType };
}
