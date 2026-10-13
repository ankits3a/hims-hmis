import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import {
  approvals, ipdAdmissionDeposits, ipdAdmissions, ipdChargeLines, ipdFinalBills, ipdPayerClaims, ipdStayExits, patientDocuments, refundVouchers,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { issueInvoice, previewInvoice, receiptUnallocatedPaise, requestRefund, withIdempotency } from "../billing";
import { holdsPermission, lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { IPD_APPROVAL_TYPE_KEYS, grantedApproval, requestIpdApproval } from "./approval-types";
import type { GrantedApproval } from "./approval-types";
import { coveredLineIds, hasUnbilledLines, liveBills } from "./bill-cover";
import { postAdmissionCharges } from "./charges";
import { activeDischarge, confirmationsOf, pendingDepartments } from "./discharge";
import { billSettled } from "./discharge-events";
import { IpdError, IpdRefusal } from "./errors";
import { depositHeldPaise } from "./interim-bill";
import { IPD_BILL_VIEW, IPD_DISCHARGE_BILL } from "./manifest";
import { computePayerSplit } from "./payer-bill";
import type { Actor, IpdDischargeBillDesk, IpdFinalBill, IpdIntentName, IpdPayerSplit } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { InvoiceLineInput } from "../tariff";
import type { AdmissionRow } from "./admission-core";
import type { BillRow } from "./bill-cover";

/**
 * E3.2 (#730) — THE FINAL BILL (spec SPEC-ipd-core §4.7; the OT's `composeDischargeBill` / `settleDischargeBill` pattern).
 *
 * COMPOSE: the running bill's NON-REVERSED lines (a reversed line and its reversal both drop out) split payer / patient by
 * the payer engine (`computePayerSplit`, E2.2). `billVersion` = the count of the admission's lines — the lines are
 * append-only, so any new posting or reversal changes it and a cashier settling against an older read is refused
 * `bill_changed`.
 *
 * SETTLE builds ONE billing invoice for the PATIENT-payable portion and, in the same transaction, applies the admission's
 * deposits (`settleFromReceipts`), takes the tenders as the invoice's receipt, raises a refund request for an excess
 * deposit (approval-gated, never a silent credit — the OT's §3A rule), records the payer's portion as an
 * `ipd_payer_claims` row and the final-bill row. Rounding happens ONCE, at the invoice (billing's totals).
 *
 * DECIDED $ (E3.2):
 * - Billing has no payer-credit model, so the invoice carries the patient's portion and the payer's portion is a claim
 *   record (filing is a later lane). Each invoice line is the charge line at its frozen price (`prepaidUnitPaise`, the
 *   tele-call seam: the price the stay was charged, not today's list); a line split between payer and patient goes on
 *   the invoice at the patient's share of its taxable value (qty 1).
 * - Review #762 RED 1 / RED 4: the SETTLE itself posts the running bill up to the settle instant, under the admission
 *   lock, before composing; the bill is final at settlement (presumed exit = settle time; the day rule's 14:00 grace
 *   applies). A gate scan later the same day adds nothing (the hospital's delay); the nightly job skips a settled
 *   admission (RED 2) and a stay still open the next IST day is the bill desk's `settled_not_exited` (a supplementary
 *   bill is owed — GitHub issue).
 * - Review #762 RED 5: patient = the invoice as billing prices it (before its one rounding); claim = total − patient.
 * - Review #762 RED 6: deposits applied are capped by `depositHeldPaise` (receipts less issued advance refunds).
 * - An excess deposit is refunded on request (`advance_refund`); with `insurer_pending_undertaking` it is HELD against the
 *   insurer's final approval (§4.7: "the deposit covers the gap") and no refund is raised.
 * - Tenders: cash, UPI and card (billing's three); a cheque / NEFT / DD is refused `tender_not_supported`.
 *
 * DECIDED ⚖ (Consumer Protection Act 2019; the state clinical-establishment rules; NHRC charter of patients' rights): a
 * patient is NEVER detained for unpaid dues, and the exit never waits on an approval (review #762 RED 7): an unpaid
 * balance is recorded at once (`dues_recorded`) against the patient's signed undertaking — an existing, active document
 * filed for THIS patient (RED 8); the invoice is left OPEN on billing's dues list (`holdUntilPaid`, never
 * `credit_extended` — billing's owner-only credit ruling is untouched); the gate pass says "dues recorded"; the dues
 * approval (billing manager or MS; requester ≠ approver) is a ledger step after the exit (`recordDuesApproval`) and the
 * bill desk lists `dues_awaiting_approval` until it is attached.
 */

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type ChargeLineRow = typeof ipdChargeLines.$inferSelect;

/**
 * The admission states in which a final bill may be composed and settled (the cascade, and every other ending). #763: a
 * void re-opens the bill after the exit (`discharged`, `transferred_out`) — a gate pass needs a settled bill, so in those
 * states a fresh settle only follows a void (a void is refused while a pass is live, so never in `discharging`).
 */
const BILLABLE: ReadonlySet<string> = new Set(["fit_declared", "lama", "absconded", "deceased", "discharged", "transferred_out"]);
const TENDERS: Record<string, "cash" | "upi" | "card"> = { cash: "cash", upi: "upi", card: "card" };

export type ComposedFinalBill = {
  billVersion: number;
  lines: ChargeLineRow[];
  live: { line: ChargeLineRow; payerPaise: number; patientPaise: number }[];
  split: IpdPayerSplit;
  totalPaise: number;
  payerPaise: number;
  patientPaise: number;
  depositHeldPaise: number;
};

/**
 * Composes a bill from the running bill's lines. `take` picks the lines this bill is about (#763): the lines no live bill
 * has taken for a new bill, or the bill's own lines for a settled view. The payer split is computed over ALL the stay's
 * lines (approvals and co-pay are consumed in posting order across the whole stay — review $2), and each picked line
 * keeps its share. `billVersion` stays the count of all the admission's lines (append-only).
 */
export async function composeFinalBill(db: Db | Tx, a: AdmissionRow, take?: (line: ChargeLineRow) => boolean): Promise<ComposedFinalBill> {
  const all = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id))
    .orderBy(asc(ipdChargeLines.serviceDate), asc(ipdChargeLines.postedAt), asc(ipdChargeLines.id));
  const reversed = new Set(all.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  const split = await computePayerSplit(db, a, all);
  const byId = new Map(split.lines.map((l) => [l.lineId, l] as const));
  const lines = take === undefined ? all : all.filter(take);
  const live = lines.filter((l) => l.reversalOf === null && !reversed.has(l.id)).map((line) => {
    const s = byId.get(line.id);
    return { line, payerPaise: s?.payerPaise ?? 0, patientPaise: s?.patientPaise ?? line.netPaise };
  });
  const sum = (f: (x: (typeof live)[number]) => number) => live.reduce((t, x) => t + f(x), 0);
  return {
    billVersion: all.length, lines, live, split,
    totalPaise: sum((x) => x.line.netPaise), payerPaise: sum((x) => x.payerPaise), patientPaise: sum((x) => x.patientPaise),
    depositHeldPaise: await depositHeldPaise(db, a),
  };
}

/** The invoice lines for the patient's portion, each at its frozen price (see the header). */
export function patientInvoiceLines(c: ComposedFinalBill): InvoiceLineInput[] {
  const out: InvoiceLineInput[] = [];
  for (const { line, patientPaise } of c.live) {
    if (patientPaise <= 0) continue;
    if (patientPaise === line.netPaise) {
      out.push({ lineId: `ipd-${line.id}`, serviceId: line.serviceId, qty: line.qty, prepaidUnitPaise: line.unitPaise });
      continue;
    }
    const taxable = line.netPaise === 0 ? 0 : Math.floor((patientPaise * line.taxablePaise) / line.netPaise);
    out.push({ lineId: `ipd-${line.id}`, serviceId: line.serviceId, qty: 1, prepaidUnitPaise: taxable });
  }
  return out;
}

/**
 * Review #762 RED 5 — THE ONE SOURCE OF TRUTH for the split of a final bill. The patient's amount is the invoice as
 * billing prices it (`rawTotalPaise`, before billing's single rounding); the payer's claim is the rest of the stay's
 * total. payer + patient = total to the paisa, always; the view and the settle both call this.
 */
export type PricedFinalBill = {
  lines: InvoiceLineInput[];
  totalPaise: number;
  patientPaise: number;
  patientRoundedPaise: number;
  payerPaise: number;
};

export async function priceFinalBill(db: Db | Tx, a: AdmissionRow, c: ComposedFinalBill, at: Date): Promise<PricedFinalBill> {
  const lines = patientInvoiceLines(c);
  const preview = lines.length === 0 ? null : await previewInvoice(db as unknown as Db, { lines, patientId: a.patientId }, at);
  const patientPaise = preview?.totals.rawTotalPaise ?? 0;
  const payerPaise = c.totalPaise - patientPaise;
  // Billing priced the patient's lines above the stay's own total (a tax or price change since posting): never a
  // negative claim — the cashier reopens the bill.
  if (payerPaise < 0) throw new IpdRefusal("bill_changed", "Invoice above the stay's lines", { totalPaise: c.totalPaise, patientPaise });
  return { lines, totalPaise: c.totalPaise, patientPaise, patientRoundedPaise: preview?.totals.netPayablePaise ?? 0, payerPaise };
}

/** Review #762 item 14: a payer portion with no payer on the admission is refused — never silently dropped. */
export function assertPayerAccounted(payerPaise: number, payerKind: string | null): void {
  if (payerPaise > 0 && payerKind === null) throw new IpdRefusal("payer_kind_missing", undefined, { payerPaise });
}

type FinalBillRow = BillRow;

/** The admission's LIVE final bill (seq 0, not voided), if any (#763: a voided bill keeps its row and counts for nothing). */
export async function finalBillRow(db: Db | Tx, admissionId: string): Promise<FinalBillRow | undefined> {
  return (await liveBills(db, admissionId)).find((b) => b.kind === "final");
}

/** #763 — the lines no live bill has taken yet (the next bill's), as a `take` for `composeFinalBill`. */
export async function unbilledTake(db: Db | Tx, admissionId: string): Promise<(line: ChargeLineRow) => boolean> {
  const bills = await liveBills(db, admissionId);
  const lines = await db.select({ id: ipdChargeLines.id, postedAt: ipdChargeLines.postedAt }).from(ipdChargeLines)
    .where(eq(ipdChargeLines.admissionId, admissionId));
  const covered = coveredLineIds(bills, lines);
  return (l) => !covered.has(l.id);
}

/** #763 — the lines one settled bill took (a bill written before #763: those posted by its settlement). */
function billTake(row: FinalBillRow): (line: ChargeLineRow) => boolean {
  const own = new Set(row.lineIds);
  return row.coverByTime ? (l) => own.has(l.id) || l.postedAt.getTime() <= row.settledAt.getTime() : (l) => own.has(l.id);
}

/** Review #762 item 10: `refund_pending` until billing issues the voucher against the refund approval. */
async function refundStateOf(db: Db | Tx, row: FinalBillRow): Promise<"none" | "refund_pending" | "refund_issued"> {
  if (row.refundPaise === 0 || row.refundApprovalId === null) return "none";
  const v = (await db.select({ id: refundVouchers.id }).from(refundVouchers).where(eq(refundVouchers.approvalId, row.refundApprovalId)).limit(1))[0];
  return v === undefined ? "refund_pending" : "refund_issued";
}

type DeskException = IpdFinalBill["exceptions"][number];

/**
 * The bill desk's open questions on a settled bill (computed on read, never stored):
 * - `dues_awaiting_approval` ⚖ — dues recorded at the exit, the approval (a ledger step) not yet attached;
 * - `settled_not_exited` $ — the bill was final at settlement and the patient is still in by the next IST day (the
 *   nightly job no longer posts: a supplementary bill is owed);
 * - `ended_after_bill` — a LAMA / abscond / death recorded after the bill (⚖ never blocked; reconcile);
 * - `refund_pending` — the excess-deposit refund's voucher is not issued yet;
 * - `supplementary_owed` (#763) — lines no live bill has taken (days after the settlement day, later services).
 */
async function deskExceptions(db: Db | Tx, a: AdmissionRow, row: FinalBillRow, at: Date): Promise<DeskException[]> {
  const out: DeskException[] = [];
  const bills = await liveBills(db, a.id);
  if (bills.some((b) => b.duesPaise > 0 && b.duesApprovalId === null)) out.push("dues_awaiting_approval");
  // #763: measured from the NEWEST live bill — a supplementary bill settled today clears yesterday's prompt.
  const lastSettled = bills.reduce((t, b) => (b.settledAt.getTime() > t.getTime() ? b.settledAt : t), row.settledAt);
  if ((a.state === "fit_declared" || a.state === "discharging") && istDayString(at) > istDayString(lastSettled)) out.push("settled_not_exited");
  const exit = (await db.select({ recordedAt: ipdStayExits.recordedAt }).from(ipdStayExits).where(eq(ipdStayExits.admissionId, a.id)))[0];
  if (exit !== undefined && exit.recordedAt.getTime() >= row.settledAt.getTime()) out.push("ended_after_bill");
  for (const b of bills) {
    if ((await refundStateOf(db, b)) === "refund_pending") { out.push("refund_pending"); break; }
  }
  if (await hasUnbilledLines(db, a.id)) out.push("supplementary_owed");
  return out;
}

/** The final bill as the cashier reads it (money: `ipd.discharge.bill` or `ipd.bill.view` only — never a doctor). */
export async function finalBillView(db: Db, a: AdmissionRow, at: Date = new Date()): Promise<IpdFinalBill> {
  const row = await finalBillRow(db, a.id);
  const c = await composeFinalBill(db, a, row === undefined ? await unbilledTake(db, a.id) : billTake(row));
  const lines = c.live.map(({ line, payerPaise, patientPaise }) => ({
    lineId: line.id, serviceDate: line.serviceDate, serviceName: line.serviceName, component: line.component, qty: line.qty,
    netPaise: line.netPaise, payerPaise, patientPaise,
  }));
  if (row !== undefined) {
    // Settled: the figures as they were settled (the split kept on the row), not a re-pricing.
    return {
      admissionId: a.id, admissionNo: a.admissionNo, billVersion: row.billVersion, lines,
      totalPaise: row.totalPaise, payerPaise: row.payerPaise, patientPaise: row.patientPaise,
      patientRoundedPaise: row.depositAppliedPaise + row.paidPaise + row.duesPaise, depositHeldPaise: c.depositHeldPaise,
      balancePaise: row.duesPaise - row.refundPaise, payerKind: a.payerKind,
      settled: {
        billNo: row.invoiceNo, settlement: row.settlement as NonNullable<IpdFinalBill["settled"]>["settlement"], paidPaise: row.paidPaise,
        refundPaise: row.refundPaise, refundState: await refundStateOf(db, row), duesPaise: row.duesPaise, duesApproved: row.duesApprovalId !== null,
        settledAt: row.settledAt.toISOString(),
      },
      exceptions: await deskExceptions(db, a, row, at),
    };
  }
  const p = await priceFinalBill(db, a, c, at);
  return {
    admissionId: a.id, admissionNo: a.admissionNo, billVersion: c.billVersion, lines,
    totalPaise: p.totalPaise, payerPaise: p.payerPaise, patientPaise: p.patientPaise, patientRoundedPaise: p.patientRoundedPaise,
    depositHeldPaise: c.depositHeldPaise, balancePaise: p.patientRoundedPaise - c.depositHeldPaise, payerKind: a.payerKind,
    settled: null, exceptions: [],
  };
}

export async function readFinalBill(db: Db, actor: Actor, admissionId: string, opts: Opts = {}): Promise<IpdFinalBill> {
  if (!(await holdsPermission(db, actor, IPD_DISCHARGE_BILL)) && !(await holdsPermission(db, actor, IPD_BILL_VIEW))) {
    throw new IpdError("ipd_forbidden", `this read needs the permission ${IPD_DISCHARGE_BILL} or ${IPD_BILL_VIEW}`, { permission: IPD_DISCHARGE_BILL });
  }
  return finalBillView(db, await readAdmission(db, admissionId), opts.now ?? new Date());
}

/**
 * Posts the running bill through the settle day as if the patient leaves NOW and answers the composed bill (the
 * cashier's read; the settle re-posts and re-prices under the lock and refuses `bill_changed` if anything moved).
 * $ DECIDED (review #762 RED 4): the bill is final at settlement — the presumed exit is the settle instant.
 */
export async function prepareFinalBill(db: Db, actor: Actor, admissionId: string, opts: Opts = {}): Promise<IpdFinalBill> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const at = opts.now ?? new Date();
  const a = await readAdmission(db, admissionId);
  if (!BILLABLE.has(a.state) && a.state !== "discharging") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
  if ((await finalBillRow(db, a.id)) === undefined) {
    await postAdmissionCharges(db, a.id, { upToIstDate: istDayString(at), now: at, presumedDischargeAt: a.endedAt ?? at });
  }
  return finalBillView(db, await readAdmission(db, admissionId), at);
}

