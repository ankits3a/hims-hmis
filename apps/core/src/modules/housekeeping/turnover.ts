import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { BED_CLEAN_KINDS, HOUSEKEEPING_KINDS, HOUSEKEEPING_TARGET_MIN, OPEN_TASK_STATES } from "@hmis/contracts";
import { events, resourceStatusHistory, resources } from "../../kernel/db/schema";
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
 * The beds module empties a bed through `releaseBedOccupant`: the kernel resource is released into `cleaning`
 * (`resource.released`, status `cleaning`, `reason` `clean:routine` / `clean:terminal`). A block ending into cleaning
 * (`unblockBed`) is a `resource.status_changed` to `cleaning` with the same reasons.
 *
 * EXACTLY ONE CLEAN PER EVENT: the clean carries `sourceRef = resource-event:<seq>` (unique in `tasks`), so a second
 * delivery, a replay or a backfill of the same event returns the first task and writes nothing. The decision is the
 * EVENT's, not the bed's present state: a release always records its clean; if the bed has already moved on when the
 * event is handled (re-occupied, cleaned by hand, blocked), the clean is raised and cancelled at once with the reason,
 * so the record shows the gap (DECIDED, PR #750 review).
 *
 * TERMINAL vs ROUTINE (DECIDED, NABH infection control): the event's reason `clean:terminal` (death, absconded,
 * infection-control and deep-clean blocks) OR an isolation bed. The status history row is read only for an event
 * written before the kernel carried the reason.
 *
 * When the bed LEAVES cleaning other than by its clean being checked — marked clean by hand, blocked, assigned —
 * every clean raised up to that event's instant that is still open OR cleaned-but-unchecked is cancelled.
 */
const CLEAN_TERMINAL = "clean:terminal";

type Subject = { resourceId: string; kind: string };
type Released = Subject & { status: string; reason?: string | null };
type StatusChanged = Subject & { from: string | null; to: string; reason: string | null };

export type TurnoverResult = { raised: TaskRow | null; cancelled: string[] };

async function ipdBed(exec: Db | Tx, bedId: string): Promise<{ status: string; isolation: string } | null> {
  const row = (await (exec as Db).select().from(resources).where(eq(resources.id, bedId)))[0];
  if (row === undefined || row.kind !== "bed") return null;
  const attrs = IpdBedAttributesSchema.safeParse(row.attributes);
  if (!attrs.success) return null; // an OT recovery bay or any other non-IPD bed: not housekeeping's turnover
  return { status: row.status, isolation: attrs.data.isolation };
}

/** Fallback for a release written before the event carried its reason: the history row of that instant. */
async function cleaningReasonAt(exec: Db | Tx, bedId: string, at: Date): Promise<string | null> {
  const row = (await (exec as Db).select({ reason: resourceStatusHistory.reason }).from(resourceStatusHistory)
    .where(and(
      eq(resourceStatusHistory.resourceId, bedId), eq(resourceStatusHistory.toStatus, "cleaning"),
      sql`${resourceStatusHistory.at} = ${at.toISOString()}::timestamptz`,
    ))
    .orderBy(desc(resourceStatusHistory.seq)).limit(1))[0];
  return row?.reason ?? null;
}

function leftCleaningBecause(status: string): string {
  if (status === "occupied") return "Bed re-occupied before cleaning";
  if (status === "available") return "Bed marked clean before the clean was raised";
  if (status === "blocked") return "Bed blocked before cleaning";
  return `Bed ${status} before cleaning`;
}

/**
 * Raise the clean for one move into cleaning: `sourceRef` names it (the event's seq), `at` is when the bed went into
 * cleaning. Returns the new task (cancelled at once when the bed has moved on), or null when the source had already
 * raised one or the bed is not an IPD bed.
 */
export async function raiseBedClean(
  db: Db, bedId: string, source: { sourceRef: string; at: Date; reason: string | null }, now: Date = new Date(),
): Promise<TaskRow | null> {
  return db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`housekeeping:bed:${bedId}`}))`);
    const bed = await ipdBed(t, bedId);
    if (bed === null) return null;
    const terminal = source.reason === CLEAN_TERMINAL || bed.isolation !== "none";
    const kind = terminal ? HOUSEKEEPING_KINDS.terminal : HOUSEKEEPING_KINDS.routine;
    const window = terminal ? HOUSEKEEPING_TARGET_MIN.terminal : HOUSEKEEPING_TARGET_MIN.routine;
    // The turnover clock runs from the bed's release, not from when the worker got to the event.
    const { task, duplicate } = await raiseTask(t, HOUSEKEEPING_ACTOR, {
      kind, placeResourceId: bedId, sourceRef: source.sourceRef, raisedAt: source.at.toISOString(),
      dueAt: new Date(source.at.getTime() + window * 60_000).toISOString(),
    }, now);
    if (duplicate === true) return null;
    if (bed.status === "cleaning") return task;
    return cancelTask(t, HOUSEKEEPING_ACTOR, { taskId: task.id, reason: leftCleaningBecause(bed.status) }, now);
  });
}

/** Cancel the bed's cleans raised up to `at` that are still open or cleaned-but-unchecked: the bed moved on at `at`. */
export async function cancelBedCleans(db: Db, bedId: string, why: string, at: Date, now: Date = new Date()): Promise<string[]> {
  return db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`housekeeping:bed:${bedId}`}))`);
    if ((await ipdBed(t, bedId)) === null) return [];
    const owed = await findTasks(t, {
      kinds: BED_CLEAN_KINDS, placeResourceId: bedId, states: [...OPEN_TASK_STATES, "done"], raisedUntil: at,
    });
    const ids: string[] = [];
    for (const row of owed) {
      await cancelTask(t, HOUSEKEEPING_ACTOR, { taskId: row.id, reason: why }, now, { closeDone: true });
      ids.push(row.id);
    }
    return ids;
  });
}

