/**
 * PLAN 13 T2 — the resource registry's error vocabulary.
 *
 * ═══ THE UNION IS CLOSED FOR THE WHOLE OF PLAN 13, ON PURPOSE ═══
 *
 * `errors.ts` is named in T2's Files list and in NO other task's, while T3, T4 and T5 all modify
 * `index.ts` and add the write surface, the read surface and the controller. So every refusal this
 * phase can make is spelled here, ahead of its caller — the `formulary/errors.ts` and
 * `membership` precedent, and the same rule follows from it: **a later task that needs a code this
 * union does not carry has found a PLAN DEFECT and reports it.** It does not widen the union and it
 * does not borrow a neighbouring code, because a refusal that answers `unknown_kind` when the kind
 * is fine and the STATUS is wrong is the kind of thing an operator chases for an hour.
 *
 * `duplicate_kind` is ADDED to the plan's own list of nine, and it is a correction rather than a
 * widening: § 5's T2 names `collectResourceKinds`' duplicate-kind refusal in as many words and then
 * lists nine codes that do not include one for it. Answering `unknown_kind` for a kind that is
 * declared TWICE would be precisely backwards. Recorded here rather than fixed silently, because
 * the union's closure is what the later tasks rely on.
 *
 * ═══ `resourceHttpStatus` IS EXPORTED BECAUSE PLAN 09 SHIPPED THE BUG THAT PROVES IT MATTERS ═══
 *
 * A `MembershipError` escaped `billing.controller.ts`'s `toHttp`, which had a clause for every
 * other module's error and none for that one, so a correct refusal reached a busy counter as a 500.
 * The mapper lives beside the codes and is exported so every controller that can receive one of
 * these maps it from the SAME table rather than a private copy (§2.54).
 */
export type ResourceErrorCode =
  /** The kind is not one this hospital has — no INSTALLED manifest declares it (A4). */
  | "unknown_kind"
  /** Two manifests declared one kind. A BOOT error, never a request error. */
  | "duplicate_kind"
  /** The status is not in this kind's declared vocabulary — or a declaration named one outside its own. */
  | "unknown_status"
  /** No resource with that id. */
  | "unknown_resource"
  /** `(site_id, kind, lower(code))` is taken (DD13). */
  | "duplicate_code"
  /** The move would make a resource its own ancestor, at any depth (A1). */
  | "cycle"
  /** The move or the create would put a resource deeper than `MAX_RESOURCE_DEPTH` (A5). */
  | "too_deep"
  /** This kind declares `occupied: null` — a floor is not assignable (DD4). */
  | "not_assignable"
  /** Something is already in it (A2). */
  | "already_occupied"
  /** Nothing is in it, so there is nothing to release (A2). */
  | "not_occupied";

const NOT_FOUND_CODES = new Set<ResourceErrorCode>(["unknown_resource"]);

/**
 * 404 for a thing that is not there, 400 for a request that could never be right whatever the
 * database holds, 409 for a state conflict the caller can act on.
 *
 * **NOTHING here answers 5xx**, which is the property the counter-side lesson above is about.
 * `duplicate_kind` and a declaration-level `unknown_status` cannot reach a controller at all — they
 * are thrown at boot — so their row in this table is the one that never fires; it is present
 * because a mapper with a hole is a 500 waiting for the day somebody moves the throw.
 */
export function resourceHttpStatus(code: ResourceErrorCode): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (code === "unknown_kind" || code === "unknown_status" || code === "duplicate_kind") return 400;
  return 409;
}

export class ResourceError extends Error {
  constructor(
    readonly code: ResourceErrorCode,
    message?: string,
    /** Carried to the response body — e.g. the ancestor chain a `cycle` refusal walked. */
    readonly detail?: unknown,
  ) {
    super(message ?? code);
    this.name = "ResourceError";
  }
}