/** Files the dues approval (billing manager or MS). ⚖ A ledger step: the patient may already have left. */
export async function askDuesApproval(
  db: Db, actor: Actor, body: { admissionId: string; amountPaise: number; note: string },
): Promise<{ approvalId: string }> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  if (!Number.isSafeInteger(body.amountPaise) || body.amountPaise <= 0) throw new IpdRefusal("dues_need_approval", "Dues must name a positive amount");
  const a = await readAdmission(db, body.admissionId);
  return withTx(db, (tx) => requestIpdApproval(tx, actor, {
    kind: "discharge_dues", subjectId: a.id, patientId: a.patientId, note: body.note, amountPaise: body.amountPaise,
  }));
}

/**
 * Attaches a GRANTED dues approval to the settled bill (review #762 RED 7: after the exit). The approval must cover the
 * dues, and its approver must not be its requester — the approvals kernel refuses that already (requester ≠ approver,
 * `assertNotSodPair`); checked again here so a row written around the kernel cannot pass (item 15).
 */
export async function recordDuesApproval(
  db: Db, actor: Actor, body: { admissionId: string; approvalId: string }, opts: Opts = {},
): Promise<{ admissionId: string; duesApprovedBy: string | null }> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const at = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const a = await lockAdmission(tx, body.admissionId);
    // #763: the live bills (final first) whose dues wait for an approval; the approval goes to the first it covers.
    const waiting = (await tx.select().from(ipdFinalBills).where(and(eq(ipdFinalBills.admissionId, a.id), isNull(ipdFinalBills.voidedAt)))
      .orderBy(asc(ipdFinalBills.seq)).for("update")).filter((b) => b.duesPaise > 0 && b.duesApprovalId === null);
    const any = waiting[0] ?? (await liveBills(tx, a.id)).find((b) => b.duesPaise > 0);
    if (any === undefined) throw new IpdRefusal("bill_unsettled", "No dues on this admission");
    // Review YELLOW 5: one approval attaches to one bill, and never the requester's own.
    const ok = await usableDuesApproval(tx, a.id, body.approvalId);
    const row = waiting.find((b) => ok !== null && (ok.amountPaise === null || ok.amountPaise >= b.duesPaise)) ?? any;
    if (ok === null || (ok.amountPaise !== null && ok.amountPaise < row.duesPaise)) {
      throw new IpdRefusal("dues_need_approval", "The approval must be granted, cover the dues, and not be the requester's own", { duesPaise: row.duesPaise });
    }
    await tx.update(ipdFinalBills).set({ duesApprovalId: ok.id, duesApprovedBy: ok.decidedBy, duesApprovedAt: at }).where(eq(ipdFinalBills.id, row.id));
    return { admissionId: a.id, duesApprovedBy: ok.decidedBy };
  });
}

