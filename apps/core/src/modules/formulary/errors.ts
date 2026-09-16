/**
 * The formulary module's error vocabulary.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 16a, ON PURPOSE ═══
 *
 * `errors.ts` is named in T2's Files list and in no other task's, while T3, T7 and T8 all modify
 * `index.ts` and the controller. So every refusal this phase can make is spelled here, ahead of its
 * caller — the membership precedent, and the same rule follows from it: a later task that needs a
 * code this union does not carry has found a PLAN DEFECT and reports it. It does not widen the
 * union, and it does not borrow a neighbouring code.
 *
 * ═══ `formularyHttpStatus` IS EXPORTED BECAUSE PLAN 09 SHIPPED THE BUG THAT PROVES IT MATTERS ═══
 *
 * A `MembershipError` escaped `billing.controller.ts`'s `toHttp`, which had a clause for every
 * other module's error and none for that one, so a correct refusal reached a busy counter as a
 * 500. The mapper lives beside the codes and is exported so that every controller which can
 * receive one of these — this module's, and any later module that calls `addMedicine` — maps it
 * from the SAME table rather than a private copy (§2.54: two copies of one fact drift).
 */
export type FormularyErrorCode =
  /** A composition or an interaction named a moiety the formulary does not have. */
  | "unknown_salt"
  | "unknown_medicine"
  /**
   * ADDED BY T2, AND IT IS A CORRECTION TO THE PLAN'S OWN LIST rather than a widening (CLOSE F5).
   * §5 names five codes and, in the same paragraph, names `updateInteraction` as one of the six
   * masters this task ships. That function's "no such row" refusal has no code among the five, and
   * the alternative — answering `unknown_salt` when the SALTS are fine and the PAIR is missing —
   * is the kind of misleading refusal a curator would chase for an hour. Recorded here rather
   * than fixed silently, because the union's closure is what later tasks rely on.
   */
  | "unknown_interaction"
  /** A brand or a moiety whose name already exists, case-insensitively. */
  | "duplicate_name"
  /** DD8 — the medicine's OWN salts interact, and admission needs an explicit acknowledgement. */
  | "intra_fdc_interaction"
  /** T7 — a staging row already approved or rejected cannot be admitted a second time. */
  | "staging_not_pending"
  /**
   * ADDED AFTER 16a, UNDER THE UNION'S OWN RULE. The closure above says a later task needing a
   * code this union does not carry "has found a PLAN DEFECT and reports it, it does not widen the
   * union and it does not borrow a neighbouring code" — so this widens it, and says why.
   *
   * `reads.ts`'s id-keyed readers REFUSE a list longer than `MAX_IDS` rather than truncating it: a
   * short map silently drops a dispense line's medicine and blanks a brand on a printed label.
   * That refusal needed a name and none of the six above means "you asked for too many at once".
   * Borrowing `unknown_medicine` would tell a caller the catalogue lacks a row it has — exactly
   * the misleading refusal that `unknown_interaction`'s note above exists to prevent.
   */
  | "too_many_ids"
  /*
   * ═══ THE MAPPING LOOP'S REFUSALS (phase 2, 2026-09-16) — WIDENED UNDER THE SAME RULE ═══
   *
   * `mapping.ts` is new surface: a pharmacist attesting which curated moiety a release substance
   * is. None of the codes above says any of the six things it must be able to refuse, and each
   * neighbour would mislead. `unknown_salt` for a missing SUBSTANCE sends a curator hunting through
   * the wrong table, and `staging_not_pending` for an already-mapped substance names a different
   * queue altogether.
   */
  /** The release substance does not exist. */
  | "unknown_substance"
  /** A draft id that is not a draft FOR THIS substance. Agreement with a draft must never be claimed by accident. */
  | "unknown_proposal"
  /**
   * Only a person attests. A drafter proposes, a human decides: `kernel/orders/place.ts`'s
   * `agent_cannot_order`, applied to the formulary. Checked before anything is read.
   */
  | "attester_not_user"
  /**
   * The target is a RELEASE IMAGE, the importer's verbatim copy of a substance. Mapping a substance
   * onto a copy of itself records that a decision was made while deciding nothing.
   */
  | "release_image_target"
  /** A plain attestation found the substance already decided. Changing it is a CORRECTION, which needs a reason. */
  | "substance_already_decided"
  /** A correction was asked for on a substance nobody has decided yet. */
  | "substance_not_decided"
  /**
   * Formulary phase 3: a bulk adoption that was malformed before any state was read: no resolution
   * named, the same substance twice, or a decision of an unknown kind.
   */
  | "invalid_adoption";

const NOT_FOUND_CODES = new Set<FormularyErrorCode>([
  "unknown_salt", "unknown_medicine", "unknown_interaction", "unknown_substance", "unknown_proposal",
]);
/** A request this module could not have served whatever the database held. */
const BAD_REQUEST_CODES = new Set<FormularyErrorCode>(["too_many_ids", "invalid_adoption"]);
/** The caller is the wrong KIND of actor for the act, whatever it holds. */
const FORBIDDEN_CODES = new Set<FormularyErrorCode>(["attester_not_user"]);

/**
 * 404 for a thing that is not there, 409 for a state conflict the caller can act on,
 * 400 for a request that was malformed before the state was consulted, 403 for an actor who may
 * never perform the act. NOTHING here answers 5xx, which is the property the counter-side lesson
 * above is about.
 */
export function formularyHttpStatus(code: FormularyErrorCode): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (BAD_REQUEST_CODES.has(code)) return 400;
  if (FORBIDDEN_CODES.has(code)) return 403;
  return 409;
}

export class FormularyError extends Error {
  constructor(
    readonly code: FormularyErrorCode,
    message?: string,
    /** Carried to the response body — e.g. the interacting pairs DD8 refused on. */
    readonly detail?: unknown,
  ) {
    super(message ?? code);
    this.name = "FormularyError";
  }
}
