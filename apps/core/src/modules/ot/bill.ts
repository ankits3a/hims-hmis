import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { daycareEncounters, invoices, otCaseImplants, otCases } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { consumptionsFor } from "../materials";
import { issueInvoice, previewInvoice, requestRefund } from "../billing";
import { loadPricingContext } from "../tariff";
import { OtError } from "./errors";
import { materialCeilingDiverged } from "./events";
import { caseState } from "./booking";
import { openHolds, releaseHolds } from "./deposit";
import { deployingImplants } from "./implants";
import type { InvoiceLineInput } from "../tariff";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T7 / DD11 — **THE DISCHARGE BILL IS COMPOSED FROM THE LEDGER, NOT TYPED.**
 *
 * ═══ THE CLAMP IS `min(tariff, MRP x qty, ceiling x qty)` AND IT IS COMPUTED HERE (F4) ═══
 *
 * Billing's own `regulated` clamp is keyed by SERVICE (`regulated_prices.service_id`) and an
 * implant's lawful maximum is keyed by BATCH: the same plate from two consignment lots carries two
 * printed MRPs. No service-level row can express that, so **no implant service will ever have a
 * `regulated_prices` row** and billing's clamp is a permanent no-op for them. This module computes
 * the bound against the batch the plate actually came from and hands it to the tariff engine as
 * `capUnitPaise` — a member of the same `min` chain, applied unconditionally, impossible to lose.
 *
 * `consumptionsFor(encounterId)` is the ONE read this is composed from (DD13). It returns
 * `mrpPaisePerBase` and `ceilingPaisePerBase` already converted to the item's base unit, which is
 * what makes A25 expressible: an MRP printed on a box of two is not the price of one plate.
 *
 * ═══ F5 / R-3.2 — THE CEILING IS RE-DERIVED, AND THE FROZEN VALUE IS PROVENANCE ═══
 *
 * `consumptionsFor` recomputes the ceiling from `item_price_regulations` at query time;
 * `material.consumed` froze it at consumption time. For every ordinary case they agree. They
 * disagree when a gazette CORRECTION is filed later with the same `effective_from` and a higher
 * `seq`, which `effectiveRegulation` orders ahead of the original. **The invoice is the tax document
 * and must match the gazette as corrected on the day of issue**, so the DERIVED value wins and
 * `material.ceiling_diverged` records the difference. NPPA enforcement reads the invoice, not the
 * event log.
 *
 * ═══ F9 — THE CONVERSION BOUNDARY IS ENFORCED BY THIS FILE ═══
 *
 * Only ledger rows with `occurred_at <= converted_at` are billed. Later rows on the same encounter
 * are the incumbent IPD's and go to a `handoff_unbilled` report line. Billing cannot enforce this —
 * it has no notion of a conversion instant — which is why F9 says the composer must.
 */

export type ImplantLine = {
  ledgerEntryId: string;
  implantId: string;
  serviceCode: string;
  qtyBase: number;
  tariffUnitPaise: number;
  mrpPaisePerBase: number | null;
  ceilingPaisePerBase: number | null;
  capUnitPaise: number;
  /** D9 — WHICH of the three won. Written into the invoice line's note. */
  boundApplied: "tariff" | "mrp" | "ceiling";
};

export type ComposedBill = {
  encounterId: string;
  patientId: string;
  lines: InvoiceLineInput[];
  notes: Record<string, string>;
  implantLines: ImplantLine[];
  packageLines: { caseId: string; serviceCode: string }[];
  handoffUnbilled: { ledgerEntryId: string; itemId: string; occurredAt: Date }[];
  unreturnedIssues: { ledgerEntryId: string; itemId: string; qtyBase: number }[];
  heldPaise: number;
  divergences: { ledgerEntryId: string; frozen: number | null; derived: number | null }[];
  /**
   * What the invoice will come to, priced through the REAL engine (`previewInvoice`) rather than
   * added up here. `settleDischargeBill` needs the figure BEFORE issuing, to decide how much of the
   * deposit to hand to `settleFromReceipts` — and a private total would be a second answer to "what
   * does this cost", diverging from the invoice the moment a GST rule or a rounding rule changes.
   */
  expectedNetPaise: number;
};

