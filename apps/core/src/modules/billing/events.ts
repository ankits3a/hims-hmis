import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The billing module's complete event surface (Plan 08, D-Events) — exactly TWENTY names, all
 * `module: "billing"` (Global Constraints — catalog discipline). Nothing else in this module
 * emits. Payload shapes follow this module's Design sections (D1-D9); the money fields are
 * integer paise throughout (§3.19 — no coercing schema helper).
 */
const MODULE = "billing";
const id = z.string().min(1);
const paise = z.number().int(); // signed — variance can be negative
const nonNegPaise = z.number().int().nonnegative();

export const invoiceIssued = defineEvent(
  "invoice.issued",
  MODULE,
  z.object({ invoiceId: id, invoiceNo: id, patientId: id, netPayablePaise: nonNegPaise }),
);

export const invoiceCreditExtended = defineEvent(
  "invoice.credit_extended",
  MODULE,
  z.object({ invoiceId: id, invoiceNo: id, patientId: id, remainderPaise: nonNegPaise, reason: z.string().min(1) }),
);

export const receiptRecorded = defineEvent(
  "receipt.recorded",
  MODULE,
  z.object({ receiptId: id, receiptNo: id, patientId: id, totalPaise: nonNegPaise }),
);

export const paymentReceived = defineEvent(
  "payment.received",
  MODULE,
  z.object({ receiptId: id, invoiceId: id, patientId: id, amountPaise: nonNegPaise }),
);

export const advanceReceived = defineEvent(
  "advance.received",
  MODULE,
  z.object({ receiptId: id, patientId: id, amountPaise: nonNegPaise }),
);

export const allocationReversed = defineEvent(
  "allocation.reversed",
  MODULE,
  z.object({ allocationId: id, receiptId: id, invoiceId: id, amountPaise: nonNegPaise, reason: z.string().min(1).nullable() }),
);

export const creditNoteIssued = defineEvent(
  "credit_note.issued",
  MODULE,
  z.object({
    creditNoteId: id, creditNoteNo: id, invoiceId: id,
    kind: z.enum(["refund", "clearance_discount", "correction"]), netPaise: paise,
  }),
);

export const refundVoucherIssued = defineEvent(
  "refund_voucher.issued",
  MODULE,
  z.object({ voucherId: id, voucherNo: id, patientId: id, kind: z.enum(["invoice_refund", "advance_refund"]), amountPaise: nonNegPaise }),
);

export const paymentRefunded = defineEvent(
  "payment.refunded",
  MODULE,
  z.object({ voucherId: id, patientId: id, amountPaise: nonNegPaise, method: z.enum(["cash", "bank_transfer"]) }),
);

export const cashierSessionOpened = defineEvent(
  "cashier_session.opened",
  MODULE,
  z.object({ sessionId: id, cashierUserId: id, openingFloatPaise: nonNegPaise }),
);

export const cashierSessionClosed = defineEvent(
  "cashier_session.closed",
  MODULE,
  z.object({ sessionId: id, cashierUserId: id, variancePaise: paise }),
);

/**
 * ═══ FD-11 — A MISTYPED COUNT IS RETRACTED IN THE OPEN, NEVER ERASED ═══
 *
 * The owner mistyped a closing count on the preview and found there was no way back: a count that
 * does not match the till files a variance approval and parks the session in `closing`, the cashier
 * cannot approve their own variance, and they cannot open a second drawer while that one is live.
 * Correct as a control, and a trap in a hospital with one supervisor.
 *
 * `recountSession` is the way back, and this event is the price of it. The retracted figures and a
 * mandatory reason are written to the log BEFORE the session reopens, so a correction is a thing
 * that happened rather than a thing that un-happened. The count a cashier first wrote down is the
 * one piece of evidence a re-count could otherwise destroy, and it is exactly the piece an audit
 * wants: "counted 0, retracted, then counted 4,020" is a different story from "counted 4,020".
 */
export const cashierSessionRecounted = defineEvent(
  "cashier_session.recounted",
  MODULE,
  z.object({
    sessionId: id,
    cashierUserId: id,
    /** What the cashier had entered and is now withdrawing. */
    retractedCountedPaise: nonNegPaise,
    retractedExpectedPaise: nonNegPaise,
    retractedVariancePaise: paise,
    /** The approval filed against the retracted count, now inert. Null if the count matched. */
    retractedApprovalId: z.string().nullable(),
    reason: z.string().min(1),
  }),
);

export const varianceFlagged = defineEvent(
  "variance.flagged",
  MODULE,
  z.object({ sessionId: id, cashierUserId: id, variancePaise: paise }),
);

export const cashThresholdWarned = defineEvent(
  "cash_threshold.warned",
  MODULE,
  z.object({ patientId: id, episodeCashPaise: nonNegPaise, thresholdPaise: nonNegPaise }),
);

export const cashThresholdBlocked = defineEvent(
  "cash_threshold.blocked",
  MODULE,
  z.object({ patientId: id, episodeCashPaise: nonNegPaise, thresholdPaise: nonNegPaise }),
);

export const tenderReconciled = defineEvent(
  "tender.reconciled",
  MODULE,
  z.object({ tenderId: id, receiptId: id, settledPaise: nonNegPaise, expectedNetPaise: nonNegPaise }),
);

export const tenderMismatched = defineEvent(
  "tender.mismatched",
  MODULE,
  z.object({ tenderId: id, receiptId: id, settledPaise: nonNegPaise, expectedNetPaise: nonNegPaise }),
);

export const degradedModeChanged = defineEvent(
  "degraded_mode.changed",
  MODULE,
  z.object({ on: z.boolean(), reason: z.string().min(1) }),
);

export const documentEnteredInError = defineEvent(
  "document.entered_in_error",
  MODULE,
  z.object({ docType: z.enum(["invoice", "receipt", "credit_note"]), docId: id, reason: z.string().min(1) }),
);

export const chargeOrphanFlagged = defineEvent(
  "charge.orphan_flagged",
  MODULE,
  z.object({ encounterId: id, patientId: id, reason: z.string().min(1) }),
);

export const dayClosed = defineEvent(
  "day.closed",
  MODULE,
  z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), totals: z.record(z.string(), z.unknown()) }),
);

/** The name manifest events.test.ts pins — order matches the plan's D-Events list. */
export const BILLING_EVENTS = [
  invoiceIssued, invoiceCreditExtended, receiptRecorded, paymentReceived, advanceReceived,
  allocationReversed, creditNoteIssued, refundVoucherIssued, paymentRefunded,
  cashierSessionOpened, cashierSessionClosed, cashierSessionRecounted, varianceFlagged,
  cashThresholdWarned, cashThresholdBlocked, tenderReconciled, tenderMismatched,
  degradedModeChanged, documentEnteredInError, chargeOrphanFlagged, dayClosed,
] as const;
