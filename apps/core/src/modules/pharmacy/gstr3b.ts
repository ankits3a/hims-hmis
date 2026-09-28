import { gstr1Summary } from "../billing";
import { purchaseRegister } from "../materials";
import { REPORTS_READ, reportRange, reportToday, requireReportPermission } from "./report-range";
import type { ReportInput } from "./sales-register";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ GAP CLOSURE A4 (2026-09-28) — THE MONTH'S GSTR-3B, FROM THE BOOKS THE HOSPITAL ALREADY KEEPS ═══
 *
 * The owner's Healthray audit found GSTR-1 (billing's day close) and the GSTR-2B reconciliation (P5), but
 * not the return that is actually paid: GSTR-3B. This builds its figures for a period, READ-ONLY:
 *
 *   3.1(a)  outward taxable supplies  — every live invoice line of the hospital (not only the pharmacy's:
 *                                       a return is per GSTIN) with a rate above 0, net of credit notes,
 *                                       exactly as `gstr1Summary` folds them. IGST is 0: every sale here
 *                                       is intra-state.
 *   3.1(c)  nil-rated and exempt      — the exempt lines (healthcare services) and the 0% lines.
 *   4(A)(5) ITC, all other            — the input tax on supplier bills booked as payable in the period.
 *   4(B)(2) ITC reversed              — the tax on our debit notes (goods returned to the supplier).
 *   6.1     tax payable               — output tax set off against ITC in the order rule 88A of the CGST
 *                                       Rules fixes: IGST credit first (here to CGST, then SGST — there is
 *                                       no IGST liability), then CGST credit against CGST and SGST against
 *                                       SGST. CGST and SGST credit never cross. What is left is paid in cash
 *                                       or carried forward, per head.
 *
 * ═══ WHAT IT DOES NOT CLAIM TO BE ═══
 *
 * It is the books' view. The ITC a hospital may claim is capped by what its suppliers filed (GSTR-2B), which
 * is why the note sends the accountant to the GSTR-2B reconciliation first. A vendor's credit note carries no
 * tax split in our books (`supplier_credit_notes.amount_paise`), so its reversal is not computed; the report
 * lists the total so the accountant can reverse it by hand. Filing stays the accountant's act on the portal.
 */

export type Gstr3bHeads = { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number };
export type Gstr3b = {
  from: string; to: string; preset: string;
  /** 3.1(a) and 3.1(c). */
  outward: { taxable: Gstr3bHeads; nilExempt: { taxablePaise: number }; byRate: { rateBps: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }[] };
  /** 4(A)(5), 4(B)(2) and the net. */
  itc: { available: Gstr3bHeads; reversed: Gstr3bHeads; net: { igstPaise: number; cgstPaise: number; sgstPaise: number }; bills: number; debitNotes: number };
  /** Vendor credit notes of the period — no tax split in the books, so not reversed here. */
  creditNotesUnsplitPaise: number;
  /** 6.1 after rule 88A's set-off. */
  payable: {
    igst: SetOff; cgst: SetOff; sgst: SetOff;
    cashPaise: number;
  };
};
/** One head of 6.1: the liability, what each credit paid of it, the cash still due, and credit left over. */
export type SetOff = { liabilityPaise: number; byIgstPaise: number; byOwnPaise: number; cashPaise: number; carryForwardPaise: number };

/**
 * Rule 88A. The IGST credit is used first, and — with no IGST liability — it pays CGST and SGST "in any order
 * and in any proportion"; it is spent on the head its own credit cannot cover first, so the cash is least.
 * Then each of CGST and SGST credit pays its own head. Exported for the test that pins the order.
 */
export function setOff(liability: { igst: number; cgst: number; sgst: number }, credit: { igst: number; cgst: number; sgst: number }): Gstr3b["payable"] {
  let igst = credit.igst;
  const onIgst = Math.min(igst, liability.igst); igst -= onIgst;
  const shortC = Math.max(0, liability.cgst - credit.cgst);
  const shortS = Math.max(0, liability.sgst - credit.sgst);
  let toC = Math.min(igst, shortC); igst -= toC;
  let toS = Math.min(igst, shortS); igst -= toS;
  // IGST credit must be exhausted before own credit is touched: any left goes on the remaining liability.
  const moreC = Math.min(igst, liability.cgst - toC); toC += moreC; igst -= moreC;
  const moreS = Math.min(igst, liability.sgst - toS); toS += moreS; igst -= moreS;
  const head = (l: number, byIgst: number, own: number): SetOff => {
    const left = l - byIgst;
    const byOwn = Math.min(left, own);
    return { liabilityPaise: l, byIgstPaise: byIgst, byOwnPaise: byOwn, cashPaise: left - byOwn, carryForwardPaise: own - byOwn };
  };
  const i = { liabilityPaise: liability.igst, byIgstPaise: onIgst, byOwnPaise: 0, cashPaise: liability.igst - onIgst, carryForwardPaise: igst };
  const c = head(liability.cgst, toC, credit.cgst);
  const s = head(liability.sgst, toS, credit.sgst);
  return { igst: i, cgst: c, sgst: s, cashPaise: i.cashPaise + c.cashPaise + s.cashPaise };
}

export async function gstr3bReport(db: Db, actor: Actor, input: ReportInput, now: Date = new Date()): Promise<Gstr3b> {
  await requireReportPermission(db, actor, REPORTS_READ, "the GSTR-3B summary");
  const range = reportRange(input.preset ?? "month", reportToday(now), input);

  const taxable: Gstr3bHeads = { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
  let nil = 0;
  const byRate = new Map<number, { rateBps: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }>();
  for (const r of await gstr1Summary(db, range.from, range.to)) {
    if (r.exempt || r.rateBps === 0) { nil += r.taxableBasePaise; continue; }
    taxable.taxablePaise += r.taxableBasePaise; taxable.cgstPaise += r.cgstPaise; taxable.sgstPaise += r.sgstPaise;
    const b = byRate.get(r.rateBps) ?? { rateBps: r.rateBps, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    b.taxablePaise += r.taxableBasePaise; b.cgstPaise += r.cgstPaise; b.sgstPaise += r.sgstPaise;
    byRate.set(r.rateBps, b);
  }

  const book = await purchaseRegister(db, range.from, range.to);
  const heads = (m: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number }): Gstr3bHeads =>
    ({ taxablePaise: m.taxablePaise, igstPaise: m.igstPaise, cgstPaise: m.cgstPaise, sgstPaise: m.sgstPaise });
  const available = heads(book.totals.bills);
  const reversed = heads(book.totals.debitNotes);
  const net = {
    igstPaise: Math.max(0, available.igstPaise - reversed.igstPaise),
    cgstPaise: Math.max(0, available.cgstPaise - reversed.cgstPaise),
    sgstPaise: Math.max(0, available.sgstPaise - reversed.sgstPaise),
  };

  return {
    from: range.from, to: range.to, preset: range.preset,
    outward: { taxable, nilExempt: { taxablePaise: nil }, byRate: [...byRate.values()].sort((a, b) => a.rateBps - b.rateBps) },
    itc: { available, reversed, net, bills: book.totals.bills.count, debitNotes: book.totals.debitNotes.count },
    creditNotesUnsplitPaise: book.totals.creditNotes.totalPaise,
    payable: setOff(
      { igst: taxable.igstPaise, cgst: Math.max(0, taxable.cgstPaise), sgst: Math.max(0, taxable.sgstPaise) },
      { igst: net.igstPaise, cgst: net.cgstPaise, sgst: net.sgstPaise },
    ),
  };
}
