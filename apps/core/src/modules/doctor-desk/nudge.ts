import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor, OwedKind } from "@hmis/contracts";
import { alerts, doctorDeskNudges } from "../../kernel/db/schema";
import { raiseNotice } from "../../kernel/alerts/notices";
import { DoctorDeskError } from "./errors";
import { deskScope } from "./scope";
import { owedByUnit } from "./owed";
import type { Db } from "../../kernel/db/client";

/**
 * DD-0.6 / D7 — THE NUDGE: one unit member asking the holder of an owed row to act, ONCE.
 *
 * DECIDED (spec 2026-10-16 §3): any member of the unit may nudge — the SR and JR are the first users
 * (R2) and the plan's own acceptance is "push from a non-member refused" — never their own row, and
 * once per row per sender (the unique index answers `already_nudged`, so a double tap or two tabs
 * cannot send two). The row must be owed by the sender's unit NOW: a key from yesterday, from another
 * unit or made up is `unknown_row`, so a nudge cannot be aimed at somebody outside the unit.
 *
 * The bell row names the SENDER and the kind of thing owed — never a patient, a UHID or a value
 * (GC6; lock screens are personal phones, plan E13). The holder opens the Tower to see which.
 */
export const NUDGE_ALERT_KIND = "doctor_desk_nudge";

const BODY: Record<OwedKind, string> = {
  lab_critical: "A critical lab result on your order is still open. Open the Doctor Desk to see it.",
  alert: "Something on your bell is still waiting for an answer. Open the Doctor Desk to see it.",
  visit_open: "A visit of yours from an earlier day is not finished. Open the Doctor Desk to see it.",
};

export async function nudge(db: Db, actor: Actor, rowKey: string, at: Date): Promise<{ nudgeId: string; holderId: string }> {
  const scope = await deskScope(db, actor, at);
  if (scope.unit === null || !scope.members.some((m) => m.userId === actor.id)) {
    throw new DoctorDeskError("not_unit_member", "Only a member of the unit can nudge its rows.");
  }
  const row = (await owedByUnit(db, scope.members, at)).find((r) => r.key === rowKey);
  if (row === undefined) throw new DoctorDeskError("unknown_row", "That item is no longer owed by your unit.");
  if (row.holder.userId === actor.id) throw new DoctorDeskError("own_row", "You hold this item yourself.");

  const nudgeId = newId();
  const won = await db.insert(doctorDeskNudges).values({
    id: nudgeId, rowKey, teamId: scope.unit.teamId, senderId: actor.id, holderId: row.holder.userId, createdAt: at,
  }).onConflictDoNothing().returning({ id: doctorDeskNudges.id });
  if (won.length === 0) throw new DoctorDeskError("already_nudged", "You have already nudged this item.");

  const sourceKey = `doctor-desk-nudge:${nudgeId}`;
  await raiseNotice(db, {
    userId: row.holder.userId, kind: NUDGE_ALERT_KIND, title: `Nudge from ${scope.name}`, body: BODY[row.kind],
    refType: "doctor_desk_nudge", refId: nudgeId, sourceKey, at,
  });
  const bell = (await db.select({ id: alerts.id }).from(alerts)
    .where(and(eq(alerts.sourceEventId, sourceKey), eq(alerts.userId, row.holder.userId))))[0];
  if (bell !== undefined) await db.update(doctorDeskNudges).set({ alertId: bell.id }).where(eq(doctorDeskNudges.id, nudgeId));
  return { nudgeId, holderId: row.holder.userId };
}