/** #763 — how long a settled bill stays on the desk without an open question (so billing can find it to void). */
export const IPD_SETTLED_BILL_RECENT_DAYS = 7;

/** #763 — the newest void approval asked for each bill (any status), for the desk's Void act. */
async function voidApprovalsOf(db: Db | Tx, billIds: readonly string[]): Promise<Map<string, { approvalId: string; status: "pending" | "granted" | "rejected" }>> {
  const out = new Map<string, { approvalId: string; status: "pending" | "granted" | "rejected" }>();
  if (billIds.length === 0) return out;
  const rows = await db.select({ id: approvals.id, subjectId: approvals.subjectId, status: approvals.status }).from(approvals)
    .where(and(eq(approvals.typeKey, IPD_APPROVAL_TYPE_KEYS.bill_void), inArray(approvals.subjectId, [...billIds])))
    .orderBy(asc(approvals.requestedAt));
  for (const r of rows) out.set(r.subjectId, { approvalId: r.id, status: r.status as "pending" | "granted" | "rejected" });
  return out;
}

/**
 * The bill desk: admissions with a live final bill that carry an open question (see `deskExceptions`), plus (#763) every
 * live final bill settled in the last `IPD_SETTLED_BILL_RECENT_DAYS` days — the desk's Supplementary and Void acts start
 * here. Newest first; each row lists the admission's live bills.
 */
