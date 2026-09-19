import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../../test/helpers/opd";
import { startConsultation } from "../../../modules/opd/consultation";
import { openVisit } from "../../../modules/opd/encounters";
import { issuePrescription } from "../../../modules/opd/prescriptions";
import { callNext } from "../../../modules/opd/queue";
import { recordVitals } from "../../../modules/opd/vitals";
import { pharmacyDispenseLines, pharmacyDispenses, pharmacyRegH1, pharmacyShelfLocations } from "./index";
import { seedPharmacyBase } from "../../../../test/helpers/pharmacy";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Db } from "../client";

const MON = new Date("2026-08-17T04:00:00.000Z");
const DOB = new Date(Date.UTC(1996, 0, 15));
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };
const LINE = { drug: "Tab Azithromycin 500 mg", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 3, instructions: null, noSubstitution: false };

/**
 * PLAN 16c T1 — the four pharmacy tables, migration 0056. The fixture is a real prescription
 * (patient → visit → consult → issue), because the dispense references the prescription and the
 * encounter by FK and a synthetic row would prove the CHECKs against a shape the counter never sees.
 */
describe("the pharmacy schema (16c T1, migration 0056)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let patientId: string;
  let encounterId: string;
  let prescriptionId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const dr = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    const clerk = await mkUser(db, "clerk", ["front_office"]);
    const vd = await mkUser(db, "vd", ["vitals_desk"]);
    const patient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB });
    patientId = patient.id;
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dr.doctorId }, MON);
    encounterId = opened.encounter.id;
    await recordVitals(db, vd.actor, encounterId, adultOk, MON);
    await callNext(db, dr.actor, opened.sessionId, MON);
    await startConsultation(db, dr.actor, encounterId, MON);
    ({ prescriptionId } = await issuePrescription(db, dr.actor, testCfg, encounterId, { lines: [LINE] }, new Date(MON.getTime() + 60_000)));
  });

  function queued(over: Partial<typeof pharmacyDispenses.$inferInsert> = {}): typeof pharmacyDispenses.$inferInsert {
    return { id: newId(), prescriptionId, prescriptionVersion: 1, patientId, encounterId, status: "queued", createdBy: "t", ...over };
  }

  it("one LIVE dispense per (prescription, version): a second queued row is refused, a cancelled one does not count", async () => {
    await db.insert(pharmacyDispenses).values(queued());
    await expect(db.insert(pharmacyDispenses).values(queued())).rejects.toThrow(/pharmacy_dispenses_live_rx_ux/);
    await db.update(pharmacyDispenses).set({ status: "cancelled", cancelledBy: "t", cancelledAt: MON, cancelReason: "test" })
      .where(eq(pharmacyDispenses.prescriptionId, prescriptionId));
    await db.insert(pharmacyDispenses).values(queued()); // re-queued after a cancel
    expect(await db.select().from(pharmacyDispenses)).toHaveLength(2);
  });

  it("a status outside the seven is refused, and 'verified' without an order, a P number and a store is refused", async () => {
    await expect(db.insert(pharmacyDispenses).values(queued({ status: "dispensed" }))).rejects.toThrow(/pharmacy_dispenses_status_ck/);
    await expect(db.insert(pharmacyDispenses).values(queued({ status: "verified" }))).rejects.toThrow(/pharmacy_dispenses_claimed_has_order_ck/);
    await db.insert(pharmacyDispenses).values(queued({ status: "claimed", claimedBy: "t" })); // claimed rows carry no order yet
  });

  it("a line: generic substitution needs consent, a declined line needs a reason, qty is positive", async () => {
    const d = queued();
    await db.insert(pharmacyDispenses).values(d);
    const line = (over: Partial<typeof pharmacyDispenseLines.$inferInsert>): typeof pharmacyDispenseLines.$inferInsert =>
      ({ id: newId(), dispenseId: d.id, lineIdx: 0, rxLine: LINE, ...over });
    await expect(db.insert(pharmacyDispenseLines).values(line({ substitutionType: "generic" }))).rejects.toThrow(/pharmacy_dispense_lines_generic_consent_ck/);
    await expect(db.insert(pharmacyDispenseLines).values(line({ status: "declined" }))).rejects.toThrow(/pharmacy_dispense_lines_declined_ck/);
    await expect(db.insert(pharmacyDispenseLines).values(line({ qtyBase: 0 }))).rejects.toThrow(/pharmacy_dispense_lines_qty_ck/);
    await db.insert(pharmacyDispenseLines).values(line({}));
    await expect(db.insert(pharmacyDispenseLines).values(line({}))).rejects.toThrow(/pharmacy_dispense_lines_idx_ux/);
  });

  it("R-4 — the H1 register is append-only: UPDATE and DELETE both raise, in the database", async () => {
    const d = queued();
    await db.insert(pharmacyDispenses).values(d);
    const lineId = newId();
    await db.insert(pharmacyDispenseLines).values({ id: lineId, dispenseId: d.id, lineIdx: 0, rxLine: LINE });
    const regId = newId();
    await db.insert(pharmacyRegH1).values({
      id: regId, dispenseLineId: lineId, dispensedAt: MON, patientId, patientName: "Test Patient", prescriberName: "Dr A",
      drugName: "Azithromycin 500 mg", batchNo: "AZ-1", qtyBase: 3, unit: "tablet", recordedBy: "t",
    });
    await expect(db.update(pharmacyRegH1).set({ qtyBase: 30 }).where(eq(pharmacyRegH1.id, regId))).rejects.toThrow(/pharmacy_reg_h1_immutable/);
    await expect(db.delete(pharmacyRegH1).where(eq(pharmacyRegH1.id, regId))).rejects.toThrow(/pharmacy_reg_h1_immutable/);
    await expect(db.execute(sql`delete from pharmacy_reg_h1`)).rejects.toThrow(/pharmacy_reg_h1_immutable/);
    const rows = await db.select().from(pharmacyRegH1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qtyBase).toBe(3);
  });
});

/**
 * PD-D18 — `pharmacy_shelf_locations`, migration 0106: one label per (counter's store, item), and the
 * label is a real, trimmed, short word — "unknown" is the ABSENCE of a row, never an empty label.
 */
describe("pharmacy_shelf_locations (PD-D18, migration 0106)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  const row = (over: Partial<typeof pharmacyShelfLocations.$inferInsert> = {}): typeof pharmacyShelfLocations.$inferInsert =>
    ({ id: newId(), storeResourceId: fx.storeId, itemId: fx.item.crocin, location: "R-12", setBy: "u", ...over });

  it("holds one label per store and item", async () => {
    await db.insert(pharmacyShelfLocations).values(row());
    await expect(db.insert(pharmacyShelfLocations).values(row({ location: "R-13" }))).rejects.toThrow(/pharmacy_shelf_locations_store_item_ux/);
    await db.insert(pharmacyShelfLocations).values(row({ itemId: fx.item.calpol, location: "rack 3 · shelf 2" }));
    expect((await db.select().from(pharmacyShelfLocations).where(eq(pharmacyShelfLocations.storeResourceId, fx.storeId))).map((r) => r.location).sort())
      .toEqual(["R-12", "rack 3 · shelf 2"]);
  });

  it.each([[""], ["   "], [" R-12"], ["R-12 "], ["X".repeat(25)]])("refuses the label %j", async (location: string) => {
    await expect(db.insert(pharmacyShelfLocations).values(row({ location }))).rejects.toThrow(/pharmacy_shelf_locations_label_ck/);
  });
});
