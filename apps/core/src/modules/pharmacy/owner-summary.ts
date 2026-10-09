import { and, gte, lt, sql } from "drizzle-orm";
import type { DayRange, OwnerPharmacy } from "@hmis/contracts";
import { pharmacyDispenses } from "../../kernel/db/schema";
import { hasPermission } from "../../kernel/auth/permissions";
import { istInstantOf } from "./config";
import { PharmacyError } from "./errors";
import { reorderAdvice } from "./replenishment";
import { REPORTS_READ } from "./report-range";
import { pharmacySalesTotals } from "./sales-register";
import { listOpenShortBook } from "./short-book";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE OWNER'S PHARMACY PAGE ═══ (owner, 2026-10-09: "Pharmacy today. week, month, custom.")
 *
 * TOTALS ONLY — no patient, no bill number. Every figure is one the pharmacy already keeps:
 *   · bills, sales, refunds and the split by where the sale came from — the sales register's own
 *     period (`pharmacySalesTotals`), so the page reconciles to the register;
 *   · prescriptions — the counter's queue: those that REACHED the counter in the range (a dispense row
 *     was created) and how many of them were handed over. A prescription that never reached the
 *     counter is not in either number: this is "served of those that came", not "of those written";
 *   · stock, AS IT STANDS NOW (never of the range) — the reorder list's own lines at or below their
 *     level or out (`reorderAdvice`), batches with 60 days or fewer left, and the open rows of the
 *     short book (what was asked for and was not there), with the first two names.
 *
 * MONEY IS THE PHARMACY REPORTS' (`pharmacy.reports.read`): a reader without it — the Medical
 * Superintendent — gets every count and no rupee (owner: "Money page for owner alone").
 */
const DAY_MS = 86_400_000;
const EXPIRING_WITHIN_DAYS = 60;

function window(range: DayRange): { start: Date; end: Date } {
  return {
    // The module's one IST clock (`config.ts` `istInstantOf`) — test/ist-clock-parity.test.ts pins one site per module.
    start: istInstantOf(range.from, "00:00"),
    end: new Date(istInstantOf(range.to, "00:00").getTime() + DAY_MS),
  };
}

export async function ownerPharmacy(
  db: Db, actor: Actor, range: DayRange, compare: DayRange | null, now: Date = new Date(),
): Promise<OwnerPharmacy> {
  const money = actor.type === "user" && await hasPermission(db, actor.id, REPORTS_READ, "hospital");
  const paise = (n: number): number | null => (money ? n : null);
  const sales = await pharmacySalesTotals(db, range.from, range.to);
  const before = compare === null ? null : await pharmacySalesTotals(db, compare.from, compare.to);

  const { start, end } = window(range);
  const [reached] = await db.select({
    n: sql<number>`count(*)::int`,
    served: sql<number>`count(*) filter (where ${pharmacyDispenses.status} = 'handed_over')::int`,
  }).from(pharmacyDispenses).where(and(gte(pharmacyDispenses.createdAt, start), lt(pharmacyDispenses.createdAt, end)));

  let stock: OwnerPharmacy["stock"] = null;
  try {
    const advice = await reorderAdvice(db, now);
    const asked = await listOpenShortBook(db);
    stock = {
      low: advice.items.filter((i) => i.status === "stock_out" || i.status === "reorder").length,
      expiring60: advice.expiring.filter((e) => e.daysLeft <= EXPIRING_WITHIN_DAYS).length,
      askedOut: asked.length,
      askedNames: asked.slice(0, 2).map((a) => a.drugName),
    };
  } catch (e) {
    if (!(e instanceof PharmacyError)) throw e; // the counter's store is not set up: no stock lines, never a zero
  }

  return {
    from: range.from, to: range.to,
    bills: sales.bills, salesPaise: paise(sales.netPaise), refundsPaise: paise(sales.refundsPaise),
    previous: compare === null || before === null ? null : { ...compare, bills: before.bills, salesPaise: paise(before.netPaise) },
    split: sales.split.map((s) => ({ key: s.key, bills: s.bills, salesPaise: paise(s.netPaise) })),
    prescriptions: { reached: reached?.n ?? 0, served: reached?.served ?? 0 },
    stock,
  };
}
