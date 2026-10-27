import { newId } from "@hmis/contracts";
import { setPin } from "../../src/kernel/auth/identity";
import { authManifest } from "../../src/kernel/auth/manifest";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { withTx } from "../../src/kernel/db/client";
import { aerbPersons } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../src/kernel/resources";
import { linenManifest, seedLinenItems } from "../../src/modules/linen";
import { ensureRole, mkUser } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";

/**
 * E2.4 LINEN — a small hospital for the linen tests: the standard catalogue and one floor with three wards.
 *   · General ward (`generalWard`): 10 general beds straight under the ward, plus one RETIRED bed (never counted).
 *   · Private wing (`mixedWard`): a room of 4 private beds and a room of 2 ICU beds (class on each bed).
 *   · ICU (`icuWard`): class `icu` on the WARD and 3 beds without a class of their own (they inherit it).
 * No clock is read here: every instant is the caller's.
 */
export const H1 = "01LINENHANDLER00000000000H1";
export const SUPA = "01LINENSUPERVISOR000000SA";
export const SUPB = "01LINENSUPERVISOR000000SB";
export const actorOf = (id: string): Actor => ({ type: "user", id });
const SEEDER: Actor = { type: "system", id: "linen-fixture" };

export type LinenHospital = { floorId: string; generalWard: string; mixedWard: string; icuWard: string; aGeneralBed: string };

export const hoursFrom = (t0: Date, h: number): Date => new Date(t0.getTime() + h * 3_600_000);

export async function seedLinenHospital(db: Db): Promise<LinenHospital> {
  await seedLinenItems(db);
  return withTx(db, async (tx) => {
    const mk = async (kind: string, code: string, name: string, parentId?: string, attributes?: Record<string, unknown>, status?: string) =>
      (await createResource(tx, SEEDER, KERNEL_RESOURCE_KINDS, {
        kind: kind as "bed", code, name, ...(parentId === undefined ? {} : { parentId }),
        ...(attributes === undefined ? {} : { attributes }), ...(status === undefined ? {} : { status }),
      })).resourceId;
    const floorId = await mk("floor", "LF3", "Floor 3");
    const generalWard = await mk("ward", "LW-GEN", "General ward", floorId);
    let aGeneralBed = "";
    for (let i = 1; i <= 10; i += 1) {
      const id = await mk("bed", `LG-${i}`, `General bed ${i}`, generalWard, { class: "general" });
      if (i === 1) aGeneralBed = id;
    }
    await mk("bed", "LG-X", "Old bed", generalWard, { class: "general" }, "retired");
    const mixedWard = await mk("ward", "LW-MIX", "Private wing", floorId);
    const pvtRoom = await mk("room", "LR-PVT", "Private rooms", mixedWard);
    for (let i = 1; i <= 4; i += 1) await mk("bed", `LP-${i}`, `Private bed ${i}`, pvtRoom, { class: "private" });
    const icuRoom = await mk("room", "LR-ICU", "Step-down ICU", mixedWard);
    for (let i = 1; i <= 2; i += 1) await mk("bed", `LI-${i}`, `ICU bed ${i}`, icuRoom, { class: "icu" });
    const icuWard = await mk("ward", "LW-ICU", "Medical ICU", floorId, { class: "icu" });
    for (let i = 1; i <= 3; i += 1) await mk("bed", `LM-${i}`, `MICU bed ${i}`, icuWard);
    return { floorId, generalWard, mixedWard, icuWard, aGeneralBed };
  });
}

/**
 * LD-1 (#978, decision 0087) — the people of the laundry floor, as real users (a signature is a PIN, checked against
 * the user record): a runner, a ward nurse who signs pickups, a second nurse who places and releases holds, the
 * laundry operator, a QC checker and a supervisor (four eyes on a condemn), a CSSD nurse who signs for theatre sets,
 * and the hospital's RSO (an open-ended AERB appointment from a date long past — no date of today is pinned).
 * `theatre` is a ward-kind place for the main theatre complex; `babyWard` holds baby linen.
 */
