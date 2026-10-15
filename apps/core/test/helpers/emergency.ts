import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { authManifest } from "../../src/kernel/auth/manifest";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { activateDefinition, approveDefinition, createDraft } from "../../src/kernel/workflow/definitions";
import { ER_SATELLITE_STORE_CODE, emergencyManifest, erEpisodeWorkflowDefinition } from "../../src/modules/emergency";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { approveRequest } from "../../src/kernel/approvals/decisions";
import { setPin } from "../../src/kernel/auth/identity";
import { withTx } from "../../src/kernel/db/client";
import * as schema from "../../src/kernel/db/schema";
import { collectOrderKinds } from "../../src/kernel/orders/kinds";
import { ordersManifest } from "../../src/kernel/orders/manifest";
import { ORDERS_PLACE } from "../../src/kernel/orders/place";
import { addMedicine, addSalt } from "../../src/modules/formulary";
import { activateLabDefinitions, labManifest } from "../../src/modules/lab";
import { createStore, postMovement, registerItem } from "../../src/modules/materials";
import { pharmacyManifest } from "../../src/modules/pharmacy";
import { activateVersion, createDraftVersion, resolveActiveTariffVersion, setTariffItem, submitVersion, upsertGstCategory } from "../../src/modules/tariff";
import { seedLabCatalogue, serviceIdForLabCode } from "../../scripts/seed-lab-catalogue";
import type { OrderKindDecl } from "../../src/kernel/orders/kinds";
import { ipdManifest } from "../../src/modules/ipd";
import { patientsManifest } from "../../src/modules/patients";
import { registerPatientApprovalTypes } from "../../src/modules/patients/approval-types";
import { mkAdmitWorld } from "./ipd";
import { ensureRole, mkUser } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { AdmitWorld } from "./ipd";

export type ErWorld = AdmitWorld & {
  /** front_office with the two ER strings (and the IPD admission desk's, from `mkAdmitWorld`). */
  erDesk: Actor;
  /** The casualty nurse: the two ER strings only. */
  erNurse: Actor;
  /** The MRD officer: `patients.merge` (files and executes merges), nothing of the ER. */
  mrd: Actor;
  /** A doctor with the board only. */
  erDoctor: Actor;
};

/**
 * ER lane 1 (#808) — `mkAdmitWorld` (the bed registry, the IPD admission workflow, billing's base, the MS) plus: the
 * `er_episode` workflow ACTIVATED the governance way (owner + MS approve, a third person activates), the patients
 * approval types (`patient_merge` decided by the MS), and the people: the ER desk (front office), the casualty nurse,
 * the MRD officer and a doctor who only reads the board.
 */
export async function mkErWorld(db: Db): Promise<ErWorld> {
  const w = await mkAdmitWorld(db);
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  registry.install(patientsManifest);
  registry.install(ipdManifest);
  registry.install(emergencyManifest);
  await syncPermissions(db, registry);
  // ER review (2026-10-15): the board readers also hold the wall screen's own string, as seed:roles grants it.
  for (const p of ["er.board.view", "er.board.wall", "er.arrival.register"]) await grantPermissionToRole(db, registry, "front_office", p);
  await ensureRole(db, "er_nurse");
  for (const p of ["er.board.view", "er.board.wall", "er.arrival.register", "er.triage", "er.care"]) await grantPermissionToRole(db, registry, "er_nurse", p);
  await ensureRole(db, "mrd_officer");
  for (const p of ["patients.read", "patients.merge"]) await grantPermissionToRole(db, registry, "mrd_officer", p);
  await grantPermissionToRole(db, registry, "doctor", "er.board.view");
  await grantPermissionToRole(db, registry, "doctor", "er.triage");
  await grantPermissionToRole(db, registry, "doctor", "er.care");
  await grantPermissionToRole(db, registry, "doctor", "er.board.wall");
  const erNurse = (await mkUser(db, "er.nurse", ["er_nurse"])).actor;
  const mrd = (await mkUser(db, "er.mrd", ["mrd_officer"])).actor;
  const erDoctor = (await mkUser(db, "er.doctor", ["doctor"])).actor;

  const draft = await createDraft(db, w.tariffDrafter, erEpisodeWorkflowDefinition);
  await approveDefinition(db, w.owner, { definitionId: draft.definitionId, roleKey: "owner", note: "fixture" });
  await approveDefinition(db, w.ms, { definitionId: draft.definitionId, roleKey: "medical_superintendent", note: "fixture" });
  await activateDefinition(db, w.tariffActivator, draft.definitionId);
  await registerPatientApprovalTypes(db, w.tariffActivator);
  return { ...w, erDesk: w.admitDesk, erNurse, mrd, erDoctor };
}

