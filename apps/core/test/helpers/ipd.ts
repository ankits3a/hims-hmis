import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { ensureRole, mkUser } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";

/** A person who may apply a bed layout: holds `auth.users.manage` (see `modules/ipd` `BED_LAYOUT_PERMISSION`). */
export async function mkBedLoader(db: Db, username = "bed.loader"): Promise<Actor> {
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  await syncPermissions(db, registry);
  await ensureRole(db, "bed_layout_loader");
  await grantPermissionToRole(db, registry, "bed_layout_loader", "auth.users.manage");
  return (await mkUser(db, username, ["bed_layout_loader"])).actor;
}
