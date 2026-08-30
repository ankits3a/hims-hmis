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
import { collect, deskOrder, printLabels } from "../../src/modules/lab";
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
  /**
   * THE BENCH — `lab_technician` + `phlebotomist`, and it is a DIFFERENT login from the desk on
   * purpose. `awaiting_collection → collected` declares `phlebotomist, lab_technician, nurse` and
   * the engine checks a `user` actor's roles itself (S4), so a fixture that drew blood as the
   * counter clerk would be asserting against a definition nobody could satisfy in a real lab.
   */
  bench: { id: string; token: string; actor: Actor };
  labDepartmentId: string;
  patientId: string;
  /** A second registration of the same person, MERGED into `patientId` (T3 A6's shape). */
  mergedLoserId: string;
  /** A DIFFERENT person entirely, with their own visit — close review MAJOR 5's discriminator. */
  otherPatientId: string;
  otherEncounterNo: string;
  encounterNo: string;
  serviceDate: string;
  unregister: () => void;
};

/**
 * Twenty-two orderables the tariff prices, chosen so that the first SIXTEEN share NO analyte with
 * one another — T5 A2 needs eight concurrent PAIRS and the duplicate detector legitimately refuses
 * the second order of an overlapping test within its window, which would silently shrink the
 * measured rounds rather than fail (§2.3: report the OBSERVED rate, never engineer the window).
 */
const PRICED_LAB_CODES = [
  "CBC", "LFT", "RFT", "LIPID", "TSH", "GLUF", "UPT", "HBSAG",
  "HIV", "HCV", "VDRL", "PSA", "VITD", "B12", "FOLATE", "FERRITIN",
  "ESR", "TFT", "FEVER", "WIDAL", "CRP", "AMYLASE",
] as const;

/**
 * The sixteen with no shared analyte, in pairs — A2's eight rounds.
 *
 * **`HIV` is deliberately absent** even though it is analyte-disjoint: it is `consent_required`, so
 * `deskOrder` refuses it without a consent block (T4 A4) and the round would place one order
 * instead of two. That is the desk working correctly and it is not what A2 is measuring.
 */
export const NON_OVERLAPPING_PAIRS: readonly (readonly [string, string])[] = [
  ["CBC", "LFT"], ["RFT", "LIPID"], ["TSH", "GLUF"], ["UPT", "HBSAG"],
  ["HCV", "VDRL"], ["PSA", "VITD"], ["B12", "FOLATE"], ["FERRITIN", "CRP"],
];

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

  for (const p of [
    "lab.catalogue.read", "lab.worklist.read", "lab.accession.operate", "lab.collection.operate",
    ORDERS_PLACE, "orders.read", "orders.cancel", "billing.credit.extend",
    "billing.invoice.issue", "billing.invoice.read", "patients.read", "lab.orders.place",
  ]) {
    await grantPermissionToRole(db, registry, "lab_technician", p);
    await grantPermissionToRole(db, registry, "phlebotomist", p);
  }

  const desk = await mkUser(db, "lab.counter", ["lab_reception"]);
  const pathologistUser = await mkUser(db, "dr.iyer", ["pathologist"]);
  const bench = await mkUser(db, "lab.bench", ["lab_technician", "phlebotomist"]);

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
  const otherPatientId = newId();
  const otherEncounterNo = "V2608290002";
  await db.insert(patients).values([
    { id: patientId, uhid: "HMS-00000101-7", name: "Ram Kumar", sex: "male",
      administrativeGender: "male", createdBy: "t", updatedBy: "t" },
    { id: mergedLoserId, uhid: "HMS-00000102-5", name: "Ram Kumar", sex: "male",
      administrativeGender: "male", status: "merged", mergedIntoPatientId: patientId,
      createdBy: "t", updatedBy: "t" },
    /** A DIFFERENT person with a confusable name — E1's own case, and MAJOR 5's discriminator. */
    { id: otherPatientId, uhid: "HMS-00000103-3", name: "Ram Kumar Yadav", sex: "male",
      administrativeGender: "male", createdBy: "t", updatedBy: "t" },
  ]);

  const unregister = registerEncounterResolver("V", async (_d, no) =>
    no === encounterNo ? { patientId, intendedPayer: "self" }
      : no === otherEncounterNo ? { patientId: otherPatientId, intendedPayer: "self" }
        : null);

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
    bench,
    pathologist: { ...pathologistUser, doctorId: labDoctorId },
    labDepartmentId,
    patientId,
    mergedLoserId,
    otherPatientId,
    otherEncounterNo,
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

/**
 * PLAN 17a T5 — THE CHAIN A COLLECTION OR ACCESSION TEST STARTS FROM: order, label, (draw).
 *
 * It goes through the REAL `deskOrder` and `printLabels` rather than inserting rows, because every
 * T5 assertion is about what those two left behind — a hand-rolled `lab_specimens` row with no
 * `lab_specimen_items` link would make `receive` assert nothing at all.
 */
export async function deskAndLabel(
  db: Db,
  fx: LabDeskFixture,
  codes: readonly string[] = ["CBC"],
  over: { draw?: boolean; wristbandScanned?: boolean; priority?: "routine" | "urgent" | "stat" } = {},
): Promise<{
  orderId: string; orderGroupId: string; itemIds: string[];
  specimens: { specimenId: string; specimenNo: string; itemIds: string[] }[];
}> {
  const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
    patientId: fx.patientId,
    encounterNo: fx.encounterNo,
    serviceDate: fx.serviceDate,
    orderingClinicianId: fx.pathologist.id,
    priority: over.priority,
    items: codes.map((c) => ({ serviceId: serviceIdForLabCode(c) })),
    credit: { reason: "counter order" },
  }));
  const patient = (await db.select().from(patients).where(eq(patients.id, fx.patientId)))[0]!;
  const { specimens } = await printLabels(db, fx.bench.actor, {
    orderGroupId: placed.orderGroupId, scannedUhid: patient.uhid,
  });
  if (over.draw !== false) {
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, fx.bench.actor, {
        specimenId: s.specimenId, wristbandScanned: over.wristbandScanned ?? true,
      }));
    }
  }
  return {
    orderId: placed.orderId, orderGroupId: placed.orderGroupId, itemIds: placed.itemIds,
    specimens: specimens.map((s) => ({ specimenId: s.specimenId, specimenNo: s.specimenNo, itemIds: s.itemIds })),
  };
}

/** The patient's UHID, for a scan a test needs to get right or deliberately wrong. */
export async function uhidOf(db: Db, patientId: string): Promise<string> {
  return (await db.select().from(patients).where(eq(patients.id, patientId)))[0]!.uhid;
}
