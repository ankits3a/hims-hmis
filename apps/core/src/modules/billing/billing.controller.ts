import { Body, Controller, Get, HttpException, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { SodViolationError } from "../../kernel/auth/sod";
import { ApprovalError } from "../../kernel/approvals/types";
import { WorkflowError } from "../../kernel/workflow/instances";
import { hmacSign } from "../../kernel/crypto";
import { receipts, refundVouchers } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { getPatientSummaries, PatientError } from "../patients";
import { loadOpdConfig, OpdError } from "../opd";
import { DISCOUNT_CATEGORIES, TariffError } from "../tariff";
import { feeQuote } from "./charge-rules";
import { loadBillingConfig, updateBillingConfig } from "./config";
import { dayBook, gstr1Summary } from "./daily-close";
import { issueCreditNote, listCreditNotes } from "./credit-notes";
import { BillingError } from "./errors";
import { getInvoice, invoiceSettlement, issueInvoice, listInvoices, previewInvoice } from "./invoices";
import {
  allocateReceipt, listDues, markEnteredInError, patientBalance, recordReceipt, reverseAllocation,
} from "./receipts";
import { issueRefundVoucher, payRefundVoucher, requestRefund } from "./refunds";
import { listMismatches, setDegraded, uploadSettlement } from "./recon";
import { beginClose, confirmClose, listSessions, openSession } from "./sessions";
import { istDay } from "./time";
import type { BillingErrorCode } from "./errors";
import type { FeeQuote } from "./charge-rules";
import type { BillingConfig } from "./config";
import type { DayBook, Gstr1Row } from "./daily-close";
import type { CreditNoteRow, IssueCreditNoteInput, IssueCreditNoteResult } from "./credit-notes";
import type { InvoiceLineRow, InvoiceRow, IssueInvoiceResult, PricedDraft } from "./invoices";
import type { AllocateReceiptResult, DueRow, MarkEnteredInErrorResult, PatientBalance, RecordReceiptResult, ReverseAllocationResult } from "./receipts";
import type { IssueRefundVoucherResult, PayRefundVoucherResult, RequestRefundResult, RefundVoucherRow } from "./refunds";
import type { MismatchRow, UploadSettlementResult } from "./recon";
import type { CashierSessionRow } from "./sessions";
import type { Settlement } from "./settlement";
import type { PatientSummary } from "../patients";
import type { OpdConfig } from "../opd";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/**
 * THE wire contract of the billing module — the 31 routes of Plan 08 Task 11, one controller for
 * the counter AND the back office (the OPD module's three-controller split buys nothing here:
 * there is one permission surface and one ledger).
 *
 * ERROR BODY — the OPD convention `{ statusCode, message, code, detail? }`, owner-ratified for
 * this NEW module. The patients and tariff modules keep their message-only bodies with the
 * `code: message` prefix; neither convention is realigned to the other (gate reports 01–07 §4/§5,
 * and an owner halt condition on this plan). Four screens branch on `code` and several refusals
 * have to carry numbers (asked-vs-cap, episode-vs-threshold), which a string prefix cannot do.
 *
 * A TariffError raised out of a billing entry point is mapped HERE to the same shape and its own
 * code: `creditShare` and `cash-math.ts` guard their inputs with the TARIFF module's `assertPaise`
 * (pipeline-A carried item 8, inherited and accepted), so a fractional amount can surface as
 * `TariffError("invalid_paise")` from inside a billing call. The wire contract must not depend on
 * which module's error class raised the refusal, so the body carries `code: "invalid_paise"`
 * either way.
 */

const NOT_FOUND_CODES = new Set<BillingErrorCode>([
  "unknown_invoice", "unknown_receipt", "unknown_line", "unknown_encounter", "unknown_series",
]);
const FORBIDDEN_CODES = new Set<BillingErrorCode>(["credit_permission_required"]);
/** Client-input refusals. Everything else is a state/ledger conflict and answers 409. */
const VALIDATION_CODES = new Set<BillingErrorCode>([
  "invalid_paise", "pan_required", "tender_ref_required", "bank_transfer_required",
  "recon_parse_failed", "duplicate_ref",
]);

function billingStatus(code: BillingErrorCode): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (FORBIDDEN_CODES.has(code)) return 403;
  if (VALIDATION_CODES.has(code)) return 400;
  return 409;
}

