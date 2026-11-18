import { BadRequestException, HttpException } from "@nestjs/common";
import { MaterialsError, materialsHttpStatus } from "../materials";
import { StoresError, storesHttpStatus } from "./errors";
import type { z } from "zod";

/**
 * STORES S1 (#1111) — one error mapper for every Stores route, the `aerb-http.ts` rule: a typed refusal
 * never reaches a person as a 500. Two families: Stores' own, and materials' (the ledger and the transfer
 * it posts through: `insufficient_stock`, `already_received`, `transfer_self_receipt`…).
 */
function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

export function toHttp(e: unknown): never {
  if (e instanceof StoresError) throw httpError(storesHttpStatus(e.code), e.message, e.code, e.detail);
  if (e instanceof MaterialsError) throw httpError(materialsHttpStatus(e.code), e.message, e.code, e.detail);
  throw e;
}

export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}
