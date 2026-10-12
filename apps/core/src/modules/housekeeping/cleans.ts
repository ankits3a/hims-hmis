import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, HOUSEKEEPING_KIND_LIST, cleanRefInput } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { getTask, nudgeTask, verifyTask } from "../tasks";
import "./kinds";
import { HousekeepingRefusal } from "./errors";
import { HOUSEKEEPING_VERIFY_TERMINAL } from "./names";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * THE TWO HOUSEKEEPING INTENTS a person calls. The doors check who may knock; these check the rest.
 *
 * `verifyClean` — the check of a cleaned bed. A terminal clean is refused up front to anyone without
 * `housekeeping.verify_terminal`, with the rule and the fix in words; the engine's `verifyTask` then enforces the
 * kind's verifier list again (the backstop for any other door), refuses the doer (`verifier_is_doer`), and, in its
 * own transaction, runs the kind's `onVerified`: the bed becomes available (ipd `markBedCleanIn`).
 *
 * `nudgeClean` — "Nudge housekeeping" from the Beds board: the engine escalates the task now.
 */
function parseRef(raw: unknown): { taskId: string; version?: number } {
  const r = cleanRefInput.safeParse(raw);
  if (!r.success) throw new HousekeepingRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

export async function verifyClean(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parseRef(raw);
  const task = await getTask(db, input.taskId);
  if (task === null || !BED_CLEAN_KINDS.includes(task.kind as (typeof BED_CLEAN_KINDS)[number])) {
    throw new HousekeepingRefusal("not_a_clean", { taskId: input.taskId });
  }
  if (task.kind === HOUSEKEEPING_KINDS.terminal && actor.type !== "system"
    && !(await hasPermission(db, actor.id, HOUSEKEEPING_VERIFY_TERMINAL, "hospital"))) {
    throw new HousekeepingRefusal("terminal_needs_supervisor", { taskId: task.id });
  }
  return verifyTask(db, actor, input, now);
}

export async function nudgeClean(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parseRef(raw);
  const task = await getTask(db, input.taskId);
  if (task === null || !HOUSEKEEPING_KIND_LIST.includes(task.kind as (typeof HOUSEKEEPING_KIND_LIST)[number])) {
    throw new HousekeepingRefusal("not_a_clean", { taskId: input.taskId });
  }
  return nudgeTask(db, actor, input, now);
}
