import { and, eq, isNull } from "drizzle-orm";
import { DIET_TASK_KINDS } from "@hmis/contracts";
import { dietMealLines, dietMealLists } from "../../kernel/db/schema";
import { SERVICES_SUPERVISOR_ROLE, SUPPORT_STAFF_ROLE, defineSkill, defineTaskKind } from "../tasks";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * DIET'S TASK KINDS, defined at import time (the API imports this module for its routes, the worker for its consumer
 * and the meal clock — both must, tasks MAP §4). DECIDED (Indian corporate-hospital food service):
 *   · `diet_delivery` — the trolley from the kitchen to one ward for one meal (or ONE tray added after dispatch): raised when the kitchen dispatches the
 *     list, done by the ward's food-service attendant (`support_staff`; nurses tap trays on the diet sheet); its Done marks the list delivered
 *     and every tray not tapped one by one as delivered;
 *   · `diet_ward_notice` — "do not serve bed X" or "NPO lifted": the ward is told when a printed list changes (NPO,
 *     transfer, OT cancelled). A tap is the proof; no check.
 * Both escalate to the services supervisor (the F&B / dietary supervisor sits there until a dietary role does).
 */
export const DIET_WARD_SKILL = "diet_ward";
defineSkill(DIET_WARD_SKILL, [SUPPORT_STAFF_ROLE]);

/**
 * Done on a delivery task: the LOAD's task marks the list delivered and only the trays that went on that trolley
 * (`on_load`); a tray added or changed after dispatch has its own task (`tray_task_id`) and is marked by that one.
 */
async function deliveryDone(tx: Tx, task: TaskRow, actor: Actor, now: Date): Promise<void> {
  const list = (await tx.select().from(dietMealLists).where(eq(dietMealLists.deliveryTaskId, task.id)).for("update"))[0];
  if (list !== undefined) {
    if (list.deliveredAt !== null) return;
    await tx.update(dietMealLists).set({ deliveredAt: now }).where(eq(dietMealLists.id, list.id));
    await tx.update(dietMealLines).set({ served: "delivered", servedAt: now, servedBy: actor.id })
      .where(and(eq(dietMealLines.listId, list.id), eq(dietMealLines.state, "active"), eq(dietMealLines.onLoad, true), isNull(dietMealLines.served)));
    return;
  }
  await tx.update(dietMealLines).set({ served: "delivered", servedAt: now, servedBy: actor.id })
    .where(and(eq(dietMealLines.trayTaskId, task.id), eq(dietMealLines.state, "active"), isNull(dietMealLines.served)));
}

export const DIET_DELIVERY_TASK = defineTaskKind({
  kind: DIET_TASK_KINDS.delivery,
  label: "Meal delivery",
  skill: DIET_WARD_SKILL,
  acceptWithinMin: 5,
  doneWithinMin: 45,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: false,
  ladderMin: [0, 15],
  onDone: deliveryDone,
});

export const DIET_WARD_NOTICE_TASK = defineTaskKind({
  kind: DIET_TASK_KINDS.wardNotice,
  label: "Diet change on ward",
  skill: DIET_WARD_SKILL,
  acceptWithinMin: 5,
  doneWithinMin: 15,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: false,
  ladderMin: [0, 10],
});
