import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  assignTaskInput, cancelPlaceInput, cancelTaskInput, completeTaskInput, newId, raiseTaskInput, returnTaskInput,
  taskRefInput,
} from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { resources, taskEvents, tasks, users } from "../../kernel/db/schema";
import { TaskError } from "./errors";
import { requireTaskKind, skillRoles, taskKind, verifierPermissionsOf } from "./kinds";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { dutyCovering, pickWorker } from "./dispatch";
import type { Actor, TaskAct, TaskEventSource, TaskSource } from "@hmis/contracts";
import type { z } from "zod";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE INTENTS ═══
 *
 * Every function here is one act on a task. Each parses its input with the contract's zod schema,
 * refuses with a `TaskError` (code + sentence + fix), and changes the task row and appends exactly one
 * `task_events` row in ONE transaction, the event's `seq` being the row's new `version`.
 *
 * Authority is the caller's: the HTTP doors check `tasks.work` / `tasks.supervise`; an intent then
 * checks only what a permission cannot say — that the task is yours, that the verifier is not the doer.
 * `asSupervisor` is set by the controller after it has checked `tasks.supervise`, and by a calling
 * module acting for the hospital (a system actor).
 */
export type TaskRow = typeof tasks.$inferSelect;
export type Exec = Db | Tx;
export type ActOptions = { asSupervisor?: boolean; source?: TaskSource };
/** `closeDone`: an owning module may also cancel a task that is done but not yet checked (the place moved on). */
export type CancelOptions = { closeDone?: boolean };

const OPEN: readonly string[] = ["created", "assigned", "accepted", "in_progress"];
const HELD: readonly string[] = ["assigned", "accepted", "in_progress"];
/** Spec §2: a second request for the same kind at the same place within ten minutes is the same request. */
export const MERGE_WINDOW_MS = 10 * 60_000;