function tariffStatus(code: string): number {
  if (code.startsWith("unknown_")) return 404;
  if (code === "invalid_paise" || code === "invalid_qty" || code === "invalid_rule_params") return 400;
  return 409;
}

function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

/** Unrecognized errors rethrow — a 500 is a genuine bug, loudly (the patients/OPD toHttp convention). */
function toHttp(e: unknown): never {
  if (e instanceof BillingError) throw httpError(billingStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof TariffError) throw httpError(tariffStatus(e.code), e.message, e.code);
  if (e instanceof OpdError) throw httpError(e.code.startsWith("unknown_") ? 404 : 409, e.message, e.code, e.detail);
  if (e instanceof PatientError) throw httpError(e.code === "patient_not_found" ? 404 : 400, e.message, e.code);
  if (e instanceof ApprovalError) throw httpError(409, e.message, e.code);
  if (e instanceof WorkflowError) throw httpError(e.code === "role_denied" ? 403 : 409, e.message, e.code);
  if (e instanceof SodViolationError) throw httpError(403, e.message, "sod_violation");
  // Several services re-parse their own input with zod and throw the raw ZodError (config.ts's
  // `updateBillingConfig` is the one pipeline A carried forward as an open seam). The closed
  // `BillingErrorCode` union has no config-shape code and `errors.ts` is outside this task's
  // Files list, so the mapping lands HERE rather than as an unratified union extension: a bad
  // body is a 400 in the ratified shape, never a 500.
  if (e instanceof z.ZodError) throw httpError(400, "request body failed validation", "invalid_request", e.issues);
  throw e;
}

/**
 * Body/query validation, in the module's OWN error shape. The OPD and tariff controllers throw
 * Nest's `BadRequestException(issues)`, whose body is Nest's default `{ statusCode, message[],
 * error }` — a shape the four billing screens would have to special-case beside the ratified one.
 */
function parsed<T>(schema: z.ZodType<T>, body: unknown, code = "invalid_request"): T {
  const r = schema.safeParse(body);
  if (!r.success) throw httpError(400, "request body failed validation", code, r.error.issues);
  return r.data;
}

// ——— bodies and queries ———————————————————————————————————————————————————————————————————————
//
// Every MONEY field is `z.number()` and never `z.number().int()`: the integer belt on an
// externally supplied amount is `assertPaise` at the service boundary (Global Constraints, the M3
// belt), and a schema that quietly refused a fractional ask first would take that belt out of the
// code path it exists to guard. The T7/T8 convention, kept at the wire.

const manualDiscountSchema = z.object({
  discountCategory: z.enum(DISCOUNT_CATEGORIES),
  kind: z.enum(["percent_bps", "flat_paise"]),
  value: z.number(),
  reason: z.string().min(1),
});
const invoiceLineSchema = z.object({
  lineId: z.string().min(1),
  serviceId: z.string().min(1),
  qty: z.number(),
  supplyContext: z.enum(["standalone", "composite_healthcare"]).optional(),
  manualDiscount: manualDiscountSchema.nullable().optional(),
});
const tenderSchema = z.object({
  mode: z.enum(["cash", "upi", "card"]),
  amountPaise: z.number(),
  refText: z.string().min(1).optional(),
});
const receiptBlockSchema = z.object({
  tenders: z.array(tenderSchema).min(1),
  panNumber: z.string().min(1).optional(),
  form60: z.boolean().optional(),
  note: z.string().max(1000).optional(),
});
const issueInvoiceBody = z.object({
  draftId: z.string().min(1),
  patientId: z.string().min(1),
  encounterId: z.string().min(1).optional(),
  buyerGstin: z.string().min(1).optional(),
  buyerLegalName: z.string().min(1).optional(),
  lines: z.array(invoiceLineSchema).min(1),
  tags: z.array(z.string()).optional(),
  receipt: receiptBlockSchema.optional(),
  credit: z.object({ reason: z.string().min(1), approvalId: z.string().min(1).optional() }).optional(),
  discountApprovals: z.record(z.string(), z.string()).optional(),
});
const previewInvoiceBody = z.object({
  encounterId: z.string().min(1).optional(),
  lines: z.array(invoiceLineSchema).min(1),
  tags: z.array(z.string()).optional(),
});
const invoicesQuery = z.object({
  patientId: z.string().min(1).optional(),
  encounterId: z.string().min(1).optional(),
});

