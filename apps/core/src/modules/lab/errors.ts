/**
 * PLAN 17 T2 — the lab's error vocabulary.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 17, ON PURPOSE ═══
 *
 * `errors.ts` is named in T2's Files list and in NO other task's, while T3–T8 all modify `index.ts`
 * and the controllers. So every refusal this phase can make is spelled here, ahead of its caller —
 * the `ot/errors.ts`, `materials/errors.ts` and `formulary/errors.ts` precedent, and the same rule
 * follows from it: **a later task that needs a code this union does not carry has found a PLAN
 * DEFECT and reports it.** It does not widen the union and it does not borrow a neighbouring code.
 *
 * `errors.test.ts` asserts BOTH directions by scanning this directory's source — declared and never
 * thrown, thrown and never declared. Plan 14's close measured what a promise in a comment is worth:
 * five codes with zero throw sites, and one code borrowed by a second caller to mean something else.
 *
 * ═══ `labHttpStatus` IS EXPORTED, AND THE THREE-TIME SPECIMEN IS WHY ═══
 *
 * Plan 09 shipped a `MembershipError` that escaped `billing.controller.ts`'s `toHttp`, so a correct
 * refusal reached a busy counter as a 500; Plan 13 shipped it again; Plan 15 exported its map to
 * stop shipping it a third time. T8's `lab.e2e.test.ts` walks a refusal from every family through
 * a real route so the mapping is EXECUTED rather than asserted.
 *
 * ═══ WHAT IS **NOT** HERE, AND WHERE EACH REFUSAL LIVES INSTEAD ═══
 *
 * The three that a reader will look for, each refused by a layer that already has a vocabulary:
 *
 *   · **placement refusals** — `unknown_kind`, `clinician_required`, `permission_denied`,
 *     `patient_encounter_mismatch` are `OrderError`s from `kernel/orders/place.ts` and the envelope
 *     owns their wording. A lab code for the same refusal would be a second name for one fact.
 *   · **money refusals** — `credit_extension_required`, `credit_permission_required`,
 *     `discount_approval_missing` are `BillingError`s. The lab CALLS billing (DD6); it does not
 *     re-refuse on billing's behalf.
 *   · **immutability** — `lab_result_immutable` and `lab_report_immutable` are raised by Postgres
 *     triggers (T1). No TypeScript throws them and none should: the whole point of DD13 is that the
 *     guard is below the service.
 */
export const LAB_ERROR_CODES = [
  /**
   * ═══ TWO CODES 17b ADDS, AND THE UNION'S OWN HEADER SAYS A LATER TASK MAY NOT ═══
   *
   * The header above rules that a task needing a code this union lacks has found a PLAN DEFECT and
   * reports it rather than widening. 17a DID report it — §9.2 F28 — and 17b's executor seed (§0,
   * written by the session that closed 17a) instructs this phase to add the code and repair the
   * borrowings in as many words. So this is the reported defect being FIXED at the phase that was
   * told to fix it, not a task helping itself; both codes are named in T6's commit message and both
   * are disclosed in §9.2.
   *
   * · **`permission_denied` (F28).** T3 and T4 refused AUTHORIZATION with `catalogue_invalid` (422)
   *   and `unknown_service` (404) — "this orderable does not exist" told to a clerk who simply
   *   lacks a grant, and a 404 that a caller cannot distinguish from a real missing row. `errors.test.ts`
   *   checks declared-vs-thrown in BOTH directions and had nothing to object to, which is exactly
   *   why it went unnoticed for two tasks. The borrowings in `catalogue.ts` and `desk.ts` are
   *   repointed here, and no test asserted either of them.
   * · **`critical_already_closed`.** `acknowledgeCritical` closes a call on a read-back with a CAS
   *   on `closed_at IS NULL`, and two nurses reading back the same potassium is the ordinary race.
   *   The loser needs a 409 of its own: borrowing `already_verified` would put a word about a
   *   pathologist's signature on a telephone call, which is F28's defect committed while fixing it.
   */
  "permission_denied",
  // ── catalogue (T3) ──
  "unknown_orderable",
  "unknown_analyte",
  "foetal_sex_refused",
  "catalogue_invalid",
  // ── the desk (T4) ──
  "unknown_service",
  "consent_required",
  "duplicate_unacknowledged",
  "addon_specimen_disposed",
  "unknown_item",
  "item_not_cancellable",
  // ── collection and accession (T5) ──
  "tube_mismatch",
  "identity_recheck_required",
  "already_received",
  "unknown_specimen",
  "specimen_not_receivable",
  "no_active_order",
  // ── 17d T2 — the typed tube number is a re-label, and a re-label is witnessed ──
  "relabel_witness_required",
  "relabel_witness_same_actor",
  // ── results (T6) ──
  "absurd_value",
  "absurd_override_same_actor",
  // ── 17d T1 — the value that is impossible for THIS patient ──
  "analyte_not_applicable",
  "impossible_override_same_actor",
  "sod_violation",
  "already_verified",
  "user_actor_required",
  "item_not_resultable",
  "unknown_result",
  "critical_already_closed",
  // ── reports (T7) ──
  "report_print_blocked",
  "collector_identity_required",
  "report_not_publishable",
  "unknown_report",
  "report_not_amendable",
  "release_approval_invalid",
  // ── 17-E T1 — the instruments on the bench ──
  "unknown_instrument",
  /**
   * ── 17-E T7 — a machine never supersedes; a human always does ──
   *
   * Six refusals and not one shared code, because `assert the CODE` (#140) is worth nothing when
   * one code means six things: a screen that must tell a technician *why* it will not sign a number
   * cannot read the sentence, and a test asserting a shared code passes on the wrong refusal.
   */
  "machine_cannot_supersede",
  "rerun_unchosen",
  "rerun_choice_reason_required",
  "no_rerun_to_choose",
  "rerun_choice_final",
  "result_superseded",
  /** ── the range book's door (the writer that `lab_reference_ranges` never had) ── */
  "range_overlap",
  /**
   * ── 17-E T7b — the analyser's bridge, and the row a link must point AT ──
   *
   * `lab_instruments.interface_id` carries a foreign key, so the database already refuses an id that
   * names no device — but as a raw Postgres error, which the controller maps to a 500. An
   * administrator who mistypes an id is told the server broke. This is the same refusal said in the
   * module's own vocabulary, and it is the sixth `unknown_*`.
   */
  "unknown_interface",
] as const;