// ═══ ER lane 3 (#810) — care: the lab (catalogue, definitions, a priced tariff), the ER store with stock, PINs ═══

export const ER_LAB_PRICE = 30_000;

export type ErCareWorld = ErWorld & {
  decls: OrderKindDecl[];
  bench: Actor;
  resident: Actor;
  /** An ER nurse whose PIN a second check uses, and the doctor's. */
  nurse2: Actor;
  pins: { nurse2: { username: string; pin: string }; erNurse: { username: string; pin: string }; doctor: { username: string; pin: string } };
  storeId: string;
  /** A drug stocked in the ER satellite store (`ER-SAT`): returns its item id. */
  stocked(name: string, opts?: { highAlert?: boolean; moiety?: string; qty?: number }): Promise<string>;
};

export async function mkErCareWorld(db: Db): Promise<ErCareWorld> {
  const w = await mkErWorld(db);
  const registry = new ModuleRegistry();
  registry.install(ordersManifest);
  registry.install(labManifest);
  registry.install(emergencyManifest);
  registry.install(pharmacyManifest);
  await syncPermissions(db, registry);
  for (const p of [ORDERS_PLACE, "lab.orders.place", "orders.read"]) await grantPermissionToRole(db, registry, "doctor", p);
  for (const role of ["lab_technician", "phlebotomist", "resident", "lab_reception"]) await ensureRole(db, role);
  for (const p of ["lab.catalogue.manage", "lab.catalogue.read"]) await grantPermissionToRole(db, registry, "lab_reception", p);
  for (const p of ["lab.collection.operate", "lab.accession.operate", "orders.read", "lab.results.enter", "lab.results.read", "lab.catalogue.read", "lab.worklist.read"]) {
    await grantPermissionToRole(db, registry, "lab_technician", p);
    await grantPermissionToRole(db, registry, "phlebotomist", p);
  }
  for (const p of ["er.board.view", "er.triage", "er.care"]) await grantPermissionToRole(db, registry, "resident", p);
  const bench = (await mkUser(db, "er.bench", ["lab_technician", "phlebotomist"])).actor;
  const resident = (await mkUser(db, "er.resident", ["doctor", "resident"])).actor;
  const nurse2 = (await mkUser(db, "er.nurse2", ["er_nurse"])).actor;
  await setPin(db, nurse2.id, "8642");
  await setPin(db, w.erNurse.id, "4321");
  await setPin(db, w.doctor.id, "1357");
  // ER review 2 (2026-10-15): the consultant rule (IPD's) reads the doctor master — the ER doctor and `w.doctor` are on it;
  // the resident is not.
  {
    const deptId = newId();
    await db.insert(schema.opdDepartments).values({ id: deptId, code: "ERCARE", name: "ER care test", createdBy: "t", updatedBy: "t" });
    for (const [userId, code] of [[w.erDoctor.id, "DR-ER-1"], [w.doctor.id, "DR-ER-2"]] as const) {
      const on = await db.select({ id: schema.opdDoctors.id }).from(schema.opdDoctors).where(eq(schema.opdDoctors.userId, userId));
      if (on.length === 0) {
        await db.insert(schema.opdDoctors).values({
          id: newId(), userId, displayName: `Dr ${code}`, code, registrationNo: "BMC/5", departmentId: deptId, createdBy: "t", updatedBy: "t",
        });
      }
    }
  }

  // The lab: catalogue, definitions, an exempt GST category, and a tariff pricing CBC and RFT (ESR deliberately not).
  const curator = (await mkUser(db, "er.labcurator", ["lab_reception"])).actor;
  await seedLabCatalogue(db, curator);
  await activateLabDefinitions(db, w.tariffActivator);
  await withTx(db, (tx) => upsertGstCategory(tx, w.tariffDrafter, {
    category: "investigation", sacCode: "999316", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null,
  }));
  const current = await resolveActiveTariffVersion(db, new Date());
  const version = await withTx(db, async (tx) => {
    const d = await createDraftVersion(tx, w.tariffDrafter, { copyFromVersionId: current!.versionId });
    for (const code of ["CBC", "RFT"]) await setTariffItem(tx, w.tariffDrafter, d.versionId, serviceIdForLabCode(code), ER_LAB_PRICE);
    return d;
  });
  const submitted = await withTx(db, (tx) => submitVersion(tx, w.tariffDrafter, version.versionId));
  await approveRequest(db, w.owner, { approvalId: submitted.approvalId, note: "er care fixture tariff" });
  await activateVersion(db, w.tariffActivator, version.versionId, new Date("2026-01-05T00:00:00Z"));

  // The ER satellite store and its stock.
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
  const { resourceId: storeId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: ER_SATELLITE_STORE_CODE, name: "ER satellite store" }));
  let n = 0;
  const erNurseName = (await db.select({ u: schema.users.username }).from(schema.users).where(eq(schema.users.id, w.erNurse.id)))[0]!.u;
  return {
    ...w, decls: collectOrderKinds(registry), bench, resident, nurse2, storeId,
    pins: {
      nurse2: { username: "er.nurse2", pin: "8642" }, erNurse: { username: erNurseName, pin: "4321" },
      doctor: { username: (await db.select({ u: schema.users.username }).from(schema.users).where(eq(schema.users.id, w.doctor.id)))[0]!.u, pin: "1357" },
    },
    stocked: async (name, opts = {}) => {
      n += 1;
      const { medicineId } = await withTx(db, async (tx) => {
        const salt = await addSalt(tx, w.admitDesk, { name: opts.moiety ?? `${name} moiety ${String(n)}`, drugClass: null, ndpsClass: null });
        return addMedicine(tx, w.admitDesk, {
          brandName: name, form: "injection", routeClass: "systemic", strengthLabel: "1 g", scheduleFlag: "H",
          salts: [{ saltId: salt.saltId, strength: "1 g" }],
        });
      });
      const itemId = await withTx(db, async (tx) => (await registerItem(tx, HEAD, {
        code: `ER-${String(n)}`, name, class: "drug", baseUom: "vial", batchTracked: true, formularyMedicineId: medicineId, gstRateBps: 1200,
        highAlert: opts.highAlert ?? false, lasa: false, lasaNote: null,
        uoms: [{ uom: "box", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: false }],
      } as never)).itemId);
      const batchId = newId();
      await db.insert(schema.stockBatches).values({
        id: batchId, itemId, batchNo: `ERB-${String(n)}`, expiryDate: "2030-12-31", mrpPaise: 5000, mrpUom: "vial", landedCostPaise: 2500, ownership: "owned", createdBy: HEAD.id,
      } as never);
      await withTx(db, (tx) => postMovement(tx, HEAD, {
        resourceId: storeId, batchId, qtyDelta: opts.qty ?? 20, reason: "grn", refType: "test", refId: batchId, occurredAt: new Date("2026-01-01T00:00:00Z"),
      }));
      return itemId;
    },
  };
}