export async function listBillDesk(db: Db, actor: Actor, opts: Opts = {}): Promise<IpdDischargeBillDesk> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const at = opts.now ?? new Date();
  const recent = new Date(at.getTime() - IPD_SETTLED_BILL_RECENT_DAYS * 24 * 3_600_000);
  const rows = await db.select({ bill: ipdFinalBills, adm: ipdAdmissions }).from(ipdFinalBills)
    .innerJoin(ipdAdmissions, eq(ipdAdmissions.id, ipdFinalBills.admissionId))
    .where(and(eq(ipdFinalBills.seq, 0), isNull(ipdFinalBills.voidedAt)))
    .orderBy(desc(ipdFinalBills.settledAt)).limit(300);
  const out: IpdDischargeBillDesk["rows"] = [];
  for (const { bill, adm } of rows) {
    const exceptions = await deskExceptions(db, adm, bill, at);
    const bills = await liveBills(db, adm.id);
    if (exceptions.length === 0 && !bills.some((b) => b.settledAt.getTime() >= recent.getTime())) continue;
    const asked = await voidApprovalsOf(db, bills.map((b) => b.id));
    out.push({
      admissionId: adm.id, admissionNo: adm.admissionNo, state: adm.state as IpdDischargeBillDesk["rows"][number]["state"], billNo: bill.invoiceNo,
      duesPaise: bills.reduce((t, b) => t + b.duesPaise, 0), refundPaise: bills.reduce((t, b) => t + b.refundPaise, 0),
      settledAt: bill.settledAt.toISOString(), exceptions,
      bills: bills.map((b) => ({
        billId: b.id, kind: b.kind as "final" | "supplementary", seq: b.seq, billNo: b.invoiceNo, totalPaise: b.totalPaise, patientPaise: b.patientPaise,
        duesPaise: b.duesPaise, refundPaise: b.refundPaise, settledAt: b.settledAt.toISOString(), voidApproval: asked.get(b.id) ?? null,
      })),
    });
  }
  return { rows: out };
}