export type LabErrorCode = (typeof LAB_ERROR_CODES)[number];

export class LabError extends Error {
  constructor(
    readonly code: LabErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `lab refused: ${code}`);
    this.name = "LabError";
  }
}

/**
 * ═══ WHY THESE STATUSES ═══
 *
 * · **404** for the five `unknown_*` — the named row does not exist.
 * · **409** for the state races (`already_received`, `already_verified`) — a CAS loser is a
 *   conflict, not a bad request, and the caller's correct response is to re-read rather than to fix
 *   its body.
 * · **403** for the three authority refusals: `sod_violation` and `absurd_override_same_actor` are
 *   both about WHO is acting (the same pair of hands twice), which is what 403 means — and
 *   `permission_denied` is the plain one the union spent two tasks without (F28).
 * · **422** for every clinical hard stop — `consent_required`, `tube_mismatch`,
 *   `identity_recheck_required`, `absurd_value`, `report_print_blocked`. These ARE the refusals this
 *   phase exists to make unskippable, and the screen's job is to name the rule, which a 4xx body does.
 *   `report_print_blocked` in particular is NOT a 402: the patient owes money to BILLING, and the
 *   lab is declining to hand over a document — a payment-required status would tell the counter to
 *   take money at the wrong window.
 */
const STATUS: Record<LabErrorCode, number> = {
  /** 403 — the caller is known and is not allowed. Never 404: a missing grant is not a missing row. */
  permission_denied: 403,

  unknown_orderable: 404,
  unknown_analyte: 404,
  foetal_sex_refused: 422,
  catalogue_invalid: 422,

  unknown_service: 404,
  consent_required: 422,
  duplicate_unacknowledged: 422,
  addon_specimen_disposed: 409,
  unknown_item: 404,
  item_not_cancellable: 409,

  tube_mismatch: 422,
  identity_recheck_required: 422,
  already_received: 409,
  unknown_specimen: 404,
  specimen_not_receivable: 409,
  no_active_order: 409,
  /** 422 with `identity_recheck_required`: a clinical hard stop the screen must name. */
  relabel_witness_required: 422,
  /** 403 with `absurd_override_same_actor`: it is about WHO is acting, not about the body. */
  relabel_witness_same_actor: 403,

  absurd_value: 422,
  absurd_override_same_actor: 403,
  /** 422 with `absurd_value`: a clinical hard stop the screen must name, not a bad request. */
  analyte_not_applicable: 422,
  /** 403 with `absurd_override_same_actor`, and for the same reason: it is about WHO is acting. */
  impossible_override_same_actor: 403,
  sod_violation: 403,
  already_verified: 409,
  user_actor_required: 403,
  item_not_resultable: 409,
  unknown_result: 404,
  critical_already_closed: 409,

  report_print_blocked: 422,
  collector_identity_required: 422,
  report_not_publishable: 422,
  unknown_report: 404,
  report_not_amendable: 409,
  release_approval_invalid: 422,

  /** 404 — the named machine is not registered. A bridge posting for one is a configuration fact. */
  unknown_instrument: 404,

  /**
   * ═══ 17-E T7 ═══
   *
   * · **403** with `sod_violation` and the two override refusals: `machine_cannot_supersede` is
   *   about WHO is acting. The bridge's body is well formed; the act is not one a machine performs.
   * · **422** for the two clinical hard stops. `rerun_unchosen` is the refusal this task exists to
   *   make unskippable and the screen's job is to name the rule, which a 4xx body does; a blank
   *   reason is refused in the same family because the reason IS the record.
   * · **409** for the three state conflicts, and each one's correct client response is to re-read:
   *   there is nothing to choose between, the set is already signed, or a newer row replaced this.
   */
  machine_cannot_supersede: 403,
  rerun_unchosen: 422,
  rerun_choice_reason_required: 422,
  no_rerun_to_choose: 409,
  rerun_choice_final: 409,
  result_superseded: 409,

  /**
   * 422 with the other clinical hard stops. Two bands over one age is not a malformed request — the
   * body is well formed and the book it would create is one whose answer depends on row order, which
   * is a rule the screen must name.
   */
  range_overlap: 422,

  /** 404 with the other five: the named row does not exist. A missing device is not a bad request. */
  unknown_interface: 404,
};

export function labHttpStatus(code: LabErrorCode): number {
  return STATUS[code];
}
