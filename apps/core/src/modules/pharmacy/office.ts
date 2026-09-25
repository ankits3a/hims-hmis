import {
  billDraftFromGrn, getPurchaseOrder, listPaymentRuns, listPurchaseOrders, listSupplierBills, overduePurchaseOrders, payables,
  planPaymentRun, purchaseOrdersAwaiting, unbilledGrns,
} from "../materials";
import { loadOpdConfig } from "../opd";
import { esc } from "../../kernel/printing/render";
import { planPurchaseDrafts } from "./purchase-drafts";
import { listOpenShortBook } from "./short-book";
import type { BillDraft, BillSummary, PayableRow, PoSummary, RunSummary, UnbilledGrn } from "../materials";
import type { ShortBookView } from "./short-book";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { RenderedDocument } from "../../kernel/printing/render";

/**
 * ═══ PARITY P2 — THE BACK OFFICE'S "NEEDS YOU TODAY" ═══
 *
 * `/pharmacy/office` opens on this (the Desk One pattern): what a pharmacist in charge or the
 * materials head has to act on, each card opening its sheet. It FEDERATES — the orders are
 * materials', the short book is the counter's, the approvals are the kernel's — and owns nothing.
 *
 *   - `awaitingYou`: orders pending an approval this person may give (the approvals worklist, never
 *     one they raised);
 *   - `drafts`: drafts to review and submit, the agent's included;
 *   - `waiting`: orders pending somebody else's approval;
 *   - `toReceive`: approved, sent and part-received orders — the GRN desk's list;
 *   - `overdue`: the subset of those past their expected date;
 *   - `shortages`: the counter's open short book;
 *   - `plan`: how much the agent would draft now, so the "make the drafts" card says it before it acts.
 */
export type OfficeToday = {
  awaitingYou: PoSummary[];
  drafts: PoSummary[];
  waiting: PoSummary[];
  toReceive: PoSummary[];
  overdue: PoSummary[];
  shortages: ShortBookView[];
  plan: { orders: number; lines: number; unassigned: number; unmatched: number; alreadyDrafted: number };
};

export async function officeToday(db: Db, actor: Actor, now: Date = new Date()): Promise<OfficeToday> {
  const [awaitingYou, drafts, pending, toReceive, overdue, shortages, plan] = await Promise.all([
    purchaseOrdersAwaiting(db, actor),
    listPurchaseOrders(db, actor, { statuses: ["draft"] }),
    listPurchaseOrders(db, actor, { statuses: ["pending_approval"] }),
    listPurchaseOrders(db, actor, { statuses: ["approved", "sent", "part_received"] }),
    overduePurchaseOrders(db, actor, now),
    listOpenShortBook(db),
    planPurchaseDrafts(db, now),
  ]);
  const mine = new Set(awaitingYou.map((p) => p.id));
  return {
    awaitingYou, drafts, waiting: pending.filter((p) => !mine.has(p.id)), toReceive, overdue, shortages,
    plan: {
      orders: plan.groups.length, lines: plan.groups.reduce((s, g) => s + g.lines.length, 0),
      unassigned: plan.unassigned.length, unmatched: plan.unmatched.length, alreadyDrafted: plan.alreadyDrafted.length,
    },
  };
}

const rupees = (paise: number): string => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const dayLabel = (d: string | null): string => d === null ? "—" : `${d.slice(8, 10)}-${MONTHS[Number(d.slice(5, 7)) - 1] ?? ""}-${d.slice(0, 4)}`;

/**
 * THE PURCHASE ORDER ON PAPER — A4, self-contained HTML, printed from the office sheet and saved as
 * PDF by the browser (the OPD report's path: the production image has no browser to make a PDF
 * with). Only an approved order prints as an order; a draft prints marked DRAFT so a paper copy can
 * never be mistaken for an authorised one.
 */
