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
  /**
   * ═══ CLOSE REVIEW — THE UNION WAS CLOSED TOO EARLY, AND `errors.ts` SAYS WHAT THAT MEANS ═══
   *
   * This file's own header states that "a later task needing a code this union does not carry has
   * found a PLAN DEFECT and reports it". Three did, and all three were reaching the caller as a
   * raw Postgres constraint violation — a 500 with an index name in the body, which is the exact
   * defect the header two paragraphs up says NOT ONE OF THESE IS.
   *
   *   · **`badge_already_issued` (409)** — a worker already holds an active badge, or the number is
   *     already in use. Two badges on one person are two partial pictures of one exposure.
   *   · **`read_already_recorded` (409)** — a reading for this badge and period exists. The schema
   *     comment promises "a re-entered report is a CORRECTION, not a second dose"; until there is a
   *     correction route this refusal is what says so, rather than a 500.
   *
   * PASS 2 removed a third, `stale_qa_pass`. Pass 1 added it to REFUSE a passing test performed
   * before the failure it would clear — and refusing meant the historical QA book could not be
   * entered at all while a machine was blocked, which is the act the register exists for. That
   * record now lands and simply releases nothing, so there is no refusal to name.
   */
  "badge_already_issued",
  "read_already_recorded",
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

  badge_already_issued: 409,
  read_already_recorded: 409,
};

export function aerbHttpStatus(code: AerbErrorCode): number {
  return STATUS[code];
}
