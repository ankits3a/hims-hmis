import { and, eq, sql } from "drizzle-orm";
import { canteenSeries, gstConfig } from "../../kernel/db/schema";
import { inclusiveTaxHead, taxHead } from "../tariff";
import { CanteenRefusal } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * MONEY. Menu prices are GST-inclusive; the tax comes OUT of the price the way the pharmacy counter takes it out of an
 * MRP (`inclusiveTaxHead`, CGST = SGST), so the payer pays exactly the menu price. Rent is exclusive: 18% ON the rent
 * (`taxHead`). Rates come from `gst_config` rows, never from code.
 */
export type TaxSplit = { netPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number };

export function splitInclusive(inclusivePaise: number, rateBps: number): TaxSplit {
  const head = rateBps === 0 ? 0 : inclusiveTaxHead(inclusivePaise, rateBps);
  return { netPaise: inclusivePaise, taxablePaise: inclusivePaise - 2 * head, cgstPaise: head, sgstPaise: head };
}

export function addOnTax(taxablePaise: number, rateBps: number): TaxSplit {
  const head = taxHead(taxablePaise, rateBps);
  return { netPaise: taxablePaise + 2 * head, taxablePaise, cgstPaise: head, sgstPaise: head };
}

export type GstRow = { category: string; sacCode: string; exempt: boolean; rateBps: number };

/** The `gst_config` row of a category, or the refusal that finance has not set it. */
export async function gstRow(exec: Db | Tx, category: string): Promise<GstRow> {
  const row = (await (exec as Db).select().from(gstConfig).where(eq(gstConfig.category, category)))[0];
  if (row === undefined) throw new CanteenRefusal("gst_config_missing", { category });
  return { category: row.category, sacCode: row.sacCode, exempt: row.exempt, rateBps: row.rateBps };
}

/** The next number of a counter (`series_key`, `period`), single-winner. */
export async function nextNo(tx: Tx, seriesKey: string, period: string): Promise<number> {
  await tx.insert(canteenSeries).values({ seriesKey, period, nextNo: 1 }).onConflictDoNothing();
  const rows = await tx.update(canteenSeries).set({ nextNo: sql`${canteenSeries.nextNo} + 1` })
    .where(and(eq(canteenSeries.seriesKey, seriesKey), eq(canteenSeries.period, period)))
    .returning({ nextNo: canteenSeries.nextNo });
  return rows[0]!.nextNo - 1;
}

/** "2627" for an instant in FY 2026-27 (April to March, IST). */
export function fyShort(at: Date): string {
  const d = new Date(at.getTime() + 330 * 60_000);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
}

/** The IST calendar day of an instant, `YYYY-MM-DD`. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** The IST minute of the day (0..1439). */
export function istMinute(at: Date): number {
  const d = new Date(at.getTime() + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** [start, end) of an IST day as instants. */
export function istDayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** [start, end) of an IST month `YYYY-MM`. */
export function istMonthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${String(y + 1)}-01` : `${String(y)}-${String(m + 1).padStart(2, "0")}`;
  return { start: new Date(`${month}-01T00:00:00+05:30`), end: new Date(`${next}-01T00:00:00+05:30`) };
}