/** The admission's deposit receipts with money still unallocated, oldest first. */
async function depositReceipts(tx: Tx, admissionId: string): Promise<{ receiptId: string; availablePaise: number }[]> {
  const deps = await tx.select({ receiptId: ipdAdmissionDeposits.receiptId }).from(ipdAdmissionDeposits)
    .where(eq(ipdAdmissionDeposits.admissionId, admissionId)).orderBy(asc(ipdAdmissionDeposits.takenAt));
  const out: { receiptId: string; availablePaise: number }[] = [];
  for (const d of deps) {
    const r = await receiptUnallocatedPaise(tx, d.receiptId);
    if (r !== null && !r.enteredInError && r.unallocatedPaise > 0) out.push({ receiptId: d.receiptId, availablePaise: r.unallocatedPaise });
  }
  return out;
}

/** RED 8 ⚖: the undertaking is an existing, active document filed for THIS patient (patients' documents). */
async function checkUndertaking(tx: Tx, patientId: string, documentId: string): Promise<void> {
  const doc = (await tx.select({ patientId: patientDocuments.patientId, status: patientDocuments.status }).from(patientDocuments)
    .where(eq(patientDocuments.id, documentId)))[0];
  if (doc?.patientId !== patientId || doc.status !== "active") throw new IpdRefusal("undertaking_invalid", undefined, { documentId });
}

