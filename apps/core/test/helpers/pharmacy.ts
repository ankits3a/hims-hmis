import { newId } from "@hmis/contracts";
import { grantPermissionToRole, syncPermissions } from "../../src/kernel/auth/permissions";
import { withTx } from "../../src/kernel/db/client";
import { patientAllergies, stockBatches } from "../../src/kernel/db/schema";
import { ModuleRegistry } from "../../src/kernel/modules/loader";
import { ALL_MANIFESTS } from "../../src/kernel/modules/manifests";
import { collectOrderKinds } from "../../src/kernel/orders/kinds";
import { ORDERS_PLACE } from "../../src/kernel/orders/place";
import { addMedicine, addSalt } from "../../src/modules/formulary";
import { createStore, postMovement, registerItem } from "../../src/modules/materials";
import { startConsultation } from "../../src/modules/opd/consultation";
import { openVisit } from "../../src/modules/opd/encounters";
import { registerOpdEncounterResolver } from "../../src/modules/opd/opd.module";
import { issuePrescription } from "../../src/modules/opd/prescriptions";
import { callNext } from "../../src/modules/opd/queue";
import { recordVitals } from "../../src/modules/opd/vitals";
import { activatePharmacyDefinitions, registerSaleItem } from "../../src/modules/pharmacy";
import { upsertGstCategory } from "../../src/modules/tariff";
import { seedBillingBase } from "./billing";
import { activateOpdVisitDefinition, ensureRole, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg } from "./opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { OrderKindDecl } from "../../src/kernel/orders/kinds";
import type { EncounterRow } from "../../src/modules/opd";
import type { IssuedPrescription, RxLine } from "../../src/modules/opd/prescriptions";

/** Monday 2026-08-17, 09:30 IST — inside every doctor's default template. */
export const MON = new Date("2026-08-17T04:00:00.000Z");
export const MON2 = new Date(MON.getTime() + 20 * 60_000);
export const MON3 = new Date(MON.getTime() + 40 * 60_000);
const DOB = new Date(Date.UTC(1996, 0, 15));
const ADULT_OK = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

export type PharmacyFixture = {
  decls: readonly OrderKindDecl[];
  registry: ModuleRegistry;
  pharmacist: { id: string; token: string; actor: Actor };
  aide: { id: string; token: string; actor: Actor };
  clerk: { id: string; token: string; actor: Actor };
  vd: { id: string; token: string; actor: Actor };
  doctor: Awaited<ReturnType<typeof mkDoctor>>;
  deptId: string;
  storeId: string;
  /** Medicines: two paracetamol 500 tablets (generic pair), one azithromycin 500 (H1), one alprazolam (X). */
  med: { crocin: string; calpol: string; azithro: string; alprax: string; ibuprofen: string };
  item: { crocin: string; calpol: string; azithro: string };
  patient: { id: string; uhid: string };
  /** The OPD `V` resolver the order envelope needs (the app module registers it at boot; a suite does it here and undoes it after). */
  unregister: () => void;
};

/**
 * PLAN 16c — everything the counter suites start from: OPD (visit definition, masters, a doctor, a
 * clerk, a vitals desk), the billing/tariff base, the pharmacy roles with the model's grants, the
 * `PHARM-OPD` store, a small formulary with a generic pair and one H1 and one X medicine, drug
 * items for three of them bridged to sale items, one patient. Rows are built through the OWNING
 * module's API wherever one exists.
 */
