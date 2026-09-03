/**
 * PLAN 18c T1 — the AERB module's error vocabulary. Its own, because the module is its own (D1):
 * a refusal that could only be spelled by importing `RadiologyError` would make the Rules' module
 * depend on a department.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 18c ═══
 *
 * `errors.ts` is named in T1's Files list and in no other task's; T2–T4 add callers. A later task
 * needing a code this union does not carry has found a PLAN DEFECT and reports it — the
 * `ot/errors.ts` and `pcpndt/errors.ts` rule, unchanged.
 *
 * ═══ NOT ONE OF THESE IS A 500, AND `device_not_licensed` IS THE ONE THAT MATTERS ═══
 *
 * A hospital whose CT licence lapsed last Friday is not a system fault. It is a lawful refusal with
 * a named reason and a person who can fix it, and it must reach the radiographer at the console AS
 * ONE — with the licence number and the date in the detail — rather than as "Internal Server
 * Error". `pcpndtHttpStatus` exists for the same reason and this is its twin.
 *
 *   · **403 `device_not_licensed`, `no_active_licence`, `not_appointed`** — authority refusals
 *     about what may emit and who may certify, which under the Rules is exactly what they are.
 *   · **409 `licence_already_active`** — a second active licence on one machine is the unique
 *     index talking; a lost race, not a malformed request.
 *   · **422 `invalid_validity`, `already_surrendered`** — hard stops with an instruction behind
 *     them.
 *   · **404 `unknown_licence`, `unknown_person`.**
 */
export const AERB_ERROR_CODES = [
  // ── licences (T1) ──
  "device_not_licensed",
  "no_active_licence",
  "licence_already_active",
  "already_surrendered",
  "invalid_validity",
  "unknown_licence",
  // ── people (T1) ──
  "not_appointed",
  "unknown_person",
] as const;

export type AerbErrorCode = (typeof AERB_ERROR_CODES)[number];

export class AerbError extends Error {
  constructor(
    readonly code: AerbErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `AERB refused: ${code}`);
    this.name = "AerbError";
  }
}

const STATUS: Record<AerbErrorCode, number> = {
  device_not_licensed: 403,
  no_active_licence: 403,
  not_appointed: 403,

  licence_already_active: 409,
  already_surrendered: 409,

  invalid_validity: 422,

  unknown_licence: 404,
  unknown_person: 404,
};

export function aerbHttpStatus(code: AerbErrorCode): number {
  return STATUS[code];
}