export async function settleFinalBill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"settle_final_bill">> {
  return settleBill(db, actor, raw, "final", opts);
}

/**
 * #763 — THE SUPPLEMENTARY BILL: the charges that accrued after the live bills (days after the settlement day, later
 * services) composed as a further invoice for the same admission ("Supplementary bill 1, 2…"), settled exactly like the
 * final bill — same payer split (the payer's portion is its own claim row), same deposit, tender, refund and ⚖ dues rules.
 * The body is `settle_final_bill`'s.
 */
export async function settleSupplementaryBill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"settle_final_bill">> {
  return settleBill(db, actor, raw, "supplementary", opts);
}

/**
 * #763 — the cashier's read of the supplementary bill: posts the running bill up to now as if the patient leaves now (the
 * settlement day of a live bill stays closed — `bill-cover.ts`) and answers the lines no live bill has taken.
 */
export async function prepareSupplementaryBill(db: Db, actor: Actor, admissionId: string, opts: Opts = {}): Promise<IpdFinalBill> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const at = opts.now ?? new Date();
  const a = await readAdmission(db, admissionId);
  if ((await finalBillRow(db, a.id)) === undefined) throw new IpdRefusal("bill_unsettled", "No settled final bill on this admission");
  await postAdmissionCharges(db, a.id, { upToIstDate: istDayString(at), now: at, presumedDischargeAt: a.endedAt ?? at });
  const fresh = await readAdmission(db, admissionId);
  const c = await composeFinalBill(db, fresh, await unbilledTake(db, a.id));
  const p = await priceFinalBill(db, fresh, c, at);
  const available = await depositAvailablePaise(db, fresh, c.depositHeldPaise);
  return {
    admissionId: a.id, admissionNo: a.admissionNo, billVersion: c.billVersion,
    lines: c.live.map(({ line, payerPaise, patientPaise }) => ({
      lineId: line.id, serviceDate: line.serviceDate, serviceName: line.serviceName, component: line.component, qty: line.qty,
      netPaise: line.netPaise, payerPaise, patientPaise,
    })),
    totalPaise: p.totalPaise, payerPaise: p.payerPaise, patientPaise: p.patientPaise, patientRoundedPaise: p.patientRoundedPaise,
    depositHeldPaise: available, balancePaise: p.patientRoundedPaise - available, payerKind: a.payerKind, settled: null, exceptions: [],
  };
}

/**
 * #763 — the deposit a new bill may still use: the deposit held (receipts less issued advance refunds) less what the live
 * bills applied and less the refunds they raised that are not issued yet (DECIDED $: a refund already promised to the
 * patient is left alone — the desk voids and re-settles if it should be netted instead).
 */
async function depositAvailablePaise(db: Db | Tx, a: AdmissionRow, held: number): Promise<number> {
  let used = 0;
  for (const b of await liveBills(db, a.id)) {
    used += b.depositAppliedPaise;
    if ((await refundStateOf(db, b)) === "refund_pending") used += b.refundPaise;
  }
  return Math.max(0, held - used);
}

async function settleBill(db: Db, actor: Actor, raw: unknown, kind: "final" | "supplementary", opts: Opts): Promise<Output<"settle_final_bill">> {
  const input: Input<"settle_final_bill"> = IPD_INTENTS.settle_final_bill.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const at = opts.now ?? new Date();
  const work = () => withTx(db, async (tx) => settleLocked(tx, actor, await lockAdmission(tx, input.admissionId), input, kind, at, true));
  if (kind === "final") return onceIpd(db, actor, "settle_final_bill", input.idempotencyKey, input, work, at);
  return withIdempotency(db, { actorId: actor.id, route: "ipd:settle_supplementary_bill", key: input.idempotencyKey.toLowerCase() }, input, work, at);
}

/** The states a supplementary bill may be settled in: a live final bill exists, the stay is in its discharge or ended. */
const SUPPLEMENTARY_STATES: ReadonlySet<string> = new Set([
  "fit_declared", "discharging", "lama", "absconded", "deceased", "discharged", "transferred_out",
]);

/**
 * #763 (review RED 2) — ⚖ THE SUPPLEMENTARY BILL'S NO-DETENTION PATH AT THE GATE, exactly the final bill's: the charges that
 * wait are settled as a supplementary bill with the dues recorded against the signed undertaking (deposit still available
 * applied first; no payment, no approval — the approval follows the exit). Called by `issue_gate_pass` inside its own
 * transaction, under the admission lock it already holds.
 */
