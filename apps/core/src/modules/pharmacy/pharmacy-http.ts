import { BadRequestException, HttpException } from "@nestjs/common";
import { z } from "zod";
import { ApprovalError } from "../../kernel/approvals/types";
import { DocumentStoreError } from "../../kernel/documents/store";
import { OrderError, orderHttpStatus } from "../../kernel/orders/errors";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources/errors";
import { WorkflowError } from "../../kernel/workflow/instances";
import { BillingError, billingHttpStatus } from "../billing";
import { MaterialsError, materialsHttpStatus } from "../materials";
import { OpdError } from "../opd";
import { PatientError } from "../patients";
import { TariffError, tariffHttpStatus } from "../tariff";
import { PharmacyError, pharmacyHttpStatus } from "./errors";

/** The `lab-http.ts` shape: every module the counter calls into keeps its own code on the wire. */
export function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

export function toHttp(e: unknown): never {
  if (e instanceof PharmacyError) throw httpError(pharmacyHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof MaterialsError) throw httpError(materialsHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof OrderError) throw httpError(orderHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof BillingError) throw httpError(billingHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof TariffError) throw httpError(tariffHttpStatus(e.code), e.message, e.code);
  if (e instanceof OpdError) throw httpError(409, e.message, e.code);
  // P19 — a walk-in sale files the prescription photo; a store that cannot take it is the server's
  // fault, said as a sentence rather than a 500.
  if (e instanceof DocumentStoreError) {
    throw httpError(pharmacyHttpStatus("document_store_unavailable"), `the prescription photo could not be stored (${e.reason}) — nothing was sold; tell IT`, "document_store_unavailable");
  }
  // P19 — a walk-in sale registers its customer and files the prescription photo.
  if (e instanceof PatientError) {
    const status = e.code === "document_too_large" ? 413 : e.code === "patient_not_found" ? 404 : 400;
    throw httpError(status, e.message, e.code);
  }
  if (e instanceof ApprovalError) throw httpError(409, e.message, e.code);
  if (e instanceof ResourceError) throw httpError(resourceHttpStatus(e.code), e.message, e.code);
  if (e instanceof WorkflowError) throw httpError(e.code === "role_denied" ? 403 : 409, e.message, e.code);
  throw e;
}

export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

export const idSchema = z.string().min(1).max(64);

export const PHARMACY_IDEMPOTENT_ROUTES = {
  claim: "POST /pharmacy/dispenses",
  verify: "POST /pharmacy/dispenses/:id/verify",
  pick: "POST /pharmacy/dispenses/:id/pick",
  bill: "POST /pharmacy/dispenses/:id/bill",
  handover: "POST /pharmacy/dispenses/:id/handover",
  /** P5 — a credit note and a refund request: a retried click must not raise two. */
  refund: "POST /pharmacy/dispenses/:id/refund",
  /** P6 — a return credits and refunds: a retried click must not return a pack twice. */
  returns: "POST /pharmacy/dispenses/:id/returns",
  /** P19 — a walk-in sale moves stock and money: a retried click must not sell twice. */
  retailSale: "POST /pharmacy/retail/sales",
  /** P20 — a paper dispense entered after an outage: once per sheet, and once per click. */
  paperDispense: "POST /pharmacy/downtime/dispenses",
  /** P19b — a walk-in return credits and refunds: a retried click must not return a pack twice. */
  retailReturn: "POST /pharmacy/retail/sales/:id/returns",
  /** STAGE D1 — an ADR report writes allergies: a retried click must not report (and write) twice. */
  adr: "POST /pharmacy/adr",
  /** STAGE D2 — a retried click must not log one near miss twice (the indicator counts rows). */
  incident: "POST /pharmacy/incidents",
  /** STAGE D3 — a retried click must not log one fridge reading twice (and cannot open a second excursion). */
  coldReading: "POST /pharmacy/cold-chain/readings",
  /** STAGE D4 — a retried click must not record one tray check twice (an after-use check posts consumption). */
  trayCheck: "POST /pharmacy/trays/checks",
  /** 2026-09-30 — a paper prescription entered at the desk: a retried click must not issue it twice. */
  paperRx: "POST /pharmacy/paper-rx",
} as const;

/**
 * OWNER RULING 2026-09-30 — a sale discount as the wire carries it: a % off MRP in basis points (800 = 8%,
 * at most 100%) or rupees off the bill in paise, and the reason. `approvalId` rides only on the bill.
 */
export const discountAskSchema = z.object({
  kind: z.enum(["percent_bps", "flat_paise"]),
  value: z.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(1).max(300),
}).refine((d) => d.kind !== "percent_bps" || d.value <= 10000, { message: "a discount cannot exceed 100%", path: ["value"] });
export const discountOnBillSchema = z.object({
  kind: z.enum(["percent_bps", "flat_paise"]),
  value: z.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(1).max(300),
  approvalId: z.string().min(1).max(64).optional(),
}).refine((d) => d.kind !== "percent_bps" || d.value <= 10000, { message: "a discount cannot exceed 100%", path: ["value"] });

/** The preview's query: `?tender=cash|upi|card|split&discountKind=percent_bps&discountValue=800&discountReason=…`. */
export const billPreviewQuery = z.object({
  tender: z.enum(["cash", "upi", "card", "split"]).optional(),
  discountKind: z.enum(["percent_bps", "flat_paise"]).optional(),
  discountValue: z.string().regex(/^\d{1,10}$/).optional(),
  discountReason: z.string().max(300).optional(),
});

export function discountFromQuery(q: z.infer<typeof billPreviewQuery>): { kind: "percent_bps" | "flat_paise"; value: number; reason: string } | undefined {
  if (q.discountKind === undefined || q.discountValue === undefined) return undefined;
  const value = Number(q.discountValue);
  if (value <= 0) return undefined;
  if (q.discountKind === "percent_bps" && value > 10000) throw new BadRequestException("a discount cannot exceed 100%");
  return { kind: q.discountKind, value, reason: q.discountReason ?? "" };
}
