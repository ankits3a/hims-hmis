import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor, OwedKind } from "@hmis/contracts";
import { alerts, doctorDeskMoves } from "../../kernel/db/schema";
import { raiseNotice } from "../../kernel/alerts/notices";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { DoctorDeskError } from "./errors";
import { approvedStandIn, deskScope } from "./scope";
import { owedByUnit } from "./owed";
import { doctorDeskRowMoved } from "./events";
import type { DeskScope } from "./scope";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ DD-1.2 — MOVE: the unit's head (or a senior resident) gives an owed row to another member ═══
 *
 * DECIDED (spec 3): the head of the unit (an officiating head inside the window, as `teamMembers`
 * returns them) or a senior resident of the unit may move; a JR or intern is `not_allowed_to_move`.
 * The row must be owed by the mover's unit NOW (`unknown_row` otherwise, as the nudge), and the new
 * holder a current member who does not hold it already (`not_unit_member` / `same_holder`).
 *
 * The SOURCE ROW IS NEVER EDITED — not the bell row, not the critical call, not the visit (plan D-A:
 * the Desk writes no clinical row). The move is the unit's record of who it now expects to act; the
 * newest move of a row wins (`owed.ts withMoves`). One transaction carries the move, its event (the
 * audit) and the new holder's bell row, which names the mover and the kind, never a patient (GC6).
 */
export const MOVE_ALERT_KIND = "doctor_desk_move";

const BODY: Record<OwedKind, string> = {
  lab_critical: "A critical lab result in your unit is now yours to act on. Open the Doctor Desk to see it.",
  alert: "An item in your unit waiting for an answer is now yours. Open the Doctor Desk to see it.",
  visit_open: "An unfinished visit in your unit is now yours to finish. Open the Doctor Desk to see it.",
};

/** Whether this member may move rows: the head (officiating included) or a senior resident. */
/** The unit's head or a senior resident; an officiating one only on a row somebody else approved. */
export async function mayMove(db: Db, scope: DeskScope, userId: string, at: Date): Promise<boolean> {
  const me = scope.members.find((m) => m.userId === userId);
  if (me === undefined || scope.unit === null || (me.roleInTeam !== "head" && me.roleInTeam !== "senior_resident")) return false;
  return !me.officiating || approvedStandIn(db, userId, scope.unit.teamId, at);
}

export type MoveDeps = { raise: typeof raiseNotice };

export async function moveRow(
  db: Db, actor: Actor, rowKey: string, toUserId: string, at: Date, deps: MoveDeps = { raise: raiseNotice },
): Promise<{ moveId: string }> {
  const scope = await deskScope(db, actor, at);
  if (scope.unit === null || !scope.members.some((m) => m.userId === actor.id)) {
    throw new DoctorDeskError("not_unit_member", "Only a member of the unit can move its rows.");
  }
  if (!(await mayMove(db, scope, actor.id, at))) throw new DoctorDeskError("not_allowed_to_move", "Only the unit's head or a senior resident moves an item.");
  const target = scope.members.find((m) => m.userId === toUserId);
  if (target === undefined) throw new DoctorDeskError("not_unit_member", "The person you chose is not in your unit today.");
  const row = (await owedByUnit(db, scope.members, at)).find((r) => r.key === rowKey);
  if (row === undefined) throw new DoctorDeskError("unknown_row", "That item is no longer owed by your unit.");
  if (row.holder.userId === toUserId) throw new DoctorDeskError("same_holder", "That person holds it already.");

  const moveId = newId();
  const sourceKey = `doctor-desk-move:${moveId}`;
  const teamId = scope.unit.teamId;
  await withTx(db, async (tx) => {
    await tx.insert(doctorDeskMoves).values({
      id: moveId, rowKey, teamId, fromUserId: row.holder.userId, toUserId, movedBy: actor.id, createdAt: at,
    });
    await appendEvent(tx, doctorDeskRowMoved.make({
      actor, occurredAt: at, correlationId: moveId,
      payload: { moveId, rowKey, teamId, fromUserId: row.holder.userId, toUserId },
    }));
    if (toUserId !== actor.id) {
      await deps.raise(tx as unknown as Db, {
        userId: toUserId, kind: MOVE_ALERT_KIND, title: `Given to you by ${scope.name}`, body: BODY[row.kind],
        refType: "doctor_desk_move", refId: moveId, sourceKey, at,
      });
      const bell = (await tx.select({ id: alerts.id }).from(alerts)
        .where(and(eq(alerts.sourceEventId, sourceKey), eq(alerts.userId, toUserId))))[0];
      if (bell !== undefined) await tx.update(doctorDeskMoves).set({ alertId: bell.id }).where(eq(doctorDeskMoves.id, moveId));
    }
  });
  return { moveId };
}
