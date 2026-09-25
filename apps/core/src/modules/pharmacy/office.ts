import {
  billDraftFromGrn, draftReturnFromRecall, draftSupplierReturns, expiryReport, getPurchaseOrder, getRecall, getSupplierReturn, getWriteOff,
  listPaymentRuns, listPurchaseOrders, listRecalls, listSupplierBills, listSupplierReturns, overduePurchaseOrders, payables,
  planPaymentRun, planSupplierReturns, purchaseOrdersAwaiting, unbilledGrns, vendorCredits, writeOffsAwaitingApproval, writeOffsReadyToPost,
} from "../materials";
import { loadOpdConfig } from "../opd";
import { getPatientSummaries } from "../patients";
import { esc } from "../../kernel/printing/render";
import { planPurchaseDrafts } from "./purchase-drafts";
import { listOpenShortBook } from "./short-book";
import type {
  BillDraft, BillSummary, PayableRow, PoSummary, RecallSummary, RecallView, ReturnSummary, ReturnView, RunSummary, UnbilledGrn, WriteOffSummary,
} from "../materials";
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
  /** PARITY P4 — `creditPaise`: vendor credit the draft sets off; `covered`: vendors whose credit covers all they are owed. */
  plan: { vendors: number; bills: number; totalPaise: number; blocked: number; until: string; creditPaise: number; covered: number };
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
      blocked: plan.blocked.length, until: plan.until, creditPaise: plan.creditPaise, covered: plan.coveredByCredit.length,
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

// ═══════════════════════════ PARITY P4 — THE OFFICE'S "RETURNS" SIDE ═══════════════════════════

/**
 * ═══ WHAT NEEDS RETURNING, DESTROYING OR CHASING TODAY ═══
 *
 * Federates materials' expiry list, returns, write-offs and recalls, as the buy and pay sides do:
 *
 *   - `expiring`: every store's batches expired, and expiring within 30 / 60 / 90 days, with value;
 *   - `plan`: what the agent would draft now (one return per vendor) and what can only be destroyed;
 *   - `drafts` (to approve), `toDispatch` (approved), `awaitingCredit` (dispatched, no credit note yet);
 *   - `writeOffsAwaiting` (the superintendent's approval) and `writeOffsToPost` (granted, hand over);
 *   - `openRecalls`;
 *   - `creditPaise`: vendor credit accepted and not yet spent on a payment run.
 */
export type OfficeReturns = {
  expiring: {
    expired: number; d30: number; d60: number; d90: number;
    expiredValuePaise: number; d30ValuePaise: number; d60ValuePaise: number; d90ValuePaise: number;
  };
  plan: { vendors: number; lines: number; taxablePaise: number; toDestroy: number; toDestroyValuePaise: number };
  drafts: ReturnSummary[];
  toDispatch: ReturnSummary[];
  awaitingCredit: ReturnSummary[];
  writeOffsAwaiting: WriteOffSummary[];
  writeOffsToPost: WriteOffSummary[];
  openRecalls: RecallSummary[];
  creditPaise: number;
};

export async function officeReturns(db: Db, actor: Actor, now: Date = new Date()): Promise<OfficeReturns> {
  const [expired, next90, plan, live, writeOffsAwaiting, writeOffsToPost, openRecalls, credits] = await Promise.all([
    expiryReport(db, actor, { preset: "expired" }, now),
    expiryReport(db, actor, { preset: "90" }, now),
    planSupplierReturns(db, now),
    listSupplierReturns(db, actor, { statuses: ["draft", "approved", "dispatched"] }),
    writeOffsAwaitingApproval(db, actor),
    writeOffsReadyToPost(db, actor),
    listRecalls(db, actor, { statuses: ["open"] }),
    vendorCredits(db),
  ]);
  const within = (days: number) => next90.rows.filter((r) => r.daysToExpiry <= days);
  const value = (rows: { costValuePaise: number }[]): number => rows.reduce((s, r) => s + r.costValuePaise, 0);
  return {
    expiring: {
      expired: expired.rows.length, d30: within(30).length, d60: within(60).length, d90: next90.rows.length,
      expiredValuePaise: value(expired.rows), d30ValuePaise: value(within(30)), d60ValuePaise: value(within(60)), d90ValuePaise: value(next90.rows),
    },
    plan: {
      vendors: plan.groups.length, lines: plan.groups.reduce((s, g) => s + g.lines.length, 0), taxablePaise: plan.taxablePaise,
      toDestroy: plan.toDestroy.length, toDestroyValuePaise: plan.toDestroy.reduce((s, d) => s + d.valuePaise, 0),
    },
    drafts: live.filter((r) => r.status === "draft"),
    toDispatch: live.filter((r) => r.status === "approved"),
    awaitingCredit: live.filter((r) => r.status === "dispatched"),
    writeOffsAwaiting, writeOffsToPost, openRecalls,
    creditPaise: [...credits.values()].reduce((s, c) => s + Math.max(0, c.acceptedPaise - c.appliedPaise), 0),
  };
}

