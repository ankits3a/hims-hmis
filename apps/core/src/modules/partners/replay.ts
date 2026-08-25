import { sql } from "drizzle-orm";
import { ACCRUAL_EVENT_NAMES, commissionAccrualEnabled, handleAccrualEvent } from "./consumer";
import { PartnersError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";

/**
 * DD7's SECOND STEP — THE BACKFILL THAT MAKES "the flag is a flip, not a project" TRUE.
 *
 * The consumer registers always and advances always, so on the day the CA gate opens the hospital
 * has a full `events` history for all four names and an `event_cursors` row that has been moving
 * the whole time. Turning the lane on is then: flip `COMMISSION_ACCRUAL_ENABLED`, run THIS, and
 * the ledger fills in from event history.
 *
 * ═══ IT IS NOT A SECOND IMPLEMENTATION, AND THAT IS THE WHOLE DESIGN ═══
 *
 * `replayAccruals` drives `handleAccrualEvent` — the SAME function the dispatcher drives — from
 * the events table instead of from a subscription bus. That is what makes "flag-on + replay
 * reproduces exactly what live processing would have produced" a property rather than a hope: a
 * backfill written as its own arithmetic would be a second place for DD12 to be wrong, and the
 * two would agree right up until the first credit note.
 *
 * ═══ IT IS ORDER-INDEPENDENT, BUT IT REPLAYS IN ORDER ANYWAY ═══
 *
 * DD12 property 4: pay-then-credit and credit-then-pay converge to the same TOTAL, because every
 * event recomputes the whole invoice. The rows in between still differ, and a ledger a human has
 * to read should tell the same story the hospital lived — so this walks `seq` ascending, which is
 * the dispatcher's own order.
 *
 * ═══ REFUSING WITH THE FLAG OFF IS DELIBERATE ═══
 *
 * `handleAccrualEvent` would return `disabled` for every row and this job would report a clean
 * pass over thousands of events having written nothing. An operator running a backfill and being
 * told it succeeded, when the reason it wrote nothing is that they forgot the flag, is exactly the
 * failure this refusal removes. `accrual_disabled` is T1's own code for it.
 */

export type ReplayCounts = {
  scanned: number;
  appended: number;
  alreadyRecorded: number;
  noDelta: number;
  skipped: number;
  payoutBlocked: number;
  appendedPaise: number;
  lastSeq: number;
};

export type ReplayOptions = {
  /** Exclusive lower bound. Default 0 — the whole history. */
  fromSeq?: number;
  /** Inclusive upper bound, so a replay can be pinned to a window a human can quote. */
  toSeq?: number;
  batchSize?: number;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_BATCH = 200;

type ReplayRow = { seq: number | string; eventId: string; name: string; payload: unknown; patientId: string | null; correlationId: string | null; occurredAt: Date | string };

export async function replayAccruals(db: Db, opts: ReplayOptions = {}): Promise<ReplayCounts> {
  if (!commissionAccrualEnabled(opts.env ?? process.env)) {
    throw new PartnersError(
      "accrual_disabled",
      "COMMISSION_ACCRUAL_ENABLED is off: a replay would walk the whole history and write nothing",
    );
  }
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const toSeq = opts.toSeq ?? null;
  const counts: ReplayCounts = {
    scanned: 0, appended: 0, alreadyRecorded: 0, noDelta: 0, skipped: 0, payoutBlocked: 0,
    appendedPaise: 0, lastSeq: opts.fromSeq ?? 0,
  };
  let cursor = opts.fromSeq ?? 0;

  for (;;) {
    const rows = (await db.execute(sql`
      select seq, event_id as "eventId", name, payload, patient_id as "patientId",
             correlation_id as "correlationId", occurred_at as "occurredAt"
      from events
      where seq > ${cursor}
        and seq <= coalesce(${toSeq}, 9223372036854775807)
        and name = any(${sql.param([...ACCRUAL_EVENT_NAMES])}::text[])
      order by seq asc
      limit ${batchSize}
    `)).rows as unknown as ReplayRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const seq = Number(row.seq);
      cursor = seq;
      counts.scanned += 1;
      counts.lastSeq = seq;
      const event: DispatchedEvent = {
        seq,
        eventId: row.eventId,
        name: row.name,
        payload: row.payload,
        patientId: row.patientId,
        correlationId: row.correlationId,
        occurredAt: new Date(row.occurredAt),
      };
      const result = await handleAccrualEvent(db, event);
      switch (result.outcome) {
        case "appended":
          counts.appended += 1;
          counts.appendedPaise += result.deltaPaise;
          break;
        case "already_recorded":
          counts.alreadyRecorded += 1;
          break;
        case "no_delta":
          counts.noDelta += 1;
          break;
        case "payout_blocked":
          counts.payoutBlocked += 1;
          break;
        default:
          counts.skipped += 1;
          break;
      }
    }
  }
  return counts;
}
