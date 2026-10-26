import { eq } from "drizzle-orm";
import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, HOUSEKEEPING_KIND_LIST, cleanRefInput, confirmCleanInput } from "@hmis/contracts";
import { raiseNoticeIn } from "../../kernel/alerts/notices";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { resources } from "../../kernel/db/schema";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { SERVICES_SUPERVISOR_ROLE, getTask, nudgeTask, rejectTask, rejectionsOf, taskKind, verifyTask } from "../tasks";
import "./kinds";
import { HousekeepingRefusal } from "./errors";
import { HOUSEKEEPING_VERIFY_TERMINAL } from "./names";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * THE TWO HOUSEKEEPING INTENTS a person calls. The doors check who may knock; these check the rest.
 *
 * `verifyClean` — the check of a cleaned bed (state, not version, decides — see below). A terminal clean is refused up front to anyone without
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
  // DECIDED (PR #750 review, finding 6): the check compares STATE, not version. The only change a clean takes after
  // the screen read it is a nudge (which bumps the version) — and the engine still refuses anything not `done`, a
  // doer, or a verifier without the kind's permission. So the screen's version is not sent on.
  return verifyTask(db, actor, { taskId: input.taskId }, now);
}

export async function nudgeClean(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parseRef(raw);
  const task = await getTask(db, input.taskId);
  if (task === null || !HOUSEKEEPING_KIND_LIST.includes(task.kind as (typeof HOUSEKEEPING_KIND_LIST)[number])) {
    throw new HousekeepingRefusal("not_a_clean", { taskId: input.taskId });
  }
  return nudgeTask(db, actor, input, now);
}

/**
 * HK-1 (#973) — CONFIRM: Pass or Fail, by a nurse or the supervisor (the kind's verifier list; a terminal clean only by
 * the supervisor or infection control, refused up front in words). The doer of ANY round never confirms (engine). Pass
 * is `verifyTask` (a bed is freed as before). Fail needs a reason and is `rejectTask`: the task goes back to work, to the
 * same attendant while on duty. A second fail puts the task in the supervisor's "Needs you" list and rings their bell.
 */
export const NEEDS_YOU_AFTER = 2;

export async function confirmClean(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const r = confirmCleanInput.safeParse(raw);
  if (!r.success) throw new HousekeepingRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const input = r.data;
  const task = await getTask(db, input.taskId);
  if (task === null || !HOUSEKEEPING_KIND_LIST.includes(task.kind as (typeof HOUSEKEEPING_KIND_LIST)[number])) {
    throw new HousekeepingRefusal("not_a_clean", { taskId: input.taskId });
  }
  if (task.kind === HOUSEKEEPING_KINDS.terminal && actor.type !== "system"
    && !(await hasPermission(db, actor.id, HOUSEKEEPING_VERIFY_TERMINAL, "hospital"))) {
    throw new HousekeepingRefusal("terminal_needs_supervisor", { taskId: task.id });
  }
  const ref = { taskId: task.id, ...(input.version === undefined ? {} : { version: input.version }) };
  if (input.result === "pass") return verifyTask(db, actor, ref, now);
  const reason = input.reason?.trim() ?? "";
  if (reason.length === 0) throw new HousekeepingRefusal("reason_required", { taskId: task.id });
  return withTx(db, async (tx) => {
    const row = await rejectTask(tx, actor, { ...ref, reason }, now);
    const fails = (await rejectionsOf(tx, [task.id])).get(task.id)?.count ?? 0;
    if (fails >= NEEDS_YOU_AFTER) await tellNeedsYou(tx, row, fails, now);
    return row;
  });
}

/** The supervisor's bell: a task failed its check again. Place and kind only, never a patient. */
async function tellNeedsYou(tx: Tx, row: TaskRow, fails: number, now: Date): Promise<void> {
  const place = row.placeResourceId === null ? null
    : (await tx.select({ name: resources.name }).from(resources).where(eq(resources.id, row.placeResourceId)))[0]?.name ?? null;
  const label = taskKind(row.kind)?.label ?? row.kind;
  for (const userId of await usersHoldingRole(tx, SERVICES_SUPERVISOR_ROLE)) {
    await raiseNoticeIn(tx, {
      userId, kind: "housekeeping.needs_you", title: `Failed ${String(fails)} times: ${label}`, body: place ?? "",
      refType: "task", refId: row.id, sourceKey: `hk:needs-you:${row.id}:${String(fails)}`, at: now,
    });
  }
}
