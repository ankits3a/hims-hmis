import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// Plan 11a D6/D7/D8 — SIX catalog names across TWO modules, in ONE file, and the pairing is a
// decision rather than an accident (the plan's §2.47 seam resolution).
//
// The four `retention.*` names are the sweep's own record. The two `backup.drill_*` names belong
// to T4's weekly restore drill, which was written one wave BEFORE this file existed and therefore
// ships emitting an exit code and a transcript only; `docker/prod/drill/restore-drill.sh` carries
// a marked seam that this task wires to these two definitions. Defining them here rather than in
// a `kernel/backup/` of their own keeps the count of new event surfaces at one: nothing else in
// the codebase imports a backup event, and a second file holding two definitions would be a
// directory whose whole content is a forward reference.
//
// WHAT IS DELIBERATELY NOT HERE: there is no `retention.swept` per-run event. A nightly job that
// found nothing to do appending a row saying so would add 365 rows a year to the very table this
// job exists to keep prunable — the same reasoning `worker/partitions.ts` records for
// `createEventPartitions` emitting nothing at all. Every name below is appended only when the
// fact it records actually happened.
const RETENTION = "retention";
const BACKUP = "backup";

/**
 * A whole IST month of `events` is gone. THIS IS THE RECORD THAT A LEGAL RECORD WAS DESTROYED, so
 * it carries the row count as well as the month: after the drop nothing else can answer "how much
 * was in it", and the partition's own name is not evidence of its size.
 */
export const partitionDropped = defineEvent(
  "retention.partition_dropped",
  RETENTION,
  z.object({
    partition: z.string().min(1), // events_YYYY_MM
    month: z.string().min(1), // YYYY-MM, IST
    rows: z.number().int(), // counted inside the dropping transaction, immediately before the drop
    retainedMonths: z.number().int(), // the RETENTION_EVENTS_MONTHS window in force for this run
  }),
);

/**
 * A month that was old enough to drop and was NOT dropped, because a hold intersects it. The
 * refusal is evented for the same reason the drop is: "we did not destroy this" is a fact counsel
 * may need, and a silent skip leaves the sweep's inaction indistinguishable from the sweep never
 * having run.
 */
export const dropBlocked = defineEvent(
  "retention.drop_blocked",
  RETENTION,
  z.object({
    partition: z.string().min(1),
    month: z.string().min(1),
    reason: z.enum(["legal_hold_global", "legal_hold_patient"]),
    holdId: z.string().nullable(), // the row in retention_legal_holds that blocked it
  }),
);

/** D7's outbox prune, evented ONCE PER RUN with a COUNT — never one event per deleted row. */
export const notificationsPruned = defineEvent(
  "retention.notifications_pruned",
  RETENTION,
  z.object({
    deleted: z.number().int(),
    batches: z.number().int(),
    retainDays: z.number().int(),
    cutoff: z.string().min(1), // ISO instant: rows with updated_at strictly before it were eligible
  }),
);

/**
 * FD-25 — THE PRINT OUTBOX'S PRUNE, and it is `notificationsPruned`'s twin because the table is
 * `notifications` with a different sink. One event per run with a count, never one per row.
 */
export const printJobsPruned = defineEvent(
  "retention.print_jobs_pruned",
  RETENTION,
  z.object({
    deleted: z.number().int(),
    batches: z.number().int(),
    retainDays: z.number().int(),
    cutoff: z.string().min(1),
  }),
);

/**
 * D6's companion sweep. A partition drop ORPHANS these three tables — measured in the 11a spike,
 * where 3 `event_idempotency` and 3 `event_deliveries` rows survived a drop by design (there are
 * no FKs) — so the same run prunes them behind the same gate and the same window. One event per
 * run with three counts, never one per row.
 */
export const sideTablesPruned = defineEvent(
  "retention.side_tables_pruned",
  RETENTION,
  z.object({
    eventIdempotency: z.number().int(),
    eventDeliveries: z.number().int(),
    eventDeadLetters: z.number().int(),
    retainedMonths: z.number().int(),
    cutoff: z.string().min(1),
  }),
);

/**
 * T4's weekly restore drill, wired at the script's marked T5 SEAM. The payload is the drill's own
 * transcript reduced to the numbers a dashboard can read; every field is nullable because the
 * verdict is emitted from an EXIT TRAP that fires on every path, including a failure before the
 * census was ever taken.
 *
 * `assertedEventId` is the id the drill looked for in the RESTORED cluster — deliberately not
 * named `eventId`, which is the envelope's own column (§10.5: a payload never duplicates an
 * envelope field, and this is a different event's id entirely).
 */
const drillPayload = z.object({
  stanza: z.string().min(1),
  censusEvents: z.number().int().nullable(),
  restoredEvents: z.number().int().nullable(),
  assertedEventId: z.string().nullable(),
  backupSeconds: z.number().int().nullable(),
  restoreSeconds: z.number().int().nullable(),
});

export const backupDrillPassed = defineEvent("backup.drill_passed", BACKUP, drillPayload);
export const backupDrillFailed = defineEvent("backup.drill_failed", BACKUP, drillPayload);
