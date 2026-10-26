import { hasPermission } from "../../kernel/auth/permissions";
import { CanteenRefusal } from "./errors";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/** The door's permission, re-checked inside every intent (a system actor — the worker — passes). */
export async function holds(db: Db | Tx, actor: Actor, permission: string): Promise<boolean> {
  if (actor.type === "system") return true;
  return hasPermission(db as Db, actor.id, permission, "hospital");
}

/** Refuses unless the actor holds one of `permissions`. */
export async function requireAny(db: Db | Tx, actor: Actor, ...permissions: string[]): Promise<void> {
  for (const p of permissions) if (await holds(db, actor, p)) return;
  throw new CanteenRefusal("not_permitted", { permissions });
}
