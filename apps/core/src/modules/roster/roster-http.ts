import { HttpException } from "@nestjs/common";
import { RosterError, rosterHttpStatus } from "./errors";

/**
 * 20-U U5a — the roster's one error mapper, written before its first route (the `radiology-http.ts`
 * rule: a typed refusal no route knows becomes a 500 at the counter). One family today, because the
 * board composes roster reads only; a route that reaches another module's errors adds its family here.
 */
export function toHttp(e: unknown): never {
  if (e instanceof RosterError) {
    const body: { statusCode: number; message: string; code: string; detail?: unknown } = {
      statusCode: rosterHttpStatus(e.code), message: e.message, code: e.code,
    };
    if (e.detail !== undefined) body.detail = e.detail;
    throw new HttpException(body, body.statusCode);
  }
  throw e;
}