const creditNoteLineSchema = z.object({ invoiceLineId: z.string().min(1), qty: z.number() });
/** The invoice id rides the PATH, so the body carries the discriminated remainder of D4's shape. */
const creditNoteBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refund"), reason: z.string().min(1), lines: z.array(creditNoteLineSchema).min(1) }),
  z.object({
    kind: z.literal("clearance_discount"), reason: z.string().min(1),
    discountCategory: z.enum(DISCOUNT_CATEGORIES), askPaise: z.number(), approvalId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("correction"), reason: z.string().min(1),
    lines: z.array(creditNoteLineSchema).min(1).optional(),
  }),
]);

const recordReceiptBody = z.object({
  patientId: z.string().min(1),
  tenders: z.array(tenderSchema).min(1),
  panNumber: z.string().min(1).optional(),
  form60: z.boolean().optional(),
  note: z.string().max(1000).optional(),
});
const receiptsQuery = z.object({ patientId: z.string().min(1).optional() });
const allocationBody = z.object({ invoiceId: z.string().min(1), amountPaise: z.number() });
const reverseAllocationBody = z.object({ reason: z.string().max(500).optional() });
const eieBody = z.object({ receiptId: z.string().min(1), reason: z.string().min(1) });

const reasonClassSchema = z.enum(["mistake", "genuine"]);
const refundMethodSchema = z.enum(["cash", "bank_transfer"]);
const requestRefundBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invoice_refund"), creditNoteId: z.string().min(1), amountPaise: z.number(),
    reasonClass: reasonClassSchema, reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("advance_refund"), patientId: z.string().min(1), amountPaise: z.number(),
    reasonClass: reasonClassSchema, reason: z.string().min(1),
  }),
]);
const issueRefundBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invoice_refund"), creditNoteId: z.string().min(1), amountPaise: z.number(),
    reasonClass: reasonClassSchema, reason: z.string().min(1),
    approvalId: z.string().min(1), method: refundMethodSchema,
  }),
  z.object({
    kind: z.literal("advance_refund"), patientId: z.string().min(1), amountPaise: z.number(),
    reasonClass: reasonClassSchema, reason: z.string().min(1),
    approvalId: z.string().min(1), method: refundMethodSchema,
  }),
]);
const payRefundBody = z.object({
  payeeName: z.string().min(1), payeeIdType: z.string().min(1), payeeIdRef: z.string().min(1),
});
const refundsQuery = z.object({
  patientId: z.string().min(1).optional(),
  status: z.enum(["issued", "paid"]).optional(),
});

const openSessionBody = z.object({ floatPaise: z.number() });
const beginCloseBody = z.object({
  denominations: z.record(z.string(), z.number()),
  note: z.string().max(1000).optional(),
});
const sessionsQuery = z.object({
  cashierUserId: z.string().min(1).optional(),
  status: z.enum(["open", "closing", "closed"]).optional(),
});

const reconUploadBody = z.object({ csv: z.string(), source: z.enum(["upi", "card"]) });
const dayQuery = z.object({ day: z.string().max(10).optional() });
const gstr1Query = z.object({ from: z.string().max(10), to: z.string().max(10) });

// The admin patch. Mirrors config.ts's own `configPatchSchema` at the wire so a bad body is
// refused HERE, in the ratified shape, before `updateBillingConfig` re-parses it (carried item 1).
const configPatchBody = z
  .object({
    cashWarnPaise: z.number().int().positive(),
    cashBlockPaise: z.number().int().positive(),
    panThresholdPaise: z.number().int().positive(),
    refundBankAbovePaise: z.number().int().positive(),
    creditCapPaise: z.number().int().nonnegative(),
    outstandingCapPaise: z.number().int().nonnegative(),
    outstandingCapMode: z.enum(["off", "warn", "block"]),
    feeBps: z.object({ upi: z.number().int().nonnegative(), card: z.number().int().nonnegative() }),
    reconTolerancePaise: z.number().int().nonnegative(),
    seriesPrefixes: z.record(z.string(), z.string().min(1)),
    chargeRules: z.object({ opdConsult: z.object({ new: z.string().min(1), renewal: z.string().min(1) }) }),
    degradedTender: z.boolean(),
    caSigned: z.boolean(),
  })
  .partial();
