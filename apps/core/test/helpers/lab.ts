import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { withTx } from "../../src/kernel/db/client";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { seedSodPairs } from "../../src/kernel/auth/sod";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { collectOrderKinds } from "../../src/kernel/orders/kinds";
import { ordersManifest } from "../../src/kernel/orders/manifest";
import { ORDERS_PLACE } from "../../src/kernel/orders/place";
import { registerEncounterResolver } from "../../src/kernel/episodes/encounter-resolvers";
import { opdDepartments, opdDoctors, patients, registrationConfig } from "../../src/kernel/db/schema";
import { labManifest } from "../../src/modules/lab/manifest";
import { activateLabDefinitions } from "../../src/modules/lab/definitions";
import { billingManifest } from "../../src/modules/billing/manifest";
import { opdManifest } from "../../src/modules/opd/manifest";
import { patientsManifest } from "../../src/modules/patients/manifest";
import { tariffManifest } from "../../src/modules/tariff/manifest";
import { upsertGstCategory } from "../../src/modules/tariff/gst-config";
import { activateVersion, createDraftVersion, setTariffItem, submitVersion } from "../../src/modules/tariff";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { seedLabCatalogue, serviceIdForLabCode } from "../../scripts/seed-lab-catalogue";
import { seedBillingBase } from "./billing";
import { activateOpdVisitDefinition, ensureRole, mkUser, seedOpdBase } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { OrderKindDecl } from "../../src/kernel/orders/kinds";

/**
 * PLAN 17a T4/T5 — THE LAB FIXTURE EVERY DESK AND ACCESSION SUITE STARTS FROM.
 *
 * ═══ FILES-LIST DEVIATION, DISCLOSED (finding F9) ═══
 *
 * §5 T4 and T5 both say "+ tests" and name no helper. This file exists anyway because BOTH tasks
 * need the same eleven-step fixture — catalogue, tariff, department, pathologist, definitions,
 * permissions — and the alternative is two copies of it that drift by construction (§2.54). It is
 * the `test/helpers/opd.ts` / `test/helpers/billing.ts` precedent, and it is reported rather than
 * smuggled: T4's diff carries a file its Files list does not name.
 *
 * ═══ EVERY ROW IS BUILT THROUGH THE OWNING MODULE'S PUBLIC API ═══
 *
 * The Plan 06 e2e pattern, and `seedBillingBase`'s own rule: never a hand-rolled insert into
 * another module's table. The two exceptions are `opd_departments` and `opd_doctors`, which have no
 * `Tx`-first creator exported from `modules/opd` (their writers are HTTP-only, the Plan 05 pattern)
 * — `seedOpdMasters` in `helpers/opd.ts` inserts them the same way for the same reason.
 */

/** A lab service the tariff deliberately has NO price for — T4 A3's discriminating input. */
export const UNPRICED_LAB_CODE = "TROPI";

export type LabDeskFixture = {
  registry: ModuleRegistry;
  decls: OrderKindDecl[];
  /** `lab_reception` + `pathologist`: the desk half and the clinician half, as one counter login. */
  desk: { id: string; token: string; actor: Actor };
  /** The pathologist of record — an `opd_doctors` row in the `LAB` department (DD15/S2). */
  pathologist: { id: string; token: string; actor: Actor; doctorId: string };
  labDepartmentId: string;
  patientId: string;
  /** A second registration of the same person, MERGED into `patientId` (T3 A6's shape). */
  mergedLoserId: string;
  encounterNo: string;
  serviceDate: string;
  unregister: () => void;
};

const PRICED_LAB_CODES = [
  "CBC", "LFT", "RFT", "LIPID", "HIV", "HBSAG", "TSH", "TFT", "GLUF", "FEVER", "WIDAL", "UPT",
] as const;

/**
 * Everything a desk test needs, in one call. Idempotent per suite: call after `truncateAll`.
 *
 * `PRICED_LAB_CODES` get a tariff item; `UNPRICED_LAB_CODE` deliberately does not, because A3 needs
 * `issueInvoice` to throw INSIDE the savepoint over a real orderable rather than over a fake one —
 * a service id the catalogue does not carry would be refused by the desk's own `unknown_service`
 * gate long before the money path, and would assert nothing about the transaction.
 */
