import { SERVICES_SUPERVISOR_ROLE, defineTaskKind, raiseTask } from "../tasks";
import type { LinenChangeReason } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { RaiseResult } from "../tasks";

/**
 * THE LINEN CHANGE TASK. Every admission and discharge changes the bed's linen (spec §5). The IPD lanes call
 * `raiseLinenChange` with the bed (or room) when they admit or discharge; this module does NOT subscribe to IPD events
 * (there is no admission in this branch yet — MAP.md §5 names the seam).
 *
 * DEFINED HERE, IMPORTED BY `index.ts`: the API loads the index, so the kind is known wherever a task is raised. The
 * worker's task clock also needs the kind (tasks MAP §4): the worker must import the linen index before the first
 * linen change task can be late — today the worker imports nothing of linen, so a late linen change falls back to the
 * engine's default ladder and tells no one (named in MAP.md as a trap for the IPD lane that wires the call).
 *
 * DECIDED: skill `general` (ward attendants, `support_staff`); accept within 10 minutes, done within 60 (the bed is
 * made before the next patient or within the hour of admission); tap is the proof; no verify step.
 */
export const LINEN_CHANGE_TASK = defineTaskKind({
  kind: "linen_change",
  label: "Change bed linen",
  skill: "general",
  acceptWithinMin: 10,
  doneWithinMin: 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: false,
});

export const LINEN_SYSTEM: Actor = { type: "system", id: "linen" };

export type RaiseLinenChangeInput = {
  /** The bed (or room) — a resource-registry node. */
  placeId: string;
  reason: LinenChangeReason;
  patientId?: string | null;
};

/**
 * Raise a linen change at a bed. Pass the caller's transaction so the task commits with the admission or discharge
 * that caused it. A second change at the same bed within ten minutes merges into the first (the engine's rule).
 */
export async function raiseLinenChange(
  exec: Db | Tx, input: RaiseLinenChangeInput, now: Date = new Date(), actor: Actor = LINEN_SYSTEM,
): Promise<RaiseResult> {
  return raiseTask(exec, actor, {
    kind: LINEN_CHANGE_TASK.kind,
    placeResourceId: input.placeId,
    ...(input.patientId === undefined ? {} : { patientId: input.patientId }),
    note: `linen change: ${input.reason}`,
  }, now);
}
