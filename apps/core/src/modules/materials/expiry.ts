import { and, eq, gt, sql } from "drizzle-orm";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { stockBalances, stockBatches } from "../../kernel/db/schema";
import { EXPIRY_THRESHOLD_DAYS } from "./config";
import { batchExpiring } from "./events";
import { daysBetween } from "./qc";
import { istDay } from "./grn";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 14 T8 / DD14 — **THE EXPIRY SWEEP: an EVENT AND A WORKLIST, deliberately NOT AN ALERT.**
 *
 * ═══ WHY NOT AN ALERT, STATED SO IT READS AS A CHOICE ═══
 *
 * The alerts consumer routes THREE event kinds (`kernel/alerts/consumer.ts`: escalation, manual
 * notify, operating mode) and the alerts manifest subscribes to `escalation.triggered` alone.
 * Adding a fourth is a kernel change this phase has no ruling for. Doc 09 §9's Expiry Watchman
 * names its own fail-open path — *"reports still queryable"* — and that is `GET /materials/expiring`,
 * which is what ships. §10.3's "structure everywhere, alerts selective", and 11g's
 * record-only-at-go-live posture.
 *
 * ═══ IDEMPOTENT PER `(BATCH, THRESHOLD)`, NOT PER RUN ═══
 *
 * `stock_batches.expiry_notified_thresholds` is a JSONB array of the day-thresholds already
 * announced for that batch. A daily job that re-emitted at 90 days every morning for a month is a
 * job an operator mutes — and a muted expiry watch is worse than none, because it looks like it is
 * working. The claim and the emit happen in ONE transaction per batch, so a crash between them
 * re-announces rather than losing the announcement.
 *
 * ═══ ONLY BATCHES WITH STOCK SOMEWHERE ═══
 *
 * A batch at zero on-hand everywhere has nothing to expire. Announcing it would fill the worklist
 * with rows a storekeeper can do nothing about, which is the same muting problem one step out.
 *
 * ═══ THE THRESHOLDS ARE DESCENDING, AND THAT IS LOAD-BEARING ═══
 *
 * `[90, 60, 30]`. The sweep takes the FIRST threshold a batch has crossed and not yet been notified
 * for, so a batch that first appears with 40 days left announces 60 — the tightest bound it has
 * actually crossed — rather than 90, which would read as "plenty of time" for something inside six
 * weeks. It announces at most ONE threshold per batch per run; the next run picks up 30.
 */

export type ExpiringBatch = {
  batchId: string;
  itemId: string;
  batchNo: string;
  expiryDate: string;
  daysRemaining: number;
  qtyOnHandTotal: number;
};

/**
 * Every batch with stock somewhere and a dated expiry, with its total on-hand. The read behind
 * `GET /materials/expiring` and the input the sweep walks.
 *
 * `withinDays` is a ceiling on the residual life, so the worklist shows what is CLOSE rather than
 * everything that will ever expire. A batch already past its date is included (negative remaining):
 * expired stock on a shelf is the most urgent row in the list, not an excluded one.
 */
