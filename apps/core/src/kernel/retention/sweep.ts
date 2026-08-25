import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import {
  eventDeadLetters,
  eventDeliveries,
  eventIdempotency,
  events,
  notifications,
  retentionLegalHolds,
} from "../db/schema";
import { withTx } from "../db/client";
import type { Db } from "../db/client";
import { appendEvent } from "../events/append";
import { EVENTS_DEFAULT_PARTITION, listEventPartitions } from "../worker/partitions";
import { dropBlocked, notificationsPruned, partitionDropped, sideTablesPruned } from "./events";
import { SEARCH_AUDIT_RETAIN_DAYS, pruneSearchAudit } from "../search/audit";
import { searchAuditPruned } from "../search/events";

// RETENTION (Plan 11a D6/D7). THIS FILE DESTROYS CLINICAL RECORDS, and every guard below is
// therefore written to fail CLOSED — the sweep does nothing at all unless it is switched on, and
// it refuses a drop on the first sign of a reason not to.
//
// THE MECHANISM SHIPS INERT (Global Constraint 5, owner ruling 6). `RETENTION_ENABLED` defaults
// to false in config.ts AND `enabled` defaults to false here, so a caller that forgets to thread
// the key gets the safe answer rather than the configured one. Flipping either default, or
// weakening the hold check, is on the plan's HALT list: it is the owner's decision with a value
// counsel has signed, not a judgement any task makes.
//
// A LEGAL HOLD GOVERNS EVERY LEG THAT TOUCHES A PATIENT'S EVENT RECORD, not just the partition
// drop. It did not, once (gate report §7.2): the hold saved the month's `events` and the same run
// deleted that month's idempotency, delivery and dead-letter rows, so the record survived and the
// account of what was done with it did not. `activeGlobalHold` and `companionSweepCutoff` are the
// two halves of the repair, and they read the SAME rows `blockingHold` reads for the same reason.
// The `notifications` prune (step 3) is deliberately NOT governed by holds — it is a different
// window on a different table and is not patient-event-scoped; see the note above step 3.
//
// EVENTS GO BY PARTITION, NOTIFICATIONS BY ROW, and that asymmetry is the whole point of D5's
// partitioning: dropping a month of `events` is one DDL statement against the retention unit,
// while `notifications` is an ordinary heap whose terminal rows are deleted in bounded batches on
// the index T2 shipped for exactly this predicate.

/** IST is a fixed UTC+05:30 design-law constant (no DST) — the same fact `scheduler.ts:67` and
 * `worker/partitions.ts` each keep locally rather than importing, for the same reason: one
 * constant is not a dependency, and `partitions.ts`'s copy is module-private besides. */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const RETENTION_ACTOR: Actor = { type: "system", id: "retention-sweep" };

/**
 * THE INERT DEFAULT, AND IT IS NOT A MIRROR OF THE ZOD DEFAULT (the `NOTIFY_STUCK_AFTER_MS` scar,
 * pump.ts:56-60): production reaches this function through `registerAllJobs`, which threads
 * `cfg.retentionEnabled`, so this value is what a DIRECT caller — a test, a script — gets when it
 * says nothing. It is `false` because the safe answer to "should I delete records?" asked by
 * someone who did not think about it is no.
 */
const DEFAULT_ENABLED = false;
/** D6's conservative window: ten years of events, in months. */
const DEFAULT_EVENTS_MONTHS = 120;
/** D7: half a year of terminal outbox rows. */
const DEFAULT_NOTIFY_RETAIN_DAYS = 180;
const DEFAULT_BATCH_SIZE = 500;
/**
 * The prune is bounded in BOTH directions: `batchSize` rows per statement, and no more than this
 * many statements per run. A nightly job that finds a million-row backlog takes it down over
 * several nights instead of holding one transaction open for minutes — and a loop that somehow
 * stopped making progress stops here rather than spinning.
 */
const MAX_NOTIFY_BATCHES = 100;
/**
 * THE CURRENT AND ADJACENT MONTHS ARE NEVER DROPPED, REGARDLESS OF CONFIGURATION (D6). This is
 * the guard that does not consult `eventsMonths` at all: a misconfigured window of 0 or 1 month
 * cannot reach the month live traffic is being written into, nor the one it was written into
 * yesterday. Future months (a partition created ahead by `createEventPartitions`) fall out of the
 * same comparison, because their distance from the current month is negative.
 */
