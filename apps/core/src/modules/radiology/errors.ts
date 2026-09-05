/**
 * PLAN 18a T2 — the radiology module's error vocabulary.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 18a, ON PURPOSE ═══
 *
 * `errors.ts` is named in T2's Files list and in NO other task's, while T3–T8 all add callers. So
 * every refusal this phase can make is spelled here, ahead of its caller — the `ot/errors.ts`,
 * `materials/errors.ts` and `formulary/errors.ts` precedent, and the same rule follows from it:
 * **a later task that needs a code this union does not carry has found a PLAN DEFECT and reports
 * it.** It does not widen the union and it does not borrow a neighbouring code to mean something
 * else, which is the specimen Plan 14's close pass measured.
 *
 * ═══ `radiologyHttpStatus` IS EXPORTED, AND PLANS 09 AND 13 ARE WHY ═══
 *
 * Plan 09 shipped a `MembershipError` that escaped its controller's `toHttp`, so a correct refusal
 * reached a busy counter as a 500; Plan 13 then shipped the same defect again, introduced BY the
 * fix for the first. The mapper therefore lives beside the codes and is exported, so every
 * controller that can surface one of these maps it from the SAME table (§2.54).
 *
 * ═══ THE STATUS CHOICES THAT ARE NOT OBVIOUS ═══
 *
 *   · **409 for every RACE** — `slot_taken`, `stale_state`, `already_acquired`, `duplicate_recent`.
 *     The caller's request was well-formed and lost a race. A 422 tells a receptionist to fix her
 *     input, which is exactly the wrong instruction when the answer is "somebody else got there".
 *   · **422 for every GATE refusal** — `not_ready`, `form_f_missing`, `gate_not_overridable`,
 *     `laterality_mismatch`, `lexical_lockout`. These ARE the hard stops this phase exists to make
 *     unskippable, and the screen's job is to name the rule, which a 4xx body does.
 *   · **403 for `second_factor_required`, `person_not_registered` and `machine_not_registered`.**
 *     All three are refusals about WHO or WHAT is acting rather than about what was sent. The two
 *     PCPNDT ones read as authority refusals because that is exactly what they are under the Act:
 *     this doctor may not perform this scan on this machine.
 *   · **402 for `payment_required`** — DD12a. It is the one refusal a receptionist resolves by
 *     taking money, and giving it its own status is what lets the console show the counter's
 *     screen instead of an error.
 */
