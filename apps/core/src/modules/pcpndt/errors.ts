/**
 * PLAN 18a T2 — the PCPNDT module's error vocabulary. Its own, because the module is its own
 * (DD1): 15b and 62 install this register without installing radiology, and a statutory refusal
 * that could only be spelled by importing `RadiologyError` would make the Act's module depend on a
 * department.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 18a ═══
 *
 * `errors.ts` is named in T2's Files list and in no other task's; T6 adds every caller. A later
 * task needing a code this union does not carry has found a PLAN DEFECT and reports it — the
 * `ot/errors.ts` rule, unchanged.
 *
 * ═══ EVERY REFUSAL HERE IS 403 OR 422, AND NOT ONE OF THEM IS A 500 ═══
 *
 * That is the design claim worth stating. A hospital that has not filed its registration, a doctor
 * who is not on the register, a machine that is not on Form B — none of these is a system fault and
 * none should reach a sonologist as one. They are lawful refusals with a named reason and a person
 * who can fix them, and `pcpndtHttpStatus` is what makes every controller say so identically
 * (§2.54; the `MembershipError`-escaped-to-500 defect Plans 09 and 13 shipped twice).
 *
 *   · **403 for `no_active_registration`, `machine_not_registered`, `person_not_registered`,
 *     `registration_expired`** — authority refusals about who and what may act, which under the Act
 *     is exactly what they are.
 *   · **403 for `same_actor`** — the in-charge may not verify a form they signed. An SoD refusal
 *     reads as one.
 *   · **422 for `form_f_missing`, `form_already_recorded`, `not_recorded`** — hard stops with an
 *     instruction behind them: record the form, then acquire.
 *   · **409 for `serial_conflict`** — a lost race on the counter, not a malformed request.
 */
export const PCPNDT_ERROR_CODES = [
  // ── registrations (T6) ──
  "no_active_registration",
  "registration_expired",
  "machine_not_registered",
  "person_not_registered",
  "unknown_registration",
  // ── the form (T6) ──
  "form_f_missing",
  "form_already_recorded",
  "form_not_open",
  "not_recorded",
  "serial_conflict",
  "same_actor",
  "unknown_form",
  "declaration_incomplete",
] as const;

export type PcpndtErrorCode = (typeof PCPNDT_ERROR_CODES)[number];

export class PcpndtError extends Error {
  constructor(
    readonly code: PcpndtErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `PCPNDT refused: ${code}`);
    this.name = "PcpndtError";
  }
}

const STATUS: Record<PcpndtErrorCode, number> = {
  no_active_registration: 403,
  registration_expired: 403,
  machine_not_registered: 403,
  person_not_registered: 403,
  unknown_registration: 404,

  form_f_missing: 422,
  form_already_recorded: 409,
  form_not_open: 409,
  not_recorded: 422,
  serial_conflict: 409,
  same_actor: 403,
  unknown_form: 404,
  declaration_incomplete: 422,
};

export function pcpndtHttpStatus(code: PcpndtErrorCode): number {
  return STATUS[code];
}
