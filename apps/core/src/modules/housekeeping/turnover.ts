import { and, desc, eq, sql } from "drizzle-orm";
import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, HOUSEKEEPING_TARGET_MIN, OPEN_TASK_STATES } from "@hmis/contracts";
import { resourceStatusHistory, resources } from "../../kernel/db/schema";
import { resourceAssigned, resourceReleased, resourceStatusChanged } from "../../kernel/resources";
import { IpdBedAttributesSchema } from "../ipd";
import { cancelTask, findTasks, raiseTask } from "../tasks";
import "./kinds";
import { HOUSEKEEPING_ACTOR } from "./names";
import type { Handler, DispatchedEvent } from "../../kernel/events/subscriptions";
import type { Db, Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * ═══ BED TURNOVER — the bed's own kernel events drive its cleaning ═══
 *
 * The beds module empties a bed through `releaseBedOccupant`, which releases the kernel resource into `cleaning`
 * (`resource.released`, status `cleaning`) and records why in the status history (`clean:routine` /
 * `clean:terminal`). A block ending into cleaning (`unblockBed`) is a `resource.status_changed` to `cleaning` with
 * the same reasons. Either one raises EXACTLY ONE cleaning task for the bed:
 *   · idempotent on the event: a task of a bed-clean kind already raised for this bed since the event's own
 *     instant means the event was seen (a second delivery, a replay) and nothing is raised; the check runs under a
 *     per-bed advisory lock, and the engine's ten-minute merge rule backs it up;
 *   · a bed no longer in `cleaning` when the event is handled (cleaned by hand, blocked, re-occupied) raises nothing.
 *
 * TERMINAL vs ROUTINE (DECIDED, NABH infection control): terminal when the release or unblock said
 * `clean:terminal` (death, absconded, infection-control and deep-clean blocks — ipd-discharge decides at
 * discharge, "organism unknown" defaults to terminal there) OR the bed is an isolation bed (isolation ≠ none).
 *
 * When the bed LEAVES cleaning other than by its clean being checked — marked clean by hand at the Beds board,
 * blocked, assigned — every open bed clean on it is cancelled with the reason. (A checked clean moves the bed to
 * available too; by then its task is verified, not open, so nothing is cancelled.)
 */
const CLEAN_TERMINAL = "clean:terminal";

type Subject = { resourceId: string; kind: string };
type Released = Subject & { status: string };
type StatusChanged = Subject & { from: string | null; to: string; reason: string | null };

export type TurnoverResult = { raised: TaskRow | null; cancelled: string[] };

async function ipdBed(exec: Db | Tx, bedId: string): Promise<{ status: string; isolation: string } | null> {
  const row = (await (exec as Db).select().from(resources).where(eq(resources.id, bedId)))[0];
  if (row === undefined || row.kind !== "bed") return null;
  const attrs = IpdBedAttributesSchema.safeParse(row.attributes);
  if (!attrs.success) return null; // an OT recovery bay or any other non-IPD bed: not housekeeping's turnover
  return { status: row.status, isolation: attrs.data.isolation };
}

/** The reason the bed went into cleaning at this instant (the status history row the release wrote). */
async function cleaningReasonAt(exec: Db | Tx, bedId: string, at: Date): Promise<string | null> {
  const row = (await (exec as Db).select({ reason: resourceStatusHistory.reason }).from(resourceStatusHistory)
    .where(and(
      eq(resourceStatusHistory.resourceId, bedId), eq(resourceStatusHistory.toStatus, "cleaning"),
      sql`${resourceStatusHistory.at} = ${at.toISOString()}::timestamptz`,
    ))
    .orderBy(desc(resourceStatusHistory.seq)).limit(1))[0];
  return row?.reason ?? null;
}

/**
 * Raise the bed's cleaning task for a move into cleaning that happened at `at`. Returns the task, or null when the
 * event was already handled or the bed is no longer waiting to be cleaned.
 */
export async function raiseBedClean(
  db: Db, bedId: string, at: Date, reason: string | null, now: Date = new Date(),
): Promise<TaskRow | null> {
  return db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`housekeeping:bed:${bedId}`}))`);
    const bed = await ipdBed(t, bedId);
    if (bed === null || bed.status !== "cleaning") return null;
    const seen = await findTasks(t, { kinds: BED_CLEAN_KINDS, placeResourceId: bedId, createdSince: at, limit: 1 });
    if (seen.length > 0) return null;
    const terminal = reason === CLEAN_TERMINAL || bed.isolation !== "none";
    const kind = terminal ? HOUSEKEEPING_KINDS.terminal : HOUSEKEEPING_KINDS.routine;
    const window = terminal ? HOUSEKEEPING_TARGET_MIN.terminal : HOUSEKEEPING_TARGET_MIN.routine;
    // The turnover clock runs from the bed's release, not from when the worker got to the event.
    const dueAt = new Date(at.getTime() + window * 60_000).toISOString();
    const { task } = await raiseTask(t, HOUSEKEEPING_ACTOR, { kind, placeResourceId: bedId, dueAt }, now);
    return task;
  });
}

/** Cancel every open bed clean on a bed that is no longer in cleaning. */
export async function cancelBedCleans(db: Db, bedId: string, why: string, now: Date = new Date()): Promise<string[]> {
  return db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`housekeeping:bed:${bedId}`}))`);
    const bed = await ipdBed(t, bedId);
    if (bed === null || bed.status === "cleaning") return [];
    const open = await findTasks(t, { kinds: BED_CLEAN_KINDS, placeResourceId: bedId, states: OPEN_TASK_STATES });
    const ids: string[] = [];
    for (const row of open) {
      await cancelTask(t, HOUSEKEEPING_ACTOR, { taskId: row.id, reason: why }, now);
      ids.push(row.id);
    }
    return ids;
  });
}

/** One event, one decision. Exported for the tests, which deliver an event twice. */
export async function handleBedEvent(db: Db, e: DispatchedEvent, now: Date = new Date()): Promise<TurnoverResult> {
  const none: TurnoverResult = { raised: null, cancelled: [] };
  const p = e.payload as Subject;
  if (p?.kind !== "bed" || typeof p.resourceId !== "string") return none;
  if (e.name === resourceReleased.name) {
    const r = p as Released;
    if (r.status !== "cleaning") return none;
    const reason = await cleaningReasonAt(db, r.resourceId, e.occurredAt);
    return { raised: await raiseBedClean(db, r.resourceId, e.occurredAt, reason, now), cancelled: [] };
  }
  if (e.name === resourceStatusChanged.name) {
    const c = p as StatusChanged;
    if (c.to === "cleaning") return { raised: await raiseBedClean(db, c.resourceId, e.occurredAt, c.reason, now), cancelled: [] };
    if (c.from === "cleaning") {
      const why = c.to === "available" ? "Bed marked clean at the Beds board" : c.to === "blocked" ? "Bed blocked" : `Bed now ${c.to}`;
      return { raised: null, cancelled: await cancelBedCleans(db, c.resourceId, why, now) };
    }
    return none;
  }
  if (e.name === resourceAssigned.name) {
    return { raised: null, cancelled: await cancelBedCleans(db, p.resourceId, "Bed re-occupied", now) };
  }
  return none;
}

/** The `Handler` `workerConsumers` registers for `housekeeping.bed_turnover`. */
export function bedTurnoverConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => { await handleBedEvent(db, e); };
}
