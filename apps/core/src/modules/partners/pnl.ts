import { asc, eq, sql } from "drizzle-orm";
import { counterparties } from "../../kernel/db/schema";
import { istDayIndexSql, payableTotalPaise } from "./accrual";
import { agingReport } from "./aging";
import { assertIdentityFree } from "./exports";
import { PartnersError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 09 T8 — THE CHANNEL P&L: ONE ROW PER PARTNER, BUILT ENTIRELY FROM READERS T6/T7 ALREADY
 * SHIPPED (DD1's whole point — a THIRD query over the same tables is a THIRD place the numbers can
 * disagree).
 *
 * ═══ WHY THIS FILE ADDS EXACTLY TWO NEW QUERIES, AND NOT A THIRD ═══
 *
 * `payableCommissionPaise` is `accrual.ts`'s own `payableTotalPaise` (state = 'accrued', escrowed
 * excluded — O-7). `receivableExpectedPaise` / `receivableMatchedPaise` / `receivableDisputedPaise`
 * are `aging.ts`'s own `agingReport(...).totals`, read off the SAME three fields the receivables
 * desk shows — `receivableMatchedPaise` is deliberately the LEDGER's `confirmedPaise`, never a sum
 * over `receivable_expectations` rows in the `matched` state, because a V3 correction produces TWO
 * claim rows for one referral and summing claims would double the money a statement corrected
 * (relay note 99 / DD5). What is genuinely new here is `cardsActive` (a count over
 * `membership_instances`) and `memberSpendPaise` — see below.
 *
 * ═══ "MEMBER SPEND" IS THE SAME PREDICATE `attributeInvoice` USES, ASKED FOR A DIFFERENT REASON ═══
 *
 * `accrual.ts`'s `attributeInvoice` decides WHOSE card earns commission on a bill: a verified
 * instrument of this counterparty whose validity window contains the invoice's `issued_at`. Member
 * spend answers a related but different question — how much business this partner's members bring
 * to the hospital, independent of whether any commission accrued on it (a suspended partner's
 * members still spend; an `external_rmp`'s never earn a payable rupee at all, DD4). Reusing the
 * IDENTICAL predicate, as one `exists (...)` correlated to `invoices`, is what stops "whose bill is
 * this" from being answered twice by two formulas that could quietly drift apart.
 *
 * ═══ DD15 — AGGREGATES ONLY, NEVER A ROW ═══
 *
 * Every field below is a count or a sum. There is no per-patient row anywhere in this file's
 * output, so there is no patient identity to leak by construction — `assertIdentityFree` is called
 * on the finished row anyway, as the same defence-in-depth `exports.ts` applies to its own rows,
 * because a later edit that joined in one identifying column should fail here rather than at
 * whatever screen renders this first.
 *
 * ═══ WHY THIS READS ZEROS WITH EVERY LANE OFF, AND WHY THAT IS NOT A SPECIAL CASE ═══
 *
 * With `COMMISSION_ACCRUAL_ENABLED` and `RECEIVABLE_COMMISSION_ENABLED` both false, the accrual
 * consumer and the attribution/statement routes write NOTHING (DD14) — so every sum below is a
 * `coalesce(sum(...), 0)` over a genuinely empty result set, and it reads zero because there is
 * nothing to sum, not because this file special-cases the flags. `cardsActive` and
 * `memberSpendPaise` are NOT flag-gated (recognition, honouring and the holder-book import are
 * unflagged per DD14's table) and can be non-zero the moment a partner's cards are imported and
 * used, independently of the three CA-gated numbers — that is a real property of a channel
 * relationship, not a bug: cards can circulate and members can spend while the hospital and the
 * partner are still working out the CA sign-off for what either side owes the other.
 */

export type PartnerPnl = {
  counterpartyId: string;
  counterpartyName: string;
  payeeClass: string;
  asOf: Date;
  cardsActive: number;
  memberSpendPaise: number;
  payableCommissionPaise: number;
  receivableExpectedPaise: number;
  receivableMatchedPaise: number;
  receivableDisputedPaise: number;
  /** `receivableMatchedPaise − payableCommissionPaise` — what this partner nets the hospital in
   *  commission cash flow alone. It says nothing about the underlying clinical revenue. */
  netChannelMarginPaise: number;
};

async function cardsActiveFor(exec: Db | Tx, counterpartyId: string): Promise<number> {
  const rows = (await exec.execute(sql`
    select count(*)::int as n from membership_instances
    where counterparty_id = ${counterpartyId} and status = 'active'
  `)).rows as { n: number }[];
  return rows[0]!.n;
}

/**
 * See the header's "member spend" section for why this is `attributeInvoice`'s own predicate.
 *
 * **PLAN 09a T3 — THIS WAS THE SECOND COPY OF MAJOR 3, AND THE REVIEWER NAMED ONLY THE FIRST.**
 * Plan 09's reviewer found the raw-instant validity comparison in `attributeInvoice`. The identical
 * two lines lived here, in a function whose own docstring declares it to BE that predicate — so
 * fixing only the one the reviewer named would have made this file's stated invariant false and
 * left the P&L crediting a different set of invoices than the ledger for the same ~18.5 hours of
 * every imported card's last day. The header says two formulas answering "whose bill is this"
 * "could quietly drift apart"; that is exactly what a one-sided fix would have caused.
 */
async function memberSpendFor(exec: Db | Tx, counterpartyId: string): Promise<number> {
  const rows = (await exec.execute(sql`
    select coalesce(sum(i.net_payable_paise), 0) as total
    from invoices i
    where exists (
      select 1 from membership_instances mi
      where mi.counterparty_id = ${counterpartyId}
        and mi.verified = true
        and mi.patient_id = i.patient_id
        and ${istDayIndexSql(sql`mi.valid_from`)} <= ${istDayIndexSql(sql`i.issued_at`)}
        and ${istDayIndexSql(sql`mi.valid_to`)} >= ${istDayIndexSql(sql`i.issued_at`)}
    )
  `)).rows as { total: string | number }[];
  return Number(rows[0]!.total);
}

/** One partner's channel P&L, as of `input.asOf`. Throws `unknown_counterparty` for a bad id. */
export async function partnerPnl(
  exec: Db | Tx,
  input: { counterpartyId: string; asOf: Date },
): Promise<PartnerPnl> {
  const cpRows = await exec
    .select({ id: counterparties.id, name: counterparties.name, payeeClass: counterparties.payeeClass })
    .from(counterparties)
    .where(eq(counterparties.id, input.counterpartyId));
  const cp = cpRows[0];
  if (!cp) throw new PartnersError("unknown_counterparty", `no counterparty ${input.counterpartyId}`);

  const [cardsActive, memberSpendPaise, payableCommissionPaise, aging] = await Promise.all([
    cardsActiveFor(exec, input.counterpartyId),
    memberSpendFor(exec, input.counterpartyId),
    payableTotalPaise(exec, input.counterpartyId),
    agingReport(exec, { counterpartyId: input.counterpartyId, asOf: input.asOf }),
  ]);

  // The ledger's own confirmed total — never a sum over expectation rows. See the header.
  const receivableMatchedPaise = aging.totals.confirmedPaise;

  const row: PartnerPnl = {
    counterpartyId: cp.id,
    counterpartyName: cp.name,
    payeeClass: cp.payeeClass,
    asOf: input.asOf,
    cardsActive,
    memberSpendPaise,
    payableCommissionPaise,
    receivableExpectedPaise: aging.totals.outstandingPaise,
    receivableMatchedPaise,
    receivableDisputedPaise: aging.totals.disputedPaise,
    netChannelMarginPaise: receivableMatchedPaise - payableCommissionPaise,
  };
  assertIdentityFree(row, "partner P&L row");
  return row;
}

/** Every counterparty's P&L, oldest-onboarded first. Empty array over an empty catalog (DD3). */
export async function partnerPnlAll(exec: Db | Tx, input: { asOf: Date }): Promise<PartnerPnl[]> {
  const rows = await exec
    .select({ id: counterparties.id })
    .from(counterparties)
    .orderBy(asc(counterparties.createdAt));
  return Promise.all(rows.map((r) => partnerPnl(exec, { counterpartyId: r.id, asOf: input.asOf })));
}