const sourceOf = (e: DispatchedEvent): string => `resource-event:${String(e.seq)}`;

/** One event, one decision. Exported for the tests, which deliver an event twice. */
export async function handleBedEvent(db: Db, e: DispatchedEvent, now: Date = new Date()): Promise<TurnoverResult> {
  const none: TurnoverResult = { raised: null, cancelled: [] };
  const p = e.payload as Subject;
  if (p?.kind !== "bed" || typeof p.resourceId !== "string") return none;
  if (e.name === resourceReleased.name) {
    const r = p as Released;
    if (r.status !== "cleaning") return none;
    const reason = r.reason !== undefined ? r.reason : await cleaningReasonAt(db, r.resourceId, e.occurredAt);
    return { raised: await raiseBedClean(db, r.resourceId, { sourceRef: sourceOf(e), at: e.occurredAt, reason }, now), cancelled: [] };
  }
  if (e.name === resourceStatusChanged.name) {
    const c = p as StatusChanged;
    if (c.to === "cleaning") {
      return { raised: await raiseBedClean(db, c.resourceId, { sourceRef: sourceOf(e), at: e.occurredAt, reason: c.reason }, now), cancelled: [] };
    }
    if (c.from === "cleaning") {
      const why = c.to === "available" ? "Bed marked clean at the Beds board" : c.to === "blocked" ? "Bed blocked" : `Bed now ${c.to}`;
      return { raised: null, cancelled: await cancelBedCleans(db, c.resourceId, why, e.occurredAt, now) };
    }
    return none;
  }
  if (e.name === resourceAssigned.name) {
    return { raised: null, cancelled: await cancelBedCleans(db, p.resourceId, "Bed re-occupied", e.occurredAt, now) };
  }
  return none;
}

/** The `Handler` `workerConsumers` registers for `housekeeping.bed_turnover`. */
export function bedTurnoverConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => { await handleBedEvent(db, e); };
}

/**
 * THE ONE-TIME BACKFILL (run by `seedCursors`, every deploy, idempotent). Seeding the cursor at `max(seq)` skips the
 * releases before it, so every IPD bed already in `cleaning` with no clean still owed gets one now — keyed on the event
 * that put it there (the same `sourceRef` a late delivery of that event would use), or on the bed and the history
 * instant for a bed whose event predates the registry's events.
 */
export async function backfillBedCleans(db: Db, now: Date = new Date()): Promise<number> {
  const beds = await db.select({ id: resources.id }).from(resources).where(and(eq(resources.kind, "bed"), eq(resources.status, "cleaning")));
  let raised = 0;
  for (const { id } of beds) {
    const owed = await findTasks(db, { kinds: BED_CLEAN_KINDS, placeResourceId: id, states: [...OPEN_TASK_STATES, "done"], limit: 1 });
    if (owed.length > 0) continue;
    const ev = (await db.select().from(events)
      .where(and(eq(events.correlationId, id), inArray(events.name, [resourceReleased.name, resourceStatusChanged.name])))
      .orderBy(desc(events.seq)).limit(5))
      .find((x) => {
        const pl = x.payload as Released & StatusChanged;
        return (x.name === resourceReleased.name && pl.status === "cleaning") || (x.name === resourceStatusChanged.name && pl.to === "cleaning");
      });
    let source: { sourceRef: string; at: Date; reason: string | null };
    if (ev !== undefined) {
      const pl = ev.payload as Released & StatusChanged;
      source = { sourceRef: `resource-event:${String(ev.seq)}`, at: ev.occurredAt, reason: pl.reason ?? (await cleaningReasonAt(db, id, ev.occurredAt)) };
    } else {
      const h = (await db.select().from(resourceStatusHistory)
        .where(and(eq(resourceStatusHistory.resourceId, id), eq(resourceStatusHistory.toStatus, "cleaning")))
        .orderBy(desc(resourceStatusHistory.seq)).limit(1))[0];
      const at = h?.at ?? now;
      source = { sourceRef: `backfill:${id}:${at.toISOString()}`, at, reason: h?.reason ?? null };
    }
    if ((await raiseBedClean(db, id, source, now)) !== null) raised += 1;
  }
  return raised;
}