const MIN_RETAINED_MONTHS = 1;

/** D7's terminal set. `queued` and `sending` are ABSENT and must stay absent — Global Constraint
 * 6: a `sending` row is the only record that a message may already be with a patient. */
const TERMINAL_NOTIFICATION_STATUSES = ["sent", "expired", "suppressed", "undeliverable"];
/** D6's mirror of the same rule one table over: a `retrying` delivery is never touched at any
 * age, because it is still owed to a consumer. */
const PRUNABLE_DELIVERY_STATUSES = ["done", "parked"];

/** `events_YYYY_MM`, and nothing else is ever dropped: a partition whose name this does not match
 * is one this codebase did not create, so retention leaves it exactly where it is. */
const PARTITION_NAME_RE = /^events_(\d{4})_(\d{2})$/;

export type RetentionSweepOptions = {
  /** Global Constraint 5. Defaults to FALSE here as well as in config. */
  enabled?: boolean;
  eventsMonths?: number;
  notifyRetainDays?: number;
  /** PLAN 11h T5 / DD4 — the search access log's own window, independent of the events window. */
  searchAuditRetainDays?: number;
  batchSize?: number;
  /** Global Constraint 11: the clock is a parameter, never read from the wall inside a branch. */
  now?: Date;
};

export type RetentionSweepResult = {
  /** Partitions dropped, in the order they were dropped. */
  dropped: string[];
  /** Partitions old enough to drop that a hold saved. */
  blocked: string[];
  notificationsDeleted: number;
  idempotencyDeleted: number;
  deliveriesDeleted: number;
  deadLettersDeleted: number;
  searchAuditDeleted: number;
};

const inert = (): RetentionSweepResult => ({
  dropped: [],
  blocked: [],
  notificationsDeleted: 0,
  idempotencyDeleted: 0,
  deliveriesDeleted: 0,
  deadLettersDeleted: 0,
  searchAuditDeleted: 0,
});

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Months since year 0, so month arithmetic is subtraction and a year rollover is not a case. */
const monthIndexOf = (year: number, month1: number): number => year * 12 + (month1 - 1);

/** The IST month `now` falls in, as a month index. */
function istMonthIndex(now: Date): number {
  const ist = new Date(now.getTime() + IST_OFFSET_MS); // read with getUTC* below: IST wall clock
  return monthIndexOf(ist.getUTCFullYear(), ist.getUTCMonth() + 1);
}

/** Midnight on the 1st of that month IN IST, as an instant — `worker/partitions.ts` writes the
 * same boundary as a string for a DDL bound; a sweep BINDS it, which is what keeps partition
 * pruning at PLAN time rather than execution time (T2's gate measurement of flag ③). */
function istMonthStart(index: number): Date {
  return new Date(`${Math.floor(index / 12)}-${pad2((index % 12) + 1)}-01T00:00:00+05:30`);
}

