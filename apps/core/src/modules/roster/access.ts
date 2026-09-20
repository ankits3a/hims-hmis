import { hasPermission } from "../../kernel/auth/permissions";
import { RosterError } from "./errors";
import { rosterActPolicy } from "./policy";
import type { RosterAct, RosterVia } from "./policy";
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

  if (!held) {
    throw new RosterError("not_permitted", undefined, { permission, act, departmentId: departmentId ?? null });
  }
}
