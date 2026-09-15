import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";
import { hasPermission } from "../auth/permissions";
import { addDays } from "./rollup";
import { DeskError } from "./types";

/**
 * PHASE STAFF-REPORTS T0 — HOW FAR BACK A PERSON MAY LOOK, owner ruling 2026-09-14.
 *
 * | tier  | reaches back | who                                                        |
 * |-------|--------------|------------------------------------------------------------|
 * | floor | 3 months     | `front_office` — and everyone else, by holding neither string |
 * | year  | 1 year       | `front_office_supervisor`                                   |
 * | full  | unbounded    | `medical_superintendent`, `staff_auditor`, `owner`          |
 *
 * ═══ A PERMISSION, NOT A `Record<roleKey, horizon>` ═══
 *
 * The obvious design is a map from role to cap. It is also the one that breaks the first time
 * somebody holds two roles, and `types.ts` says in its own header that they do: *"Roles combine —
 * the counter clerk this work began with holds registration, appointments and billing at once."* A
 * role map needs a `max()` across the caller's holdings, and it will be written without one,
 * because the person writing it has a single role in mind. Two permission strings union for free:
 * hold more, see more, with no arithmetic to get wrong.
 *
 * It also means the owner moves a person between tiers with a GRANT instead of a release, and
 * `grantPermissionToRole` refuses any string no manifest declares — so a typo is a loud failure at
 * seed time rather than a permission nobody can hold.
 *
 * ═══ THE TIERS ARE A LATTICE ═══
 *
 * `.full` implies `.year` implies the floor. Nobody has to hold both, and holding both is harmless.
 *
 * ═══ COMPUTED FROM THE CALLER, NEVER THE SUBJECT ═══
 *
 * A supervisor reading a clerk's brief is bound by the SUPERVISOR's tier. This is the same split
 * `DeskProviderCtx` draws between `actor` (whose rows) and `reader` (whose visibility), for the same
 * reason: collapse them and the reader inherits the subject's clearance.
 */
export const HISTORY_YEAR = "staff.reports.history.year";
export const HISTORY_FULL = "staff.reports.history.full";

/** The floor is three months — the span `quarter` already means, so a capped caller keeps that period whole. */
export const FLOOR_DAYS = 91;
export const YEAR_DAYS = 365;

/** `oldestDay === null` is unbounded. `capDays` is carried so a refusal can say what the cap IS. */
export type Horizon = { oldestDay: string | null; capDays: number | null };

/** The pure half: what the two booleans mean. Separated so the lattice is testable without a database. */
export function capDaysFor(holds: { year: boolean; full: boolean }): number | null {
  if (holds.full) return null;
  return holds.year ? YEAR_DAYS : FLOOR_DAYS;
}

export function horizonFrom(capDays: number | null, today: string): Horizon {
  return { oldestDay: capDays === null ? null : addDays(today, -(capDays - 1)), capDays };
}

/**
 * A NON-USER ACTOR GETS THE FLOOR. An agent or a system caller holds no role assignments, so
 * `hasPermission` would answer false twice and land on the floor anyway — but saying so here means
 * the answer does not depend on that staying true. The restrictive default is the safe one.
 *
 * `.full` is checked first so the common unbounded caller costs one round of queries, not two.
 */
export async function horizonFor(db: Db, actor: Actor, today: string): Promise<Horizon> {
  if (actor.type !== "user") return horizonFrom(FLOOR_DAYS, today);
  const full = await hasPermission(db, actor.id, HISTORY_FULL, "hospital");
  if (full) return horizonFrom(null, today);
  const year = await hasPermission(db, actor.id, HISTORY_YEAR, "hospital");
  return horizonFrom(capDaysFor({ year, full: false }), today);
}

/**
 * ═══ IT REFUSES. IT DOES NOT TRUNCATE AND IT DOES NOT RETURN EMPTY ═══
 *
 * The cheap implementations are to clamp the window to the horizon, or to return the brief with no
 * days in it. Both are worse than a refusal and worse in the same way: they produce a NUMBER that
 * looks right.
 *
 * An empty brief reads as *"this person did nothing"* — which `requireSubject`'s own comment calls
 * the one answer a supervisor must never be given by accident, because it is indistinguishable from
 * a person who did nothing. A silently clamped window is worse still: it answers a question the
 * caller did not ask, in the shape of the one they did.
 *
 * `deskHttpStatus` sends this as a 400, which is its rule for "the caller asked for something the
 * system will not do" — not a 403, because the caller MAY read this report; they may not read this
 * far back, and the message says so.
 */
export function assertWithinHorizon(oldestDay: string, horizon: Horizon): void {
  if (horizon.oldestDay === null || oldestDay >= horizon.oldestDay) return;
  throw new DeskError(
    "history_horizon_exceeded",
    `that reaches back to ${oldestDay}; your history reaches ${String(horizon.capDays)} days, to ${horizon.oldestDay}`,
  );
}
