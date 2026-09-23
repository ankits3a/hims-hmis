import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import { opdPatientReminders, users } from "../../kernel/db/schema";
import { getPatient } from "../patients";
import { OpdError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE PATIENT REMINDER (Consult v2, owner 2026-09-23) ═══
 *
 * A sticky note on the PATIENT that every doctor sees on every visit until somebody clears it. The table
 * is its own audit: a reminder is never updated in place and never deleted — setting a new one clears the
 * old one in the same transaction, and a cleared row keeps who cleared it and when.
 *
 * The patient is resolved through `getPatient`, the gate every clinical reader uses, so a sealed patient
 * the actor may not see is refused with the same `patient_not_found` an absent id produces.
 */
export type ReminderView = { id: string; text: string; setBy: string; setByName: string; setAt: Date };

async function visiblePatientId(db: Db, actor: Actor, patientId: string): Promise<string> {
  const visible = await getPatient(db, actor, patientId);
  if (!visible) throw new OpdError("patient_not_found", `unknown patient ${patientId}`);
  return visible.patient.id;
}

export async function activeReminder(db: Db, actor: Actor, patientId: string): Promise<ReminderView | null> {
  const id = await visiblePatientId(db, actor, patientId);
  const [row] = await db
    .select({ r: opdPatientReminders, fullName: users.fullName, username: users.username })
    .from(opdPatientReminders)
    .leftJoin(users, eq(users.id, opdPatientReminders.setBy))
    .where(and(eq(opdPatientReminders.patientId, id), isNull(opdPatientReminders.clearedAt)));
  if (!row) return null;
  const name = (row.fullName ?? "").trim() !== "" ? row.fullName! : (row.username ?? row.r.setBy);
  return { id: row.r.id, text: row.r.text, setBy: row.r.setBy, setByName: name, setAt: row.r.setAt };
}

export async function setReminder(db: Db, actor: Actor, patientId: string, text: string, now: Date = new Date()): Promise<ReminderView> {
  const id = await visiblePatientId(db, actor, patientId);
  const clean = text.trim(); // the route's zod body already refuses a blank one
  await withTx(db, async (tx) => {
    await tx.update(opdPatientReminders)
      .set({ clearedBy: actor.id, clearedAt: now })
      .where(and(eq(opdPatientReminders.patientId, id), isNull(opdPatientReminders.clearedAt)));
    await tx.insert(opdPatientReminders).values({ id: newId(), patientId: id, text: clean, setBy: actor.id, setAt: now });
  });
  return (await activeReminder(db, actor, id))!;
}

export async function clearReminder(db: Db, actor: Actor, patientId: string, now: Date = new Date()): Promise<{ cleared: boolean }> {
  const id = await visiblePatientId(db, actor, patientId);
  const rows = await db.update(opdPatientReminders)
    .set({ clearedBy: actor.id, clearedAt: now })
    .where(and(eq(opdPatientReminders.patientId, id), isNull(opdPatientReminders.clearedAt)))
    .returning({ id: opdPatientReminders.id });
  return { cleared: rows.length > 0 };
}