/** The outcomes a bill may be composed from (DD11). `cancelled` composes nothing. */
export const COMPOSABLE_OUTCOMES = ["discharged", "converted", "absconded", "deceased"] as const;

/**
 * A24/A25 — the clamp, per row. PURE.
 *
 * `qtyBase` multiplies the two PER-BASE bounds and nothing else: the tariff is already a per-unit
 * price and the engine multiplies it itself. A25's mutant uses `mrpPaise` — the price printed on the
 * PACK — directly, which is a factor of the pack size out on every implant sold in anything but ones.
 */
export function clampImplantUnitPaise(
  tariffUnitPaise: number,
  row: { mrpPaisePerBase: number | null; ceilingPaisePerBase: number | null },
): { capUnitPaise: number; boundApplied: "tariff" | "mrp" | "ceiling" } {
  let cap = tariffUnitPaise;
  let boundApplied: "tariff" | "mrp" | "ceiling" = "tariff";
  if (row.mrpPaisePerBase !== null && row.mrpPaisePerBase < cap) {
    cap = row.mrpPaisePerBase;
    boundApplied = "mrp";
  }
  if (row.ceilingPaisePerBase !== null && row.ceilingPaisePerBase < cap) {
    cap = row.ceilingPaisePerBase;
    boundApplied = "ceiling";
  }
  return { capUnitPaise: cap, boundApplied };
}

/**
 * A28 — the frozen ceiling on the `material.consumed` event for one ledger entry, or null when the
 * event carries none. Read from the event STREAM, because that is where the freeze lives: nothing
 * materialises it into a column, and inventing one would be a second copy of a number whose whole
 * purpose is to be the original.
 */
export async function frozenCeilingPaisePerBase(exec: Db | Tx, ledgerEntryId: string): Promise<number | null> {
  const rows = (await exec.execute(sql`
    select payload->>'ceilingPaisePerBase' as "frozen"
      from events
     where name = 'material.consumed'
       and payload->>'ledgerEntryId' = ${ledgerEntryId}
     order by seq desc
     limit 1
  `)).rows as { frozen: string | null }[];
  const frozen = rows[0]?.frozen;
  return frozen === undefined || frozen === null ? null : Number.parseInt(frozen, 10);
}

/**
 * COMPOSES the bill. It writes nothing — `settleDischargeBill` does — so a screen can preview the
 * exact draft that will be issued, which is `previewInvoice`'s own reason for existing.
 */
