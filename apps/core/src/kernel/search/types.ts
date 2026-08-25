import type { Actor, SearchEntity, SearchHit, SearchQuery } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * PLAN 11h T1 / DD1 — A SEARCH PROVIDER IS DECLARED ON THE §4 MANIFEST, NEVER IMPORTED.
 *
 * The manifest is already where a module declares its permissions and its menu, and
 * `syncPermissions` already walks `registry.all()` at boot. Search rides that same seam, which
 * buys three properties nothing else would have given for free:
 *
 *   1. The cross-module isolation lint stays satisfied — modules REGISTER into the kernel, and no
 *      module ever imports another's query code.
 *   2. `permission` is DECLARED, so the fan-out can decide whether a provider may run BEFORE it
 *      runs. A provider that checks permission inside `run` is a defect: by then the query has
 *      already been issued and the decision is no longer auditable from the declaration.
 *   3. A stage-2 module (procurement, pharmacy, LIMS…) adds ONE ARRAY ENTRY instead of a screen.
 */
export type SearchProvider = {
  /** Stable `<module>.<entity>` key. Appears in the response and in T5's audit row. */
  key: string;
  entity: SearchEntity;
  /**
   * The permission the caller must hold AT HOSPITAL SCOPE for this provider to run at all.
   * It must be a string some manifest declares — `assertProvidersDeclared` refuses anything else,
   * the same way `grantPermissionToRole` refuses an undeclared permission (Plan 02).
   */
  permission: string;
  run(ctx: SearchProviderCtx): Promise<SearchProviderResult>;
};

export type SearchProviderResult = {
  hits: SearchHit[];
  /**
   * What the provider would have returned uncapped. It must be counted by the SAME query that
   * produced the hits — a total computed without the RBAC predicate is how a sealed record leaks
   * as an integer (DD3).
   */
  total: number;
};

export type SearchProviderCtx = {
  db: Db;
  actor: Actor;
  query: SearchQuery;
  limit: number;
  /**
   * Aborted when the provider outruns its budget.
   *
   * BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT DO: the fan-out stops WAITING on a slow provider,
   * it does not cancel the provider's database round-trip — drizzle exposes no cancel seam, and
   * `pg` would need the query's own connection. The signal is here so a provider that CAN honour
   * it (an HTTP call, a loop over batches) does, and so the contract is stated rather than
   * discovered. The real defence is that every provider is cheap by construction: indexed
   * predicates and a hard cap.
   */
  signal: AbortSignal;
  /**
   * The clock, as a PARAMETER (Global Constraint 11). A provider that reads the wall clock inside a
   * branch cannot be tested against a fixed day, and the OPD provider's default window is exactly
   * that kind of branch.
   */
  now?: Date;
};

export class SearchError extends Error {
  constructor(
    readonly code: "user_actor_required" | "undeclared_permission" | "duplicate_provider",
    message: string,
  ) {
    super(message);
    this.name = "SearchError";
  }
}
