import { hasPermission } from "../../kernel/auth/permissions";
import { DietRefusal } from "./errors";
import { DIET_MANAGE, DIET_ORDER } from "./names";
import type { Actor, DietSource } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/** The door's permission, re-checked inside every intent (a system actor — the worker — passes). */
export async function holds(db: Db | Tx, actor: Actor, permission: string): Promise<boolean> {
  if (actor.type === "system") return true;
  return hasPermission(db as Db, actor.id, permission, "hospital");
}

export async function requirePermission(db: Db | Tx, actor: Actor, permission: string): Promise<void> {
  if (!(await holds(db, actor, permission))) throw new DietRefusal("forbidden", { permission });
}

/**
 * Provenance by what the person may do, not by a role name: `diet.manage` is the dietician's, `diet.order` without it
 * the doctor's, NPO alone the nurse's. The worker is `system`; an OT booking says so itself.
 */
export async function sourceOf(db: Db | Tx, actor: Actor): Promise<DietSource> {
  if (actor.type === "system") return "system";
  if (await holds(db, actor, DIET_MANAGE)) return "dietician";
  if (await holds(db, actor, DIET_ORDER)) return "doctor";
  return "nurse";
}