export async function recordSupplementaryDuesIn(
  tx: Tx, actor: Actor, a: AdmissionRow, undertakingDocumentId: string, at: Date,
): Promise<Output<"settle_final_bill">> {
  return settleLocked(tx, actor, a, {
    idempotencyKey: a.id, admissionId: a.id, billVersion: 0, patientPayablePaise: 0, settlement: "dues_recorded", payments: [], undertakingDocumentId,
  }, "supplementary", at, false);
}

/**
 * One settle under the admission lock. `checkRead`: the cashier's settle names the bill version and the patient amount it
 * read (`bill_changed` otherwise); the gate's dues path (`recordSupplementaryDuesIn`) composes and records in one act.
 */
async function settleLocked(
  tx: Tx, actor: Actor, a: AdmissionRow, input: Input<"settle_final_bill">, kind: "final" | "supplementary", at: Date, checkRead: boolean,
): Promise<Output<"settle_final_bill">> {
  const tenders = input.payments.map((p) => {
    const mode = TENDERS[p.tender];
    if (mode === undefined) throw new IpdError("tender_not_supported", `the billing ledger takes cash, UPI and card, not ${p.tender}`, { tender: p.tender });
    return { mode, amountPaise: p.amountPaise, ...(p.ref === undefined ? {} : { refText: p.ref }) };
  });
  {
    const live = await liveBills(tx, a.id);
    let seq = 0;
    if (kind === "final") {
      if (!BILLABLE.has(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
      if (live.length > 0) throw new IpdRefusal("final_bill_exists");
      if (a.state === "fit_declared") {
        const d = await activeDischarge(tx, a.id);
        const pending = d === undefined ? [] : pendingDepartments(await confirmationsOf(tx, d.id));
        if (pending.length > 0) throw new IpdRefusal("charges_unconfirmed", undefined, { pending });
      }
    } else {
      // Review YELLOW 6: the same state guard as the final bill (plus the discharge under way and the ended stays).
      if (!SUPPLEMENTARY_STATES.has(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
      if (!live.some((b) => b.kind === "final")) throw new IpdRefusal("bill_unsettled", "No settled final bill on this admission");
      seq = live.reduce((m, b) => Math.max(m, b.seq), 0) + 1;
    }
    // RED 1: the settle posts the running bill itself, up to the presumed exit (= now; RED 4), before composing.
    await postAdmissionCharges(tx as unknown as Db, a.id, { upToIstDate: istDayString(at), now: at, presumedDischargeAt: a.endedAt ?? at });
    const c = await composeFinalBill(tx, a, await unbilledTake(tx, a.id));
    if (checkRead && c.billVersion !== input.billVersion) throw new IpdRefusal("bill_changed", undefined, { billVersion: c.billVersion });
    if (kind === "supplementary" && c.live.length === 0) throw new IpdError("nothing_to_bill", "no charge waits for a supplementary bill");
    const p = await priceFinalBill(tx, a, c, at);
    // Item 11: the split's inputs (payer record, non-payables, deposits) are not in the line count — the amount the
    // cashier read is the check.
    if (checkRead && p.patientPaise !== input.patientPayablePaise) throw new IpdRefusal("bill_changed", undefined, { patientPayablePaise: p.patientPaise });
    assertPayerAccounted(p.payerPaise, a.payerKind);

    const netPaise = p.patientRoundedPaise;
    const tenderedPaise = tenders.reduce((s, t) => s + t.amountPaise, 0);
    if (tenderedPaise > netPaise) {
      throw new IpdError("tender_exceeds_bill", "record what is applied to the bill and give the change", { tenderedPaise, netPayablePaise: netPaise });
    }
    // RED 6: the deposit available is the receipts less the advance refunds already issued (`depositHeldPaise`); #763: less
    // what the live bills already applied or promised back.
    const held = await depositAvailablePaise(tx, a, c.depositHeldPaise);
    const deposits = await depositReceipts(tx, a.id);
    let toCover = netPaise - tenderedPaise;
    let heldLeft = held;
    const settleFromReceipts: { receiptId: string; amountPaise: number }[] = [];
    for (const d of deposits) {
      if (toCover <= 0 || heldLeft <= 0) break;
      const take = Math.min(d.availablePaise, toCover, heldLeft);
      settleFromReceipts.push({ receiptId: d.receiptId, amountPaise: take });
      toCover -= take;
      heldLeft -= take;
    }
    const depositApplied = settleFromReceipts.reduce((s, r) => s + r.amountPaise, 0);
    const duesPaise = Math.max(0, toCover);
    const excess = Math.max(0, held - depositApplied);

    // RED 7 / RED 8 ⚖: dues are recorded at once against the signed undertaking; the approval follows the exit.
    if (input.undertakingDocumentId !== undefined) await checkUndertaking(tx, a.patientId, input.undertakingDocumentId);
    if (duesPaise > 0 && (input.settlement !== "dues_recorded" || input.undertakingDocumentId === undefined)) {
      throw new IpdRefusal("dues_need_approval", undefined, { duesPaise });
    }
    let duesApproval: { id: string; by: string | null } | null = null;
    if (duesPaise > 0 && input.duesApprovalId !== undefined) {
      // Review YELLOW 5: attached only when granted, covering, not the requester's own, and on no other bill.
      const ok = await usableDuesApproval(tx, a.id, input.duesApprovalId);
      if (ok !== null && (ok.amountPaise === null || ok.amountPaise >= duesPaise)) duesApproval = { id: ok.id, by: ok.decidedBy };
    }

    const label = kind === "final" ? "IPD final bill" : `IPD supplementary bill ${String(seq)}`;
    let invoice: { invoiceId: string; invoiceNo: string } | null = null;
    if (p.lines.length > 0) {
      const issued = await issueInvoice(tx as unknown as Db, actor, {
        draftId: newId(),
        patientId: a.patientId,
        lines: p.lines,
        ...(settleFromReceipts.length > 0 ? { settleFromReceipts } : {}),
        ...(tenders.length > 0 ? { receipt: { tenders, note: `${label} ${a.admissionNo ?? a.id}` } } : {}),
        ...(duesPaise > 0 ? { holdUntilPaid: { reason: `${label} dues ${a.admissionNo ?? a.id} — undertaking ${input.undertakingDocumentId ?? ""}` } } : {}),
      }, at);
      invoice = { invoiceId: issued.invoiceId, invoiceNo: issued.invoiceNo };
    }

    let refundPaise = 0;
    let refundApprovalId: string | null = null;
    if (excess > 0 && input.settlement !== "insurer_pending_undertaking") {
      const refund = await requestRefund(tx as unknown as Db, actor, {
        patientId: a.patientId, kind: "advance_refund", amountPaise: excess, reasonClass: "genuine",
        reason: `IPD deposit exceeded the ${kind === "final" ? "final" : "supplementary"} bill for ${a.admissionNo ?? a.id}`,
      });
      refundPaise = excess;
      refundApprovalId = refund.approvalId;
    }

    const finalBillId = newId();
    await tx.insert(ipdFinalBills).values({
      id: finalBillId, admissionId: a.id, billVersion: c.billVersion, invoiceId: invoice?.invoiceId ?? null, invoiceNo: invoice?.invoiceNo ?? null,
      totalPaise: p.totalPaise, payerPaise: p.payerPaise, patientPaise: p.patientPaise,
      depositAppliedPaise: depositApplied, paidPaise: tenderedPaise, refundPaise, refundApprovalId, duesPaise,
      settlement: input.settlement, duesApprovalId: duesApproval?.id ?? null, duesApprovedBy: duesApproval?.by ?? null,
      duesApprovedAt: duesApproval === null ? null : at,
      undertakingDocumentId: input.undertakingDocumentId ?? null, split: c.split as unknown as Record<string, unknown>,
      settledBy: actor.id, settledAt: at, kind, seq, lineIds: c.lines.map((l) => l.id),
    });
    if (p.payerPaise > 0) {
      // A supplementary bill's payer portion is its own claim row (the payer seam takes one claim per bill).
      await tx.insert(ipdPayerClaims).values({
        id: newId(), admissionId: a.id, finalBillId, payerKind: a.payerKind!, coverageId: a.coverageId, preAuthNumber: c.split.preAuthNumber,
        claimPaise: p.payerPaise, status: "pending", createdBy: actor.id, createdAt: at,
      });
    }
    await appendEvent(tx, billSettled.make({
      payload: { admissionId: a.id, finalBillId, invoiceId: invoice?.invoiceId ?? null, kind, seq, provenance: provenanceOf(actor) },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return {
      billId: finalBillId, billNo: invoice?.invoiceNo ?? `NIL-${a.admissionNo ?? a.id}${seq === 0 ? "" : `-S${String(seq)}`}`, totalPaise: p.totalPaise,
      payerPayablePaise: p.payerPaise, patientPayablePaise: p.patientPaise, paidPaise: tenderedPaise, refundPaise, duesPaise,
    };
  }
}

/**
 * Review YELLOW 5 — a dues approval is usable once: granted, on this admission, decided by someone other than its
 * requester (the engine refuses that; re-checked so a row written around it cannot pass), and attached to no bill yet.
 */
async function usableDuesApproval(tx: Db | Tx, admissionId: string, approvalId: string): Promise<GrantedApproval | null> {
  const ok = await grantedApproval(tx, approvalId, "discharge_dues", [admissionId]);
  if (ok === null) return null;
  const req = (await tx.select({ requesterId: approvals.requesterId }).from(approvals).where(eq(approvals.id, approvalId)))[0];
  if (req === undefined || ok.decidedBy === null || ok.decidedBy === req.requesterId) return null;
  const used = await tx.select({ id: ipdFinalBills.id }).from(ipdFinalBills).where(eq(ipdFinalBills.duesApprovalId, approvalId));
  return used.length > 0 ? null : ok;
}
