import { sql } from "drizzle-orm";
import { hasPermission } from "../../kernel/auth/permissions";
import { RosterError } from "./errors";
import { rosterActPolicy } from "./policy";
import { delegationsInForce } from "./delegations-read";
import type { RosterAct, RosterVia } from "./policy";
import type { RosterAuthority } from "../../kernel/db/schema/roster";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

export { ROSTER_MANAGE, ROSTER_PUBLISH, ROSTER_READ, ROSTER_PERMISSIONS } from "./policy";
export type { RosterPermission } from "./policy";

/**
 * PHASE R (R1) — the two halves of "may you", in the order they are asked.
 *
 * 1. **`rosterActPolicy`** — may this KIND of actor ever do this? Pure, and it is where `never`
 *    lives (V8).
 * 2. **this function** — does this actor HOLD the grant, at the scope the act names?
 *
 * ═══ THE SCOPE IS THE DEPARTMENT, AND THIS IS THE S1 FIX ARRIVING IN ACCESS CONTROL ═══
 *
 * Plan 20 T1 asked `hasPermission(..., "hospital")` for every act. That is the same conflation the
 * resolver had: it means the senior resident who may publish Orthopaedics' October may publish
 * Medicine's, because the only scope anybody was ever checked at was the building. Every act that
 * names a department is checked AT that department.
 *
 * **There is no second, "hospital fallback" call, and there must not be.** `hasPermission` already
 * returns true for a HOSPITAL-scoped holding whatever scope the caller asks for
 * (`kernel/auth/permissions.ts`: `if (h.scopeType === "hospital") return true`). The medical
 * superintendent holds the roster strings at hospital scope and therefore passes a department-scoped
 * check without anything special being written here. A second call would be dead code that looked
 * load-bearing — and the next person to read it would widen it.
 *
 * An act that names NO department (the hospital's own roster, the master lists) is checked at
 * `hospital`, which a department-scoped holding does NOT satisfy. That asymmetry is the point.
 */
export type RosterScope = { readonly departmentId?: string };

export async function requireRosterAct(
  exec: Db | Tx,
  actor: Actor,
  act: RosterAct,
  scope: RosterScope = {},
  via: RosterVia = "direct",
): Promise<void> {
  // Throws `act_not_available_to_actor` for a cell the matrix marks `never`. First, always: a
  // machine asking to publish must be told it is the wrong kind of thing, not that it lacks a grant.
  const { permission } = rosterActPolicy(actor, act, via);
  if (permission === null) return; // a named `system` job reading or drafting its own proposal

  const { departmentId } = scope;
  const held = departmentId === undefined
    ? await hasPermission(exec as Db, actor.id, permission, "hospital")
    : await hasPermission(exec as Db, actor.id, permission, "department", { departmentId });

  if (held) return;

  // Not held outright — but somebody may have handed this authority over while they are away.
  if (await heldByDelegation(exec, actor.id, act, departmentId)) return;

  throw new RosterError("not_permitted", undefined, { permission, act, departmentId: departmentId ?? null });
}

/**
 * ═══ PHASE R (R3) — THE DELEGATION PATH, AND WHY IT IS NARROW ═══
 *
 * A delegation moves ONE authority. The map below says which acts each authority can satisfy, and
 * it is deliberately not "a delegation of anything grants `roster.periods.publish`" — all six
 * authorities happen to be gated on that one string today, so the loose version would let a HOD who
 * delegated **leave approval** find their deputy publishing October's roster. The act is what is
 * checked, not the string it happens to share.
 *
 * Three further narrowings, each one a hole this would otherwise have:
 *
 *   · it runs only AFTER the ordinary check fails, so the common path costs nothing;
 *   · it runs only after `rosterActPolicy` has already passed, so **no delegation ever makes a
 *     machine into a person** — the matrix's `never` column is about what kind of thing an actor
 *     is, and a delegation is about what a person may do;
 *   · a `department`-scoped delegation satisfies only that department, and an act naming no
 *     department needs a `hospital`-scoped one — the same asymmetry `hasPermission` has.
 */
const ACT_AUTHORITIES: Partial<Record<RosterAct, readonly RosterAuthority[]>> = {
  publish: ["publish"],
  accept_warning: ["override_rule"],
  declare: ["declare_holiday", "declare_mode"],
};

async function heldByDelegation(
  exec: Db | Tx, userId: string, act: RosterAct, departmentId: string | undefined,
): Promise<boolean> {
  const authorities = ACT_AUTHORITIES[act];
  if (authorities === undefined) return false;

  // The database's clock, for the same reason every other instant in this module comes from it.
  const r = await (exec as Db).execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  const at = raw instanceof Date ? raw : new Date(String(raw));

  const live = await delegationsInForce(exec, userId, at);
  return live.some((d) => {
    if (!authorities.includes(d.authority as RosterAuthority)) return false;
    if (d.scopeType === "hospital") return true;
    if (departmentId === undefined) return false;
    return d.scopeType === "department" && d.scopeId === departmentId;
  });
}