export async function expiringBatches(
  db: Db | Tx,
  now: Date,
  // The widest threshold, widened to a plain `number` so a caller may narrow it. The `as const`
  // on `EXPIRY_THRESHOLD_DAYS` makes its members literal types, which would otherwise make this
  // parameter accept only the literal 90.
  withinDays: number = EXPIRY_THRESHOLD_DAYS[0],
): Promise<ExpiringBatch[]> {
  /**
   * CLOSE REVIEW m2 — **IST, not UTC.** This was `now.toISOString().slice(0, 10)`, so between 00:00
   * and 05:30 IST "today" was YESTERDAY and every `daysRemaining` — and therefore every threshold
   * band — was off by one. The `ist-clock-parity` census could not see it, because the defect was
   * not a hand-rolled offset but the ABSENCE of one; a census of copies cannot count omissions.
   */
  const today = istDay(now);
  const rows = await db.select({
    batchId: stockBatches.id,
    itemId: stockBatches.itemId,
    batchNo: stockBatches.batchNo,
    expiryDate: stockBatches.expiryDate,
    qtyOnHandTotal: sql<number>`coalesce(sum(${stockBalances.qtyOnHand}), 0)::int`,
  })
    .from(stockBatches)
    .innerJoin(stockBalances, eq(stockBalances.batchId, stockBatches.id))
    .where(and(
      sql`${stockBatches.expiryDate} is not null`,
      // `::int` is REQUIRED, not decorative: a bare parameter beside a `date` is `unknown` to
      // Postgres and `date + unknown` is ambiguous ("operator is not unique"). Found by execution.
      sql`${stockBatches.expiryDate} <= (${today}::date + ${withinDays}::int)`,
    ))
    .groupBy(stockBatches.id, stockBatches.itemId, stockBatches.batchNo, stockBatches.expiryDate)
    .having(gt(sql`coalesce(sum(${stockBalances.qtyOnHand}), 0)`, 0));

  return rows
    .filter((r) => r.expiryDate !== null)
    .map((r) => ({
      batchId: r.batchId, itemId: r.itemId, batchNo: r.batchNo,
      expiryDate: r.expiryDate as string,
      daysRemaining: daysBetween(today, r.expiryDate as string),
      qtyOnHandTotal: r.qtyOnHandTotal,
    }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * The threshold to announce for a batch: the TIGHTEST one it has crossed and not yet been notified
 * for, or `null` when there is nothing to say.
 *
 * Ascending scan over a descending list is what produces "tightest": `[90, 60, 30]` reversed is
 * `[30, 60, 90]`, and the first one the batch is inside is the tightest bound it has crossed.
 *
 * ═══ A WIDER BAND AFTER A TIGHTER ONE IS MOOT, AND SAYING IT WOULD BE WORSE THAN SILENCE ═══
 *
 * **Found by execution.** A batch 40 days out has crossed BOTH 90 and 60. The first sweep correctly
 * announces 60. Without the guard below, the SECOND sweep then announced 90 — because 90 was still
 * "crossed and not yet announced" — and the worklist told a storekeeper "ninety days" about
 * something with six weeks left. Announcing a band you have already gone past is not merely noise;
 * it is *reassuring* noise, which is the failure mode this whole mechanism exists to avoid.
 *
 * So: once a batch has been announced at some band, every WIDER band is closed for it for ever. The
 * rule is "crossing a band implies having crossed all wider ones", enforced here rather than by
 * writing the implied set into the row — one place, and the stored array stays a record of what was
 * actually SAID rather than of what was implied.
 */
export function thresholdToAnnounce(daysRemaining: number, alreadyNotified: readonly number[]): number | null {
  const ascending = [...EXPIRY_THRESHOLD_DAYS].sort((a, b) => a - b);
  const tightestAnnounced = alreadyNotified.length > 0 ? Math.min(...alreadyNotified) : Number.POSITIVE_INFINITY;
  for (const t of ascending) {
    // Wider than something already said → moot, and everything after it is wider still.
    if (t >= tightestAnnounced) return null;
    if (daysRemaining <= t && !alreadyNotified.includes(t)) return t;
  }
  return null;
}

/**
 * `dailyIst("06:30")` — the `sweepAppointmentNoShows` shape (`jobs.ts:176`).
 *
 * 06:30 IST because a storekeeper reads the worklist at the start of a shift, and an event emitted
 * at midnight would sit unread for seven hours while the batch got a day closer.
 *
 * Returns what it announced so the job's own log line is a count rather than a silence.
 */
export async function sweepBatchExpiry(
  db: Db,
  now: Date,
): Promise<{ announced: { batchId: string; thresholdDays: number }[] }> {
  const candidates = await expiringBatches(db, now);
  const announced: { batchId: string; thresholdDays: number }[] = [];

  for (const c of candidates) {
    // ONE TRANSACTION PER BATCH: the claim and the emit move together, and a failure on one batch
    // does not lose the announcements already made for the others.
    const result = await withTx(db, async (tx) => {
      // Re-read INSIDE the transaction and lock the row, so two workers cannot both announce.
      await tx.execute(sql`select id from stock_batches where id = ${c.batchId} for update`);
      const rows = await tx.select().from(stockBatches).where(eq(stockBatches.id, c.batchId));
      const batch = rows[0];
      if (batch === undefined) return null;

      const notified = Array.isArray(batch.expiryNotifiedThresholds) ? batch.expiryNotifiedThresholds : [];
      const threshold = thresholdToAnnounce(c.daysRemaining, notified);
      if (threshold === null) return null;

      await tx.update(stockBatches)
        .set({ expiryNotifiedThresholds: [...notified, threshold] })
        .where(eq(stockBatches.id, c.batchId));

      await appendEvent(tx, batchExpiring.make({
        payload: {
          batchId: c.batchId, itemId: c.itemId, batchNo: c.batchNo,
          expiryDate: c.expiryDate, thresholdDays: threshold, qtyOnHandTotal: c.qtyOnHandTotal,
        },
        // A sweep has no human actor — the `sweepAppointmentNoShows` convention.
        actor: { type: "system", id: "materials-expiry-sweep" },
        correlationId: c.batchId,
      }));
      return { batchId: c.batchId, thresholdDays: threshold };
    });
    if (result !== null) announced.push(result);
  }
  return { announced };
}
