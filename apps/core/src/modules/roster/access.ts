import { hasPermission } from "../../kernel/auth/permissions";
import { RosterError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

export const ROSTER_MANAGE = "roster.periods.manage";
export const ROSTER_PUBLISH = "roster.periods.publish";
export const ROSTER_READ = "roster.read";

/**
 * Drafting and publishing are TWO strings because they are two people in the building this is for:
 * the unit's senior resident drafts the month, the unit head or the HOD publishes it (phase 20-U
 * §4). Whoever holds both may do both — the split is available, never forced.
 */
export async function requireRosterPermission(
  exec: Db | Tx, actor: Actor, permission: typeof ROSTER_MANAGE | typeof ROSTER_PUBLISH,
): Promise<void> {
  if (actor.type !== "user") {
    throw new RosterError("not_permitted", "only a signed-in member of staff may change a roster — it names who answers for patients");
  }
  if (!(await hasPermission(exec as Db, actor.id, permission, "hospital"))) {
    throw new RosterError("not_permitted", `${actor.id} does not hold ${permission}`, { permission });
  }
}