function parse<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const reasonMissing = r.error.issues.some((i) => i.path[0] === "reason");
    throw new TaskError(reasonMissing ? "reason_required" : "bad_input", {
      issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  return r.data;
}

function eventSource(actor: Actor, source?: TaskSource): TaskEventSource {
  if (actor.type === "system") return "system";
  if (source !== undefined) return source;
  return actor.type === "agent" ? "agent" : "person";
}

async function logEvent(
  tx: Exec, row: TaskRow, act: TaskAct, actor: Actor, source: TaskEventSource, at: Date, detail: Record<string, unknown> = {},
): Promise<void> {
  await (tx as Db).insert(taskEvents).values({
    taskId: row.id, seq: row.version, act, actorType: actor.type, actorId: actor.id, source, at, detail,
  });
}

async function lockTask(tx: Exec, taskId: string): Promise<TaskRow> {
  const row = (await (tx as Db).select().from(tasks).where(eq(tasks.id, taskId)).for("update"))[0];
  if (row === undefined) throw new TaskError("not_found", { taskId });
  return row;
}

function checkVersion(row: TaskRow, version: number | undefined): void {
  if (version !== undefined && version !== row.version) throw new TaskError("stale", { taskId: row.id, version: row.version });
}

const bump = (now: Date) => ({ version: sql`${tasks.version} + 1`, updatedAt: now });

async function update(tx: Exec, id: string, set: PgUpdateSetSource<typeof tasks>, now: Date): Promise<TaskRow> {
  const row = (await (tx as Db).update(tasks).set({ ...set, ...bump(now) }).where(eq(tasks.id, id)).returning())[0];
  if (row === undefined) throw new TaskError("not_found", { taskId: id });
  return row;
}

const tx = <T>(exec: Exec, fn: (t: Tx) => Promise<T>): Promise<T> => (exec as Db).transaction(fn);

/* ═══════════════════════════════ raise ═══════════════════════════════ */

/** `duplicate`: the input's `sourceRef` had already raised this task; nothing was written. */
export type RaiseResult = { task: TaskRow; merged: boolean; duplicate?: boolean };

/**
 * Raise a task. Same kind + same place + an open task raised within ten minutes = MERGED into that
 * task (its `merged_count` grows, a `merged` event says who asked again). A transaction-scoped
 * advisory lock on (kind, place) makes two simultaneous requests merge rather than both insert.
 * A new task is dispatched at once to the least-loaded on-duty worker of its skill, or stays in the pool.
 */
export async function raiseTask(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<RaiseResult> {
  const input = parse(raiseTaskInput, raw);
  const kind = requireTaskKind(input.kind);
  const source = eventSource(actor, input.source);
  return tx(exec, async (t) => {
    const place = input.placeResourceId ?? null;
    // One task per source: the owning module's key decides, exactly, instead of the ten-minute merge window.
    if (input.sourceRef !== undefined) {
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`tasks:source:${input.sourceRef}`}))`);
      const seen = (await t.select().from(tasks).where(eq(tasks.sourceRef, input.sourceRef)).limit(1))[0];
      if (seen !== undefined) return { task: seen, merged: false, duplicate: true };
      if (place !== null) {
        const found = await t.select({ id: resources.id }).from(resources).where(eq(resources.id, place));
        if (found.length === 0) throw new TaskError("unknown_place", { placeResourceId: place });
      }
    } else if (place !== null) {
      const found = await t.select({ id: resources.id }).from(resources).where(eq(resources.id, place));
      if (found.length === 0) throw new TaskError("unknown_place", { placeResourceId: place });
      const patient = input.patientId ?? null;
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`tasks:${kind.kind}:${place}:${patient ?? "-"}`}))`);
      // FOR UPDATE: a task being closed under us is re-read after its commit; if it is no longer open it is
      // not returned, and this request becomes a task of its own instead of a merge into a closed one.
      // The merge key includes the patient (null-safe): a different patient is never the same request.
      const open = (await t.select().from(tasks).where(and(
        eq(tasks.kind, kind.kind),
        eq(tasks.placeResourceId, place),
        sql`${tasks.patientId} is not distinct from ${patient}`,
        inArray(tasks.state, [...OPEN]),
        gte(tasks.createdAt, new Date(now.getTime() - MERGE_WINDOW_MS)),
      )).orderBy(desc(tasks.createdAt)).limit(1).for("update"))[0];
      if (open !== undefined && OPEN.includes(open.state)) {
        const row = await update(t, open.id, { mergedCount: sql`${tasks.mergedCount} + 1` }, now);
        await logEvent(t, row, "merged", actor, source, now, { note: input.note ?? null });
        return { task: row, merged: true };
      }
    }
    const dueAt = input.dueAt !== undefined ? new Date(input.dueAt) : new Date(now.getTime() + kind.doneWithinMin * 60_000);
    const inserted = (await t.insert(tasks).values({
      id: newId(), kind: kind.kind, placeResourceId: place, patientId: input.patientId ?? null,
      priority: input.priority ?? "routine", dueAt, skill: kind.skill, proofNeeded: kind.proofNeeded,
      verifyRequired: kind.verifyRequired, state: "created", note: input.note ?? null,
      requestedBy: actor.id, source: input.source ?? (actor.type === "agent" ? "agent" : "person"),
      createdAt: now, updatedAt: now, version: 1,
      sourceRef: input.sourceRef ?? null, raisedAt: input.raisedAt !== undefined ? new Date(input.raisedAt) : now,
    }).returning())[0]!;
    await logEvent(t, inserted, "raised", actor, source, now, {});
    const dispatched = await dispatchInto(t, inserted, now, []);
    return { task: dispatched ?? inserted, merged: false };
  });
}