export async function seedLabDeskBase(db: Db, encounterNo = "V2608290001"): Promise<LabDeskFixture> {
  const serviceDate = "2026-08-29";
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
  await seedOpdBase(db);
  await seedSodPairs(db);

  const registry = new ModuleRegistry();
  registry.install(ordersManifest);
  registry.install(patientsManifest);
  registry.install(tariffManifest);
  registry.install(billingManifest);
  registry.install(opdManifest);
  registry.install(labManifest);
  await syncPermissions(db, registry);

  const base = await seedBillingBase(db);

  for (const key of ["lab_reception", "pathologist", "lab_technician", "phlebotomist"]) {
    await ensureRole(db, key);
  }
  /**
   * The four grants the seed script gives these roles, narrowed to what T4 and T5 exercise. They are
   * granted here rather than by running `seed-roles.ts` because that script's 126-permission census
   * is a different test's subject, and a fixture that ran it would fail the day that census moves.
   */
  for (const p of [
    "lab.desk.operate", "lab.orders.place", "lab.catalogue.manage", "lab.catalogue.read",
    "lab.worklist.read", "lab.accession.operate", "lab.collection.operate",
    ORDERS_PLACE, "orders.read", "orders.cancel",
    "billing.invoice.issue", "billing.invoice.read", "billing.credit.extend",
    "billing.receipt.record", "billing.session.own", "patients.read",
  ]) {
    await grantPermissionToRole(db, registry, "lab_reception", p);
    await grantPermissionToRole(db, registry, "pathologist", p);
  }

  const desk = await mkUser(db, "lab.counter", ["lab_reception"]);
  const pathologistUser = await mkUser(db, "dr.iyer", ["pathologist"]);

  const labDepartmentId = newId();
  await db.insert(opdDepartments).values({
    id: labDepartmentId, code: "LAB", name: "Laboratory", active: true, createdBy: "t", updatedBy: "t",
  });
  const labDoctorId = newId();
  await db.insert(opdDoctors).values({
    id: labDoctorId, userId: pathologistUser.id, departmentId: labDepartmentId,
    displayName: "Dr Iyer", registrationNo: "MCI/PATH/9001", active: true, createdBy: "t", updatedBy: "t",
  });

  const patientId = newId();
  const mergedLoserId = newId();
  await db.insert(patients).values([
    { id: patientId, uhid: "HMS-00000101-7", name: "Ram Kumar", sex: "male",
      administrativeGender: "male", createdBy: "t", updatedBy: "t" },
    { id: mergedLoserId, uhid: "HMS-00000102-5", name: "Ram Kumar", sex: "male",
      administrativeGender: "male", status: "merged", mergedIntoPatientId: patientId,
      createdBy: "t", updatedBy: "t" },
  ]);

  const unregister = registerEncounterResolver("V", async (_d, no) =>
    no === encounterNo ? { patientId, intendedPayer: "self" } : null);

  await seedLabCatalogue(db, pathologistUser.actor);

  /**
   * A SECOND tariff version carrying the base three PLUS the lab codes, copied from the base one
   * and activated after it. `investigation` needs its own GST category: `priceInvoiceLines` throws
   * `gst_config_missing` for a category with no row, which is the correct refusal and not one this
   * fixture wants to be asserting by accident.
   */
  await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, {
    category: "investigation", sacCode: "999316", exempt: true, rateBps: 0,
    specialRule: null, thresholdPaise: null,
  }));
  const draft = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, base.drafter, { copyFromVersionId: base.tariffVersionId });
    for (const code of PRICED_LAB_CODES) {
      await setTariffItem(tx, base.drafter, d.versionId, serviceIdForLabCode(code), 30000);
    }
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, base.drafter, draft.versionId));
  await approveRequest(db, base.owner, { approvalId: submitted.approvalId, note: "lab fixture" });
  await activateVersion(db, base.activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));

  await activateLabDefinitions(db, base.activator);
  /**
   * THE OPD VISIT DEFINITION TOO — `openLabWalkin` goes through `openVisitInTx`, which calls
   * `startInstance(OPD_VISIT_DEF_KEY, …)`. Without it every walk-in dies on `no_active_definition`,
   * which is the honest failure and not the one T4 A9 is asserting. Class A, activated exactly as
   * the go-live runbook does it (`helpers/opd.ts`).
   */
  await activateOpdVisitDefinition(db);

  return {
    registry,
    decls: collectOrderKinds(registry),
    desk,
    pathologist: { ...pathologistUser, doctorId: labDoctorId },
    labDepartmentId,
    patientId,
    mergedLoserId,
    encounterNo,
    serviceDate,
    unregister,
  };
}

/** Deactivates the `LAB` department — T4 A9's second leg without re-seeding the world. */
export async function deactivateLabDepartment(db: Db, departmentId: string): Promise<void> {
  await db.update(opdDepartments).set({ active: false }).where(eq(opdDepartments.id, departmentId));
}

export { serviceIdForLabCode };