/** The hospital's GSTIN state (the letterhead's), so an out-of-state vendor's debit note reverses IGST. */
async function hospitalStateCode(db: Db): Promise<string | null> {
  const gstin = (await loadOpdConfig(db)).letterhead.gstin;
  return gstin === undefined ? null : gstin.slice(0, 2);
}

/** The person's press of "make the drafts": one DRAFT return per vendor (the ones ticked, or all). */
export async function officeDraftReturns(db: Db, actor: Actor, now: Date, vendorIds?: readonly string[]): Promise<ReturnView[]> {
  return draftSupplierReturns(db, actor, now, { hospitalStateCode: await hospitalStateCode(db), ...(vendorIds === undefined ? {} : { vendorIds }) });
}

/** One tap on a recall: a draft return of the batch to its supplier. */
export async function officeReturnFromRecall(db: Db, actor: Actor, recallId: string, now: Date = new Date()): Promise<ReturnView> {
  return draftReturnFromRecall(db, actor, recallId, now, { hospitalStateCode: await hospitalStateCode(db) });
}

export type OfficeRecall = RecallView & {
  /** The dispensed-to list for the callback: READ-ONLY, one row per consume row, with the patient's name, UHID and phone. */
  patients: Record<string, { uhid: string; name: string | null; phone: string | null; restricted: boolean }>;
};

/**
 * A recall with its callback list: the ledger's `consume` rows of the batch, and the patients they
 * went to — names and phone numbers read ONCE, batched, with the reason written to the PHI access log
 * (FD-25's `withContact`). A restricted patient shows no name and no number.
 */
export async function officeRecall(db: Db, actor: Actor, recallId: string): Promise<OfficeRecall> {
  const recall = await getRecall(db, actor, recallId);
  const ids = [...new Set(recall.dispensed.map((d) => d.patientId).filter((x): x is string => x !== null))];
  const people = ids.length === 0 ? [] : await getPatientSummaries(db, actor, ids, { withContact: { reason: `drug recall ${recall.recallNo} — patient callback` } });
  return {
    ...recall,
    patients: Object.fromEntries(people.map((p) => [p.requestedId, { uhid: p.uhid, name: p.restricted ? null : p.name, phone: p.restricted ? null : (p.phone ?? null), restricted: p.restricted }])),
  };
}

const PRINT_CSS = `@page{size:210mm 297mm;margin:14mm}body{font-family:"Segoe UI",Arial,"Nirmala UI",sans-serif;font-size:11px;color:#111;margin:0}
  header{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:10px}
  .nm{font-size:16px;font-weight:700}.ad{font-size:10px}.t{text-align:right}.t h1{margin:0;font-size:18px}
  .two{display:flex;justify-content:space-between;gap:20px;margin-bottom:10px}
  table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ccc;padding:4px;text-align:left;vertical-align:top}
  .n{text-align:right}.c{color:#555;font-size:9px}.tot td{font-weight:700;border-top:2px solid #111}
  .small{font-size:9px;color:#444}footer{display:flex;justify-content:space-between;margin-top:40px}
  .stamp{border:2px solid #b00;color:#b00;font-weight:700;text-align:center;padding:4px;margin-bottom:8px;-webkit-print-color-adjust:exact}`;