/** Offer a pool task to the least-loaded on-duty worker. Null when nobody is on (it stays in the pool). */
export async function dispatchInto(t: Exec, row: TaskRow, now: Date, exclude: readonly string[]): Promise<TaskRow | null> {
  const worker = await pickWorker(t, row.skill, now, exclude);
  if (worker === null) return null;
  const assigned = (await (t as Db).update(tasks).set({
    state: "assigned", assigneeKind: "person", assigneeId: worker.userId, assignedAt: now,
    shiftEndsAt: worker.shiftEndsAt, ...bump(now),
  }).where(and(eq(tasks.id, row.id), eq(tasks.state, "created"), isNull(tasks.assigneeId))).returning())[0];
  if (assigned === undefined) return null;
  await logEvent(t, assigned, "assigned", DISPATCH_ACTOR, "system", now, { to: worker.userId, by: "dispatch" });
  return assigned;
}

export const DISPATCH_ACTOR: Actor = { type: "system", id: "tasks-dispatch" };

/* ═══════════════════════════════ assign (supervisor) ═══════════════════════════════ */

export async function assignTask(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parse(assignTaskInput, raw);
  return tx(exec, async (t) => {
    const row = await lockTask(t, input.taskId);
    checkVersion(row, input.version);
    if (!OPEN.includes(row.state)) throw new TaskError("not_open", { taskId: row.id, state: row.state });
    const worker = (await t.select({ id: users.id, active: users.active }).from(users).where(eq(users.id, input.userId)))[0];
    if (worker === undefined || !worker.active) throw new TaskError("unknown_worker", { userId: input.userId });
    await requireSkill(t, input.userId, row.skill, row.id);
    const duty = await dutyCovering(t, input.userId, now);
    if (duty === null) throw new TaskError("not_on_duty", { taskId: row.id, userId: input.userId });
    const next = await update(t, row.id, {
      state: "assigned", assigneeKind: "person", assigneeId: input.userId, assignedAt: now, shiftEndsAt: duty.endsAt,
    }, now);
    await logEvent(t, next, "assigned", actor, eventSource(actor), now, { to: input.userId, from: row.assigneeId, by: "supervisor" });
    return next;
  });
}

/* ═══════════════════════════════ accept — exactly one wins ═══════════════════════════════ */

/**
 * ONE conditional UPDATE decides: the row moves only while it is still `created` or `assigned` AND
 * unassigned or assigned to the caller. Two workers tapping Accept together: Postgres serialises the
 * two UPDATEs on the row lock, the second re-reads the row after the first commits, its WHERE no
 * longer matches, and it gets `already_taken`. No read-check-write window exists to lose.
 */
export async function acceptTask(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parse(taskRefInput, raw);
  const duty = await dutyCovering(exec, actor.id, now);
  return tx(exec, async (t) => {
    // Only a task this worker could actually take is checked for skill and duty; anything else falls
    // through to the conditional UPDATE, whose refusal (already_taken, not_open …) is the truer answer.
    const seen = (await t.select().from(tasks).where(eq(tasks.id, input.taskId)))[0];
    if (seen !== undefined && ["created", "assigned"].includes(seen.state) && (seen.assigneeId === null || seen.assigneeId === actor.id)) {
      await requireSkill(t, actor.id, seen.skill, seen.id);
      if (duty === null) throw new TaskError("not_on_duty", { taskId: seen.id });
    }
    const won = (await t.update(tasks).set({
      state: "accepted", assigneeKind: "person", assigneeId: actor.id, assignedAt: sql`coalesce(${tasks.assignedAt}, ${now.toISOString()}::timestamptz)`,
      shiftEndsAt: duty?.endsAt ?? null, ...bump(now),
    }).where(and(
      eq(tasks.id, input.taskId),
      inArray(tasks.state, ["created", "assigned"]),
      or(isNull(tasks.assigneeId), and(eq(tasks.assigneeKind, "person"), eq(tasks.assigneeId, actor.id))),
      ...(input.version === undefined ? [] : [eq(tasks.version, input.version)]),
    )).returning())[0];
    if (won !== undefined) {
      await logEvent(t, won, "accepted", actor, eventSource(actor), now, {});
      return won;
    }
    const row = (await t.select().from(tasks).where(eq(tasks.id, input.taskId)))[0];
    if (row === undefined) throw new TaskError("not_found", { taskId: input.taskId });
    if (!OPEN.includes(row.state)) throw new TaskError("not_open", { taskId: row.id, state: row.state });
    if (row.assigneeId !== null && row.assigneeId !== actor.id) throw new TaskError("already_taken", { taskId: row.id });
    if (input.version !== undefined && input.version !== row.version) throw new TaskError("stale", { taskId: row.id });
    throw new TaskError("wrong_state", { taskId: row.id, state: row.state });
  });
}

