import { BadRequestException, HttpException } from "@nestjs/common";
import { z } from "zod";
import { ResourceError, resourceHttpStatus } from "../../kernel/resources/errors";
import { AerbError, aerbHttpStatus } from "./errors";

/**
 * PLAN 18c T1 — **ONE ERROR MAPPER FOR EVERY AERB ROUTE**, the `radiology-http.ts` rule applied to
 * a second module: this repository has shipped the 500-escape three times (Plans 09, 13, 15) — a
 * service throws a typed error, no route knows the type, and a lawful refusal reaches a human as
 * "Internal Server Error".
 *
 * **Two families, and only two.** `AerbError` (this module's) and `ResourceError` (the device
 * registry's — T2 drives a device status through `changeResourceStatus`, which refuses an
 * occupied machine). A third family appearing here means a module reached somewhere D1 says it
 * should not.
 */
export function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

export function toHttp(e: unknown): never {
  if (e instanceof AerbError) throw httpError(aerbHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof ResourceError) throw httpError(resourceHttpStatus(e.code), e.message, e.code);
  throw e;
}

/** A zod refusal is a 400 with the ISSUES — a clerk told "invalid body" cannot fix it. */
export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

export const idSchema = z.string().min(1).max(64);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
