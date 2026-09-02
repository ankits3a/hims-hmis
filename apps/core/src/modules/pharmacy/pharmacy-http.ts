import { BadRequestException, HttpException } from "@nestjs/common";
import { z } from "zod";
import { ApprovalError } from "../../kernel/approvals/types";
import { OrderError, orderHttpStatus } from "../../kernel/orders/errors";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources/errors";
import { WorkflowError } from "../../kernel/workflow/instances";
import { BillingError, billingHttpStatus } from "../billing";
import { MaterialsError, materialsHttpStatus } from "../materials";
import { OpdError } from "../opd";
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
} as const;