export async function purchaseOrderDocument(db: Db, actor: Actor, poId: string): Promise<RenderedDocument> {
  const po = await getPurchaseOrder(db, actor, poId);
  const letterhead = (await loadOpdConfig(db)).letterhead;
  const authorised = ["approved", "sent", "part_received", "received"].includes(po.status);
  const approver = po.approvedBy === null ? "" : (po.names[po.approvedBy] ?? po.approvedBy);
  const rows = po.lines.map((l, i) => `<tr>
      <td>${String(i + 1)}</td><td>${esc(l.itemName)}<div class="c">${esc(l.itemCode)}</div></td>
      <td>${esc(l.uom)} of ${String(l.multiplier)}</td><td class="n">${String(l.qtyPacks)}</td><td class="n">${l.freePacks === 0 ? "—" : String(l.freePacks)}</td>
      <td class="n">${rupees(l.ratePaise)}</td><td class="n">${(l.gstRateBps / 100).toFixed(l.gstRateBps % 100 === 0 ? 0 : 2)}%</td>
      <td class="n">${l.mrpPaise === null ? "—" : rupees(l.mrpPaise)}</td><td class="n">${rupees(l.lineTotalPaise)}</td></tr>`).join("");
  const body = `
  ${authorised ? "" : `<div class="stamp">DRAFT — NOT AN ORDER (${esc(po.status.replace("_", " "))})</div>`}
  <header><div><div class="nm">${esc(letterhead.name)}</div>
    <div class="ad">${letterhead.legalName === undefined ? "" : `A unit of ${esc(letterhead.legalName)}<br>`}${letterhead.addressLines.map(esc).join("<br>")}${letterhead.gstin === undefined ? "" : `<br>GSTIN ${esc(letterhead.gstin)}`}</div></div>
    <div class="t"><h1>Purchase Order</h1><div>${esc(po.poNo)}</div><div>${dayLabel(po.createdAt.slice(0, 10))}</div></div></header>
  <section class="two"><div><b>To</b><br>${esc(po.vendorName)}<br>${po.vendorGstin === null ? "" : `GSTIN ${esc(po.vendorGstin)}`}</div>
    <div><b>Deliver to</b><br>${esc(po.storeName)} (${esc(po.storeCode)})<br>Expected by ${dayLabel(po.expectedDate)}</div></section>
  <table><thead><tr><th>#</th><th>Item</th><th>Pack</th><th class="n">Qty</th><th class="n">Free</th><th class="n">Rate ₹</th><th class="n">GST</th><th class="n">MRP ₹</th><th class="n">Amount ₹</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="8" class="n">Taxable value</td><td class="n">${rupees(po.subtotalPaise)}</td></tr>
  <tr><td colspan="8" class="n">GST</td><td class="n">${rupees(po.gstPaise)}</td></tr>
  <tr class="tot"><td colspan="8" class="n">Total</td><td class="n">${rupees(po.totalPaise)}</td></tr></tfoot></table>
  ${po.terms === null ? "" : `<p><b>Terms.</b> ${esc(po.terms)}</p>`}
  <p class="small">Supply batch number, expiry and MRP on the invoice for every line. Goods short-dated, damaged or above the MRP stated are refused at the gate. Quantities above the order are not accepted.</p>
  <footer><div>${authorised ? `Approved by ${esc(approver)}` : ""}</div><div>Authorised signatory · ${esc(letterhead.legalName ?? letterhead.name)}</div></footer>`;
  const css = `@page{size:210mm 297mm;margin:14mm}body{font-family:"Segoe UI",Arial,"Nirmala UI",sans-serif;font-size:11px;color:#111;margin:0}
  header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:10px}
  .nm{font-size:16px;font-weight:700}.ad{font-size:10px}.t{text-align:right}.t h1{margin:0;font-size:18px}
  .two{display:flex;justify-content:space-between;gap:20px;margin-bottom:10px}
  table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ccc;padding:4px;text-align:left;vertical-align:top}
  .n{text-align:right}.c{color:#555;font-size:9px}.tot td{font-weight:700;border-top:2px solid #111}
  .small{font-size:9px;color:#444}footer{display:flex;justify-content:space-between;margin-top:40px}
  .stamp{border:2px solid #b00;color:#b00;font-weight:700;text-align:center;padding:4px;margin-bottom:8px;-webkit-print-color-adjust:exact}`;
  const title = `${po.poNo} — ${po.vendorName}`;
  return {
    title,
    page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`,
  };
}

/**
 * ═══ PARITY P3 — THE OFFICE'S "PAY" SIDE: WHAT NEEDS PAYING ATTENTION TODAY ═══
 *
 * Federates materials' payables, as `officeToday` federates its orders:
 *
 *   - `toMatch`: posted challans no bill names yet — each opens a bill the agent prefilled;
 *   - `drafts`: bills entered and not yet matched;
 *   - `held`: bills held outside the match tolerance, waiting for the head's accept-the-difference;
 *   - `matched`: matched bills one keystroke from being booked;
 *   - `dueThisWeek` / `overdue`: accepted bills by due date (MSME first on both);
 *   - `runs`: runs in draft, awaiting the owner's authorisation, and authorised but not yet paid;
 *   - `plan`: what the agent would put on a run now, so its card says it before a person presses.
 */
export type OfficePay = {
  toMatch: UnbilledGrn[];
  drafts: BillSummary[];
  held: BillSummary[];
  matched: BillSummary[];
  dueThisWeek: PayableRow[];
  overdue: PayableRow[];
  runs: RunSummary[];
  outstandingPaise: number;
  overduePaise: number;
  plan: { vendors: number; bills: number; totalPaise: number; blocked: number; until: string };
};

const msmeFirst = (a: PayableRow, b: PayableRow): number =>
  Number(b.msme) - Number(a.msme) || (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.billNo.localeCompare(b.billNo);

export async function officePay(db: Db, actor: Actor, now: Date = new Date()): Promise<OfficePay> {
  const [toMatch, bills, book, runs, plan] = await Promise.all([
    unbilledGrns(db, actor),
    listSupplierBills(db, actor, { statuses: ["draft", "held_for_match", "matched"] }),
    payables(db, actor, now),
    listPaymentRuns(db, actor, { statuses: ["draft", "pending_authorisation", "authorised"] }),
    planPaymentRun(db, now),
  ]);
  return {
    toMatch,
    drafts: bills.filter((b) => b.status === "draft"),
    held: bills.filter((b) => b.status === "held_for_match"),
    matched: bills.filter((b) => b.status === "matched"),
    dueThisWeek: book.bills.filter((b) => b.overdueDays === 0 && b.dueDate !== null && b.dueDate <= plan.until).sort(msmeFirst),
    overdue: book.bills.filter((b) => b.overdueDays > 0).sort(msmeFirst),
    runs,
    outstandingPaise: book.totalOutstandingPaise,
    overduePaise: book.overduePaise,
    plan: {
      vendors: plan.groups.length, bills: plan.groups.reduce((s, g) => s + g.bills.length, 0), totalPaise: plan.totalPaise,
      blocked: plan.blocked.length, until: plan.until,
    },
  };
}

/**
 * The agent's bill for a GRN, with the hospital's GSTIN state (the letterhead's) so an out-of-state
 * vendor's bill is prefilled as IGST. Writes nothing.
 */
export async function officeBillDraft(db: Db, actor: Actor, grnId: string): Promise<BillDraft> {
  const gstin = (await loadOpdConfig(db)).letterhead.gstin;
  return billDraftFromGrn(db, actor, grnId, { hospitalStateCode: gstin === undefined ? null : gstin.slice(0, 2) });
}
