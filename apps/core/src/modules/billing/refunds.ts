import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import {
  allocations, creditNoteLines, creditNotes, invoiceLines, invoices, refundVouchers,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { getEncounter } from "../opd";
import { assertPaise } from "../tariff";
import { loadBillingConfig } from "./config";
import { refundableSurplusOf } from "./credit-notes";
import { BillingError } from "./errors";
import { paymentRefunded, refundVoucherIssued } from "./events";
import { advanceOf } from "./receipts";
import { nextDocNo } from "./series";
import { requireOpenSession } from "./sessions";
import type { ChargeRules } from "./config";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * Plan 08 D6 — refund vouchers: money OUT, approval-gated ALWAYS (spec §7), carrying the four
 * legacy refund guards in their 2026 renderings.
 *
 *   Guard 1 (STRUCTURAL, K27) — a voucher can never pay out money the hospital never took. An
 *     `invoice_refund` is capped by the money actually RECEIVED against that invoice (Sigma
 *     effective allocations) and by the surplus its credit notes actually freed; an
 *     `advance_refund` is capped by the patient's advance balance. Both are checked under a row
 *     lock, which is what makes them total rather than advisory.
 *   Guards 2+3 (FLAGS, not blocks) — `terminal_encounter` and `delivered_line` ride the approval
 *     request and the voucher row so the approver sees WHY the item is escalated. NOTHING is
 *     auto-blocked: the legacy system's hard refusals turned into unrecorded cash-drawer
 *     workarounds, and an approval an approver can see is worth more than a refusal they route
 *     around (owner ruling 3).
 *   Guard 4 — `reasonClass: 'mistake' | 'genuine'` plus a non-empty `reason` on every voucher,
 *     zod-required at the boundary (Plan 12's Fraud Sentinel dimension).
 *
 * LOCK DISCIPLINE (D1, and the Plan 06.1 C1 lesson — the single ordered lock, never row-then-set;
 * see the identical warning in `receipts.ts` and in `modules/tariff/versions.ts`). The advance
 * lane locks EVERY receipt row of the patient in ONE statement, `order by id for update`, before
 * it reads the balance: two concurrent advance refunds therefore queue instead of both reading
 * the same pre-refund balance, and D1's "the advance balance is never negative" becomes an
 * enforced invariant rather than a comment. Locking the rows one at a time — the row-then-set
 * shape 06.1 C1 died of — would let two writers acquire them in opposite orders and deadlock.
 * The file's global acquisition order matches `receipts.ts`: INVOICE first, RECEIPTS second, and
 * neither lane here takes both.
 *
 * WHAT THIS FILE DOES NOT DO. It writes no `receipts` row and never reaches
 * `insertReceiptWithTenders` — a refund is money leaving, not money arriving, so nothing here
 * needs that helper's missing `assertPaise` belt (pipeline A carried-forward item 6). The one
 * externally supplied amount this module owns is the refund amount, and it passes `assertPaise`
 * at both entry points below, before any read or write.
 */

/** The approval every voucher needs (D6: approval-gated ALWAYS), and the subject it binds to. */
export const REFUND_APPROVAL_TYPE = "billing_refund";
export const REFUND_APPROVAL_SUBJECT = "billing_refund";

export type RefundVoucherRow = typeof refundVouchers.$inferSelect;
export type RefundKind = "invoice_refund" | "advance_refund";
export type RefundMethod = "cash" | "bank_transfer";
export type RefundReasonClass = "mistake" | "genuine";
/** Guards 2+3. Flags, never blocks — they escalate a decision, they do not make it. */
export type GuardFlag = "terminal_encounter" | "delivered_line";

const reasonClassSchema = z.enum(["mistake", "genuine"]); // guard 4
const methodSchema = z.enum(["cash", "bank_transfer"]);

/**
 * `amountPaise` is deliberately `z.number()` and NOT `z.number().int()`: the integer belt on an
 * externally supplied amount is `assertPaise` (Global Constraints — the M3 belt at the module
 * boundary), and a schema that quietly refused a fractional ask first would take that belt out of
 * the code path it exists to guard. The T7 convention, kept.
 */
const requestRefundSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invoice_refund"),
    creditNoteId: z.string().min(1), // the paper the refund draws on (D4: the only way a receivable shrinks)
    amountPaise: z.number(),
    reasonClass: reasonClassSchema,
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("advance_refund"),
    patientId: z.string().min(1),
    amountPaise: z.number(),
    reasonClass: reasonClassSchema,
    reason: z.string().min(1),
  }),
]);

const issueRefundVoucherSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invoice_refund"),
    creditNoteId: z.string().min(1),
    amountPaise: z.number(),
    reasonClass: reasonClassSchema,
    reason: z.string().min(1),
    approvalId: z.string().min(1),
    method: methodSchema,
  }),
  z.object({
    kind: z.literal("advance_refund"),
    patientId: z.string().min(1),
    amountPaise: z.number(),
    reasonClass: reasonClassSchema,
    reason: z.string().min(1),
    approvalId: z.string().min(1),
    method: methodSchema,
  }),
]);

/**
 * Refund-to-payer (spec §7): WHO the money went to is captured when it leaves, not when the
 * voucher is written — the payee is often not the patient, and at request time nobody knows who
 * will collect. The printed voucher's ink signature line is the other half; the signed QR rides
 * the print surface (T13).
 */
const payRefundVoucherSchema = z.object({
  voucherId: z.string().min(1),
  payeeName: z.string().min(1),
  payeeIdType: z.string().min(1),
  payeeIdRef: z.string().min(1),
});

export type RequestRefundInput = z.infer<typeof requestRefundSchema>;
export type IssueRefundVoucherInput = z.infer<typeof issueRefundVoucherSchema>;
export type PayRefundVoucherInput = z.infer<typeof payRefundVoucherSchema>;

export type RequestRefundResult = {
  approvalId: string;
  instanceId: string;
  patientId: string;
  invoiceId: string | null;
  creditNoteId: string | null;
  amountPaise: number;
  guardFlags: GuardFlag[];
};

export type IssueRefundVoucherResult = {
  voucherId: string;
  voucherNo: string;
  patientId: string;
  kind: RefundKind;
  invoiceId: string | null;
  creditNoteId: string | null;
  amountPaise: number;
  method: RefundMethod;
  guardFlags: GuardFlag[];
  status: "issued";
};

export type PayRefundVoucherResult = {
  voucherId: string;
  voucherNo: string;
  patientId: string;
  amountPaise: number;
  method: RefundMethod;
  cashierSessionId: string | null;
  paidAt: Date;
  status: "paid";
};

// ---------------------------------------------------------------------------------------------
// Readers. Each reads ONE table at a time: drizzle renders a column interpolated into a `sql`
// SELECT FIELD without its table qualifier, so a two-table query written that way can silently
// compare the wrong columns (the caveat T5, T6 and T7 each recorded on the same aggregates).
// ---------------------------------------------------------------------------------------------

/** Effective allocation against one invoice: Sigma apply - Sigma reverse (D1) — money RECEIVED. */
async function receivedPaiseOf(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({
      total: sql<string>`coalesce(sum(case when ${allocations.kind} = 'apply' then ${allocations.amountPaise} else -${allocations.amountPaise} end), 0)`,
    })
    .from(allocations)
    .where(eq(allocations.invoiceId, invoiceId));
  return Number(rows[0]!.total); // sum() over bigint arrives as numeric text
}

/** Sigma vouchers already drawn against one invoice — issued money counts, it is owed either way. */
async function vouchersAgainstInvoice(exec: Db | Tx, invoiceId: string): Promise<number> {
  const rows = await exec
    .select({ total: sql<string>`coalesce(sum(${refundVouchers.amountPaise}), 0)` })
    .from(refundVouchers)
    .where(and(eq(refundVouchers.invoiceId, invoiceId), inArray(refundVouchers.status, ["issued", "paid"])));
  return Number(rows[0]!.total);
}

/**
 * D6's guard-1 serializer for the invoice lane. Locking an immutable row is legal — 0012's trigger
 * forbids UPDATE and DELETE, not locks — and it is the same row, in the same mode, that
 * `allocateReceipt` and `issueCreditNote` take, so a refund, an allocation and a credit note
 * against one invoice queue instead of racing each other's sums.
 */
