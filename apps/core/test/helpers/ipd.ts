import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { ensureRole, mkPatient, mkUser, seedOpdBase } from "./opd";
import { ipdManifest } from "../../src/modules/ipd";
import { patientsManifest } from "../../src/modules/patients";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../src/kernel/resources";
import { withTx } from "../../src/kernel/db/client";
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

// ═══ E1.1 — a small hospital for the bed intents: one floor, one ward, a twin room and flagged beds ═══

const IPD_BED_DEFAULTS = {
  class: "general", genderRule: "any", isolation: "none", negativePressure: false, icu: false,
  equipment: [], daycare: false, overflow: false,
} as const;

export type BedWorld = {
  desk: Actor; dutyManager: Actor; cleaner: Actor; viewer: Actor; nobody: Actor;
  floorId: string; wardId: string; roomId: string;
  bed(code: string, attrs?: Partial<Record<keyof typeof IPD_BED_DEFAULTS, unknown>>, parent?: "ward" | "room"): Promise<string>;
  patient(sex: "male" | "female" | "other", ageYears?: number, name?: string): Promise<string>;
};

/**
 * Users: `desk` holds view+manage (front office), `dutyManager` all four, `cleaner` view+clean, `viewer` view only,
 * `nobody` none. Places: F-T floor → F-T-W ward → F-T-R twin room; beds made on demand.
 */
export async function mkBedWorld(db: Db): Promise<BedWorld> {
  await seedOpdBase(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    t_bed_desk: ["ipd.beds.view", "ipd.beds.manage"],
    t_bed_duty: ["ipd.beds.view", "ipd.beds.manage", "ipd.beds.clean", "ipd.beds.overflow"],
    t_bed_clean: ["ipd.beds.view", "ipd.beds.clean"],
    t_bed_view: ["ipd.beds.view"],
    t_bed_none: [],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const user = async (name: string, role: string): Promise<Actor> => (await mkUser(db, name, [role])).actor;
  const desk = await user("bed.desk", "t_bed_desk");
  const dutyManager = await user("bed.duty", "t_bed_duty");
  const cleaner = await user("bed.clean", "t_bed_clean");
  const viewer = await user("bed.view", "t_bed_view");
  const nobody = await user("bed.none", "t_bed_none");
  const SETUP: Actor = { type: "system", id: "test-bed-world" };
  const place = (kind: string, code: string, parentId: string | null, attributes?: Record<string, unknown>) =>
    withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, { kind, code, name: code, parentId, ...(attributes ? { attributes } : {}) }))
      .then((r) => r.resourceId);
  const floorId = await place("floor", "F-T", null);
  const wardId = await place("ward", "F-T-W", floorId, { department: "MED", unitType: "WARD", wardType: "ward" });
  const roomId = await place("room", "F-T-R", wardId);
  let n = 0;
  return {
    desk, dutyManager, cleaner, viewer, nobody, floorId, wardId, roomId,
    bed: (code, attrs = {}, parent = "ward") => place("bed", code, parent === "room" ? roomId : wardId, { ...IPD_BED_DEFAULTS, ...attrs }),
    patient: async (sex, ageYears = 40, name) => {
      n += 1;
      const phone = `98765${String(43210 + n).padStart(5, "0")}`;
      const guardian = ageYears < 18 ? { guardian: { name: "Test Guardian", relationship: "mother" as const, phone } } : {};
      return (await mkPatient(db, desk, { name: name ?? `Test Patient ${String(n)}`, sex, ageYears, phone, ...guardian })).id;
    },
  };
}
