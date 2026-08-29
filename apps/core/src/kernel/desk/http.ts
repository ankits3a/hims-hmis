import { BadRequestException, HttpException } from "@nestjs/common";
import { DeskError } from "./types";
import type { z } from "zod";

/**
 * PLAN 07c T9 — THE DESK'S OWN `parsed` / `toHttp` PAIR, following the OPD controller's precedent
 * rather than inventing a third convention.
 *
 * ═══ AND IT CLOSES A LATENT DEFECT IN THE ROUTES T1–T3 ALREADY SHIPPED ═══
 *
 * `desk.controller.ts` called `deskQuery.parse(query)` directly. A raw `ZodError` is not an
 * `HttpException`, so `GET /me/desk?date=nonsense` answered **500 Internal Server Error** — an
 * operator sees an outage where a caller sent a bad parameter, and it is the sort of thing that
 * gets escalated at 21:00 as "the desk is down". Nothing caught it because no test had asked for a
 * malformed date. `parsed` returns 400 with the issues, exactly as `opd-masters.controller.ts` does.
 */
export function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}

/**
 * `DeskError`'s codes split three ways, and the split is the point rather than a lookup table:
 *
 * - **BOOT-TIME REFUSALS** (`duplicate_provider`, `undeclared_permission`) and a provider returning
 *   a fact that is not a countable integer (`bad_fact`) are PROGRAMMING errors. They stay 500,
 *   because that is what they are: nothing the caller sent could have avoided them, and dressing
 *   one up as a 400 would tell an operator to go and look at the request.
 * - **`unknown_user` is 404**, matching `PatientError`'s `patient_not_found` in the same position.
 * - Everything else is a 400: the caller asked for something the system will not do.
 */
export function deskHttpStatus(code: string): number {
  if (code === "unknown_user") return 404;
  if (code === "duplicate_provider" || code === "undeclared_permission" || code === "bad_fact") return 500;
  return 400;
}

export function toHttp(e: unknown): never {
  if (e instanceof DeskError) {
    throw new HttpException({ code: e.code, message: e.message }, deskHttpStatus(e.code));
  }
  throw e;
}
