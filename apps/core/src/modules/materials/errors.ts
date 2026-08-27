/**
 * The materials module's error vocabulary.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 14, ON PURPOSE ═══
 *
 * `errors.ts` is named in T2's Files list and in NO other task's, while T3–T8 all modify `index.ts`
 * and the controller. So every refusal this phase can make is spelled here, ahead of its caller —
 * the `formulary/errors.ts` and membership precedent, and the same rule follows from it: **a later
 * task that needs a code this union does not carry has found a PLAN DEFECT and reports it.** It
 * does not widen the union and it does not borrow a neighbouring code.
 *
 * The plan states the other half of the same discipline: *"Every code listed here is thrown by some
 * task below; a code thrown by no path is a lie the reviewer should catch."*
 *
 * ═══ CLOSE REVIEW M8 — THAT SENTENCE PROMISED A TEST THAT WAS NEVER WRITTEN, AND THE UNION HAD
 *     DRIFTED IN BOTH DIRECTIONS BEHIND IT ═══
 *
 * This paragraph used to end *"Both directions are asserted by `errors.test.ts` at T8, when every
 * thrower exists."* **`errors.test.ts` did not exist.** It is the most expensive kind of comment: a
 * claim about the test suite, in the file the test was supposed to guard, believed by every reader
 * including the reviewer of the task that was meant to write it. The close pass found what it was
 * hiding, mechanically, in one pass over this directory:
 *
 *   · **Five declared codes had ZERO throw sites** — `batch_required`, `expiry_required`,
 *     `expired`, `mrp_below_cost`, `mrp_above_ceiling`. All five are `qc.ts` `RuleCode`s: a
 *     DIFFERENT union, recorded on the GRN line as a verdict and never thrown as an error. They
 *     were transcribed into this union because DD8's rules read like refusals. They are removed;
 *     `qc.ts` owns them and always did.
 *   · **`not_in_transit` was declared for `receiveStock`, unreachable there by construction** (a
 *     ternary whose true branch sat inside a guard excluding it), **and BORROWED by `postGrn`** to
 *     mean "gate QC has not run" — the exact practice this header forbids two paragraphs up.
 *     `postGrn` now has `qc_not_run`, and `not_in_transit` is gone.
 *
 * **`errors.test.ts` now exists and asserts both directions by scanning this directory's source**,
 * so the next code that is declared-and-never-thrown, or thrown-and-never-declared, fails a suite
 * instead of waiting for a reviewer. A promise in a comment is not a guard.
 *
 * ═══ `materialsHttpStatus` IS EXPORTED, AND PLAN 13's M-CLASS IS WHY ═══
 *
 * Plan 09 shipped a `MembershipError` that escaped `billing.controller.ts`'s `toHttp` — which had a
 * clause for every other module's error and none for that one — so a correct refusal reached a busy
 * counter as a 500. **Plan 13 then shipped the same defect a second time, INTRODUCED BY THE FIX for
 * the first**: a kernel refusal escaped an OPD controller as a 500 because the remediation added a
 * code and not a mapping. The mapper therefore lives beside the codes and is exported so that every
 * controller which can receive one of these maps it from the SAME table rather than a private copy
 * (§2.54: two copies of one fact drift).
 *
 * **The rule for T3–T8, stated once here:** a new throw site must be reachable through
 * `materialsHttpStatus` from every controller that can surface it. T8's e2e walks that path.
 *
 * ═══ THREE CODES THE PLAN'S UNION DOES NOT LIST AND THE PLAN'S OWN TEXT REQUIRES — finding F5 ═══
 *
 * T2's Produces enumerates twenty-six codes and calls the union closed. Three refusals the plan
 * names elsewhere have no code among the twenty-six, so the union as written cannot express
 * behaviour the plan mandates. They are added here, at the one task allowed to own this file, and
 * disclosed rather than smuggled (AGENT-RULES: disclose-don't-work-around). Borrowing a
 * neighbouring code — the alternative — is the exact defect the header above describes, one level
 * down: a caller told `vendor_not_active` when the real problem is a missing PAN certificate
 * chases the wrong thing.
 *
 *   · **`approval_not_granted`** — T4's Assertion Book row A6 names it in as many words:
 *     *"Then `applyBankChange` on a `pending` (not granted) change — refuses
 *     `approval_not_granted`-class."* A required mutant kill has no code to assert without it.
 *   · **`documents_incomplete`** — T4's Produces: `activateVendor` *"refuses without a
 *     `gst_certificate` or `pan` document on file … drug-licence documents are required only when
 *     `classFlags.drugLicensed`"*. `agreement_missing` is O-8's consignment-specific refusal and
 *     means something else.
 *   · **`unknown_document`** — `applyBankChange(changeId)`, `receiveStock(transferId)`,
 *     `postGrn(grnId)` and `getGrn` all take an id that may name nothing. `already_received` is a
 *     WRONG-STATUS refusal and answering it for a row that does not exist would tell the caller the
 *     transfer exists and is finished. (This clause named `not_in_transit` until M8 removed it;
 *     the argument is unchanged and now points at the code that actually makes it.)
 */
