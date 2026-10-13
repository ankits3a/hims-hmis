import { asc, eq } from "drizzle-orm";
import { IPD_INTENTS, newId } from "@hmis/contracts";
import { istDayString } from "../../kernel/approvals/cumulative";
import { withTx } from "../../kernel/db/client";
import { ipdAdmissionDeposits, ipdChargeLines, ipdFinalBills, ipdPayerClaims } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { issueInvoice, previewInvoice, receiptUnallocatedPaise, requestRefund } from "../billing";
import { roundTotalToRupee } from "../tariff";
import { holdsPermission, lockAdmission, onceIpd, provenanceOf, readAdmission, requireIpdPermission } from "./admission-core";
import { grantedApproval, requestIpdApproval } from "./approval-types";
import { postAdmissionCharges } from "./charges";
import { activeDischarge, confirmationsOf, pendingDepartments } from "./discharge";
import { billSettled } from "./discharge-events";
import { IpdError, IpdRefusal } from "./errors";
import { depositHeldPaise } from "./interim-bill";
import { IPD_BILL_VIEW, IPD_DISCHARGE_BILL } from "./manifest";
import { computePayerSplit } from "./payer-bill";
import type { Actor, IpdFinalBill, IpdIntentName, IpdPayerSplit } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { InvoiceLineInput } from "../tariff";
import type { AdmissionRow } from "./admission-core";

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
 * - The final bill posts the running bill up to the settle day as if the patient leaves at that instant
 *   (`presumedDischargeAt`): the day rule's discharge-day grace (free until 14:00) applies. A later real exit after 14:00
 *   is caught by the nightly job as a supplementary line.
 * - An excess deposit is refunded on request (`advance_refund`); with `insurer_pending_undertaking` it is HELD against the
 *   insurer's final approval (§4.7: "the deposit covers the gap") and no refund is raised.
 * - Tenders: cash, UPI and card (billing's three); a cheque / NEFT / DD is refused `tender_not_supported`.
 *
 * DECIDED ⚖ (Consumer Protection Act 2019; the state clinical-establishment rules; NHRC charter of patients' rights): a
 * patient is NEVER detained for unpaid dues. An unpaid patient-payable balance needs a GRANTED `ipd_discharge_dues`
 * approval (billing manager or MS) covering it and the signed undertaking; the invoice is then left OPEN on billing's
 * dues list (`holdUntilPaid`, never `credit_extended` — billing's owner-only credit ruling is untouched) and the gate
 * pass issues with "dues recorded".
 */

type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };
type ChargeLineRow = typeof ipdChargeLines.$inferSelect;

/** The admission states in which a final bill may be composed and settled (the cascade, and every other ending). */
const BILLABLE: ReadonlySet<string> = new Set(["fit_declared", "lama", "absconded", "deceased"]);
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

export async function composeFinalBill(db: Db | Tx, a: AdmissionRow): Promise<ComposedFinalBill> {
  const lines = await db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, a.id))
    .orderBy(asc(ipdChargeLines.serviceDate), asc(ipdChargeLines.postedAt), asc(ipdChargeLines.id));
  const reversed = new Set(lines.flatMap((l) => (l.reversalOf === null ? [] : [l.reversalOf])));
  const split = await computePayerSplit(db, a, lines);
  const byId = new Map(split.lines.map((l) => [l.lineId, l] as const));
  const live = lines.filter((l) => l.reversalOf === null && !reversed.has(l.id)).map((line) => {
    const s = byId.get(line.id);
    return { line, payerPaise: s?.payerPaise ?? 0, patientPaise: s?.patientPaise ?? line.netPaise };
  });
  const sum = (f: (x: (typeof live)[number]) => number) => live.reduce((t, x) => t + f(x), 0);
  return {
    billVersion: lines.length, lines, live, split,
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

function settledView(row: typeof ipdFinalBills.$inferSelect | undefined): IpdFinalBill["settled"] {
  if (row === undefined) return null;
  return {
    billNo: row.invoiceNo, settlement: row.settlement as NonNullable<IpdFinalBill["settled"]>["settlement"], paidPaise: row.paidPaise,
    refundPaise: row.refundPaise, duesPaise: row.duesPaise, settledAt: row.settledAt.toISOString(),
  };
}

export async function finalBillRow(db: Db | Tx, admissionId: string) {
  return (await db.select().from(ipdFinalBills).where(eq(ipdFinalBills.admissionId, admissionId)))[0];
}

/** The final bill as the cashier reads it (money: `ipd.discharge.bill` or `ipd.bill.view` only — never a doctor). */
export async function finalBillView(db: Db, a: AdmissionRow): Promise<IpdFinalBill> {
  const c = await composeFinalBill(db, a);
  const settled = await finalBillRow(db, a.id);
  const patientRounded = roundTotalToRupee(Math.max(c.patientPaise, 0)).roundedPaise;
  return {
    admissionId: a.id, admissionNo: a.admissionNo, billVersion: c.billVersion,
    lines: c.live.map(({ line, payerPaise, patientPaise }) => ({
      lineId: line.id, serviceDate: line.serviceDate, serviceName: line.serviceName, component: line.component, qty: line.qty,
      netPaise: line.netPaise, payerPaise, patientPaise,
    })),
    totalPaise: c.totalPaise, payerPaise: c.payerPaise, patientPaise: c.patientPaise, patientRoundedPaise: patientRounded,
    depositHeldPaise: c.depositHeldPaise, balancePaise: patientRounded - c.depositHeldPaise, payerKind: a.payerKind,
    settled: settledView(settled),
  };
}

export async function readFinalBill(db: Db, actor: Actor, admissionId: string): Promise<IpdFinalBill> {
  if (!(await holdsPermission(db, actor, IPD_DISCHARGE_BILL)) && !(await holdsPermission(db, actor, IPD_BILL_VIEW))) {
    throw new IpdError("ipd_forbidden", `this read needs the permission ${IPD_DISCHARGE_BILL} or ${IPD_BILL_VIEW}`, { permission: IPD_DISCHARGE_BILL });
  }
  return finalBillView(db, await readAdmission(db, admissionId));
}

/**
 * Posts the running bill through the settle day (as if the patient leaves now) and answers the composed bill. Called by
 * the cashier when the bill is opened; the settle that follows names this `billVersion`.
 */
export async function prepareFinalBill(db: Db, actor: Actor, admissionId: string, opts: Opts = {}): Promise<IpdFinalBill> {
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const at = opts.now ?? new Date();
  const a = await readAdmission(db, admissionId);
  if (!BILLABLE.has(a.state) && a.state !== "discharging") throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
  if ((await finalBillRow(db, a.id)) === undefined) {
    await postAdmissionCharges(db, a.id, { upToIstDate: istDayString(at), now: at, presumedDischargeAt: a.endedAt ?? at });
  }
  return finalBillView(db, await readAdmission(db, admissionId));
}

/** Files the dues approval for the patient's unpaid balance (the approver is the billing manager or the MS). */
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

/** The admission's deposit receipts with money still unallocated, oldest first (the money applied before any tender). */
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

export async function settleFinalBill(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"settle_final_bill">> {
  const input: Input<"settle_final_bill"> = IPD_INTENTS.settle_final_bill.input.parse(raw);
  await requireIpdPermission(db, actor, IPD_DISCHARGE_BILL);
  const tenders = input.payments.map((p) => {
    const mode = TENDERS[p.tender];
    if (mode === undefined) throw new IpdError("tender_not_supported", `the billing ledger takes cash, UPI and card, not ${p.tender}`, { tender: p.tender });
    return { mode, amountPaise: p.amountPaise, ...(p.ref === undefined ? {} : { refText: p.ref }) };
  });
  const at = opts.now ?? new Date();
  return onceIpd(db, actor, "settle_final_bill", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const a = await lockAdmission(tx, input.admissionId);
    if (!BILLABLE.has(a.state)) throw new IpdRefusal("admission_wrong_state", undefined, { state: a.state });
    if ((await finalBillRow(tx, a.id)) !== undefined) throw new IpdError("final_bill_exists", "this admission's final bill is already settled — a missed charge is a supplementary bill");
    if (a.state === "fit_declared") {
      const d = await activeDischarge(tx, a.id);
      const pending = d === undefined ? [] : pendingDepartments(await confirmationsOf(tx, d.id));
      if (pending.length > 0) throw new IpdRefusal("charges_unconfirmed", undefined, { pending });
    }
    const c = await composeFinalBill(tx, a);
    if (c.billVersion !== input.billVersion) throw new IpdRefusal("bill_changed", undefined, { billVersion: c.billVersion });

    const lines = patientInvoiceLines(c);
    const preview = lines.length === 0 ? null : await previewInvoice(tx as unknown as Db, { lines, patientId: a.patientId }, at);
    const netPaise = preview?.totals.netPayablePaise ?? 0;
    const tenderedPaise = tenders.reduce((s, t) => s + t.amountPaise, 0);
    if (tenderedPaise > netPaise) {
      throw new IpdError("tender_exceeds_bill", "record what is applied to the bill and give the change", { tenderedPaise, netPayablePaise: netPaise });
    }
    // Deposits first (oldest receipt first), then the tenders; what is left is dues.
    const deposits = await depositReceipts(tx, a.id);
    let toCover = netPaise - tenderedPaise;
    const settleFromReceipts: { receiptId: string; amountPaise: number }[] = [];
    for (const d of deposits) {
      if (toCover <= 0) break;
      const take = Math.min(d.availablePaise, toCover);
      settleFromReceipts.push({ receiptId: d.receiptId, amountPaise: take });
      toCover -= take;
    }
    const depositApplied = settleFromReceipts.reduce((s, r) => s + r.amountPaise, 0);
    const duesPaise = Math.max(0, toCover);
    const excess = deposits.reduce((s, d) => s + d.availablePaise, 0) - depositApplied;

    let duesApprovedBy: string | null = null;
    if (duesPaise > 0) {
      // ⚖ Never a detention: the balance goes to the approver and the dues register.
      if (input.settlement !== "dues_approved" || input.undertakingDocumentId === undefined) {
        throw new IpdRefusal("dues_need_approval", undefined, { duesPaise });
      }
      const ok = await grantedApproval(tx, input.duesApprovalId, "discharge_dues", [a.id]);
      if (ok === null || (ok.amountPaise !== null && ok.amountPaise < duesPaise)) {
        throw new IpdRefusal("dues_need_approval", undefined, { duesPaise, approvalId: input.duesApprovalId ?? null });
      }
      duesApprovedBy = ok.decidedBy;
    }

    let invoice: { invoiceId: string; invoiceNo: string } | null = null;
    if (lines.length > 0) {
      const issued = await issueInvoice(tx as unknown as Db, actor, {
        draftId: newId(),
        patientId: a.patientId,
        lines,
        ...(settleFromReceipts.length > 0 ? { settleFromReceipts } : {}),
        ...(tenders.length > 0 ? { receipt: { tenders, note: `IPD final bill ${a.admissionNo ?? a.id}` } } : {}),
        ...(duesPaise > 0 ? { holdUntilPaid: { reason: `IPD dues on discharge ${a.admissionNo ?? a.id} — undertaking ${input.undertakingDocumentId ?? ""}, approval ${input.duesApprovalId ?? ""}` } } : {}),
      }, at);
      invoice = { invoiceId: issued.invoiceId, invoiceNo: issued.invoiceNo };
    }

    let refundPaise = 0;
    let refundApprovalId: string | null = null;
    if (excess > 0 && input.settlement !== "insurer_pending_undertaking") {
      const refund = await requestRefund(tx as unknown as Db, actor, {
        patientId: a.patientId, kind: "advance_refund", amountPaise: excess, reasonClass: "genuine",
        reason: `IPD deposit exceeded the final bill for ${a.admissionNo ?? a.id}`,
      });
      refundPaise = excess;
      refundApprovalId = refund.approvalId;
    }

    const finalBillId = newId();
    await tx.insert(ipdFinalBills).values({
      id: finalBillId, admissionId: a.id, billVersion: c.billVersion, invoiceId: invoice?.invoiceId ?? null, invoiceNo: invoice?.invoiceNo ?? null,
      totalPaise: Math.max(0, c.totalPaise), payerPaise: Math.max(0, c.payerPaise), patientPaise: netPaise,
      depositAppliedPaise: depositApplied, paidPaise: tenderedPaise, refundPaise, refundApprovalId, duesPaise,
      settlement: input.settlement, duesApprovalId: duesPaise > 0 ? input.duesApprovalId ?? null : null, duesApprovedBy,
      undertakingDocumentId: input.undertakingDocumentId ?? null, split: c.split as unknown as Record<string, unknown>,
      settledBy: actor.id, settledAt: at,
    });
    if (c.payerPaise > 0 && a.payerKind !== null) {
      await tx.insert(ipdPayerClaims).values({
        id: newId(), admissionId: a.id, finalBillId, payerKind: a.payerKind, coverageId: a.coverageId, preAuthNumber: c.split.preAuthNumber,
        claimPaise: c.payerPaise, status: "pending", createdBy: actor.id, createdAt: at,
      });
    }
    await appendEvent(tx, billSettled.make({
      payload: {
        admissionId: a.id, finalBillId, invoiceId: invoice?.invoiceId ?? null, settlement: input.settlement, duesRecorded: duesPaise > 0,
        provenance: provenanceOf(actor),
      },
      actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
    }));
    return {
      billId: finalBillId, billNo: invoice?.invoiceNo ?? `NIL-${a.admissionNo ?? a.id}`, totalPaise: Math.max(0, c.totalPaise),
      payerPayablePaise: Math.max(0, c.payerPaise), patientPayablePaise: netPaise, paidPaise: tenderedPaise, refundPaise, duesPaise,
    };
  }), at);
}

