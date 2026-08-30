import { eq, inArray } from "drizzle-orm";
import { invoices, orders } from "../../kernel/db/schema";
import { invoiceSettlement } from "../billing";
import { billedLabLines } from "./money";
import { LabError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 17b T7 / DD6, **DD23** — **THE DELIVERY INTERLOCK**, and it is INVOICE-grained.
 *
 * ═══ THE ONE FUNCTION, AND NOBODY RE-DERIVES IT FROM INVOICES (CONTRACT §6.5) ═══
 *
 * 22c-F's patient app, 24a's rider app and 18a all call this. A second answer to "may this document
 * leave the building" is how one surface hands over a report another surface is holding.
 *
 * ═══ WHY INVOICE-GRAINED, WHICH IS DD23 AND CORRECTS T7 A1 AS AUTHORED ═══
 *
 * `settlementState` is a PURE function of three numbers about ONE INVOICE, and the only exported
 * reader is `invoiceSettlement(exec, invoiceId)`: **there is no line-grained settlement in this
 * system.** So a mixed invoice — a consultation plus two lab lines — that is half paid HOLDS the
 * lab report until it settles. That OVER-blocks and never UNDER-blocks, and the alternative is
 * worse than the inconvenience: attributing a partial payment to particular lines is an allocation
 * policy this hospital deliberately does not have, and inventing one inside the laboratory would
 * put a second answer beside billing's on a question about money.
 *
 * **What its sum does not include, named because the close review will ask (§9.6):** it sums
 * nothing. It asks `invoiceSettlement` per invoice and takes billing's verdict, so it inherits
 * exactly billing's blind spots and adds none — an `entered_in_error` invoice still reads
 * `unpaid` here (it is `patientOutstandingPaise` that excludes those), a DEPOSIT held against a
 * future bill is not an allocation, and money taken at another counter and not yet allocated is
 * unallocated. Every one of those errs towards HOLDING the document.
 *
 * ═══ AND THE SENTENCE THIS FILE'S CALLER MUST NOT GET WRONG ═══
 *
 * **The doctor's read never calls this.** `listResultsForEncounter` returns verified results for an
 * unpaid self-pay order and the critical-value CALL never consults it either. The interlock holds a
 * DOCUMENT; it has never held a fact, and 02 O-1 forbids the other thing.
 */

/** DD6 — the payers whose bills are settled by an institution, never at the report counter. */
export const EXEMPT_PAYERS: readonly string[] = ["tpa", "pmjay", "corporate"];

/**
 * DD6 / Plan 15 DD2 — a day-care encounter's money is settled at DISCHARGE, in one bill for the
 * whole episode. Holding its lab report at the counter would hold it against a bill nobody has
 * composed yet, so the `D` prefix delivers like an exempt payer and for the same reason.
 */
export const EXEMPT_ENCOUNTER_PREFIXES: readonly string[] = ["D"];

export type DeliveryVerdict = {
  allowed: boolean;
  reason: "unpaid_invoices" | "exempt_payer" | "settled" | "released_by_approval";
  /** DD23 — INVOICES, not lines. The counter shows the patient which bills to clear. */
  unpaidInvoiceIds: string[];
  outstandingPaise: number;
};

/**
 * MAY THIS ORDER'S REPORT BE HANDED OVER?
 *
 * `releasedByApproval` is the caller's fact — `reports.ts` reads the granted `lab_release_unpaid`
 * approval and passes it in — rather than a second approval lookup here. One reader of the approval
 * register, and this function stays answerable for money alone.
 */
export async function deliveryAllowed(
  exec: Db | Tx,
  orderId: string,
  opts: { releasedByApproval?: boolean } = {},
): Promise<DeliveryVerdict> {
  const [order] = await (exec as Db)
    .select({ encounterNo: orders.encounterNo })
    .from(orders).where(eq(orders.id, orderId));
  if (!order) throw new LabError("unknown_item", `no order ${orderId}`);

  /**
   * ═══ CLOSE REVIEW PASS 2, F22 / PASS 1's §9 ANSWER — THE GRAIN IS THE CLINICAL ACT ═══
   *
   * DD23 made the interlock invoice-grained over ONE ORDER's lab lines, and pass 1's answer to the
   * §9 brief found the charge that leaves out: **the reflex's own.** DD9 makes a reflex a NEW ORDER
   * with its own credit invoice, so a TSH paid ₹300 in cash reflexing an unpaid FT4 left
   * `deliveryAllowed(the TSH order)` reading `settled` while ₹450 stood — same patient, same tube,
   * same visit, minutes apart, and the counter hands the TSH report over.
   *
   * **DD23 is AMENDED to the ORDER GROUP**, which is phase 0 DD2's "one clinical act": the set of
   * orders a patient is collecting reports for. It over-blocks — a paid CBC is held while an unpaid
   * reflex on the same act stands — and DD23's own ruling is that over-blocking is the safe
   * direction, because the alternative is handing over a document against money the hospital has
   * not been paid. A counter clerk reads "₹450 outstanding on this visit's tests", which is a
   * sentence they can act on at the cash window.
   *
   * Recorded as §9.2 F45 and in the gate report as a ruling made at close review under the owner's
   * standing rule: when confused, take the most logical Indian-corporate-hospital choice.
   */
  const [group] = await (exec as Db)
    .select({ orderGroupId: orders.orderGroupId }).from(orders).where(eq(orders.id, orderId));
  const siblings = group === undefined ? [orderId] : (await (exec as Db)
    .select({ id: orders.id }).from(orders)
    .where(eq(orders.orderGroupId, group.orderGroupId))).map((o) => o.id);

  const lines = (await Promise.all(siblings.map((id) => billedLabLines(exec, id)))).flat();
  const invoiceIds = [...new Set(lines.map((l) => l.invoiceId).filter((id): id is string => id !== null))];

  /**
   * NOTHING WAS BILLED ⇒ NOTHING IS OWED. An order whose every item carries no invoice line is a
   * report with no money behind it, and holding it would hold it for ever.
   */
  if (invoiceIds.length === 0) {
    return { allowed: true, reason: "settled", unpaidInvoiceIds: [], outstandingPaise: 0 };
  }

  const rows = await (exec as Db)
    .select({ id: invoices.id, intendedPayer: invoices.intendedPayer })
    .from(invoices).where(inArray(invoices.id, invoiceIds));

  /**
   * ═══ THE PAYER BRANCH IS PER INVOICE, AND EVERY INVOICE MUST QUALIFY (T7 A2) ═══
   *
   * A reflex test billed to the patient on a second, self-pay invoice does not become the TPA's
   * because the desk invoice was. `every` rather than `some`: the exemption is a statement about
   * who settles the whole of this order, and one self-pay line is one bill somebody owes.
   */
  /**
   * ═══ THE WHOLE SERIES PREFIX, EXACTLY — CLOSE REVIEW PASS 2, F13 ═══
   *
   * m8 replaced `startsWith("D")` with `includes(slice(0,1))` and the two are IDENTICAL for the
   * hazard it named (`"DC2608300001"` matches both), while the change quietly broke the opposite
   * case: a future multi-letter exempt prefix (`"DC"`) would have matched `startsWith` and cannot
   * match a one-character slice. The fix inverted its own justification.
   *
   * An episode number is `<PREFIX><YYMMDD><4 digits>` (`series.ts`'s `formatEpisodeNo`), so the
   * prefix is the leading letters and nothing else. Extracting it and comparing for EQUALITY is
   * right in both directions: `"D"` never matches `"DC…"`, and a `"DC"` entry would.
   */
  const seriesPrefix = /^[A-Z]+/.exec(order.encounterNo)?.[0] ?? "";
  const exemptByEncounter = EXEMPT_ENCOUNTER_PREFIXES.includes(seriesPrefix);
  const exemptByPayer = rows.length > 0 && rows.every((r) => EXEMPT_PAYERS.includes(r.intendedPayer));
  if (exemptByEncounter || exemptByPayer) {
    return { allowed: true, reason: "exempt_payer", unpaidInvoiceIds: [], outstandingPaise: 0 };
  }

  const unpaid: string[] = [];
  let outstandingPaise = 0;
  for (const row of rows) {
    const settlement = await invoiceSettlement(exec, row.id);
    if (settlement.state !== "settled") {
      unpaid.push(row.id);
      outstandingPaise += settlement.outstandingPaise;
    }
  }

  if (unpaid.length === 0) {
    return { allowed: true, reason: "settled", unpaidInvoiceIds: [], outstandingPaise: 0 };
  }
  /**
   * THE APPROVAL RELEASES THE DOCUMENT AND CHANGES NOTHING ABOUT THE MONEY (T7 A4). The unpaid
   * invoices are still named and the outstanding is still reported, because `billing_manager` is
   * carrying a receivable, not writing one off.
   */
  if (opts.releasedByApproval === true) {
    return { allowed: true, reason: "released_by_approval", unpaidInvoiceIds: unpaid, outstandingPaise };
  }
  return { allowed: false, reason: "unpaid_invoices", unpaidInvoiceIds: unpaid, outstandingPaise };
}