export async function composeDischargeBill(
  db: Db, encounterId: string, now: Date = new Date(),
): Promise<ComposedBill> {
  const encounter = (await db.select().from(daycareEncounters)
    .where(eq(daycareEncounters.id, encounterId)))[0];
  if (!encounter) throw new OtError("unknown_case", `unknown day-care encounter ${encounterId}`);

  if (encounter.outcome === null || !(COMPOSABLE_OUTCOMES as readonly string[]).includes(encounter.outcome)) {
    throw new OtError(
      "bill_not_composable",
      `an encounter whose outcome is ${String(encounter.outcome)} composes no bill — a cancelled case releases its deposit instead (DD11)`,
      { outcome: encounter.outcome },
    );
  }

  const cases = await db.select().from(otCases).where(eq(otCases.encounterId, encounterId));
  if (cases.length === 0) throw new OtError("bill_not_composable", "this encounter has no cases");

  /**
   * A27 — EVERY case on the encounter must be `signed_out` or later, and it is EVERY rather than the
   * first: N8's bilateral encounter carries two, and a bill composed while the second is still on
   * the table is a bill for an operation that has not finished. The mutant checks `cases[0]`.
   */
  const AFTER_THEATRE = ["signed_out", "in_recovery", "discharge_ready", "discharged", "converted", "absconded", "deceased"];
  const unfinished: { caseId: string; state: string }[] = [];
  for (const kase of cases) {
    const state = await caseState(db, kase.id);
    if (!AFTER_THEATRE.includes(state)) unfinished.push({ caseId: kase.id, state });
  }
  if (unfinished.length > 0) {
    throw new OtError(
      "bill_not_composable",
      `${String(unfinished.length)} case(s) on this encounter have not been signed out: ${unfinished.map((u) => `${u.caseId} (${u.state})`).join(", ")} — I7's ghost case`,
      { unfinished },
    );
  }

  // A27's second half — no implant may still be waiting for its ledger fact.
  for (const kase of cases) {
    const waiting = await deployingImplants(db, kase.id);
    if (waiting.length > 0) {
      throw new OtError(
        "bill_not_composable",
        `${String(waiting.length)} implant(s) on case ${kase.id} have no ledger fact yet — the bill would be composed from a ledger that does not know about them`,
        { caseId: kase.id },
      );
    }
  }

  const ctx = await loadPricingContext(db, { at: now, tags: [] });
  const serviceByCode = new Map(Object.values(ctx.services).map((s) => [s.code, s]));

  const lines: InvoiceLineInput[] = [];
  const notes: Record<string, string> = {};
  const packageLines: { caseId: string; serviceCode: string }[] = [];

  /**
   * ONE PACKAGE LINE PER CASE. A `deceased` encounter whose case never reached `incision` bills no
   * package: the theatre and anaesthesia facts are 15d's bands, and charging a package for an
   * operation that did not start is the one line nobody could defend to a family.
   */
  for (const kase of cases) {
    if (encounter.outcome === "deceased" && kase.incision === null) continue;
    const service = serviceByCode.get(kase.packageServiceCode);
    if (!service) {
      throw new OtError(
        "bill_not_composable",
        `the tariff carries no service "${kase.packageServiceCode}" — the go-live runbook creates one per procedure class (DD6/F8)`,
      );
    }
    const lineId = `pkg-${kase.id}`;
    lines.push({ lineId, serviceId: service.id, qty: 1 });
    notes[lineId] = `day-care package, ${kase.procedureClass}`;
    packageLines.push({ caseId: kase.id, serviceCode: kase.packageServiceCode });
  }

  // ── the implants, from the LEDGER ──
  const consumptions = await consumptionsFor(db, encounterId);
  const implantRows = await db.select().from(otCaseImplants).where(eq(otCaseImplants.encounterId, encounterId));
  const byLedgerEntry = new Map(implantRows.filter((r) => r.ledgerEntryId !== null).map((r) => [r.ledgerEntryId!, r]));

  const implantLines: ImplantLine[] = [];
  const handoffUnbilled: ComposedBill["handoffUnbilled"] = [];
  const unreturnedIssues: ComposedBill["unreturnedIssues"] = [];
  const divergences: ComposedBill["divergences"] = [];

  for (const row of consumptions) {
    /**
     * ═══ F9 — THE CONVERSION BOUNDARY ═══
     *
     * `converted_at` is the line the money is cut along (R-3.6). A consumption AFTER it belongs to
     * the incumbent IPD's bill, booked to the PATIENT rather than to an encounter this system owns,
     * and it goes to a report row instead. The mutant has no filter and bills the incumbent's stock
     * on our invoice.
     */
    if (encounter.convertedAt !== null && row.occurredAt.getTime() > encounter.convertedAt.getTime()) {
      handoffUnbilled.push({ ledgerEntryId: row.ledgerEntryId, itemId: row.itemId, occurredAt: row.occurredAt });
      continue;
    }

    const implant = byLedgerEntry.get(row.ledgerEntryId);
    /**
     * A26 — an EXPLANTED implant is excluded. D8's case is one plate deployed, found wrong, removed,
     * and a second one deployed: the patient is charged ONCE. The mutant filters on `deployed_at`,
     * which is set on both rows, and bills the patient for the plate that came back out.
     */
    if (implant !== undefined && implant.explantedAt !== null) continue;
    // A consumption with no OT implant row is a consumable, not an implant: 16c's chargeables spine
    // bills those, and this phase does not pretend to.
    if (implant === undefined) continue;

    const service = serviceByCode.get(implant.serviceCode);
    if (!service) {
      throw new OtError(
        "bill_not_composable",
        `the tariff carries no implant service "${implant.serviceCode}" — it is chosen at scan from the tariff's own list (§4A-2)`,
      );
    }
    const tariffUnitPaise = ctx.tariff.items[service.id];
    if (tariffUnitPaise === undefined) {
      throw new OtError("bill_not_composable", `no price for "${implant.serviceCode}" in tariff version ${ctx.tariff.versionId}`);
    }

    // A28 — the DERIVED ceiling wins; the frozen one is provenance and a divergence is evented.
    const frozen = await frozenCeilingPaisePerBase(db, row.ledgerEntryId);
    if (frozen !== row.ceilingPaisePerBase) {
      divergences.push({ ledgerEntryId: row.ledgerEntryId, frozen, derived: row.ceilingPaisePerBase });
    }

    /**
     * ═══ CLOSE REVIEW M4 — A CEILING THAT CANNOT BE RE-DERIVED IS NOT "NO CEILING" ═══
     *
     * `consumptionsFor` returns `ceilingPaisePerBase: null` whenever `mrpPerBaseUnit` throws — an
     * unrecognised `mrp_uom` on the regulation row, or a gazette price that does not divide into
     * whole paise per base unit (a ceiling filed per `box` of 3). `clampImplantUnitPaise` skips a
     * null bound, so the clamp silently became `min(tariff, MRP)` and the invoice could stand ABOVE
     * the NPPA ceiling — in exactly the untidy cases, and with this file's own header claiming the
     * cap is "impossible to lose".
     *
     * The frozen value is the ceiling that was in force when the implant was consumed, carried on
     * `material.consumed`. Falling back to it is strictly better than dropping the bound: it is a
     * real gazette number for this item, and the divergence row above already records that the two
     * readings differ, so the fallback is visible rather than silent. Both null is the honest
     * unregulated case and keeps no ceiling.
     */
    const ceilingPaisePerBase = row.ceilingPaisePerBase ?? frozen;
    const { capUnitPaise, boundApplied } = clampImplantUnitPaise(tariffUnitPaise, {
      mrpPaisePerBase: row.mrpPaisePerBase, ceilingPaisePerBase,
    });
    const lineId = `impl-${implant.id}`;
    lines.push({ lineId, serviceId: service.id, qty: row.qtyBase, capUnitPaise });
    notes[lineId] = `implant ${implant.serviceCode}; unit bound: ${boundApplied} (${String(capUnitPaise)}p/base)`;
    implantLines.push({
      ledgerEntryId: row.ledgerEntryId, implantId: implant.id, serviceCode: implant.serviceCode,
      qtyBase: row.qtyBase, tariffUnitPaise,
      // The ceiling the clamp actually used (M4) — the derived one, or the frozen fallback.
      mrpPaisePerBase: row.mrpPaisePerBase, ceilingPaisePerBase,
      capUnitPaise, boundApplied,
    });
  }

  /**
   * D12 — stock ISSUED to the theatre and never consumed. A WARNING row, never a block: an unreturned
   * kit is a stores question and holding a discharged patient's bill for it would be answering the
   * wrong one. 15d's kit reconciliation owns the charge consequence.
   */
  const issues = (await db.execute(sql`
    select id as "ledgerEntryId", item_id as "itemId", qty_delta as "qtyDelta"
      from stock_ledger
     where encounter_id = ${encounterId} and reason = 'issue'
  `)).rows as { ledgerEntryId: string; itemId: string; qtyDelta: number }[];
  for (const issue of issues) {
    const consumed = consumptions.some((c) => c.itemId === issue.itemId);
    if (!consumed) {
      unreturnedIssues.push({ ledgerEntryId: issue.ledgerEntryId, itemId: issue.itemId, qtyBase: Math.abs(issue.qtyDelta) });
    }
  }

  const holds = await withTx(db, (tx) => openHolds(tx, encounterId));
  // Priced by the engine, through billing's own preview — never summed here (see `expectedNetPaise`).
  const preview = await previewInvoice(db, { encounterId: encounter.encounterNo, lines, patientId: encounter.patientId });
  return {
    encounterId, patientId: encounter.patientId, lines, notes, implantLines, packageLines,
    handoffUnbilled, unreturnedIssues,
    heldPaise: holds.reduce((sum, h) => sum + h.amountPaise, 0),
    divergences,
    expectedNetPaise: preview.totals.netPayablePaise,
  };
}

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
    cash as (
      select rt.receipt_id, sum(rt.amount_paise) as cash_paise
        from receipt_tenders rt
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

export type SettleResult = {
  invoiceId: string;
  invoiceNo: string;
  netPayablePaise: number;
  allocatedPaise: number;
  refundApprovalId: string | null;
  refundPaise: number;
  handoffUnbilled: ComposedBill["handoffUnbilled"];
  unreturnedIssues: ComposedBill["unreturnedIssues"];
};

/**
 * Issues the composed invoice, allocates the encounter's HELD deposit to it, and raises a refund
 * request for any excess.
 *
 * ═══ A29 — THE HOLDS, NOT `advanceOf` ═══
 *
 * The allocation is of the receipts THIS ENCOUNTER holds. A patient with a hold on two encounters
 * has two deposits, and allocating from the patient-level advance would spend one encounter's
 * deposit on the other's bill — F3's finding at the settlement end rather than the gate end.
 *
 * ═══ THE OVER-DEPOSIT IS A REFUND REQUEST, NOT A SILENT CREDIT (§3A) ═══
 *
 * §3A: *"never held as 'credit for next time' without the patient's written choice."* So the excess
 * raises an `advance_refund` request — approval-gated, like every voucher — rather than sitting on
 * the patient as an advance nobody told them about.
 */
export async function settleDischargeBill(
  db: Db, actor: Actor,
  input: {
    encounterId: string;
    /** M9 — the full tender list; a discharge is not a cash-only desk. */
    tenders?: { mode: "cash" | "upi" | "card"; amountPaise: number; refText?: string }[];
    cashTenderPaise?: number;
    note?: string;
    /** M8 — a deliberate SECOND bill on this encounter (a return to theatre, N13). */
    additionalBill?: boolean;
  },
  now: Date = new Date(),
): Promise<SettleResult> {
  const composed = await composeDischargeBill(db, input.encounterId, now);
  const encounter = (await db.select().from(daycareEncounters)
    .where(eq(daycareEncounters.id, input.encounterId)))[0]!;

  /**
   * ═══ CLOSE REVIEW M8 — A DOUBLE-SUBMIT USED TO TAKE THE CASH TWICE ═══
   *
   * Nothing refused a second settlement. `composeDischargeBill` never looked for an existing
   * invoice and `issueInvoice` was handed a fresh `newId()` every time, so a cashier double-tapping
   * a cash-only discharge got **two invoices, two receipts and two payments**. The deposit-funded
   * path happened to self-block on the second call because `releaseHolds` had already run — which
   * is luck, not a guard, and the cash-only path (a waived deposit, a scheme patient's
   * non-payables) had no luck to rely on.
   *
   * `additionalBill` is the deliberate second bill — a return to theatre on the same encounter
   * (N13), which this module supports. It has to be asked for in as many words, because the whole
   * point is that a repeated request is not one.
   */
  const existing = await db.select({ id: invoices.id, invoiceNo: invoices.invoiceNo })
    .from(invoices).where(eq(invoices.encounterId, encounter.encounterNo));
  if (existing.length > 0 && input.additionalBill !== true) {
    throw new OtError(
      "bill_not_composable",
      `${encounter.encounterNo} is already billed (${existing.map((i) => i.invoiceNo).join(", ")}) — pass additionalBill to raise a second bill for a return to theatre (M8)`,
      { invoiceNos: existing.map((i) => i.invoiceNo) },
    );
  }

  /**
   * ═══ CLOSE REVIEW M9 — THE DISCHARGE DESK IS NOT A CASH-ONLY DESK ═══
   *
   * The route took `cashTenderPaise` and nothing else, so any balance above the held deposit had to
   * be settled in cash or `issueInvoice` refused it `unsettled_issue_refused`. Combined with the
   * §269ST ceiling that C1 now enforces properly, a ₹2,50,000 bill with no deposit **could not be
   * settled through this module at all** — and the documented workaround (record a receipt, then
   * hold it) needs `ot.cases.book`, which DD14 deliberately keeps away from the billing desk.
   *
   * `cashTenderPaise` is kept as the shorthand it was, and folded into the same list, so the two
   * cannot disagree about what was tendered. §269ST is asked about the CASH subset only, which is
   * what the section is about.
   */
  const tenders = [
    ...(input.tenders ?? []),
    ...(input.cashTenderPaise !== undefined && input.cashTenderPaise > 0
      ? [{ mode: "cash" as const, amountPaise: input.cashTenderPaise }]
      : []),
  ];
  const tenderedPaise = tenders.reduce((sum, t) => sum + t.amountPaise, 0);
  /**
   * CLOSE REVIEW (MINOR 4) — an OVER-tender used to become a silent patient-level advance: the
   * surplus sat on the receipt as unallocated money and no refund was requested, which is exactly
   * what §3A says must not happen ("never held as credit for next time"). The deposit lane was
   * guarded and this one was not. A counter takes the money and gives change, so the tender it
   * RECORDS is what is being applied; anything above the bill is a typo, and the fix is to say so
   * rather than to quietly bank it.
   */
  if (tenderedPaise > composed.expectedNetPaise) {
    throw new OtError(
      "deposit_shortfall",
      `tendered ${String(tenderedPaise)}p against a ${String(composed.expectedNetPaise)}p bill — record what is being applied, and give the change`,
      { tenderedPaise, netPayablePaise: composed.expectedNetPaise },
    );
  }
  const cashPaise = tenders.filter((t) => t.mode === "cash").reduce((sum, t) => sum + t.amountPaise, 0);

  // F24e — BEFORE the invoice, because a refused tender must not leave an issued bill behind.
  if (cashPaise > 0) {
    await assertCashWithinEncounterLimit(db, input.encounterId, encounter.encounterNo, cashPaise);
  }

  /**
   * ═══ A29 — THE HOLDS ON *THIS* ENCOUNTER, PLANNED BEFORE THE INVOICE AND APPLIED INSIDE IT ═══
   *
   * `settleFromReceipts` (Plan 15 T7's billing seam) allocates each hold in the SAME transaction
   * that writes the invoice, so the bill is never momentarily unsettled and billing's D2 step 3
   * invariant is untouched. Oldest hold first — a patient who paid twice has the earlier money spent
   * first, which is what a ledger reader expects and what makes a partial refund's arithmetic
   * legible.
   *
   * It is the ENCOUNTER's holds and never `advanceOf`: a patient with a deposit on two encounters
   * has two deposits, and spending one on the other's bill is F3's finding at the settlement end.
   */
  const holds = (await withTx(db, (tx) => openHolds(tx, input.encounterId)))
    .sort((a, b) => a.heldAt.getTime() - b.heldAt.getTime());
  let toSettle = Math.max(0, composed.expectedNetPaise - tenderedPaise);
  const settleFromReceipts: { receiptId: string; amountPaise: number }[] = [];
  let plannedFromHolds = 0;
  for (const hold of holds) {
    if (toSettle <= 0) break;
    const amount = Math.min(hold.amountPaise, toSettle);
    settleFromReceipts.push({ receiptId: hold.receiptId, amountPaise: amount });
    plannedFromHolds += amount;
    toSettle -= amount;
  }

  // MINOR 1 — the SAME clock prices the preview and the invoice. A caller passing an explicit `now`
  // (a backdated settlement) otherwise priced `expectedNetPaise` against one tariff version and the
  // invoice against another, and the mismatch surfaced as `unsettled_issue_refused`.
  const result = await issueInvoice(db, actor, {
    draftId: newId(),
    patientId: composed.patientId,
    encounterId: encounter.encounterNo,
    lines: composed.lines,
    ...(settleFromReceipts.length > 0 ? { settleFromReceipts } : {}),
    ...(tenders.length > 0 ? { receipt: { tenders, note: input.note } } : {}),
  }, now);
  const allocated = result.allocatedPaise + result.settledFromHeldPaise;

  /**
   * ═══ THE HOLDS CLOSE HERE, AND ONLY AFTER THE INVOICE EXISTS ═══
   *
   * Every open hold is disposed of by this call — spent into the invoice above, or returned as the
   * `excess` refund request below — so all of them close, with the invoice named as the reason.
   * Without this the earmark outlived the money: `heldPaise()` kept reporting a deposit that
   * billing had already allocated, which is the number DD12's booking gate and the `excess` refund
   * arithmetic both read (see bill.test.ts `F-settle`).
   *
   * AFTER `issueInvoice`, never before: releasing first and then failing to issue would drop the
   * earmark while the money sat unspent, which is the strictly worse direction. A crash in the gap
   * leaves a hold open over a settled invoice — recoverable, and exactly the state that shipped
   * before this line existed, because a re-settle is refused by billing's own allocation guard
   * rather than double-spending the receipt.
   *
   * MINOR 3 — and the REFUND is raised first. The two used to run the other way round, so a throw
   * inside `requestRefund` (an approval type missing, a validation refusal) left the holds released
   * with no refund raised behind them: the patient's money unearmarked and nobody asked to return
   * it. Raising the request first means the worse failure is a refund request over holds that are
   * still open, which a human reading either row can see.
   */
  /**
   * CLOSE REVIEW (MINOR 2) — `heldPaise` is summed from the SAME `holds` read that planned the
   * settlement, not from `composed.heldPaise`, which was a separate earlier query. A hold released
   * between the two produced a refund request for money that was no longer earmarked.
   */
  const heldAtSettlement = holds.reduce((sum, h) => sum + h.amountPaise, 0);
  const excess = heldAtSettlement - plannedFromHolds;
  let refundApprovalId: string | null = null;
  if (excess > 0) {
    /**
     * CLOSE REVIEW (MINOR 5) — §3A's third-party payer is carried into the reason.
     *
     * `ot_deposit_holds.paid_by` records who actually handed over the money (Spike Q6), and
     * `requestRefund` has no payee field: billing captures the payee at VOUCHER time, which is the
     * right moment — the person standing at the counter is who gets paid, and pre-filling a payee
     * from a booking-day note would be worse than not carrying it. What was missing is that the
     * clerk raising the voucher had no way to KNOW a third party paid. The reason line says so, so
     * the fact travels to where the decision is made without pre-empting it.
     */
    const payers = holds
      .map((h) => h.paidBy as { name?: string; relation?: string } | null)
      .filter((p): p is { name?: string; relation?: string } => p !== null && typeof p.name === "string");
    const payerNote = payers.length === 0
      ? ""
      : ` — deposit paid by ${payers.map((p) => `${p.name!}${p.relation === undefined ? "" : ` (${p.relation})`}`).join(", ")}; confirm the payee at the counter (§3A)`;
    const refund = await requestRefund(db, actor, {
      patientId: composed.patientId, kind: "advance_refund", amountPaise: excess,
      reason: `day-care deposit exceeded the discharge bill for ${encounter.encounterNo}${payerNote}`,
      reasonClass: "genuine",
    });
    refundApprovalId = refund.approvalId;
  }
  await withTx(db, (tx) => releaseHolds(tx, input.encounterId, `settled against ${result.invoiceNo}`));

  // A28 — the divergences, evented once the invoice exists so the event can name the line's price.
  for (const divergence of composed.divergences) {
    const line = composed.implantLines.find((l) => l.ledgerEntryId === divergence.ledgerEntryId);
    if (line === undefined) continue;
    await withTx(db, (tx) => appendEvent(tx, materialCeilingDiverged.make({
      actor, patientId: composed.patientId, encounterId: input.encounterId,
      payload: {
        encounterId: input.encounterId, ledgerEntryId: divergence.ledgerEntryId,
        itemId: line.serviceCode,
        frozenCeilingPaisePerBase: divergence.frozen,
        derivedCeilingPaisePerBase: divergence.derived,
        invoicedUnitPaise: line.capUnitPaise,
      },
    })));
  }

  return {
    invoiceId: result.invoiceId, invoiceNo: result.invoiceNo,
    netPayablePaise: result.totals.netPayablePaise, allocatedPaise: allocated,
    refundApprovalId, refundPaise: excess > 0 ? excess : 0,
    handoffUnbilled: composed.handoffUnbilled, unreturnedIssues: composed.unreturnedIssues,
  };
}

/**
 * §11.11's orphan report, OT-side. The daily close's own `orphanScan` reads `opd_encounters` only
 * and its widening is routed to 16c with the chargeables spine (DD11), so a discharged day-care
 * encounter with no invoice is reported HERE or by nobody.
 */
export async function unbilledDaycare(
  db: Db, day: string,
): Promise<{ encounterId: string; encounterNo: string; outcome: string | null }[]> {
  return (await db.execute(sql`
    select e.id as "encounterId", e.encounter_no as "encounterNo", e.outcome as "outcome"
      from daycare_encounters e
     where e.outcome in ('discharged', 'converted', 'absconded', 'deceased')
       and (e.discharged_at::date = ${day}::date or e.converted_at::date = ${day}::date
            or e.updated_at::date = ${day}::date)
       and not exists (select 1 from invoices i where i.encounter_id = e.encounter_no)
     order by e.encounter_no
  `)).rows as { encounterId: string; encounterNo: string; outcome: string | null }[];
}