export type MaterialsErrorCode =
  // ── 404: a thing that is not there ──────────────────────────────────────────────────────────
  /** T3 — no such item, or the id names a row of the wrong shape. */
  | "unknown_item"
  /** T4 — no such vendor. */
  | "unknown_vendor"
  /** T5 — the resource id is not a `store`-kind resource, or does not exist. */
  | "unknown_store"
  /** T5/T6 — no such `stock_batches` row. */
  | "unknown_batch"
  /** T4/T6 — the transfer, GRN, lot or bank-change row named does not exist. */
  | "unknown_document"

  // ── 409: a state conflict the caller can act on ─────────────────────────────────────────────
  /**
   * T3 — the UoM is not one of THIS item's (`uom.ts`, A2). Never a global UoM table.
   *
   * **Filed under 409 despite the `unknown_` prefix (m8).** The item was found; it is the unit in
   * the request that is wrong, or an MRP that will not divide into whole paise. See
   * `NOT_FOUND_CODES` below, which deliberately omits it.
   */
  | "unknown_uom"
  /** T3/T4 — an item `code` or a vendor `code` that already exists, case-insensitively. */
  | "duplicate_code"
  /** T3, A1 — DD3's CHECK, refused in code so the error names the RULE and not the constraint. */
  | "drug_needs_medicine"
  /** T3, A1 — DD3's other direction: a non-drug item pointing at a formulary medicine. */
  | "non_drug_has_medicine"
  /** T3, A3 — a second UoM with multiplier 1, or a base UoM that is not `items.base_uom`. */
  | "base_uom_required"
  /** T4/T6 — the vendor is `draft` or `suspended`; only an `active` vendor may be received from. */
  | "vendor_not_active"
  /** T4/T6 — the vendor is `blacklisted`. Distinct from `vendor_not_active` because the remedy differs. */
  | "vendor_blacklisted"
  /** T4, A5 — reinstatement attempted before `blacklist_until`. O-11's clock, refused. */
  | "blacklist_active"
  /** T4 — `applyBankChange` on a change whose approval is not `granted` (A6). */
  | "approval_not_granted"
  /** T6, A16 — **O-8**: a consignment GRN from a vendor with no `consignment_agreement` valid that day. */
  | "agreement_missing"
  /** T4 — `activateVendor` without the `gst_certificate`/`pan` minimum, or without a drug licence when the class demands it. */
  | "documents_incomplete"
  /** T6, A17 — a `near_expiry` line with no GRANTED `materials_near_expiry_acceptance` on the GRN. */
  | "near_expiry_unapproved"
  /** T5/T6/T7, DD14 — the batch is recall-frozen: no outbound movement, and no new receipt. */
  | "batch_frozen"
  /** T6, A14 — a batch row exists for `(item, batch_no, ownership)` and its expiry or MRP disagrees. */
  | "batch_mismatch"
  /** T5 — `on_hand − reserved − frozen < |delta|` on an outbound movement. */
  | "insufficient_stock"
  /** T7, A20 — the consignment lot's `received − deployed − returned` cannot cover the deployment. */
  | "lot_exhausted"
  /** T6 — `postGrn` on a GRN that has not been through gate QC. DD8's two-stage gate, refused. */
  | "qc_not_run"
  /** T7 — `receiveStock` against a line already received. */
  | "already_received"
  /**
   * T5 — the DD6 invariant, refused BEFORE the CHECK so the caller gets a code rather than a
   * constraint name. Distinct from `insufficient_stock`: that one is about available stock at a
   * location, this one is the last guard on the arithmetic itself.
   */
  | "negative_stock";

/**
 * 404 for a thing that is not there, 409 for a state conflict the caller can act on.
 * NOTHING here answers 5xx, which is the property the two counter-side lessons above are about.
 */
/**
 * CLOSE REVIEW m8 — **`unknown_uom` is NOT in this set, despite the prefix.** Every other
 * `unknown_*` names a ROW the caller addressed and the server could not find, which is what 404
 * means. `unknown_uom` is raised when the REQUEST BODY carries a unit the item does not declare, or
 * an MRP that will not divide into whole paise — the item was found, and answering 404 tells the
 * caller the opposite of what happened. It is a 409 with the rest of the validation conflicts.
 */
const NOT_FOUND_CODES = new Set<MaterialsErrorCode>([
  "unknown_item", "unknown_vendor", "unknown_store", "unknown_batch",
  "unknown_document",
]);

export function materialsHttpStatus(code: MaterialsErrorCode): number {
  return NOT_FOUND_CODES.has(code) ? 404 : 409;
}

export class MaterialsError extends Error {
  constructor(
    readonly code: MaterialsErrorCode,
    message?: string,
    /** Carried to the response body — e.g. the QC rule that fired, or the lot's remaining quantity. */
    readonly detail?: unknown,
  ) {
    super(message ?? code);
    this.name = "MaterialsError";
  }
}
