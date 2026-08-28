/**
 * PLAN 15 T2 — the mini-OT's error vocabulary.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 15, ON PURPOSE ═══
 *
 * `errors.ts` is named in T2's Files list and in NO other task's, while T3–T8 all modify
 * `index.ts` and the controllers. So every refusal this phase can make is spelled here, ahead of
 * its caller — the `materials/errors.ts` and `formulary/errors.ts` precedent, and the same rule
 * follows from it: **a later task that needs a code this union does not carry has found a PLAN
 * DEFECT and reports it.** It does not widen the union and it does not borrow a neighbouring code.
 *
 * `errors.test.ts` asserts BOTH directions by scanning this directory's source — declared and never
 * thrown, thrown and never declared — because Plan 14's close pass measured what a promise in a
 * comment is worth: five codes with zero throw sites, and one code borrowed by a second caller to
 * mean something else entirely. A promise in a comment is not a guard.
 *
 * ═══ `otHttpStatus` IS EXPORTED, AND PLAN 13's M-CLASS IS WHY ═══
 *
 * Plan 09 shipped a `MembershipError` that escaped `billing.controller.ts`'s `toHttp`, so a correct
 * refusal reached a busy counter as a 500. Plan 13 then shipped the same defect a second time,
 * INTRODUCED BY THE FIX for the first. The mapper therefore lives beside the codes and is exported,
 * so every controller that can surface one of these maps it from the SAME table (§2.54).
 *
 * ═══ THE STATUS CHOICES THAT ARE NOT OBVIOUS ═══
 *
 *   · **409, not 422, for every RACE** — `theatre_occupied`, `bay_occupied`, `stale_version`,
 *     `duplicate_booking`, `duplicate_scan`. The caller's request was well-formed and lost a race;
 *     a 422 tells a nurse to fix her input, which is exactly the wrong instruction.
 *   · **422 for every GATE refusal** — `gate_open`, `not_ready`, `count_mismatch`,
 *     `implant_deploying`, `escort_required`. These ARE the hard stops this phase exists to make
 *     unskippable, and the screen's job is to name the rule, which a 4xx body does.
 *   · **403 for `privilege_refused` and `same_actor`** — both are authority refusals about WHO is
 *     acting, not about what was sent. `same_actor` is an SoD refusal and reads as one.
 */
export const OT_ERROR_CODES = [
  // ── booking and definition data (T3) ──
  "criteria_refused",
  "privilege_refused",
  "duplicate_booking",
  "definition_not_active",
  "definition_invalid",
  "unknown_case",
  // ── readiness (T4) ──
  "gate_open",
  "gate_not_overridable",
  "gate_already_terminal",
  "same_actor",
  "not_ready",
  "consent_authority_missing",
  "list_not_publishable",
  /**
   * ── the cockpit (T5) ──
   *
   * ═══ THREE CODES LEFT THIS UNION AT T5, AND `errors.test.ts` IS WHAT REMOVED THEM (finding T5-b) ═══
   *
   * All three were declared here at T2 because they NAME real refusals. None of them is thrown by
   * this module, and each is refused by a different layer that already has its own vocabulary —
   * which is Plan 14's M8 lesson arriving a phase later and being caught by the test that phase's
   * close had to invent, rather than by a reviewer:
   *
   *   · **`identity_mismatch`** — `verifyHolding` RETURNS `{ ok: false, reason }`; it does not throw.
   *     A wristband that scans to the wrong patient is a modal the nurse reads and a near-miss row,
   *     not an exception. The string survives as an `ot_incidents.kind`, which is a DIFFERENT union
   *     — exactly the `qc.ts` `RuleCode` overlap M8 untangled.
   *   · **`theatre_occupied`** — the REGISTRY throws `ResourceError("already_occupied")` and T8's
   *     `toHttp` maps it to 409. An OT code for the same refusal would be a second name for one
   *     fact, and the one nobody threw would be the one a caller matched on.
   *   · **`timestamp_immutable`** — `0035`'s trigger raises it, in Postgres, as
   *     `ot_timestamp_immutable`. No TypeScript throws it and none should: the whole point of DD8
   *     is that the guard is below the service.
   */
  "bad_transition",
  "checklist_incomplete",
  "count_mismatch",
  "stale_version",
  "implant_state",
  "implant_deploying",
  "duplicate_scan",
  // ── recovery (T6) ──
  "bay_occupied",
  "escort_required",
  "not_discharge_ready",
  // ── the bill (T7) ──
  "bill_not_composable",
  "deposit_shortfall",
  "cash_limit_exceeded",
] as const;

export type OtErrorCode = (typeof OT_ERROR_CODES)[number];

export class OtError extends Error {
  constructor(
    readonly code: OtErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `OT refused: ${code}`);
    this.name = "OtError";
  }
}

const STATUS: Record<OtErrorCode, number> = {
  criteria_refused: 422,
  privilege_refused: 403,
  duplicate_booking: 409,
  definition_not_active: 409,
  definition_invalid: 422,
  unknown_case: 404,

  gate_open: 422,
  gate_not_overridable: 422,
  gate_already_terminal: 409,
  same_actor: 403,
  not_ready: 422,
  consent_authority_missing: 422,
  list_not_publishable: 422,

  bad_transition: 409,
  checklist_incomplete: 422,
  count_mismatch: 422,
  stale_version: 409,
  implant_state: 422,
  implant_deploying: 422,
  duplicate_scan: 409,

  bay_occupied: 409,
  escort_required: 422,
  not_discharge_ready: 422,

  bill_not_composable: 422,
  deposit_shortfall: 422,
  cash_limit_exceeded: 422,
};

export function otHttpStatus(code: OtErrorCode): number {
  return STATUS[code];
}