async function lockInvoice(
  tx: Tx,
  invoiceId: string,
): Promise<{ id: string; patientId: string; encounterId: string | null; netPayablePaise: number }> {
  const rows = await tx
    .select({
      id: invoices.id, patientId: invoices.patientId,
      encounterId: invoices.encounterId, netPayablePaise: invoices.netPayablePaise,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .for("update");
  const row = rows[0];
  if (!row) throw new BillingError("unknown_invoice", `unknown invoice ${invoiceId}`);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Guards 2+3 — the flags (D6)
// ---------------------------------------------------------------------------------------------

/**
 * D8's fee branch, read here rather than imported: `charge-rules.ts` (T10) will own the canonical
 * `feeServiceFor`, and this task cannot create it. A `revisit` is FREE (spec:224, Plan 07's owner
 * decision), so it has no fee line and nothing on it can be a delivered consultation.
 */
function feeServiceIdFor(visitType: string, rules: ChargeRules): string | null {
  if (visitType === "revisit") return null;
  return visitType === "renewal" ? rules.opdConsult.renewal : rules.opdConsult.new;
}

/**
 * Guards 2 and 3 (D6), computed — never enforced. `terminal_encounter` when the invoice's
 * encounter has reached a terminal state; `delivered_line` when the money being refunded pays for
 * the consultation fee AND that consultation was actually completed. Both ride the approval
 * request and the stored voucher so the approver can see the escalation's reason.
 *
 * The encounter is read through the OPD module's `getEncounter` (its index.ts), never its tables —
 * billing reads no other module's tables (spec §4 module isolation).
 *
 * An advance refund has no document and therefore no flags: there is no encounter behind money
 * that was never billed. A missing or dangling encounter reference yields no flags rather than a
 * refusal — an absent encounter is not evidence of a terminal one, and guards 2+3 never block.
 */
export async function guardFlagsFor(
  exec: Db | Tx,
  ref: { invoiceId?: string | null; creditNoteId?: string | null },
): Promise<GuardFlag[]> {
  const invoiceId = ref.invoiceId ?? (ref.creditNoteId ? await invoiceIdOfCreditNote(exec, ref.creditNoteId) : null);
  if (invoiceId === null) return [];

  const invoiceRows = await exec
    .select({ id: invoices.id, encounterId: invoices.encounterId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const invoice = invoiceRows[0];
  if (!invoice || invoice.encounterId === null) return [];

  const encounter = await getEncounter(exec, invoice.encounterId);
  if (!encounter) return [];

  const flags: GuardFlag[] = [];
  if (encounter.status === "completed" || encounter.status === "abandoned") flags.push("terminal_encounter");

  const cfg = await loadBillingConfig(exec);
  const feeServiceId = feeServiceIdFor(encounter.visitType, cfg.chargeRules);
  if (feeServiceId !== null && encounter.consultCompletedAt !== null) {
    const serviceIds = await refundedServiceIds(exec, invoiceId, ref.creditNoteId ?? null);
    if (serviceIds.has(feeServiceId)) flags.push("delivered_line");
  }
  return flags;
}

/** The services whose money is being refunded: the credit note's lines, or the whole invoice. */
async function refundedServiceIds(exec: Db | Tx, invoiceId: string, creditNoteId: string | null): Promise<Set<string>> {
  if (creditNoteId === null) {
    const rows = await exec
      .select({ serviceId: invoiceLines.serviceId })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId));
    return new Set(rows.map((r) => r.serviceId));
  }
  const credited = await exec
    .select({ invoiceLineId: creditNoteLines.invoiceLineId })
    .from(creditNoteLines)
    .where(eq(creditNoteLines.creditNoteId, creditNoteId));
  const lineIds = credited.map((r) => r.invoiceLineId);
  if (lineIds.length === 0) return new Set();
  const rows = await exec
    .select({ serviceId: invoiceLines.serviceId })
    .from(invoiceLines)
    .where(inArray(invoiceLines.id, lineIds));
  return new Set(rows.map((r) => r.serviceId));
}

async function invoiceIdOfCreditNote(exec: Db | Tx, creditNoteId: string): Promise<string> {
  const rows = await exec
    .select({ invoiceId: creditNotes.invoiceId })
    .from(creditNotes)
    .where(eq(creditNotes.id, creditNoteId));
  const row = rows[0];
  if (!row) {
    // T1's closed BillingErrorCode union (frozen outside this task) carries no unknown_credit_note
    // code; the detail names what was actually missing.
    throw new BillingError("unknown_invoice", `unknown credit note ${creditNoteId}`, { creditNoteId });
  }
  return row.invoiceId;
}

// ---------------------------------------------------------------------------------------------
// The refund target — one resolution, shared by request and issue, so the approval a request
// files and the approval an issue checks can never bind to different things.
// ---------------------------------------------------------------------------------------------

type RefundTarget = {
  patientId: string;
  invoiceId: string | null;
  creditNoteId: string | null;
  encounterId: string | null;
  subjectId: string;
};

async function resolveTarget(db: Db, input: RequestRefundInput | IssueRefundVoucherInput): Promise<RefundTarget> {
  if (input.kind === "advance_refund") {
    // The patient IS the subject: an advance is not a document, it is a balance.
    return {
      patientId: input.patientId, invoiceId: null, creditNoteId: null, encounterId: null,
      subjectId: input.patientId,
    };
  }
  const invoiceId = await invoiceIdOfCreditNote(db, input.creditNoteId);
  const rows = await db
    .select({ id: invoices.id, patientId: invoices.patientId, encounterId: invoices.encounterId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  const invoice = rows[0];
  if (!invoice) throw new BillingError("unknown_invoice", `unknown invoice ${invoiceId}`);
  return {
    patientId: invoice.patientId, invoiceId: invoice.id, creditNoteId: input.creditNoteId,
    encounterId: invoice.encounterId, subjectId: input.creditNoteId,
  };
}

/** Check-on-execute: granted, and bound to THIS subject, patient and amount (the T5/T7 shape). */
async function assertGrantedApproval(
  db: Db,
  approvalId: string,
  expected: { subjectId: string; patientId: string; amountPaise: number },
): Promise<void> {
  const approval = await getApproval(db, approvalId);
  if (!approval || approval.status !== "granted") {
    throw new BillingError("approval_not_granted", `approval ${approvalId} is not granted`);
  }
  const bound =
    approval.typeKey === REFUND_APPROVAL_TYPE &&
    approval.subjectType === REFUND_APPROVAL_SUBJECT &&
    approval.subjectId === expected.subjectId &&
    approval.patientId === expected.patientId &&
    approval.amountPaise === expected.amountPaise;
  if (!bound) {
    throw new BillingError("approval_subject_mismatch", `approval ${approvalId} does not bind to this refund`, {
      expected: { typeKey: REFUND_APPROVAL_TYPE, subjectType: REFUND_APPROVAL_SUBJECT, ...expected },
      got: {
        typeKey: approval.typeKey, subjectType: approval.subjectType, subjectId: approval.subjectId,
        patientId: approval.patientId, amountPaise: approval.amountPaise,
      },
    });
  }
}

/**
 * The kernel's `ApprovalRequestInput` has no free-form payload column (kernel/db/schema/approvals.ts),
 * so the guard flags ride the one field an approver actually reads — the request note. The voucher
 * row carries them structurally in `guard_flags`.
 */
function refundRequestNote(input: RequestRefundInput, guardFlags: GuardFlag[]): string {
  const flags = guardFlags.length === 0 ? "none" : guardFlags.join(", ");
  return `${input.kind} (${input.reasonClass}): ${input.reason} [guard flags: ${flags}]`;
}

// ---------------------------------------------------------------------------------------------
// D6 — request, issue, pay
// ---------------------------------------------------------------------------------------------

/**
 * Files the mandatory `billing_refund` approval with the guard flags attached and the money on it,
 * so the kernel's C-12 same-patient/same-day aggregation comes free (approvals/cumulative.ts).
 * Nothing is written here but the approval: a refund request is a question, not a document.
 */
export async function requestRefund(db: Db, actor: Actor, rawInput: RequestRefundInput): Promise<RequestRefundResult> {
  const input = requestRefundSchema.parse(rawInput);
  assertPaise(input.amountPaise, "refund amount"); // the M3 belt at OUR boundary
  if (input.amountPaise === 0) {
    throw new BillingError("invalid_paise", "a refund must move a positive amount of money");
  }

  const target = await resolveTarget(db, input);
  const guardFlags = await guardFlagsFor(db, { invoiceId: target.invoiceId, creditNoteId: target.creditNoteId });

  const filed = await withTx(db, (tx) =>
    requestApproval(tx, actor, {
      typeKey: REFUND_APPROVAL_TYPE,
      subject: { type: REFUND_APPROVAL_SUBJECT, id: target.subjectId },
      patientId: target.patientId,
      encounterId: target.encounterId ?? undefined,
      amountPaise: input.amountPaise,
      requestNote: refundRequestNote(input, guardFlags),
    }),
  );

  return {
    approvalId: filed.approvalId,
    instanceId: filed.instanceId,
    patientId: target.patientId,
    invoiceId: target.invoiceId,
    creditNoteId: target.creditNoteId,
    amountPaise: input.amountPaise,
    guardFlags,
  };
}

/**
 * D6 — the voucher. Check-on-execute against the GRANTED approval (the dispatcher stays
 * unscheduled until Plan 11), then GUARD 1 under a row lock, then the row.
 *
 * GUARD 1, invoice lane: `Sigma vouchers against this invoice + this ask <= min(money RECEIVED,
 * refundable surplus)`. Both terms matter and neither is the invoice's NET (K27/M-R1 — capping at
 * net lets a dues bill be refunded in full, which is the legacy defect this guard exists for):
 *   · money RECEIVED (Sigma effective allocations) is the structural invariant — the hospital
 *     cannot pay back cash it never took;
 *   · the refundable surplus (D4: credited + allocated beyond the net) is what a credit note
 *     actually freed — a patient who still owes money is owed none back.
 *
 * GUARD 1, advance lane: the ask must fit inside the patient's advance balance, read under the
 * single ordered receipt lock. `advanceOf` (T6) already subtracts every advance-refund voucher
 * issued or paid, so this comparison IS D1's "the advance balance is never negative": the balance
 * a second refunder reads is the one the first left behind, because it cannot read it until the
 * first commits.
 */
export async function issueRefundVoucher(
  db: Db,
  actor: Actor,
  rawInput: IssueRefundVoucherInput,
  now: Date = new Date(),
): Promise<IssueRefundVoucherResult> {
  const input = issueRefundVoucherSchema.parse(rawInput);
  assertPaise(input.amountPaise, "refund amount"); // the M3 belt at OUR boundary
  if (input.amountPaise === 0) {
    throw new BillingError("invalid_paise", "a refund must move a positive amount of money");
  }

  const cfg = await loadBillingConfig(db);
  const target = await resolveTarget(db, input);
  await assertGrantedApproval(db, input.approvalId, {
    subjectId: target.subjectId, patientId: target.patientId, amountPaise: input.amountPaise,
  });
  const guardFlags = await guardFlagsFor(db, { invoiceId: target.invoiceId, creditNoteId: target.creditNoteId });

  return withTx(db, async (tx) => {
    if (input.kind === "invoice_refund") {
      const invoiceId = target.invoiceId!; // an invoice_refund always resolves one (resolveTarget)
      await lockInvoice(tx, invoiceId);
      const receivedPaise = await receivedPaiseOf(tx, invoiceId);
      const surplusPaise = await refundableSurplusOf(tx, invoiceId);
      const drawnPaise = await vouchersAgainstInvoice(tx, invoiceId);
      const capPaise = Math.min(receivedPaise, surplusPaise);
      if (drawnPaise + input.amountPaise > capPaise) {
        throw new BillingError(
          "refund_exceeds_received",
          `${String(input.amountPaise)}p exceeds the ${String(capPaise - drawnPaise)}p this invoice can still refund`,
          { askedPaise: input.amountPaise, drawnPaise, receivedPaise, surplusPaise, capPaise },
        );
      }
    } else {
      // THE SINGLE ORDERED LOCK (D1, and the Plan 06.1 C1 lesson): every receipt row of this
      // patient, in id order, in ONE statement — never row-then-set. Held before the balance is
      // read, so a concurrent advance refund queues here and reads the balance this one leaves.
      await tx.execute(sql`select id from receipts where patient_id = ${target.patientId} order by id for update`);
      const advancePaise = await advanceOf(tx, target.patientId);
      if (input.amountPaise > advancePaise) {
        throw new BillingError(
          "refund_exceeds_advance",
          `${String(input.amountPaise)}p exceeds the ${String(advancePaise)}p advance this patient holds`,
          { askedPaise: input.amountPaise, advancePaise },
        );
      }
    }

    const voucherId = newId();
    const voucherNo = await nextDocNo(tx, cfg, "voucher", now);
    await tx.insert(refundVouchers).values({
      id: voucherId,
      voucherNo,
      patientId: target.patientId,
      kind: input.kind,
      creditNoteId: target.creditNoteId,
      invoiceId: target.invoiceId,
      amountPaise: input.amountPaise,
      method: input.method,
      payeeName: null, // refund-to-payer identity is captured when the money LEAVES (payRefundVoucher)
      payeeIdType: null,
      payeeIdRef: null,
      reasonClass: input.reasonClass,
      reason: input.reason,
      guardFlags,
      approvalId: input.approvalId,
      status: "issued",
      requestedBy: actor.id,
      issuedAt: now,
    });
    await appendEvent(
      tx,
      refundVoucherIssued.make({
        actor,
        payload: {
          voucherId, voucherNo, patientId: target.patientId, kind: input.kind, amountPaise: input.amountPaise,
        },
        patientId: target.patientId,
        encounterId: target.encounterId ?? undefined,
        // Invoice-scoped emissions correlate to the invoice; an advance refund has none to name
        // and is found by its patient (Global Constraints — catalog discipline).
        correlationId: target.invoiceId ?? undefined,
      }),
    );

    return {
      voucherId,
      voucherNo,
      patientId: target.patientId,
      kind: input.kind,
      invoiceId: target.invoiceId,
      creditNoteId: target.creditNoteId,
      amountPaise: input.amountPaise,
      method: input.method,
      guardFlags,
      status: "issued",
    };
  });
}

/**
 * D6 — the money leaves. Single-winner `issued -> paid` conditional UPDATE, so a double payment is
 * `voucher_state_conflict` rather than two disbursements of one voucher.
 *
 * The bank-transfer floor is checked HERE, at the disbursement, and not at issue: the threshold
 * governs the INSTRUMENT the money leaves by, and that is a decision made at the drawer. A cash
 * voucher above the configured floor is therefore issuable and unpayable until it is reissued as a
 * transfer — deliberate, and the reason M-R2 (a pay path that skips the threshold) is a required
 * kill: this is the only place that refusal can be observed.
 *
 * A cash payment is drawer-bound: it needs the ACTING cashier's own open session (D9), and the
 * session id it stamps is what makes `beginClose`'s expected-cash fold subtract the outflow.
 */
export async function payRefundVoucher(
  db: Db,
  actor: Actor,
  rawInput: PayRefundVoucherInput,
  now: Date = new Date(),
): Promise<PayRefundVoucherResult> {
  const input = payRefundVoucherSchema.parse(rawInput);
  const cfg = await loadBillingConfig(db);

  return withTx(db, async (tx) => {
    const rows = await tx.select().from(refundVouchers).where(eq(refundVouchers.id, input.voucherId));
    const voucher = rows[0];
    if (!voucher) {
      // The closed union (T1, frozen here) carries no unknown-voucher code; the predicate a caller
      // cares about is the same one — there is no PAYABLE voucher with this id.
      throw new BillingError("voucher_state_conflict", `no payable refund voucher ${input.voucherId}`, {
        voucherId: input.voucherId, found: false,
      });
    }

    if (voucher.amountPaise > cfg.refundBankAbovePaise && voucher.method !== "bank_transfer") {
      throw new BillingError(
        "bank_transfer_required",
        `${String(voucher.amountPaise)}p is above the ${String(cfg.refundBankAbovePaise)}p cash refund ceiling`,
        {
          voucherId: voucher.id, amountPaise: voucher.amountPaise,
          refundBankAbovePaise: cfg.refundBankAbovePaise, method: voucher.method,
        },
      );
    }

    const cashierSessionId = voucher.method === "cash" ? (await requireOpenSession(tx, actor)).id : null;

    const updated = await tx
      .update(refundVouchers)
      .set({
        status: "paid",
        paidBy: actor.id,
        paidAt: now,
        cashierSessionId,
        payeeName: input.payeeName,
        payeeIdType: input.payeeIdType,
        payeeIdRef: input.payeeIdRef,
      })
      .where(and(eq(refundVouchers.id, voucher.id), eq(refundVouchers.status, "issued")))
      .returning();
    if (updated.length === 0) {
      throw new BillingError("voucher_state_conflict", `refund voucher ${voucher.id} is not awaiting payment`, {
        voucherId: voucher.id, status: voucher.status,
      });
    }
    const paid = updated[0]!;

    await appendEvent(
      tx,
      paymentRefunded.make({
        actor,
        payload: {
          voucherId: paid.id, patientId: paid.patientId, amountPaise: paid.amountPaise,
          method: paid.method as RefundMethod,
        },
        patientId: paid.patientId,
        correlationId: paid.invoiceId ?? undefined,
      }),
    );

    return {
      voucherId: paid.id,
      voucherNo: paid.voucherNo,
      patientId: paid.patientId,
      amountPaise: paid.amountPaise,
      method: paid.method as RefundMethod,
      cashierSessionId: paid.cashierSessionId,
      paidAt: now,
      status: "paid",
    };
  });
}