/* ═══════════════════════════════ start, done ═══════════════════════════════ */

/** The worker must hold one of the roles the task's skill maps to (`skillRoles`). */
async function requireSkill(t: Exec, userId: string, skill: string, taskId: string): Promise<void> {
  if (!(await actorHoldsAnyRole(t as Tx, userId, [...skillRoles(skill)]))) throw new TaskError("wrong_skill", { taskId, skill });
}

function requireMine(row: TaskRow, actor: Actor): void {
  if (row.assigneeKind !== "person" || row.assigneeId !== actor.id) throw new TaskError("not_yours", { taskId: row.id });
}

export async function startTask(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parse(taskRefInput, raw);
  return tx(exec, async (t) => {
    const row = await lockTask(t, input.taskId);
    checkVersion(row, input.version);
    if (!OPEN.includes(row.state)) throw new TaskError("not_open", { taskId: row.id, state: row.state });
    requireMine(row, actor);
    if (row.state !== "accepted") throw new TaskError("wrong_state", { taskId: row.id, state: row.state });
    const next = await update(t, row.id, { state: "in_progress" }, now);
    await logEvent(t, next, "started", actor, eventSource(actor), now, {});
    return next;
  });
}

export async function completeTask(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parse(completeTaskInput, raw);
  return tx(exec, async (t) => {
    const row = await lockTask(t, input.taskId);
    checkVersion(row, input.version);
    if (!OPEN.includes(row.state)) throw new TaskError("not_open", { taskId: row.id, state: row.state });
    requireMine(row, actor);
    if (row.state !== "in_progress") throw new TaskError("wrong_state", { taskId: row.id, state: row.state });
    if (row.proofNeeded !== "none" && (input.proof === undefined || input.proof.kind !== row.proofNeeded)) {
      throw new TaskError("proof_missing", { taskId: row.id, proofNeeded: row.proofNeeded });
    }
    const next = await update(t, row.id, {
      state: "done", proof: (input.proof ?? null) as Record<string, unknown> | null, doneBy: actor.id, doneAt: now,
    }, now);
    await logEvent(t, next, "done", actor, eventSource(actor), now, input.proof === undefined ? {} : { proof: input.proof.kind });
    // The owning module's record of the finished work, in the SAME transaction (maintenance: the ticket is fixed).
    const decl = taskKind(row.kind);
    if (decl?.onDone !== undefined) await decl.onDone(t, next, actor, now);
    return next;
  });
}

/* ═══════════════════════════════ verify ═══════════════════════════════ */

