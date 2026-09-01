import { newId } from "@hmis/contracts";
import { patients, registrationConfig, resources } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { withTx } from "../../src/kernel/db/client";
import { addMachine, addPerson, createRegistration } from "../../src/modules/pcpndt";
import { ensureRole, mkUser } from "./opd";
import type { Db } from "../../src/kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * ═══ THE SHARED PCPNDT FIXTURE (18a T6) ═══
 *
 * Four suites need the same precondition — a patient, a device, the five permissions synced, an
 * in-charge and a sonologist who between them hold `write` and `verify` but NEVER both, and a live
 * §19 registration with one machine and one registered person on it.
 *
 * **DISCLOSED: this file is in no task's Files list** (the F23 pattern, second instance). Building
 * it four times would be four chances to build it slightly differently, and a Form F test that
 * fails because its fixture drifted teaches nothing.
 *
 * ═══ IT INSERTS THE DEVICE ROW DIRECTLY RATHER THAN CALLING `createResource` ═══
 *
 * `createResource` needs a resource-kind declaration, and the only one carrying `device` is
 * RADIOLOGY's. Importing it here would make the statutory register's own tests depend on a
 * department — which is precisely the coupling DD1 exists to prevent and the property 15b and 62
 * are promised. The row is a kernel table, so a direct insert bends no rule.
 */
export type PcpndtFixture = {
  /** Holds `registrations.manage`, `form_f.verify`, `form_f.read`. NEVER `form_f.write` (DD14). */
  incharge: Actor;
  /** Holds `form_f.write` and `form_f.read`, and is a REGISTERED PERSON on the registration. */
  sonologist: Actor;
  /** Holds every read permission but is registered NOWHERE — A2's negative. */
  outsider: Actor;
  patientId: string;
  deviceResourceId: string;
  /** A second device, deliberately NOT on any registration — A2's machine negative. */
  unregisteredDeviceId: string;
  registrationId: string;
  machineId: string;
  personId: string;
};

export const PCPNDT_PERMISSIONS = [
  "pcpndt.registrations.manage", "pcpndt.registrations.read",
  "pcpndt.form_f.write", "pcpndt.form_f.read", "pcpndt.form_f.verify",
] as const;

/** A device row of kind `device`, which is all the register needs to know about a machine. */
export async function mkDevice(db: Db, code: string): Promise<string> {
  const id = newId();
  await db.insert(resources).values({
    id, kind: "device", code, name: `${code} machine`, status: "available",
    attributes: { modality: "usg" }, createdBy: "t", updatedBy: "t",
  });
  return id;
}

export async function setupPcpndtFixture(
  db: Db,
  opts: { validFrom?: string; validTo?: string } = {},
): Promise<PcpndtFixture> {
  await db.insert(registrationConfig)
    .values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();

  const patientId = "01PATIENT0000000000000001";
  await db.insert(patients).values({
    id: patientId, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female",
    administrativeGender: "female", dob: new Date(Date.UTC(1996, 0, 1)),
    createdBy: "t", updatedBy: "t",
  });

  const deviceResourceId = await mkDevice(db, "USG-1");
  const unregisteredDeviceId = await mkDevice(db, "USG-2");

  const registry = new ModuleRegistry();
  registry.install({
    key: "pcpndt", title: "PCPNDT", menu: [], permissions: [...PCPNDT_PERMISSIONS], subscriptions: [],
  });
  await syncPermissions(db, registry);
  for (const role of ["pcpndt_incharge", "radiologist", "radiographer"]) await ensureRole(db, role);

  /**
   * DD14's separation, expressed as grants rather than asserted in prose: the in-charge VERIFIES
   * and the sonologist WRITES, and no role here holds both. `verifyFormF` refuses `same_actor` on
   * top of this, because a temporary grant could otherwise put both in one pair of hands.
   */
  for (const p of ["pcpndt.registrations.manage", "pcpndt.registrations.read", "pcpndt.form_f.verify", "pcpndt.form_f.read"]) {
    await grantPermissionToRole(db, registry, "pcpndt_incharge", p);
  }
  for (const p of ["pcpndt.form_f.write", "pcpndt.form_f.read"]) {
    await grantPermissionToRole(db, registry, "radiologist", p);
  }
  await grantPermissionToRole(db, registry, "radiographer", "pcpndt.form_f.read");

  const { actor: incharge } = await mkUser(db, "dr.incharge", ["pcpndt_incharge"]);
  const { actor: sonologist } = await mkUser(db, "dr.sono", ["radiologist"]);
  const { actor: outsider } = await mkUser(db, "dr.outsider", ["radiologist"]);

  const { registrationId } = await withTx(db, (tx) => createRegistration(tx, incharge, {
    site: "Main hospital",
    registrationNo: "PNDT/MH/2026/0001",
    validFrom: opts.validFrom ?? "2026-01-01",
    validTo: opts.validTo ?? "2027-12-31",
    inchargeUserId: incharge.id,
  }));
  const { machineId } = await withTx(db, (tx) => addMachine(tx, incharge, {
    registrationId, deviceResourceId, make: "GE", model: "Voluson S10", serial: "SN-99001",
    formBRef: "FORMB/2026/7",
  }));
  const { personId } = await withTx(db, (tx) => addPerson(tx, incharge, {
    registrationId, userId: sonologist.id, qualification: "MD Radiodiagnosis", councilRegNo: "MCI-44221",
  }));

  return {
    incharge, sonologist, outsider, patientId, deviceResourceId, unregisteredDeviceId,
    registrationId, machineId, personId,
  };
}
