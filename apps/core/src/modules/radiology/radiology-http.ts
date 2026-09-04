import { BadRequestException, HttpException } from "@nestjs/common";
import { z } from "zod";
import { OrderError, orderHttpStatus } from "../../kernel/orders/errors";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources/errors";
import { WorkflowError } from "../../kernel/workflow/instances";
import { BillingError, billingHttpStatus } from "../billing";
import { TariffError, tariffHttpStatus } from "../tariff";
import { PcpndtError, pcpndtHttpStatus } from "../pcpndt";
import { AerbError, aerbHttpStatus } from "../aerb";
import { RadiologyError, radiologyHttpStatus } from "./errors";

/**
 * PLAN 18a T3 — **ONE ERROR MAPPER FOR EVERY RADIOLOGY ROUTE.**
 *
 * This repository has shipped the 500-escape three times (Plans 09, 13 and 15): a service throws a
 * typed error, no route knows the type, and a refusal a counter could have acted on reaches the
 * clerk as "Internal Server Error". 17b's gate report names it as the thing its e2e existed to
 * prove. So the mapper is written ONCE, before the first route, and every route funnels through it.
 *
 * **EIGHT families** (close review: `AerbError` was the missing one), and every one of them is
 * reachable from `placeImagingOrder` alone:
 * `RadiologyError` (this module's), `PcpndtError` (the register's — a Form F refusal surfaces on
 * imaging routes), `OrderError` (the kernel envelope's — `unknown_kind`, `clinician_required`,
 * `patient_encounter_mismatch`), `BillingError` (the idempotency claim), `TariffError`,
 * `ResourceError` (the device registry) and `WorkflowError` (the study machine).
 *
 * `WorkflowError` maps `role_denied` to 403 and everything else to 409, which is `lab-http.ts`'s
 * own rule: a transition refused because the actor lacks the role is an authorisation answer, and a
 * transition refused because the study has moved on is a conflict.
 */
export function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

export function toHttp(e: unknown): never {
  if (e instanceof RadiologyError) throw httpError(radiologyHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof PcpndtError) throw httpError(pcpndtHttpStatus(e.code), e.message, e.code, e.detail);
  /**
   * ═══ CLOSE REVIEW — `device_not_licensed` WAS REACHING THE CONSOLE AS A 500 ═══
   *
   * `startAcquisition` calls `assertDeviceLicensed` and `recordAcquired` calls `recordDose`; both
   * throw `AerbError`, and this mapper did not know the family, so `toHttp` rethrew and Nest's
   * default filter answered `{"statusCode":500,"message":"Internal server error"}` — no code, no
   * licence number, no date. `aerb/errors.ts` has a section header that says NOT ONE OF THESE IS A
   * 500, and the radiographer at the console was getting exactly that. Eighth family.
   */
  if (e instanceof AerbError) throw httpError(aerbHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof OrderError) throw httpError(orderHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof BillingError) throw httpError(billingHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof TariffError) throw httpError(tariffHttpStatus(e.code), e.message, e.code);
  if (e instanceof ResourceError) throw httpError(resourceHttpStatus(e.code), e.message, e.code);
  if (e instanceof WorkflowError) {
    throw httpError(e.code === "role_denied" ? 403 : 409, e.message, e.code);
  }
  throw e;
}

/** A zod refusal is a 400 with the ISSUES — a counter told "invalid body" cannot fix it. */
export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

export const idSchema = z.string().min(1).max(64);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * The idempotency scope's `route` string. It is a CONSTANT rather than the request path, because
 * `(actorId, route, key)` is the unique key: two routes sharing a spelling would let a retry of one
 * replay the other's response.
 */
export const RADIOLOGY_IDEMPOTENT_ROUTES = {
  placeOrder: "POST /radiology/orders",
  addViews: "POST /radiology/orders/:orderId/items",
} as const;