/** The doer never verifies their own task; the verifier holds the kind's permission (default `tasks.supervise`). */
export async function verifyTask(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<TaskRow> {
  const input = parse(taskRefInput, raw);
  return tx(exec, async (t) => {
    const row = await lockTask(t, input.taskId);
    checkVersion(row, input.version);
    if (!row.verifyRequired) throw new TaskError("no_verify_step", { taskId: row.id });
    if (row.state !== "done") throw new TaskError(row.state === "verified" || row.state === "cancelled" ? "not_open" : "wrong_state", { taskId: row.id, state: row.state });
    if (row.doneBy === actor.id) throw new TaskError("verifier_is_doer", { taskId: row.id });
    const decl = taskKind(row.kind);
    const permissions = verifierPermissionsOf(decl);
    if (actor.type !== "system") {
      let admitted = false;
      for (const p of permissions) {
        if (await hasPermission(t as unknown as Db, actor.id, p, "hospital")) { admitted = true; break; }
      }
      if (!admitted) throw new TaskError("not_permitted", { taskId: row.id, permission: permissions.join(" or ") });
    }
    const next = await update(t, row.id, { state: "verified", verifiedBy: actor.id, verifiedAt: now }, now);
    await logEvent(t, next, "verified", actor, eventSource(actor), now, {});
    // The owning module's consequence of a passed check, in the SAME transaction (housekeeping: the bed is free).
    if (decl?.onVerified !== undefined) await decl.onVerified(t, next, actor, now);
    return next;
  });
}

/* ═══════════════════════════════ cancel, return ═══════════════════════════════ */

export async function cancelTask(
  exec: Exec, actor: Actor, raw: unknown, now: Date = new Date(), opts: CancelOptions = {},
): Promise<TaskRow> {
  const input = parse(cancelTaskInput, raw);
  return tx(exec, async (t) => {
    const row = await lockTask(t, input.taskId);
    checkVersion(row, input.version);
    const closable = opts.closeDone === true ? [...OPEN, "done"] : OPEN;
    if (!closable.includes(row.state)) throw new TaskError("not_open", { taskId: row.id, state: row.state });
    const next = await update(t, row.id, { state: "cancelled", cancelReason: input.reason }, now);
    await logEvent(t, next, "cancelled", actor, eventSource(actor), now, { reason: input.reason });
    return next;
  });
}

/**
 * Cancel every open task at a place — for a caller such as "the bed was re-occupied" (spec §2 edge
 * case). Runs inside the caller's transaction when handed one (a savepoint), so the bed act and the
 * cancellations commit together. Returns the cancelled ids.
 */
export async function cancelTasksForPlace(exec: Exec, actor: Actor, raw: unknown, now: Date = new Date()): Promise<string[]> {
  const input = parse(cancelPlaceInput, raw);
  return tx(exec, async (t) => {
    const open = await t.select().from(tasks)
      .where(and(eq(tasks.placeResourceId, input.placeResourceId), inArray(tasks.state, [...OPEN])))
      .for("update");
    const ids: string[] = [];
    for (const row of open) {
      const next = await update(t, row.id, { state: "cancelled", cancelReason: input.reason }, now);
      await logEvent(t, next, "cancelled", actor, eventSource(actor), now, { reason: input.reason, byPlace: true });
      ids.push(row.id);
    }
    return ids;
  });
}

/**
 * Put a held task back in the pool: the worker says they cannot do it, a supervisor takes it back,
 * or the sweep finds the worker's shift over. The assignee is cleared; dispatch offers it again.
 */
export async function returnToPool(
  exec: Exec, actor: Actor, raw: unknown, now: Date = new Date(), opts: ActOptions = {},
): Promise<TaskRow> {
  const input = parse(returnTaskInput, raw);
  return tx(exec, async (t) => {
    const row = await lockTask(t, input.taskId);
    checkVersion(row, input.version);
    if (!OPEN.includes(row.state)) throw new TaskError("not_open", { taskId: row.id, state: row.state });
    if (!HELD.includes(row.state)) throw new TaskError("wrong_state", { taskId: row.id, state: row.state });
    if (opts.asSupervisor !== true && actor.type !== "system") requireMine(row, actor);
    const next = await update(t, row.id, {
      state: "created", assigneeKind: null, assigneeId: null, assignedAt: null, shiftEndsAt: null,
    }, now);
    await logEvent(t, next, "returned", actor, eventSource(actor), now, { from: row.assigneeId, reason: input.reason ?? null });
    return next;
  });
}

export { eventSource };

/** For the sweep: the event writer, so every state change the clock makes carries the same history. */
export { logEvent as appendTaskEvent, update as updateTaskRow, lockTask };