function letterheadBlock(letterhead: { name: string; legalName?: string; addressLines: string[]; gstin?: string }): string {
  return `<div><div class="nm">${esc(letterhead.name)}</div>
    <div class="ad">${letterhead.legalName === undefined ? "" : `A unit of ${esc(letterhead.legalName)}<br>`}${letterhead.addressLines.map(esc).join("<br>")}${letterhead.gstin === undefined ? "" : `<br>GSTIN ${esc(letterhead.gstin)}`}</div></div>`;
}

const qtyText = (qty: number, baseUom: string, pack: { uom: string; multiplier: number } | null): string => {
  if (pack === null || qty < pack.multiplier) return `${String(qty)} ${baseUom}`;
  const packs = Math.floor(qty / pack.multiplier);
  const loose = qty % pack.multiplier;
  return `${String(packs)} ${pack.uom}${loose === 0 ? "" : ` + ${String(loose)} ${baseUom}`} (${String(qty)} ${baseUom})`;
};

const REASON_WORDS: Record<string, string> = { expired: "Expired", near_expiry: "Near expiry", damaged: "Damaged", recalled: "Recalled" };

/**
 * OUR DEBIT NOTE ON PAPER — A4, self-contained HTML, printed from the office (the PO's path). It goes
 * with the goods. Before dispatch it prints as a RETURN NOTE marked NOT A DEBIT NOTE, so a draft can
 * never be mistaken for the voucher.
 */