export type LinenStaff = {
  runner: Actor; nurse: Actor; nurseInCharge: Actor; operator: Actor; qc: Actor; supervisor: Actor; cssd: Actor; rso: Actor;
  nursePin: string; cssdPin: string; theatre: string; babyWard: string;
};

export async function mkLinenStaff(db: Db, h: LinenHospital): Promise<LinenStaff> {
  const registry = new ModuleRegistry();
  for (const m of [authManifest, linenManifest]) registry.install(m);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    t_linen_runner: ["linen.handle"],
    t_linen_nurse: ["linen.handle"],
    t_linen_incharge: ["linen.handle", "linen.hold.release"],
    t_linen_plant: ["linen.handle", "linen.plant", "linen.qc"],
    t_linen_sup: ["linen.view", "linen.manage", "linen.plant", "linen.qc"],
    t_linen_cssd: ["linen.cssd_receive"],
    t_linen_rso: ["linen.hold.release"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const user = async (name: string, role: string): Promise<Actor> => (await mkUser(db, name, [role])).actor;
  const runner = await user("ln.runner", "t_linen_runner");
  const nurse = await user("ln.nurse", "t_linen_nurse");
  const nurseInCharge = await user("ln.incharge", "t_linen_incharge");
  const operator = await user("ln.operator", "t_linen_plant");
  const qc = await user("ln.qc", "t_linen_plant");
  const supervisor = await user("ln.sup", "t_linen_sup");
  const cssd = await user("ln.cssd", "t_linen_cssd");
  const rso = await user("ln.rso", "t_linen_rso");
  const nursePin = "2468";
  const cssdPin = "1357";
  await setPin(db, nurse.id, nursePin);
  await setPin(db, cssd.id, cssdPin);
  await setPin(db, runner.id, "9753");
  await db.insert(aerbPersons).values({
    id: newId(), userId: rso.id, personRole: "rso", qualification: "RSO Level-2", validFrom: "2000-01-01", createdBy: rso.id,
  });
  const { theatre, babyWard } = await withTx(db, async (tx) => {
    const mk = async (code: string, name: string) =>
      (await createResource(tx, SEEDER, KERNEL_RESOURCE_KINDS, { kind: "ward", code, name, parentId: h.floorId })).resourceId;
    return { theatre: await mk("LW-OT", "Main theatre"), babyWard: await mk("LW-NB", "Newborn ward") };
  });
  return { runner, nurse, nurseInCharge, operator, qc, supervisor, cssd, rso, nursePin, cssdPin, theatre, babyWard };
}

/**
 * LD-2 (#979, decisions 0087 and 0092) — the vendor dock and the money: the laundry desk (challans, returns, rate cards,
 * bills, uniforms, tags, licences), the owner and finance (approve a recovery; never their own), and stores (approve a
 * bill's excess over the accepted pieces).
 */
export type VendorDesk = { desk: Actor; owner: Actor; finance: Actor; stores: Actor };

export async function mkVendorDesk(db: Db): Promise<VendorDesk> {
  const registry = new ModuleRegistry();
  for (const m of [authManifest, linenManifest]) registry.install(m);
  await syncPermissions(db, registry);
  const grants: Record<string, string[]> = {
    t_linen_desk: ["linen.view", "linen.handle", "linen.plant", "linen.vendor", "linen.uniform"],
    t_linen_owner: ["linen.view", "linen.vendor", "linen.recovery.approve"],
    t_linen_finance: ["linen.view", "linen.recovery.approve"],
    t_linen_stores: ["linen.view", "linen.bill.approve"],
  };
  for (const [role, perms] of Object.entries(grants)) {
    await ensureRole(db, role);
    for (const p of perms) await grantPermissionToRole(db, registry, role, p);
  }
  const user = async (name: string, role: string): Promise<Actor> => (await mkUser(db, name, [role])).actor;
  return {
    desk: await user("ln.desk", "t_linen_desk"),
    owner: await user("ln.owner", "t_linen_owner"),
    finance: await user("ln.finance", "t_linen_finance"),
    stores: await user("ln.stores", "t_linen_stores"),
  };
}
