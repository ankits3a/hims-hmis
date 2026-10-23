import { and, eq, gte, inArray } from "drizzle-orm";
import { ACT_CHOICES, ACT_NOTE_MAX, newId } from "@hmis/contracts";
import type { ActChoice, Actor } from "@hmis/contracts";
import { doctorDeskActs } from "../../kernel/db/schema";
import { DoctorDeskError } from "./errors";
import { doctorDeskCriticalActed } from "./events";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { deskScope } from "./scope";
import { owedByUnit } from "./owed";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ DD-1.3 (D3) — "WHAT DID YOU DO?": the act, not the acknowledgement, closes the loop ═══
 *
 * Owner board Main.dc.html: *"What did you do? The loop closes on the act, not the tap."* A lab
 * critical stays on the Tower and in Clocks Running — red while the lab's call is open, amber once the
 * lab has read it back — until somebody records what was done. DECIDED (spec 4):
 *   · DD-1 takes acts on lab criticals (`lab_critical:<call id>`); imaging criticals keep radiology's own
 *     acknowledgement until its ladder exposes one (`not_actable`).
 *   · Who: the holder, or any member of the holder's unit (another SR took it). Re-checked at the act:
 *     the row must be owed by the actor's unit NOW — or, for a doctor in no unit, be the actor's own.
 *   · Once per row (`already_acted`); "Other" needs a few words (`note_required`).
 * Critical→act is `acted_at − opened_at` (the call's opening, copied onto the act row).
 */
export async function recordAct(
  db: Db, actor: Actor, rowKey: string, choice: ActChoice, note: string | null, at: Date,
): Promise<{ actId: string; minutes: number }> {
  if (!rowKey.startsWith("lab_critical:")) throw new DoctorDeskError("not_actable", "An act is recorded on a lab critical.");
  if (!(ACT_CHOICES as readonly string[]).includes(choice)) throw new DoctorDeskError("not_actable", "Unknown act.");
  const text = note === null ? null : note.trim().slice(0, ACT_NOTE_MAX);
  if (choice === "other" && (text === null || text.length < 3)) throw new DoctorDeskError("note_required", "Say in a few words what you did.");

  const done = await db.select({ id: doctorDeskActs.id }).from(doctorDeskActs).where(eq(doctorDeskActs.rowKey, rowKey)).limit(1);
  if (done.length > 0) throw new DoctorDeskError("already_acted", "An act is already recorded on this item.");

  const scope = await deskScope(db, actor, at);
  const inUnit = scope.unit !== null && scope.members.some((m) => m.userId === actor.id);
  const pool = inUnit ? scope.members : [{ userId: actor.id, name: scope.name }];
  const row = (await owedByUnit(db, pool, at)).find((r) => r.key === rowKey);
  if (row === undefined) {
    throw new DoctorDeskError(inUnit ? "unknown_row" : "not_unit_member", "That critical is not one your unit holds now.");
  }
  const actId = newId();
  const teamId = inUnit ? scope.unit!.teamId : null;
  const minutes = minutesBetween(new Date(row.since), at);
  // The act and its event land together (audit): no act without its event, no event without its act.
  await withTx(db, async (tx) => {
    const won = await tx.insert(doctorDeskActs).values({
      id: actId, rowKey, teamId, holderId: row.holder.userId, actorId: actor.id,
      choice, note: text === "" ? null : text, openedAt: new Date(row.since), actedAt: at,
    }).onConflictDoNothing().returning({ id: doctorDeskActs.id });
    if (won.length === 0) throw new DoctorDeskError("already_acted", "An act is already recorded on this item.");
    await appendEvent(tx, doctorDeskCriticalActed.make({
      actor, occurredAt: at, correlationId: actId,
      payload: { actId, rowKey, teamId, holderId: row.holder.userId, choice, minutes },
    }));
  });
  return { actId, minutes };
}

export const minutesBetween = (from: Date, to: Date): number => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

export type ActRow = typeof doctorDeskActs.$inferSelect;

/** Acts by these people since `since` (their own acts — the "critical → act" figure, D6: acts, not screens). */
export async function actsBy(exec: Db | Tx, userIds: readonly string[], since: Date): Promise<ActRow[]> {
  if (userIds.length === 0) return [];
  return (exec as Db).select().from(doctorDeskActs).where(and(inArray(doctorDeskActs.actorId, [...userIds]), gte(doctorDeskActs.actedAt, since)));
}

/** Acts recorded in a unit since `since`. */
export async function actsInTeam(exec: Db | Tx, teamIds: readonly string[], since: Date): Promise<ActRow[]> {
  if (teamIds.length === 0) return [];
  return (exec as Db).select().from(doctorDeskActs).where(and(inArray(doctorDeskActs.teamId, [...teamIds]), gte(doctorDeskActs.actedAt, since)));
}

/** The median of critical→act minutes, or null when there is none. */
export function medianMinutes(acts: readonly Pick<ActRow, "openedAt" | "actedAt">[]): number | null {
  if (acts.length === 0) return null;
  const xs = acts.map((a) => minutesBetween(a.openedAt, a.actedAt)).sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid]! : Math.round((xs[mid - 1]! + xs[mid]!) / 2);
}