export async function debitNoteDocument(db: Db, actor: Actor, returnId: string): Promise<RenderedDocument> {
  const r = await getSupplierReturn(db, actor, returnId);
  const letterhead = (await loadOpdConfig(db)).letterhead;
  const issued = r.debitNoteNo !== null;
  const rows = r.lines.map((l, i) => `<tr>
      <td>${String(i + 1)}</td><td>${esc(l.itemName)}<div class="c">${esc(l.itemCode)}${l.hsnCode === null ? "" : ` · HSN ${esc(l.hsnCode)}`}</div></td>
      <td>${esc(l.batchNo)}<div class="c">exp ${dayLabel(l.expiryDate)}</div></td><td>${esc(REASON_WORDS[l.reason] ?? l.reason)}</td>
      <td class="n">${esc(qtyText(l.qtyBase, l.baseUom, l.pack))}</td><td class="n">${rupees(l.ratePaise)}</td><td class="n">${rupees(l.taxablePaise)}</td>
      <td class="n">${(l.gstRateBps / 100).toFixed(l.gstRateBps % 100 === 0 ? 0 : 2)}%</td>
      <td class="n">${r.interState ? rupees(l.igstPaise) : `${rupees(l.cgstPaise)} + ${rupees(l.sgstPaise)}`}</td><td class="n">${rupees(l.totalPaise)}</td></tr>`).join("");
  const body = `
  ${issued ? "" : `<div class="stamp">RETURN NOTE — NOT A DEBIT NOTE (${esc(r.status)})</div>`}
  <header>${letterheadBlock(letterhead)}
    <div class="t"><h1>${issued ? "Debit Note" : "Return Note"}</h1><div>${esc(r.debitNoteNo ?? r.returnNo)}</div><div>${dayLabel(r.debitNoteDate ?? r.createdAt.slice(0, 10))}</div>
    <div class="c">Return ${esc(r.returnNo)}${r.recallNo === null ? "" : ` · Recall ${esc(r.recallNo)}`}</div></div></header>
  <section class="two"><div><b>To</b><br>${esc(r.vendorName)}<br>${r.vendorGstin === null ? "" : `GSTIN ${esc(r.vendorGstin)}`}</div>
    <div><b>Purchase return</b><br>${r.interState ? "Inter-state: IGST" : "Intra-state: CGST + SGST"}</div></section>
  <table><thead><tr><th>#</th><th>Item</th><th>Batch</th><th>Reason</th><th class="n">Qty</th><th class="n">Rate ₹</th><th class="n">Taxable ₹</th><th class="n">GST</th><th class="n">${r.interState ? "IGST ₹" : "CGST + SGST ₹"}</th><th class="n">Amount ₹</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><td colspan="9" class="n">Taxable value</td><td class="n">${rupees(r.taxablePaise)}</td></tr>
  ${r.interState ? `<tr><td colspan="9" class="n">IGST</td><td class="n">${rupees(r.igstPaise)}</td></tr>` : `<tr><td colspan="9" class="n">CGST</td><td class="n">${rupees(r.cgstPaise)}</td></tr><tr><td colspan="9" class="n">SGST</td><td class="n">${rupees(r.sgstPaise)}</td></tr>`}
  <tr class="tot"><td colspan="9" class="n">Total</td><td class="n">${rupees(r.totalPaise)}</td></tr></tfoot></table>
  <p class="small">We have debited your account with the amount above for the goods returned. Please issue your credit note against ${esc(r.debitNoteNo ?? r.returnNo)}; it is set against your next payment.</p>
  <footer><div>Dispatched by ${esc(r.dispatchedBy === null ? "—" : (r.names[r.dispatchedBy] ?? r.dispatchedBy))}<br>Received by (vendor) ____________</div><div>Authorised signatory · ${esc(letterhead.legalName ?? letterhead.name)}</div></footer>`;
  const title = `${r.debitNoteNo ?? r.returnNo} — ${r.vendorName}`;
  return {
    title, page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`,
  };
}

/**
 * THE DESTRUCTION MANIFEST ON PAPER (BMW Rules 2016) — A4: items, batches, quantities and value, the
 * disposal agency, its manifest / challan number and the handover date, and signatures. Before it is
 * posted it prints as a CONDEMNATION LIST, stamped with its approval's state.
 */
export async function writeOffManifestDocument(db: Db, actor: Actor, writeOffId: string): Promise<RenderedDocument> {
  const w = await getWriteOff(db, actor, writeOffId);
  const letterhead = (await loadOpdConfig(db)).letterhead;
  const posted = w.status === "posted";
  const rows = w.lines.map((l, i) => `<tr>
      <td>${String(i + 1)}</td><td>${esc(l.itemName)}<div class="c">${esc(l.itemCode)}${l.hsnCode === null ? "" : ` · HSN ${esc(l.hsnCode)}`}</div></td>
      <td>${esc(l.batchNo)}</td><td>${dayLabel(l.expiryDate)}</td><td>${esc(l.supplierName ?? "—")}</td>
      <td class="n">${String(l.qtyBase)} ${esc(l.baseUom)}</td><td class="n">${rupees(l.valuePaise)}</td></tr>`).join("");
  const approver = w.approval?.decidedBy == null ? "" : (w.names[w.approval.decidedBy] ?? w.approval.decidedBy);
  const body = `
  ${posted ? "" : `<div class="stamp">CONDEMNATION LIST — NOT YET DESTROYED (approval ${esc(w.approvalStatus)})</div>`}
  <header>${letterheadBlock(letterhead)}
    <div class="t"><h1>${posted ? "Destruction Manifest" : "Condemnation List"}</h1><div>${esc(w.writeOffNo)}</div><div>${dayLabel(w.disposalDate ?? w.requestedAt.slice(0, 10))}</div></div></header>
  <section class="two"><div><b>Store</b><br>${esc(w.storeName)} (${esc(w.storeCode)})<br>Reason: ${esc(w.reason)}</div>
    <div><b>Bio-Medical Waste Management Rules, 2016</b><br>Yellow category (d) — expired / discarded medicines<br>
    Disposal agency: ${esc(w.disposalAgency ?? "____________")}<br>Manifest / challan no.: ${esc(w.manifestNo ?? "____________")}<br>Handed over on: ${w.disposalDate === null ? "____________" : dayLabel(w.disposalDate)}</div></section>
  <table><thead><tr><th>#</th><th>Item</th><th>Batch</th><th>Expiry</th><th>Supplier</th><th class="n">Qty</th><th class="n">Value ₹ (cost)</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr class="tot"><td colspan="6" class="n">Total value written off</td><td class="n">${rupees(w.totalValuePaise)}</td></tr></tfoot></table>
  ${w.note === null ? "" : `<p><b>Note.</b> ${esc(w.note)}</p>`}
  <footer><div>Raised by ${esc(w.names[w.requestedBy] ?? w.requestedBy)}<br>Approved by ${esc(approver === "" ? "____________" : approver)} (Medical Superintendent)</div>
    <div>Received for disposal by ____________<br>(agency representative, with seal)</div></footer>`;
  const title = `${w.writeOffNo} — ${w.storeName}`;
  return {
    title, page: { widthMm: 210, heightMm: 297 },
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`,
  };
}