export const RADIOLOGY_ERROR_CODES = [
  // ── placement (T3) ──
  "encounter_closed",
  "duplicate_recent",
  "unknown_study",
  "unknown_study_type",
  // ── scheduling (T4) ──
  "slot_taken",
  "device_unavailable",
  "modality_mismatch",
  "age_band_mismatch",
  "already_acquired",
  "bad_transition",
  "definition_not_active",
  "definition_invalid",
  // ── the gates (T5) ──
  "gate_open",
  "gate_not_overridable",
  "gate_already_terminal",
  "evidence_invalid",
  "evidence_stale",
  "reason_required",
  "not_ready",
  "stale_state",
  // ── acquisition (T7) ──
  "form_f_missing",
  "machine_not_registered",
  "person_not_registered",
  "payment_required",
  "dose_required",
  "contrast_mismatch",
  // ── 18b T2 — the Study Instance UID ──
  "invalid_study_instance_uid",
  "duplicate_study_instance_uid",
  // ── 18b T3 — the viewer door ──
  "no_images",
  "pacs_not_configured",
  // ── 18b close review ──
  "invalid_date",
  "machine_draft_not_signable",
  /**
   * ═══ F41 (CLOSE REVIEW, RULED) — THE TWO CODES THE UNION WAS MISSING ═══
   *
   * This file's header says a task needing a code the union does not carry has found a PLAN DEFECT
   * and reports it rather than borrowing a neighbour. T5–T8 reported it, in five places, and the
   * close review is the decision the rule exists to force. **The ask is granted.**
   *
   *   · `forbidden` (403) — an authorisation refusal. The worst of the five borrowings was
   *     `unknown_study` (**404**) for a PERMISSION failure in `read.ts`: an authorisation answer
   *     dressed as a not-found, invisible only because the controller guard answers 403 first, so
   *     an internal caller saw the wrong thing and a route added later would have shipped it.
   *   · `unknown_invoice_line` (404) — `linkInvoiceLine` answered `unknown_study` ("no study") when
   *     the INVOICE LINE was unknown, sending a counter to look for the wrong missing object.
   *   · `already_resolved` (409) — a bill decision already worked. `already_acquired` was carrying
   *     that meaning as well as its own.
   *
   * ═══ AND THE CONSTRAINT THE ASK DID NOT STATE ═══
   *
   * **The RESTRICTED hold-out must never become one of these.** A reader who may not see a row gets
   * the same answer as a reader asking about a row that does not exist; turning that into a
   * distinguishable 403 would rebuild the oracle the hold-out exists to remove (§9.8 rule 4 — a fix
   * that removes a disclosure must not re-derive it through a neighbouring field). Only the
   * PERMISSION checks change code. `worklist`'s *"you do not hold radiology.worklist.read"* is
   * about the ACTOR and is a 403; `studyView` returning null is about the ROW and stays a null.
   */
  "forbidden",
  "unknown_invoice_line",
  "already_resolved",
  /**
   * ── 18a-iii T1 — the expired vial ──
   *
   * This file's header rules that a task needing a code the union does not carry has found a plan
   * defect and reports it rather than borrowing a neighbour. `contrast_mismatch` is the nearest
   * neighbour and it means *"the contrast does not match this study or this patient"* — a consent
   * gate, a non-contrast examination, an allergy. An in-date vial for the right study, whose LABEL
   * says it expired last month, is a different refusal, and a floor reading "contrast mismatch" on
   * a correctly ordered CT would go looking for the wrong problem.
   */
  "vial_expired",
  // ── reports (T8) ──
  "second_factor_required",
  "laterality_mismatch",
  "lexical_lockout",
  "already_signed",
  "prelim_not_publishable",
  "report_not_signed",
] as const;

export type RadiologyErrorCode = (typeof RADIOLOGY_ERROR_CODES)[number];

export class RadiologyError extends Error {
  constructor(
    readonly code: RadiologyErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `radiology refused: ${code}`);
    this.name = "RadiologyError";
  }
}

const STATUS: Record<RadiologyErrorCode, number> = {
  encounter_closed: 422,
  duplicate_recent: 409,
  unknown_study: 404,
  unknown_study_type: 422,

  slot_taken: 409,
  device_unavailable: 422,
  modality_mismatch: 422,
  age_band_mismatch: 422,
  already_acquired: 409,
  bad_transition: 409,
  definition_not_active: 409,
  definition_invalid: 422,

  forbidden: 403,
  unknown_invoice_line: 404,
  already_resolved: 409,

  gate_open: 422,
  gate_not_overridable: 422,
  gate_already_terminal: 409,
  evidence_invalid: 422,
  evidence_stale: 422,
  reason_required: 422,
  not_ready: 422,
  stale_state: 409,

  form_f_missing: 422,
  machine_not_registered: 403,
  person_not_registered: 403,
  payment_required: 402,
  dose_required: 422,
  contrast_mismatch: 422,
  invalid_study_instance_uid: 422,
  duplicate_study_instance_uid: 409,
  no_images: 422,
  pacs_not_configured: 409,
  invalid_date: 422,
  machine_draft_not_signable: 422,
  vial_expired: 422,

  second_factor_required: 403,
  laterality_mismatch: 422,
  lexical_lockout: 422,
  already_signed: 409,
  prelim_not_publishable: 422,
  report_not_signed: 422,
};

export function radiologyHttpStatus(code: RadiologyErrorCode): number {
  return STATUS[code];
}
