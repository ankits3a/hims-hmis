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
   * the request that is wrong (or an MRP with no unit). An MRP that will not divide into whole paise
   * was also refused here until the loose-MRP ruling (owner, 2026-09-22); it no longer is. See
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
  /**
   * **An action already taken, on a row that is now terminal.** T7's `receiveStock` against a line
   * already received is the case it was named for; it is not the only one it means.
   *
   * ═══ SECOND-PASS FINDING F7 — SEVEN THROW SITES, AND THE **DOCSTRING** WAS THE DEFECT ═══
   *
   * This read *"T7 — `receiveStock` against a line already received"* while seven sites raised it
   * with six different subjects: a GRN whose QC verdict is already recorded (`grn.ts`), a GRN
   * already posted (`grn.ts`), a reservation already consumed or released (`ledger.ts`, twice), a
   * transfer in a terminal status (`transfers.ts`), a transfer LINE already received
   * (`transfers.ts` — the documented one), and a bank change no longer `pending` (`vendors.ts`).
   * M8 removed one borrowed code and left these; `errors.test.ts` cannot see them, because a borrow
   * satisfies both directions it asserts.
   *
   * **Resolved by widening the DEFINITION rather than by minting six codes, and the reason is this
   * file's own test for when to split one.** `vendor_blacklisted` is separate from
   * `vendor_not_active` *"because the remedy differs"*. Here the remedy does **not** differ: for all
   * seven the caller's next move is identical — stop, this is already done, re-read the row. Six
   * near-synonyms would give a client six things to switch on and one thing to do, which is a
   * worse interface than one honest code, and each would need a locale string saying the same
   * sentence in six ways.
   *
   * What DOES change is that the meaning is now written down, so the next author is choosing it
   * rather than borrowing it — and `errors.test.ts` pins the throw-site census, so an EIGHTH site
   * in a new file has to update a test and say why. A shared code is legitimate; a shared code
   * nobody declared is the defect.
   */
  | "already_received"
  /**
   * T5 — the DD6 invariant, refused BEFORE the CHECK so the caller gets a code rather than a
   * constraint name. Distinct from `insufficient_stock`: that one is about available stock at a
   * location, this one is the last guard on the arithmetic itself.
   */
  | "negative_stock"
  // ── Plan 14c, first slice: counts ──
  /** The login lacks the counts grant the act needs; the act checks it as well as the route. */
  | "permission_denied"
  | "unknown_count"
  /** A count is already being counted at this store: two sheets on one shelf is how counts go wrong. */
  | "count_already_open"
  /** Nobody holding `materials.counts.perform` is free of the store and of the scheduling. */
  | "no_eligible_counter"
  /** The transit store, or a retired one, is not a shelf anyone can count. */
  | "not_countable"
  /** The sheet belongs to the counter the system assigned. */
  | "count_not_assigned"
  | "count_not_open"
  /** Every line on the sheet needs a number; a blank is not a zero. */
  | "count_incomplete"
  | "invalid_count_qty"
  /** The sheet's time is before the freeze or after the submission. */
  | "invalid_count_time"
  | "count_not_submitted"
  | "reason_required"
  // ── Plan 14c, second slice: adjustments ──
  /** Only a variance line of a submitted or closed count is booked; a match has nothing to book. */
  | "nothing_to_adjust"
  /** A line flagged for recount is booked from its recount, never from the count that flagged it. */
  | "recount_pending"
  | "already_requested"
  /** The reason does not fit the direction: `found` books stock on, the loss reasons write it off. */
  | "invalid_adjustment_reason"
  | "adjustment_unapproved"
  | "unknown_adjustment"
  // ── The transfer screen (2026-09-17): two signatures, and the destination's own keeper ──
  /** The person who issued a transfer tries to receive it. DD9's two signatures are two people. */
  | "transfer_self_receipt"
  /** The destination names its keepers (`attributes.custodianRoles`) and the receiver holds none of them. */
  | "not_store_keeper"
  // ── PHARMACY PARITY P2 — purchase orders and the GRN received against one ──
  /** No such purchase order. */
  | "unknown_purchase_order"
  /** The order is not in the state this act needs (edit a draft, approve a pending one, send an approved one…). */
  | "po_wrong_status"
  /** A line or header the order cannot carry: no lines, a quantity or rate out of range, an item twice, a pack the item does not have. */
  | "po_invalid"
  /** A GRN line would take an order line past what was ordered plus the receipt tolerance (paid quantity; free goods apart). */
  | "po_over_receipt"
  /** The GRN is not for this order: another vendor or store, or an item the order does not carry. */
  | "po_mismatch"
  /** The person who approved the order is the one receiving it (`po_approver_grn_receiver`). */
  | "po_approver_receiving"
  /** Stock levels that do not hold `0 ≤ min ≤ reorder < max`. */
  | "invalid_stock_level"
  // ── PHARMACY PARITY P3 — supplier bills, the match, payment runs and payments ──
  /** No such supplier bill. */
  | "unknown_supplier_bill"
  /** The bill is not in the state this act needs. */
  | "bill_wrong_status"
  /** A bill or bill line out of shape: no lines, a GRN not this vendor's or not posted, an amount out of range. */
  | "bill_invalid"
  /** The vendor already has a live bill with this number in this financial year. */
  | "duplicate_bill"
  /** A GRN is already on another live bill. */
  | "grn_already_billed"
  /** Whoever entered the bill tries to accept its difference; somebody else does. */
  | "bill_self_accept"
  /** No such payment run. */
  | "unknown_payment_run"
  /** The run is not in the state this act needs. */
  | "run_wrong_status"
  /** A run or run line out of shape: a bill not payable, more than the bill still owes, no lines. */
  | "run_invalid"
  /** Only the run's preparer submits it (so the kernel's requester ≠ approver is preparer ≠ authoriser). */
  | "run_not_preparer"
  /** The person who authorised the run records its payment (`payment_authoriser_recorder`). */
  | "authoriser_recording"
  /** The vendor's bank details changed and the cooling-off has not ended (`vendors.first_payment_allowed_at`). */
  | "vendor_cooling_off"
  /** Cash to one vendor in one day would pass the Income-tax Act s.40A(3) limit. */
  | "cash_limit_exceeded"
  /** A bank mode without its reference (UTR, cheque number). */
  | "payment_reference_required"
  // ── PHARMACY PARITY P4 — returns to the supplier, credit notes, write-offs, recalls ──
  /** No such return to a supplier. */
  | "unknown_supplier_return"
  /** The return is not in the state this act needs (edit a draft, approve a draft, dispatch an approved one…). */
  | "return_wrong_status"
  /** A return or line out of shape: no lines, a batch not the vendor's or not owned stock, a store not a store, a quantity or rate out of range. */
  | "return_invalid"
  /** The batch cannot go back to this supplier: the hospital's own opening or trial stock, or no supplier on the batch. */
  | "not_returnable"
  /** An expired batch is past the vendor's return window — it is destroyed, not returned. */
  | "return_window_passed"
  /** Whoever drafted the return approves it; somebody else does (maker ≠ checker). */
  | "return_self_approve"
  /** Whoever approved the return dispatches it (`return_approver_dispatcher`). */
  | "approver_dispatching"
  /** A credit note out of shape: more than the debit note, a short credit without its reason, a date in the future. */
  | "credit_invalid"
  /** A credit note cannot be cancelled once the payment runs have spent it. */
  | "credit_spent"
  /** No such write-off. */
  | "unknown_write_off"
  /** The write-off is not in the state this act needs. */
  | "writeoff_wrong_status"
  /** A write-off or line out of shape: no lines, a batch not in that store, an expiry write-off of stock not yet expired. */
  | "writeoff_invalid"
  /** The write-off's approval is not granted yet: nothing is destroyed before it is. */
  | "writeoff_unapproved"
  /** Posting a write-off needs the disposal agency, its manifest / challan number and the handover date. */
  | "disposal_required"
  /** No such recall. */
  | "unknown_recall"
  /** The batch already has an open recall. */
  | "recall_open"
  /** The recall is not in the state this act needs. */
  | "recall_wrong_status"
  /** A recall is closed only when no store holds any of the batch. */
  | "recall_stock_remaining"
  // ── PHARMACY P6 — the controlled-drug cabinet (`controlled.ts`, `controlled-check.ts`) ──
  /** A movement at the controlled cabinet without a witness, or by a system actor. */
  | "custody_required"
  /** The holder named as a witness, or one witness twice. */
  | "custody_same_person"
  /** The holder or a witness is not an active member of staff. */
  | "custody_witness_unknown"
  /** A narcotic-cabinet item taken into an open store. */
  | "controlled_outside_custody"
  /** Anything but a narcotic-cabinet item taken into the cabinet, which is reserved for them (r.65(12)). */
  | "not_a_controlled_item"
  /** A balance check or a cabinet act out of shape: not the cabinet, a batch missing from the count, a count below zero. */
  | "controlled_check_invalid";

/**
 * 404 for a thing that is not there, 409 for a state conflict the caller can act on.
 * NOTHING here answers 5xx, which is the property the two counter-side lessons above are about.
 */
/**
 * CLOSE REVIEW m8 — **`unknown_uom` is NOT in this set, despite the prefix.** Every other
 * `unknown_*` names a ROW the caller addressed and the server could not find, which is what 404
 * means. `unknown_uom` is raised when the REQUEST BODY carries a unit the item does not declare, or
 * an MRP with no unit — the item was found, and answering 404 tells the
 * caller the opposite of what happened. It is a 409 with the rest of the validation conflicts.
 */
const NOT_FOUND_CODES = new Set<MaterialsErrorCode>([
  "unknown_item", "unknown_vendor", "unknown_store", "unknown_batch",
  "unknown_document", "unknown_count", "unknown_adjustment", "unknown_purchase_order",
  "unknown_supplier_bill", "unknown_payment_run",
  "unknown_supplier_return", "unknown_write_off", "unknown_recall",
]);

export function materialsHttpStatus(code: MaterialsErrorCode): number {
  // 14c: the act's own grant check answers as the route guard would.
  if (code === "permission_denied") return 403;
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
