import { and, eq, sql } from "drizzle-orm";
import { documentSeries } from "../../kernel/db/schema";
import { BillingError } from "./errors";
import { fyOf } from "./time";
import type { BillingConfig, SeriesKey } from "./config";
import type { Tx } from "../../kernel/db/client";

/**
 * D5 — document series: per-fiscal-year, row-locked counters. GST needs consecutive serials of
 * at most 16 chars that RESET each fiscal year, which a `bigserial` cannot do, so the counter is
 * a `(series_key, fy)` row moved by a single-winner `UPDATE ... RETURNING` — the OPD token
 * precedent (`allocateToken`, modules/opd/sessions.ts: the RETURNING value is the POST-increment
 * counter, so the number just handed out is one less).
 *
 * `series_key` is snake_case ('invoice'|'receipt'|'credit_note'|'voucher' — the documentSeries
 * schema comment, kernel/db/schema/billing.ts). `billing_config.series_prefixes` supplies the
 * printable prefix per key; config.ts keeps that map LOOSE (any subset of keys can be present) —
 * a config missing one of the four canonical keys is a business-COMPLETENESS question that
 * validate:billing/validateBillingConfig catches, never a write-time SHAPE question. `nextDocNo`
 * itself is this module's own enforcement of that: an absent prefix throws `unknown_series`.
 */
export async function nextDocNo(tx: Tx, cfg: BillingConfig, seriesKey: SeriesKey, at: Date): Promise<string> {
  const prefix = cfg.seriesPrefixes[seriesKey];
  if (!prefix) throw new BillingError("unknown_series", `no series prefix configured for "${seriesKey}"`);
  const { fyShort } = fyOf(at);

  // First-ever row for this (key, fy): default next_no = 1 (billing.ts's column default), so the
  // INSERT alone hands out no number — the UPDATE below is what allocates one. Cold start is
  // exactly this path with no pre-existing row (verify-by-execution flag 6): ON CONFLICT DO
  // NOTHING lets every racer's INSERT no-op after the first, and every racer proceeds to the same
  // single-winner UPDATE.
  await tx.insert(documentSeries).values({ seriesKey, fy: fyShort, nextNo: 1 }).onConflictDoNothing();

  const rows = await tx
    .update(documentSeries)
    .set({ nextNo: sql`${documentSeries.nextNo} + 1` })
    .where(and(eq(documentSeries.seriesKey, seriesKey), eq(documentSeries.fy, fyShort)))
    .returning({ nextNo: documentSeries.nextNo });
  const used = rows[0]!.nextNo - 1;
  return `${prefix}/${fyShort}/${String(used).padStart(6, "0")}`;
}
