import { sql } from "drizzle-orm";
import { OtError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * F24e — **§269ST ACROSS THE ENCOUNTER, not per service day.**
 *
 * Billing's own C-2 check is per `service_day` (`cash-law.ts`), which a deposit-then-discharge pair
 * defeats: ₹1,50,000 cash on the booking day and ₹60,000 on the discharge day are two lawful days
 * and one unlawful transaction, because §269ST counts receipts "in respect of a single transaction"
 * and one operation is one transaction whatever the calendar says.
 *
 * So this sums CASH receipts held on the encounter plus the discharge tender and refuses at the
 * threshold. Billing's per-day check stays where it is and catches the single-day case; this catches
 * the one it cannot see.
 */
export const CASH_LIMIT_PAISE = 20_000_000; // ₹2,00,000

export async function encounterCashPaise(
  exec: Db | Tx, encounterId: string, encounterNo: string,
): Promise<number> {
  /**
   * ═══ CLOSE REVIEW C1 — THE GUARD USED TO COUNT ONLY THE BOOKING DEPOSIT ═══
   *
   * The first version summed `ot_deposit_holds ⋈ receipt_tenders WHERE mode='cash'` and nothing
   * else, which was wrong three separate ways — and the one that mattered was the direction that
   * UNDER-counts:
   *
   *   1. **A discharge tender is never held**, so it never entered the total. Two bills on one
   *      encounter (a return to theatre — N13, which this module supports) could each take ₹40,000
   *      cash on top of a ₹1,50,000 deposit and each be told it was inside the limit. ₹2,30,000
   *      received in respect of one transaction, with the guard reporting compliance.
   *   2. It summed the receipt's WHOLE cash tender rather than the part earmarked here, so a
   *      ₹1,50,000 cash advance with ₹10,000 held against this encounter counted as ₹1,50,000.
   *   3. Two holds carved from one receipt counted that receipt twice.
   *
   * So the total is now built per RECEIPT, each counted exactly once:
   *
   *   · a receipt whose money reached an INVOICE on this encounter contributes all of its cash —
   *     that money was received in respect of this operation, whatever else it was labelled;
   *   · a receipt merely EARMARKED here contributes `least(earmarked, its cash)` — a patient with a
   *     large cash advance has not paid it all for this operation.
   *
   * Over-counting is the safe direction and under-counting is a §271DA penalty, so where the two
   * readings differ this takes the larger: a released hold still counts, because the cash was
   * received. `>=` not `>`: §269ST prohibits receiving ₹2,00,000 **or more**.
   */
  const rows = (await exec.execute(sql`
    with held as (
      select h.receipt_id, sum(h.amount_paise) as earmarked
        from ot_deposit_holds h
       where h.encounter_id = ${encounterId}
       group by h.receipt_id
    ),
    billed as (
      select distinct a.receipt_id
        from allocations a
        join invoices i on i.id = a.invoice_id
       where i.encounter_id = ${encounterNo}
    ),
    -- PASS-2 MINOR-6 — restricted to the receipts in scope. The first version grouped EVERY cash
    -- tender in the hospital before filtering, so a query on the discharge path scaled with the
    -- hospital's lifetime receipt count rather than with this encounter.
    scoped as (
      select receipt_id from held union select receipt_id from billed
    ),
    cash as (
      select rt.receipt_id, sum(rt.amount_paise) as cash_paise
        from receipt_tenders rt
        join scoped s on s.receipt_id = rt.receipt_id
       where rt.mode = 'cash'
       group by rt.receipt_id
    )
    select coalesce(sum(
      case when b.receipt_id is not null then c.cash_paise
           else least(h.earmarked, c.cash_paise) end
    ), 0)::bigint as "cash"
      from cash c
      left join held   h on h.receipt_id = c.receipt_id
      left join billed b on b.receipt_id = c.receipt_id
     where h.receipt_id is not null or b.receipt_id is not null
  `)).rows as { cash: string | number }[];
  return Number(rows[0]?.cash ?? 0);
}

export async function assertCashWithinEncounterLimit(
  exec: Db | Tx, encounterId: string, encounterNo: string, incomingCashPaise: number,
): Promise<void> {
  if (incomingCashPaise <= 0) return;
  const prior = await encounterCashPaise(exec, encounterId, encounterNo);
  const total = prior + incomingCashPaise;
  if (total >= CASH_LIMIT_PAISE) {
    throw new OtError(
      "cash_limit_exceeded",
      `this encounter's cash total would reach ${String(total)}p (§269ST blocks at ${String(CASH_LIMIT_PAISE)}p) — ${String(prior)}p is already held against it, on an earlier day (F24e)`,
      { priorCashPaise: prior, incomingCashPaise, totalPaise: total, limitPaise: CASH_LIMIT_PAISE },
    );
  }
}