const monthLabel = (index: number): string => `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;

function partitionMonthIndex(name: string): number | null {
  const m = PARTITION_NAME_RE.exec(name);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return monthIndexOf(Number(m[1]), month);
}

type Blocker = { reason: "legal_hold_global" | "legal_hold_patient"; holdId: string | null };

/**
 * THE ACTIVE GLOBAL HOLD, if any — ONE query with TWO consumers: the partition loop (through
 * `blockingHold`) and the companion sweep (through `companionSweepCutoff`).
 *
 * It is a named function rather than the same four-line `where` written twice on purpose. Two
 * copies of this predicate is EXACTLY how the events partitions came to be protected while the
 * side tables were not (gate report §7.2): the hold rule lived at one call site, the second leg
 * of the sweep never asked, and the two could not be seen to disagree because there was nothing
 * to compare. One function cannot drift from itself.
 */
async function activeGlobalHold(db: Db): Promise<string | null> {
  const [hold] = await db
    .select({ id: retentionLegalHolds.id })
    .from(retentionLegalHolds)
    .where(and(isNull(retentionLegalHolds.releasedAt), isNull(retentionLegalHolds.patientId)))
    .limit(1);
  return hold?.id ?? null;
}

/**
 * A HOLD IS A ROW, NOT A CONFIG FLAG (D6), and this is the query that makes it structural. Two
 * shapes, both read from `retention_legal_holds` with `released_at is null`:
 *   · a GLOBAL hold (`patient_id` null) holds every month for everyone — litigation's actual
 *     shape ("preserve everything from this period");
 *   · a PATIENT hold holds any month containing an event of that patient.
 * The patient leg joins the partition's own rows through the parent with BOUND month bounds, so
 * the planner prunes to the one partition (T2-GATE-1: a bound value folds to a Const, a `now()`
 * computed inside the statement does not).
 */
async function blockingHold(db: Db, from: Date, to: Date): Promise<Blocker | null> {
  const globalHoldId = await activeGlobalHold(db);
  if (globalHoldId !== null) return { reason: "legal_hold_global", holdId: globalHoldId };

  const [patient] = await db
    .select({ id: retentionLegalHolds.id })
    .from(events)
    .innerJoin(retentionLegalHolds, eq(retentionLegalHolds.patientId, events.patientId))
    .where(
      and(
        gte(events.recordedAt, from),
        lt(events.recordedAt, to),
        isNull(retentionLegalHolds.releasedAt),
        isNotNull(retentionLegalHolds.patientId),
      ),
    )
    .limit(1);
  if (patient) return { reason: "legal_hold_patient", holdId: patient.id };

  return null;
}

/**
 * THE HOLD FLOOR FOR THE COMPANION SWEEP (gate report §7.2). A hold used to save the events
 * partition while the SAME RUN deleted that month's delivery, idempotency and dead-letter trail —
 * the partition survived, `retention.drop_blocked` was evented, and the record of who was told
 * what about that month went anyway. This is the query that closes it.
 *
 * The contract: **no side-table row at or after the returned instant is deleted.**
 *   · `null` — a GLOBAL hold is active, and the companion sweep deletes NOTHING at all. That is
 *     the correct reading of "preserve everything from this period": a delivery trail is part of
 *     everything, and a global hold blocks every candidate month anyway, so the honest form of
 *     the clamp is a no-op rather than an instant.
 *   · a Date — `cutoff` unchanged when no active patient hold reaches back past it (the
 *     unheld-estate case, and the one V12 measures), and otherwise the IST MONTH START of the
 *     oldest held event, because the month is the retention unit (D5): a held month keeps its
 *     trail from the first of the month, not from the instant of one event inside it.
 *
 * WHY THIS IS A QUERY AND NOT THE PARTITION LOOP'S `blocked` LIST, which is the shorter fix and
 * was the first design considered: the loop only ever asks about months that have a NAMED
 * `events_YYYY_MM` partition AND are drop-eligible. Two real months escape it — a month whose
 * rows landed in the DEFAULT partition (never listed, never dropped, so never asked about) and a
 * month older than the oldest surviving partition that still has side-table rows of its own. A
 * global hold with no drop-eligible partition at all escapes it too, and leaves `blocked` empty
 * while the sweep deletes on the raw cutoff. Under a hold, every one of those is the same defect
 * one case narrower. Reading the holds directly cannot miss a month.
 *
 * It cannot be defeated by the drops that ran first, either: a partition containing an event of a
 * held patient is blocked, never dropped, so no drop above can have removed the evidence this
 * reads. (`blocked` is therefore always a SUBSET of what this protects, never a superset.)
 */
async function companionSweepCutoff(db: Db, cutoff: Date): Promise<Date | null> {
  if ((await activeGlobalHold(db)) !== null) return null;

  // Only rows OLDER than `cutoff` are candidates for deletion at all, so only a held event older
  // than `cutoff` can move the floor — and bounding the scan here keeps it off the live months.
  const [oldest] = await db
    .select({ recordedAt: events.recordedAt })
    .from(events)
    .innerJoin(retentionLegalHolds, eq(retentionLegalHolds.patientId, events.patientId))
    .where(
      and(
        lt(events.recordedAt, cutoff),
        isNull(retentionLegalHolds.releasedAt),
        isNotNull(retentionLegalHolds.patientId),
      ),
    )
    .orderBy(asc(events.recordedAt))
    .limit(1);
  if (!oldest) return cutoff;

  // Strictly earlier than `cutoff` by construction: the event is older than `cutoff`, `cutoff` is
  // itself an IST month start, so the month containing the event starts before it.
  return istMonthStart(istMonthIndex(oldest.recordedAt));
}

const rowsAffected = (result: { rowCount: number | null }): number => result.rowCount ?? 0;

/**
 * `retentionSweep` — the NINTH job on the clock, a `dailyIst` registration at 01:15 IST
 * (`RETENTION_SWEEP_IST` in `worker/jobs.ts`).
 *
 * Order is deliberate: partitions first, then the side tables the partitions orphan, then the
 * outbox. A partition drop is the only irreversible step, and everything after it is a delete of
 * rows whose event is already gone.
 *
 * IDEMPOTENT AND SAFE TO RUN TWICE: every step is a delete or a drop of things outside the
 * window, so a second run in the same night finds nothing left to do and appends nothing.
 */
export async function retentionSweep(
  db: Db,
  opts: RetentionSweepOptions = {},
): Promise<RetentionSweepResult> {
  const enabled = opts.enabled ?? DEFAULT_ENABLED;
  // GLOBAL CONSTRAINT 5 — THE INERT GATE, and it is the first statement in the function on
  // purpose: disabled means NO drop, NO delete and NO event, not "a run that happens to find
  // nothing". Nothing below this line executes, so nothing below it can be got wrong by a
  // configuration that has not been signed off.
  if (!enabled) return inert();

  const now = opts.now ?? new Date();
  const eventsMonths = opts.eventsMonths ?? DEFAULT_EVENTS_MONTHS;
  const notifyRetainDays = opts.notifyRetainDays ?? DEFAULT_NOTIFY_RETAIN_DAYS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const currentMonth = istMonthIndex(now);
  /** The oldest month INSIDE the window. Everything strictly older is eligible — which makes the
   * events window and the side-table window one number rather than two that can drift. */
  const oldestRetainedMonth = currentMonth - eventsMonths;
  const cutoff = istMonthStart(oldestRetainedMonth);

  const result = inert();

  // ---------------------------------------------------------------------------------------------
  // 1. Partitions — DROPPED WHOLE, never deleted row by row (D6).
  // ---------------------------------------------------------------------------------------------
  for (const name of await listEventPartitions(db)) {
    // `listEventPartitions` already excludes it; said again here because the consequence of
    // getting it wrong is not a lost month but a FAILED INSERT on the hospital's write path for
    // every row whose month nobody pre-created (worker/partitions.ts).
    if (name === EVENTS_DEFAULT_PARTITION) continue;
    const index = partitionMonthIndex(name);
    if (index === null) continue;
    if (currentMonth - index <= MIN_RETAINED_MONTHS) continue; // regardless of configuration
    if (index >= oldestRetainedMonth) continue; // inside the retention window

    const from = istMonthStart(index);
    const to = istMonthStart(index + 1);

    const blocker = await blockingHold(db, from, to);
    if (blocker) {
      await withTx(db, (tx) =>
        appendEvent(
          tx,
          dropBlocked.make({
            actor: RETENTION_ACTOR,
            payload: {
              partition: name,
              month: monthLabel(index),
              reason: blocker.reason,
              holdId: blocker.holdId,
            },
          }),
        ),
      );
      result.blocked.push(name);
      continue;
    }

    const [counted] = await db
      .select({ rows: sql<number>`count(*)::int` })
      .from(events)
      .where(and(gte(events.recordedAt, from), lt(events.recordedAt, to)));

    // ONE TRANSACTION, so a month is never destroyed without the record of its destruction. The
    // DROP takes ACCESS EXCLUSIVE on the parent and the append then writes into the CURRENT
    // month's partition under that same lock — which is safe, and is one more reason this job
    // runs at 01:15 IST rather than during a clinic.
    await withTx(db, async (tx) => {
      // `name` came from pg_class and has just been matched against `^events_\d{4}_\d{2}$`, so
      // nothing a caller supplies can reach this statement text. A partition bound cannot be a
      // parameter and neither can an identifier, which is why this is `sql.raw` at all.
      await tx.execute(sql.raw(`drop table "${name}"`));
      await appendEvent(
        tx,
        partitionDropped.make({
          actor: RETENTION_ACTOR,
          payload: {
            partition: name,
            month: monthLabel(index),
            rows: counted?.rows ?? 0,
            retainedMonths: eventsMonths,
          },
        }),
      );
    });
    result.dropped.push(name);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. THE COMPANION SWEEP (D6, from the spike's finding 3) — the three side tables a partition
  //    drop ORPHANS. There are no FKs from any of them into `events` (a recorded trade in
  //    schema/worker.ts), so a dropped month leaves their rows behind and moves the growth
  //    problem one table over. Same gate, same window and — since §7.2 — THE SAME HOLDS as the
  //    drops above, which is the whole of the fix: `sideCutoff` is `cutoff` clamped back to the
  //    start of the oldest held month, or `null` when a global hold makes the whole leg a no-op.
  //    A held month keeps its delivery trail, not just its events.
  //
  //    STATED CONSEQUENCE, ACCEPTED BY THE PLAN: deleting an `event_idempotency` row older than
  //    the window re-opens semantic dedup for a key whose event no longer exists. That is
  //    consistent — the event it deduplicated is gone — and it is said out loud rather than
  //    discovered later. Under a hold the event is NOT gone, which is the other half of why the
  //    clamp belongs here.
  // ---------------------------------------------------------------------------------------------
  const sideCutoff = await companionSweepCutoff(db, cutoff);
  if (sideCutoff !== null) {
    result.idempotencyDeleted = rowsAffected(
      await db.delete(eventIdempotency).where(lt(eventIdempotency.recordedAt, sideCutoff)),
    );
    // `retrying` IS NOT IN `PRUNABLE_DELIVERY_STATUSES` AND MUST NOT BE: it is a delivery still
    // owed to a consumer, and its age says only that it has been failing for a long time.
    result.deliveriesDeleted = rowsAffected(
      await db
        .delete(eventDeliveries)
        .where(
          and(
            lt(eventDeliveries.updatedAt, sideCutoff),
            inArray(eventDeliveries.status, PRUNABLE_DELIVERY_STATUSES),
          ),
        ),
    );
    result.deadLettersDeleted = rowsAffected(
      await db.delete(eventDeadLetters).where(lt(eventDeadLetters.parkedAt, sideCutoff)),
    );

    const sideTotal =
      result.idempotencyDeleted + result.deliveriesDeleted + result.deadLettersDeleted;
    if (sideTotal > 0) {
      await withTx(db, (tx) =>
        appendEvent(
          tx,
          sideTablesPruned.make({
            actor: RETENTION_ACTOR,
            payload: {
              eventIdempotency: result.idempotencyDeleted,
              eventDeliveries: result.deliveriesDeleted,
              eventDeadLetters: result.deadLettersDeleted,
              retainedMonths: eventsMonths,
              // The instant ACTUALLY used, so a hold that moved it is visible in the event
              // stream rather than inferable only from the counts.
              cutoff: sideCutoff.toISOString(),
            },
          }),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 2b. THE SEARCH ACCESS LOG (Plan 11h T5 / DD4) — its own window, and NOT hold-clamped.
  //
  // `search_audit` keeps its own retention (90 days by default) because it is telemetry with a
  // legal purpose, not a clinical record: tying it to `RETENTION_EVENTS_MONTHS` (120 months) would
  // keep every desk's keystrokes for a decade, and tying the events window to 90 days would
  // destroy the medico-legal record. Two purposes, two numbers, stated once each.
  //
  // IT IS DELIBERATELY NOT CLAMPED BY `companionSweepCutoff`, and that absence is reasoned rather
  // than forgotten: `retention_legal_holds` is keyed on `patient_id`, and a search-audit row
  // references no patient — it holds a query STRING and per-entity counts. "Does a hold on patient
  // X cover the fact that somebody typed 'sharma'?" has no answer this code could compute, so a
  // hold check here would be one that always passes, which is worse than none because it would
  // read like protection. If access logs must ever survive a hold, the hold model grows an
  // actor/time window first — an owner ruling, recorded in the phase document, not invented here.
  //
  // Destroying it IS evented, for the reason `partitionDropped` carries: after the delete nothing
  // else can say how much was in it.
  // ---------------------------------------------------------------------------------------------
  {
    const retainDays = opts.searchAuditRetainDays ?? SEARCH_AUDIT_RETAIN_DAYS;
    /**
     * IT LOOPS, LIKE THE NOTIFICATIONS LEG BELOW, AND THE FIRST VERSION DID NOT — found by the
     * phase's independent reviewer (MAJOR 3).
     *
     * A single `batchSize` (500) statement per nightly sweep cannot keep a 90-day window: twenty
     * desks at sixty palette searches a day is ~1,200 rows, and the palette debounces at 200 ms so
     * one lookup is often several rows. Deleting 500 while adding 1,200 accumulates ~700/day
     * FOREVER, and this table holds `raw_query` — typed patient names. The retention promise DD4
     * makes to DPDP and NABH would have been silently unkept, and the table would have become
     * exactly the second copy of PHI it was designed not to be.
     *
     * The same `MAX_*_BATCHES` ceiling as notifications, for the same reason: a sweep must end.
     */
    let searchBatches = 0;
    while (searchBatches < MAX_NOTIFY_BATCHES) {
      const removed = await pruneSearchAudit(db, { retainDays, batchSize, now });
      result.searchAuditDeleted += removed;
      searchBatches += 1;
      if (removed < batchSize) break; // the window is clear
    }
    if (result.searchAuditDeleted > 0) {
      await withTx(db, (tx) =>
        appendEvent(
          tx,
          searchAuditPruned.make({
            actor: RETENTION_ACTOR,
            payload: {
              rows: result.searchAuditDeleted,
              retainDays,
              cutoff: new Date(now.getTime() - retainDays * 24 * 60 * 60 * 1000).toISOString(),
            },
          }),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 3. `notifications` — TERMINAL ROWS ONLY, in bounded batches (D7).
  //
  //    GLOBAL CONSTRAINT 6: `queued` and `sending` are never pruned at any age. A `queued` row is
  //    a message still owed to a patient; a `sending` row is the only record that a message may
  //    ALREADY BE WITH ONE. Neither becomes safe to delete by getting old.
  //
  //    The predicate is `(status, updated_at)` in that order, which is T2's prune index (added to
  //    schema/notifications.ts for exactly this statement) rather than the pump's claim index.
  //
  //    AND IT IS NOT GOVERNED BY A LEGAL HOLD, deliberately. `NOTIFY_RETAIN_DAYS` is a different
  //    window on a different table, and the outbox is not the patient event record a hold
  //    preserves: it is the messaging side-effect of one. Whether a GLOBAL hold ought to suspend
  //    it as well is a question for counsel and the owner, not for this function — it is booked
  //    as a recommendation, not implemented here, and the shape of the change if it is ever taken
  //    is one more `activeGlobalHold` check guarding this loop.
  // ---------------------------------------------------------------------------------------------
  const notifyCutoff = new Date(now.getTime() - notifyRetainDays * DAY_MS);
  let batches = 0;
  while (batches < MAX_NOTIFY_BATCHES) {
    const doomed = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          inArray(notifications.status, TERMINAL_NOTIFICATION_STATUSES),
          lt(notifications.updatedAt, notifyCutoff),
        ),
      )
      .limit(batchSize);
    if (doomed.length === 0) break;
    await db.delete(notifications).where(
      inArray(notifications.id, doomed.map((r) => r.id)),
    );
    result.notificationsDeleted += doomed.length;
    batches += 1;
    if (doomed.length < batchSize) break;
  }

  if (result.notificationsDeleted > 0) {
    await withTx(db, (tx) =>
      appendEvent(
        tx,
        notificationsPruned.make({
          actor: RETENTION_ACTOR,
          payload: {
            deleted: result.notificationsDeleted,
            batches,
            retainDays: notifyRetainDays,
            cutoff: notifyCutoff.toISOString(),
          },
        }),
      ),
    );
  }

  return result;
}
