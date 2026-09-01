import { BadRequestException, HttpException } from "@nestjs/common";
import { z } from "zod";
import { PcpndtError, pcpndtHttpStatus } from "./errors";

/**
 * PLAN 18a T6 — the register's error mapper, written once and used by every route.
 *
 * `errors.ts`'s header makes the claim this file enforces: **not one refusal in this module is a
 * 500.** A hospital that has not filed its registration, a doctor who is not on the register, a
 * machine outside Form B — each is a lawful refusal with a named reason and a person who can fix
 * it, and each must reach a sonologist as that rather than as "Internal Server Error". Plans 09, 13
 * and 15 shipped the escape three times between them.
 */
export function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpException {
  const body: { statusCode: number; message: string; code: string; detail?: unknown } = { statusCode, message, code };
  if (detail !== undefined) body.detail = detail;
  return new HttpException(body, statusCode);
}

export function toHttp(e: unknown): never {
  if (e instanceof PcpndtError) throw httpError(pcpndtHttpStatus(e.code), e.message, e.code, e.detail);
  throw e;
}

export function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}
