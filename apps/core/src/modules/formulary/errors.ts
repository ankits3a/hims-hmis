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
  | "staging_not_pending";

const NOT_FOUND_CODES = new Set<FormularyErrorCode>(["unknown_salt", "unknown_medicine", "unknown_interaction"]);

/**
 * 404 for a thing that is not there, 409 for a state conflict the caller can act on.
 * NOTHING here answers 5xx, which is the property the counter-side lesson above is about.
 */
export function formularyHttpStatus(code: FormularyErrorCode): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
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
