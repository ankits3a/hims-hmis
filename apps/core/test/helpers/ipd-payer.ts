import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { ipdManifest } from "../../src/modules/ipd";
import { patientsManifest } from "../../src/modules/patients";
import { ensureRole, mkUser } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";

/**
 * E2.2 (#726) — the billing manager's TPA seat for the payer-split suites: the authorisation record (`ipd.payer.manage`),
 * its money terms and the non-payables list (`ipd.payer.terms`), the interim bill, and reading a patient's coverages.
 */
export async function mkTpaDesk(db: Db, username = "tpa.desk"): Promise<Actor> {
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  await ensureRole(db, "t_tpa_desk");
  const declared = new Set(registry.allPermissions());
  for (const p of ["ipd.payer.manage", "ipd.payer.terms", "ipd.bill.view", "patients.read"]) {
    if (declared.has(p)) await grantPermissionToRole(db, registry, "t_tpa_desk", p);
  }
  return (await mkUser(db, username, ["t_tpa_desk"])).actor;
}