export async function seedPharmacyBase(db: Db): Promise<PharmacyFixture> {
  await seedOpdBase(db);
  await activateOpdVisitDefinition(db);
  const { deptId, roomId } = await seedOpdMasters(db);
  const registry = new ModuleRegistry();
  for (const m of ALL_MANIFESTS) registry.install(m);
  await syncPermissions(db, registry);
  const base = await seedBillingBase(db);
  // The three medicine slabs `seed:tariff` carries (16c T2 / S2); the billing base seeds only `pharmacy` (12%).
  for (const [category, rateBps, exempt] of [["pharmacy_exempt", 0, true], ["pharmacy_5", 500, false], ["pharmacy_18", 1800, false]] as const) {
    await withTx(db, (tx) => upsertGstCategory(tx, base.drafter, { category, sacCode: "3004", exempt, rateBps, specialRule: null, thresholdPaise: null }));
  }

  await ensureRole(db, "pharmacy");
  await ensureRole(db, "pharmacy_assistant");
  for (const p of [
    "pharmacy.dispense.place", "pharmacy.dispense.read", "pharmacy.dispense.scheduled", "pharmacy.sale_items.manage",
    ORDERS_PLACE, "orders.read", "orders.cancel",
    "billing.invoice.issue", "billing.invoice.read", "billing.receipt.record", "billing.session.own",
    "patients.read", "formulary.read", "materials.stock.read", "opd.prescriptions.verify",
  ]) await grantPermissionToRole(db, registry, "pharmacy", p);
  for (const p of ["pharmacy.dispense.place", "pharmacy.dispense.read", "orders.read", "patients.read", "formulary.read"]) {
    await grantPermissionToRole(db, registry, "pharmacy_assistant", p);
  }
  const pharmacist = await mkUser(db, "ph.mehta", ["pharmacy"]);
  const aide = await mkUser(db, "aide.ravi", ["pharmacy_assistant"]);
  const clerk = await mkUser(db, "clerk", ["front_office"]);
  const vd = await mkUser(db, "vd", ["vitals_desk"]);
  const doctor = await mkDoctor(db, { username: "dr.sen", departmentId: deptId, roomId });
  await activatePharmacyDefinitions(db, base.activator);

  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
  const { resourceId: storeId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: "PHARM-OPD", name: "OPD pharmacy counter" }));

  const med = await withTx(db, async (tx) => {
    const para = await addSalt(tx, pharmacist.actor, { name: "Paracetamol", aliases: ["acetaminophen"], drugClass: "analgesic" });
    const azi = await addSalt(tx, pharmacist.actor, { name: "Azithromycin", drugClass: "macrolide" });
    const alp = await addSalt(tx, pharmacist.actor, { name: "Alprazolam", drugClass: "benzodiazepine" });
    const ibu = await addSalt(tx, pharmacist.actor, { name: "Ibuprofen", drugClass: "nsaid" });
    const crocin = await addMedicine(tx, pharmacist.actor, { brandName: "Crocin 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "OTC", salts: [{ saltId: para.saltId, strength: "500 mg" }] });
    const calpol = await addMedicine(tx, pharmacist.actor, { brandName: "Calpol 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "OTC", salts: [{ saltId: para.saltId, strength: "500 mg" }] });
    const azithro = await addMedicine(tx, pharmacist.actor, { brandName: "Azee 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "H1", salts: [{ saltId: azi.saltId, strength: "500 mg" }] });
    const alprax = await addMedicine(tx, pharmacist.actor, { brandName: "Alprax 0.5", form: "tablet", routeClass: "systemic", strengthLabel: "0.5 mg", scheduleFlag: "X", salts: [{ saltId: alp.saltId, strength: "0.5 mg" }] });
    const ibuprofen = await addMedicine(tx, pharmacist.actor, { brandName: "Brufen 400", form: "tablet", routeClass: "systemic", strengthLabel: "400 mg", scheduleFlag: "H", salts: [{ saltId: ibu.saltId, strength: "400 mg" }] });
    return { crocin: crocin.medicineId, calpol: calpol.medicineId, azithro: azithro.medicineId, alprax: alprax.medicineId, ibuprofen: ibuprofen.medicineId };
  });

  const item = await withTx(db, async (tx) => {
    const mk = async (code: string, name: string, medicineId: string, gst: number): Promise<string> => {
      const { itemId } = await registerItem(tx, HEAD, {
        code, name, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId, gstRateBps: gst,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, pharmacist.actor, itemId);
      return itemId;
    };
    return {
      crocin: await mk("CROC500", "Crocin 500 tablet", med.crocin, 1200),
      calpol: await mk("CALP500", "Calpol 500 tablet", med.calpol, 1200),
      azithro: await mk("AZEE500", "Azee 500 tablet", med.azithro, 500),
    };
  });

  const patient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB });
  const unregister = registerOpdEncounterResolver();
  return { decls: collectOrderKinds(registry), registry, pharmacist, aide, clerk, vd, doctor, deptId, storeId, med, item, patient, unregister };
}

/** open → vitals → call → start → issue: the production path a prescription actually takes. */
export async function issueRx(
  db: Db,
  fx: PharmacyFixture,
  lines: RxLine[],
  opts: { patientId?: string; at?: Date; overrides?: Omit<Parameters<typeof issuePrescription>[4], "lines"> } = {},
): Promise<{ encounter: EncounterRow; tokenNo: number | null; issued: IssuedPrescription }> {
  const at = opts.at ?? MON;
  const opened = await openVisit(db, fx.clerk.actor, { patientId: opts.patientId ?? fx.patient.id, departmentId: fx.deptId, doctorId: fx.doctor.doctorId }, at);
  await recordVitals(db, fx.vd.actor, opened.encounter.id, ADULT_OK, at);
  await callNext(db, fx.doctor.actor, opened.sessionId, at);
  const started = await startConsultation(db, fx.doctor.actor, opened.encounter.id, at);
  const issued = await issuePrescription(db, fx.doctor.actor, testCfg, started.encounter.id, { lines, ...(opts.overrides ?? {}) }, new Date(at.getTime() + 60_000));
  return { encounter: started.encounter, tokenNo: opened.tokenNo, issued };
}

export async function addAllergy(db: Db, patientId: string, substance: string): Promise<void> {
  await db.insert(patientAllergies).values({ id: newId(), patientId, substance, source: "registration", recordedBy: "t" });
}

export const line = (over: Partial<RxLine> & { drug: string }): RxLine => ({
  dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false, medicineId: null, ...over,
});

/** A RE-ISSUE on the same encounter (version + 1) — what a doctor does after the counter sends the patient back. */
export async function reissueRx(
  db: Db,
  fx: PharmacyFixture,
  encounterId: string,
  lines: RxLine[],
  opts: { at?: Date; overrides?: Omit<Parameters<typeof issuePrescription>[4], "lines"> } = {},
): Promise<IssuedPrescription> {
  return issuePrescription(db, fx.doctor.actor, testCfg, encounterId, { lines, ...(opts.overrides ?? {}) }, opts.at ?? MON2);
}

/**
 * Stock at the counter's store, the way the ledger sees it: a `stock_batches` row in the storage
 * shape the GRN writes (the `ledger.test.ts` fixture) and ONE `grn` movement through
 * `postMovement` — the only writer of balances. MRP is printed per STRIP of 10 unless told otherwise.
 */
export async function stockIn(
  db: Db,
  fx: PharmacyFixture,
  input: { itemId: string; batchNo: string; expiryDate?: string | null; mrpPaise?: number | null; mrpUom?: string | null; qtyBase: number; at?: Date },
): Promise<string> {
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
  const batchId = newId();
  await db.insert(stockBatches).values({
    id: batchId, itemId: input.itemId, batchNo: input.batchNo,
    expiryDate: input.expiryDate === undefined ? "2027-06-30" : input.expiryDate,
    mrpPaise: input.mrpPaise === undefined ? 12000 : input.mrpPaise, mrpUom: input.mrpUom === undefined ? "strip" : input.mrpUom,
    landedCostPaise: 500, ownership: "owned", createdBy: HEAD.id,
  });
  await withTx(db, (tx) => postMovement(tx, HEAD, {
    resourceId: fx.storeId, batchId, qtyDelta: input.qtyBase, reason: "grn", refType: "test", refId: batchId, occurredAt: input.at ?? MON,
  }));
  return batchId;
}
