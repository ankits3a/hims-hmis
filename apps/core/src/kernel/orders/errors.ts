/**
 * PLAN 17 PHASE 0 T2 — the order envelope's error vocabulary.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF THIS PHASE, ON PURPOSE ═══
 *
 * `errors.ts` is named in T2's Files list and in NO other task's, while T3, T4 and T5 add the
 * placement path, the state machine and the readers. So every refusal this phase can make is
 * spelled here, ahead of its caller — the `kernel/resources/errors.ts` and `formulary/errors.ts`
 * precedent, and the same rule follows from it: **a later task that needs a code this union does
 * not carry has found a PLAN DEFECT and reports it.** It does not widen the union and it does not
 * borrow a neighbouring code, because a refusal that answers `unknown_kind` when the kind is fine
 * and the ACTOR is wrong is the kind of thing an operator chases for an hour.
 *
 * ═══ `orderHttpStatus` IS EXPORTED THOUGH THIS PHASE MOUNTS NO ROUTE ═══
 *
 * Plan 09 shipped the bug that proves this matters: a `MembershipError` escaped
 * `billing.controller.ts`'s `toHttp`, which had a clause for every other module's error and none
 * for that one, so a correct refusal reached a busy counter as a 500. The envelope has no
 * controller in this phase — it has no screen at all — and the mapper is still written HERE, beside
 * the codes, so that the first module to mount an ordering route maps from this table rather than
 * inventing a private copy (§2.54).
 */
export type OrderErrorCode =
  // ─── BOOT refusals: `collectOrderKinds`, never reachable from a request (DD3) ───
  /** Two manifests claim one kind. One kind has one series, one permission and one queue. */
  | "duplicate_kind"
  /** A declaration names a `seriesKey` `EPISODE_SERIES` does not carry — no number could be minted. */
  | "unknown_series"
  /** A declaration's `placePermission` is declared by no manifest — a kind nobody could ever place. */
  | "undeclared_permission"
  // ─── PLACEMENT refusals: `placeOrder` (T3) ───
  /** No INSTALLED manifest claims this kind. A legal string; not a kind THIS hospital has. */
  | "unknown_kind"
  /** DD6 — the LLM narrates and never originates. An `agent` actor may not place an order, ever. */
  | "agent_cannot_order"
  /** DD6 — a `patient` actor on a kind whose declaration is not `selfOrderable`. */
  | "self_order_not_permitted"
  /** DD6 — a `system` actor with no `protocol_ref`. A reflex rule that cannot name itself. */
  | "protocol_ref_required"
  /** DD6 — the kind declares `requiresClinician` and no `ordering_clinician_id` was supplied. */
  | "clinician_required"
  /** DD6 / 18a — the kind declares `requiresIndication` and no indication was supplied. */
  | "indication_required"
  /** The actor holds `orders.place` but not the kind's own `placePermission`, or neither. */
  | "permission_denied"
  /** No registered prefix resolves this encounter number, or its resolver returned nothing. */
  | "unknown_encounter"
  /** The encounter resolves to a DIFFERENT patient than the caller named (E19, 02 A1). */
  | "patient_encounter_mismatch"
  /** An order with no items. There is nothing for a department to do. */
  | "no_items"
  // ─── ADVANCE refusals: `advanceOrderItem` (T4) ───
  /** No item with that id. */
  | "unknown_item"
  /** The four-state table does not admit this edge (DD4). */
  | "illegal_transition"
  /** The compare-and-set matched no row: somebody else moved this item first (E5). */
  | "stale_state"
  /** DD5 — cancelling from `in_progress` without saying why. The CHECK refuses it too. */
  | "cancel_reason_required"
  /** This actor type may not make this move (a `patient` completing their own test; an `agent`). */
  | "actor_cannot_advance";

/** These name a thing that is not there; everything else is a request that could never be right. */
const NOT_FOUND_CODES = new Set<OrderErrorCode>(["unknown_item", "unknown_encounter"]);

/** A state conflict the caller can act on — retry, or tell the user somebody got there first. */
const CONFLICT_CODES = new Set<OrderErrorCode>(["stale_state", "illegal_transition"]);

/** Authorisation, which is 403 and not 400: the request is well-formed and the caller may not. */
const FORBIDDEN_CODES = new Set<OrderErrorCode>([
  "permission_denied", "agent_cannot_order", "self_order_not_permitted", "actor_cannot_advance",
]);

/**
 * **NOTHING here answers 5xx**, which is the property the counter-side lesson above is about. The
 * three BOOT codes cannot reach a controller at all — they are thrown at startup — so their rows in
 * this table never fire; they are present because a mapper with a hole is a 500 waiting for the day
 * somebody moves the throw.
 */
export function orderHttpStatus(code: OrderErrorCode): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (FORBIDDEN_CODES.has(code)) return 403;
  if (CONFLICT_CODES.has(code)) return 409;
  return 400;
}

export class OrderError extends Error {
  constructor(
    readonly code: OrderErrorCode,
    message?: string,
    /** Carried to the response body — e.g. the state the compare-and-set actually found. */
    readonly detail?: unknown,
  ) {
    super(message ?? code);
    this.name = "OrderError";
  }
}
