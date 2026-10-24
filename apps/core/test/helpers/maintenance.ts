import { newId } from "@hmis/contracts";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { rosterAssignments, rosterPeriods } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { housekeepingManifest } from "../../src/modules/housekeeping";
import { ipdManifest } from "../../src/modules/ipd";
import { maintenanceManifest } from "../../src/modules/maintenance";
import { patientsManifest } from "../../src/modules/patients";
import { tasksManifest } from "../../src/modules/tasks";
import { mkHousekeepingWorld } from "./housekeeping";
import { ensureRole, mkUser } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { HousekeepingWorld } from "./housekeeping";

/**
 * E1.5 MAINTENANCE — the housekeeping world (beds, cleaners, a services supervisor, the ward-nurse side `w.nurse`
 * holding `ipd.beds.clean`) plus: an engineering technician (`maintenance_staff`) and a biomedical engineer
 * (`biomedical_engineer`), both on a published presence duty around the real clock; a raiser (`maintenance.raise`
 * only); a confirmer holding `maintenance.confirm` only; a maintenance manager. No instant here is a pinned date.
 */
export type MaintenanceWorld = HousekeepingWorld & {
  tech: Actor; bme: Actor; raiser: Actor; confirmer: Actor; manager: Actor;
};

export async function mkMaintenanceWorld(db: Db): Promise<MaintenanceWorld> {
  const w = await mkHousekeepingWorld(db);
  const registry = new ModuleRegistry();
  for (const m of [authManifest, patientsManifest, ipdManifest, tasksManifest, housekeepingManifest, maintenanceManifest]) registry.install(m);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    maintenance_staff: ["tasks.view", "tasks.work", "maintenance.view", "maintenance.work", "maintenance.raise"],
    biomedical_engineer: ["tasks.view", "tasks.work", "maintenance.view", "maintenance.work", "maintenance.raise"],
    t_mt_raise: ["maintenance.raise"],
    t_mt_confirm: ["maintenance.confirm", "maintenance.raise"],
    t_mt_manage: ["maintenance.view", "maintenance.manage", "maintenance.raise"],
    t_bed_duty: ["maintenance.raise"],
    t_bed_clean: ["maintenance.raise"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const tech = (await mkUser(db, "mt.tech", ["maintenance_staff"])).actor;
  const bme = (await mkUser(db, "mt.bme", ["biomedical_engineer"])).actor;
  const raiser = (await mkUser(db, "mt.raise", ["t_mt_raise"])).actor;
  const confirmer = (await mkUser(db, "mt.confirm", ["t_mt_confirm"])).actor;
  const manager = (await mkUser(db, "mt.manage", ["t_mt_manage"])).actor;

  // One published period per department: the housekeeping world's period carries these duties too.
  const period = (await db.select({ id: rosterPeriods.id, departmentId: rosterPeriods.departmentId }).from(rosterPeriods).limit(1))[0]!;
  const periodId = period.id;
  const departmentId = period.departmentId!;
  const now = Date.now();
  for (const a of [tech, bme]) {
    const id = newId();
    await db.insert(rosterAssignments).values({
      id, periodId, userId: a.id, positionKey: "staff_nurse", startsAt: new Date(now - 3_600_000), endsAt: new Date(now + 8 * 3_600_000),
      mode: "presence", kind: "duty", departmentId, coverScope: "department", effective: true, lineageId: id,
      proposedByActorId: manager.id, createdBy: manager.id, updatedBy: manager.id,
    });
  }
  return { ...w, tech, bme, raiser, confirmer, manager };
}
