import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { storesPrBandSettings, storesPurchaseRequestLines, storesPurchaseRequestStamps, storesPurchaseRequests } from "../../kernel/db/schema";
import type { StoresBand } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * STORES S5a (#1115, decisions 2, 3; ruling 0099 Q4) — THE QUOTATION BANDS AND THE SPLIT CHECK.
 *
 * Band A (One quote) up to ₹25,000; band B (Three quotes) above that up to ₹5,00,000; band C (Committee) above ₹5 lakh
 * and, whatever the value, any line in the "Medical equipment" category (a category whose tag rule is `always`).
 * IT and furniture follow the value bands (DECIDED in the spec). The estimate leaves out lines on a live rate contract:
 * they order as band A against that contract without fresh quotes (decision 4).
 *
 * The split check (decision 3): a department's request is banded on what that department asked for in the same
 * category over the 30 days before the read; the central store's (and the planner's) on the same item, because a store
 * reorders a category every week. A declined or cancelled request is not counted. When the sum crosses a band edge the
 * higher band applies and the request carries "Split?" with the requests it summed. A buyer can lift a band
 * (`stores_pr_band_settings`), never lower it below this floor.
 */
export const BAND_A_MAX_PAISE = 2_500_000;
export const BAND_B_MAX_PAISE = 50_000_000;
export const SPLIT_WINDOW_DAYS = 30;
const RANK: Record<StoresBand, number> = { A: 0, B: 1, C: 2 };

export function bandFor(estimatePaise: number, opts: { equipment?: boolean } = {}): StoresBand {
  if (opts.equipment === true) return "C";
  if (estimatePaise <= BAND_A_MAX_PAISE) return "A";
  if (estimatePaise <= BAND_B_MAX_PAISE) return "B";
  return "C";
}

export const higherBand = (a: StoresBand, b: StoresBand): StoresBand => (RANK[a] >= RANK[b] ? a : b);

type LineRow = typeof storesPurchaseRequestLines.$inferSelect;
type PrRow = typeof storesPurchaseRequests.$inferSelect;
export type BandInfo = { band: StoresBand; estimatePaise: number; split: { prIds: string[]; prNos: string[] } | null };

const lineValue = (l: Pick<LineRow, "qtyBase" | "unitEstimatePaise">): number => l.qtyBase * l.unitEstimatePaise;

/** Band of one request as read at `now`: its own lines, the 30-day sums, and any band the buyer lifted it to. */
export async function bandOf(db: Db | Tx, pr: PrRow, lines: readonly LineRow[], now: Date): Promise<BandInfo> {
  const estimatePaise = lines.reduce((a, l) => a + lineValue(l), 0);
  const counted = lines.filter((l) => !l.onContract);
  let band = bandFor(counted.reduce((a, l) => a + lineValue(l), 0), { equipment: lines.some((l) => l.equipment) });
  let split: BandInfo["split"] = null;

  if (counted.length > 0 && band !== "C") {
    const since = new Date(now.getTime() - SPLIT_WINDOW_DAYS * 86_400_000);
    const byDepartment = pr.source === "department";
    const sameSource = byDepartment ? [pr.source] : ["central", "planner"];
    const peers = await (db as Db).select({ pr: storesPurchaseRequests }).from(storesPurchaseRequests)
      .where(and(
        inArray(storesPurchaseRequests.source, sameSource), gt(storesPurchaseRequests.raisedAt, since), lte(storesPurchaseRequests.raisedAt, now),
        byDepartment ? eq(storesPurchaseRequests.departmentId, pr.departmentId!) : undefined,
      ));
    const live = peers.filter((p) => p.pr.id !== pr.id).map((p) => p.pr);
    const stamped = live.length === 0 ? [] : await (db as Db).select({ prId: storesPurchaseRequestStamps.prId, kind: storesPurchaseRequestStamps.kind })
      .from(storesPurchaseRequestStamps).where(inArray(storesPurchaseRequestStamps.prId, live.map((p) => p.id)));
    const dead = new Set(stamped.filter((s) => s.kind !== "approved").map((s) => s.prId));
    const others = live.filter((p) => !dead.has(p.id));
    const otherLines = others.length === 0 ? [] : await (db as Db).select().from(storesPurchaseRequestLines)
      .where(and(inArray(storesPurchaseRequestLines.prId, others.map((p) => p.id)), eq(storesPurchaseRequestLines.onContract, false)));
    const keyOf = (l: LineRow): string | null => (byDepartment ? l.categoryId : l.itemId);
    for (const key of new Set(counted.map(keyOf).filter((k): k is string => k !== null))) {
      const mine = counted.filter((l) => keyOf(l) === key);
      const theirs = otherLines.filter((l) => keyOf(l) === key);
      if (theirs.length === 0) continue;
      const sum = [...mine, ...theirs].reduce((a, l) => a + lineValue(l), 0);
      const summed = bandFor(sum);
      if (RANK[summed] > RANK[band]) {
        band = summed;
        const ids = [pr.id, ...new Set(theirs.map((l) => l.prId))];
        const nos = new Map([pr, ...others].map((p) => [p.id, p.prNo] as const));
        split = { prIds: ids, prNos: ids.map((id) => nos.get(id) ?? id) };
      }
    }
  }
  const [lifted] = await (db as Db).select({ band: storesPrBandSettings.band }).from(storesPrBandSettings)
    .where(eq(storesPrBandSettings.prId, pr.id)).orderBy(desc(storesPrBandSettings.at), desc(storesPrBandSettings.id)).limit(1);
  if (lifted !== undefined) band = higherBand(band, lifted.band as StoresBand);
  return { band, estimatePaise, split };
}