const degradedBody = z.object({ on: z.boolean(), reason: z.string().min(1) });

type ReceiptRowSelect = typeof receipts.$inferSelect;
type InvoiceDetail = { invoice: InvoiceRow; lines: InvoiceLineRow[]; settlement: Settlement };
type InvoicePrint = {
  letterhead: OpdConfig["letterhead"];
  invoice: InvoiceRow;
  lines: InvoiceLineRow[];
  patient: PatientSummary | null;
  settlement: Settlement;
  qrPayload: string;
};

@Controller("billing")
export class BillingController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ——— invoices ———————————————————————————————————————————————————————————————————————————————

  @RequirePermission("billing.invoice.issue", "hospital")
  @Post("invoices")
  async issue(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IssueInvoiceResult> {
    const b = parsed(issueInvoiceBody, body);
    try {
      return await issueInvoice(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.invoice.issue", "hospital")
  @Post("invoices/preview")
  async preview(@Body() body: unknown): Promise<PricedDraft> {
    const b = parsed(previewInvoiceBody, body);
    try {
      return await previewInvoice(this.db, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.invoice.read", "hospital")
  @Get("invoices")
  async invoices(@Query() query: unknown): Promise<{ items: InvoiceRow[] }> {
    const q = parsed(invoicesQuery, query);
    return { items: await listInvoices(this.db, q) };
  }

  @RequirePermission("billing.invoice.read", "hospital")
  @Get("invoices/:id")
  async invoice(@Param("id") id: string): Promise<InvoiceDetail> {
    const found = await getInvoice(this.db, id);
    if (!found) toHttp(new BillingError("unknown_invoice", `unknown invoice ${id}`));
    return { ...found, settlement: await invoiceSettlement(this.db, id) };
  }

  /**
   * The printed invoice (Step 3): the ONE shipped letterhead (spec: one hospital), the
   * confidential-safe patient summary, the stored lines and heads, derived settlement, and the
   * signed QR every printed money document carries — `bil1.invoice.<id>.<sig>`, HMAC under the
   * existing SECRET_KEY (the Plan 05 card / Plan 07 e-Rx pattern; no new env var).
   */
  @RequirePermission("billing.invoice.read", "hospital")
  @Get("invoices/:id/print")
  async print(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<InvoicePrint> {
    const found = await getInvoice(this.db, id);
    if (!found) toHttp(new BillingError("unknown_invoice", `unknown invoice ${id}`));
    try {
      const opd = await loadOpdConfig(this.db);
      const [patient] = await getPatientSummaries(this.db, actor, [found.invoice.patientId]);
      const qrBody = `bil1.invoice.${id}`;
      return {
        letterhead: opd.letterhead,
        invoice: found.invoice,
        lines: found.lines,
        patient: patient ?? null,
        settlement: await invoiceSettlement(this.db, id),
        qrPayload: `${qrBody}.${hmacSign(this.cfg.secretKey, qrBody)}`,
      };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.credit_note.issue", "hospital")
  @Post("invoices/:id/credit-notes")
  async creditNote(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<IssueCreditNoteResult> {
    const b = parsed(creditNoteBody, body);
    // Rebuilt branch by branch rather than spread: `{ ...b, invoiceId }` over a discriminated
    // union widens to one object carrying every branch's optional fields, which is NOT the union
    // `issueCreditNote` accepts.
    const input: IssueCreditNoteInput =
      b.kind === "refund"
        ? { kind: "refund", invoiceId: id, reason: b.reason, lines: b.lines }
        : b.kind === "clearance_discount"
          ? {
            kind: "clearance_discount", invoiceId: id, reason: b.reason,
            discountCategory: b.discountCategory, askPaise: b.askPaise, approvalId: b.approvalId,
          }
          : { kind: "correction", invoiceId: id, reason: b.reason, lines: b.lines };
    try {
      return await issueCreditNote(this.db, actor, input);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.invoice.read", "hospital")
  @Get("invoices/:id/credit-notes")
  async creditNotes(@Param("id") id: string): Promise<{ items: CreditNoteRow[] }> {
    return { items: await listCreditNotes(this.db, { invoiceId: id }) };
  }

  @RequirePermission("billing.invoice.read", "hospital")
  @Get("visits/:encounterId/fee-quote")
  async feeQuoteRoute(@Param("encounterId") encounterId: string): Promise<FeeQuote> {
    try {
      return await feeQuote(this.db, encounterId);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— receipts, allocations, the ledger ——————————————————————————————————————————————————————

  @RequirePermission("billing.receipt.record", "hospital")
  @Post("receipts")
  async receipt(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RecordReceiptResult> {
    const b = parsed(recordReceiptBody, body);
    try {
      return await recordReceipt(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * `receipts.ts` ships no `listReceipts` and is outside this task's Files list, so the read lives
   * here — against this module's OWN table, which module isolation (spec §4) allows; what it
   * forbids is reading ANOTHER module's tables, and every patient name on this surface still comes
   * from `getPatientSummaries`. Arrival order is `seq`, never the id (§3.26).
   */
  @RequirePermission("billing.invoice.read", "hospital")
  @Get("receipts")
  async receiptList(@Query() query: unknown): Promise<{ items: ReceiptRowSelect[] }> {
    const q = parsed(receiptsQuery, query);
    const where = q.patientId === undefined ? undefined : eq(receipts.patientId, q.patientId);
    return { items: await this.db.select().from(receipts).where(where).orderBy(desc(receipts.seq)) };
  }

  @RequirePermission("billing.receipt.record", "hospital")
  @Post("receipts/:id/allocations")
  async allocate(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<AllocateReceiptResult> {
    const b = parsed(allocationBody, body);
    try {
      return await allocateReceipt(this.db, actor, { receiptId: id, invoiceId: b.invoiceId, amountPaise: b.amountPaise });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.allocation.reverse", "hospital")
  @Post("allocations/:id/reverse")
  async reverse(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<ReverseAllocationResult> {
    const b = parsed(reverseAllocationBody, body);
    try {
      return await reverseAllocation(this.db, actor, { allocationId: id, reason: b.reason });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.eie.mark", "hospital")
  @Post("eie")
  async eie(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<MarkEnteredInErrorResult> {
    const b = parsed(eieBody, body);
    try {
      return await markEnteredInError(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.invoice.read", "hospital")
  @Get("patients/:patientId/balance")
  async balance(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<PatientBalance> {
    try {
      return await patientBalance(this.db, actor, patientId);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.invoice.read", "hospital")
  @Get("patients/:patientId/dues")
  async dues(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<{ items: DueRow[] }> {
    try {
      return { items: await listDues(this.db, actor, { patientId }) };
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— refunds ————————————————————————————————————————————————————————————————————————————————

  @RequirePermission("billing.refund.request", "hospital")
  @Post("refunds/request")
  async refundRequest(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RequestRefundResult> {
    const b = parsed(requestRefundBody, body);
    try {
      return await requestRefund(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.refund.request", "hospital")
  @Post("refunds")
  async refundIssue(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<IssueRefundVoucherResult> {
    const b = parsed(issueRefundBody, body);
    try {
      return await issueRefundVoucher(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.refund.pay", "hospital")
  @Post("refunds/:id/pay")
  async refundPay(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<PayRefundVoucherResult> {
    const b = parsed(payRefundBody, body);
    try {
      return await payRefundVoucher(this.db, actor, { voucherId: id, ...b });
    } catch (e) {
      toHttp(e);
    }
  }

  /** `refunds.ts` ships no voucher worklist reader and is outside this task's Files list — see
   * `receiptList` above for why the read lives here. Newest first: `refund_vouchers` carries no
   * `seq`, so the order key is `issued_at` with the document number as the tie-break (the
   * `listCreditNotes` precedent). */
  @RequirePermission("billing.reports.read", "hospital")
  @Get("refunds")
  async refundList(@Query() query: unknown): Promise<{ items: RefundVoucherRow[] }> {
    const q = parsed(refundsQuery, query);
    const conditions = [];
    if (q.patientId !== undefined) conditions.push(eq(refundVouchers.patientId, q.patientId));
    if (q.status !== undefined) conditions.push(eq(refundVouchers.status, q.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return {
      items: await this.db
        .select().from(refundVouchers).where(where)
        .orderBy(desc(refundVouchers.issuedAt), desc(refundVouchers.voucherNo)),
    };
  }

  // ——— cashier sessions ———————————————————————————————————————————————————————————————————————

  @RequirePermission("billing.session.own", "hospital")
  @Post("sessions")
  async sessionOpen(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<CashierSessionRow> {
    const b = parsed(openSessionBody, body);
    try {
      return await openSession(this.db, actor, b.floatPaise);
    } catch (e) {
      toHttp(e);
    }
  }

  /** The acting cashier's own live drawer, or null — the session screen's first read. */
  @RequirePermission("billing.session.own", "hospital")
  @Get("sessions/current")
  async sessionCurrent(@CurrentActor() actor: Actor): Promise<{ session: CashierSessionRow | null }> {
    const own = await listSessions(this.db, { cashierUserId: actor.id });
    return { session: own.find((s) => s.status === "open" || s.status === "closing") ?? null };
  }

  @RequirePermission("billing.session.own", "hospital")
  @Post("sessions/:id/close")
  async sessionClose(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<CashierSessionRow> {
    const b = parsed(beginCloseBody, body);
    await this.requireOwnSession(actor, id);
    try {
      return await beginClose(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.session.own", "hospital")
  @Post("sessions/:id/confirm-close")
  async sessionConfirmClose(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<CashierSessionRow> {
    await this.requireOwnSession(actor, id);
    try {
      return await confirmClose(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.session.read", "hospital")
  @Get("sessions")
  async sessions(@Query() query: unknown): Promise<{ items: CashierSessionRow[] }> {
    const q = parsed(sessionsQuery, query);
    return { items: await listSessions(this.db, q) };
  }

  // ——— reconciliation, degraded mode ——————————————————————————————————————————————————————————

  @RequirePermission("billing.recon.upload", "hospital")
  @Post("recon/upload")
  async reconUpload(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<UploadSettlementResult> {
    const b = parsed(reconUploadBody, body);
    try {
      return await uploadSettlement(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.reports.read", "hospital")
  @Get("recon/mismatches")
  async reconMismatches(@CurrentActor() actor: Actor): Promise<{ items: MismatchRow[] }> {
    try {
      return { items: await listMismatches(this.db, actor) };
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— reports ————————————————————————————————————————————————————————————————————————————————

  @RequirePermission("billing.reports.read", "hospital")
  @Get("day-book")
  async dayBookRoute(@Query() query: unknown): Promise<DayBook> {
    const q = parsed(dayQuery, query);
    try {
      return await dayBook(this.db, q.day ?? istDay(new Date()));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.reports.read", "hospital")
  @Get("gstr1")
  async gstr1(@Query() query: unknown): Promise<{ rows: Gstr1Row[] }> {
    const q = parsed(gstr1Query, query);
    try {
      return { rows: await gstr1Summary(this.db, q.from, q.to) };
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— configuration (D-17) ———————————————————————————————————————————————————————————————————

  @RequirePermission("billing.reports.read", "hospital")
  @Get("config")
  async config(): Promise<BillingConfig> {
    try {
      return await loadBillingConfig(this.db);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.config.write", "hospital")
  @Put("config")
  async configPut(@Body() body: unknown): Promise<BillingConfig> {
    const b = parsed(configPatchBody, body, "invalid_config");
    try {
      return await withTx(this.db, (tx) => updateBillingConfig(tx, b));
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("billing.config.write", "hospital")
  @Put("degraded")
  async degraded(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ degradedTender: boolean }> {
    const b = parsed(degradedBody, body);
    try {
      return await setDegraded(this.db, actor, b.on, b.reason);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * The session routes' actor guard (pipeline-A carried item 3). `confirmClose` performs NO actor
   * check of its own — any caller holding the permission could finalize another cashier's session
   * and the `cashier_session.closed` event would record that arbitrary caller — and `beginClose`
   * derives the session from the ACTOR, so its `:id` would otherwise be decorative. Both are bound
   * to the caller's own drawer here.
   *
   * 403 with its own `code`, not a bare status: the permission-less refusal on these same routes
   * is ALSO a 403, so a status-only assertion could not tell "you may not close sessions" from
   * "that is not your session" (§3.14b).
   */
  private async requireOwnSession(actor: Actor, sessionId: string): Promise<void> {
    const own = await listSessions(this.db, { cashierUserId: actor.id });
    if (!own.some((s) => s.id === sessionId)) {
      throw httpError(403, `session ${sessionId} does not belong to this cashier`, "not_your_session", { sessionId });
    }
  }
}
