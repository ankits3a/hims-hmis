import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { seedBillingBase } from "../../../test/helpers/billing";
import { registrationConfig, opdEncounters } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { saveConsultNote, startConsultation } from "./consultation";
// §4 — a module may import another module's index.ts (its declared interface) and never its
// internals. `pnpm lint` refuses `../tariff/services`, and it refused this file's first draft.
import { listPriceList } from "../tariff";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07d T5 / DD4 — **ADVISED INVESTIGATIONS, AND THE SPIKE (S2) THAT SHAPED THEM.**
 *
 * S2 asked whether `services.category` could group the catalogue. Measured at kickoff: it is free
 * text with no CHECK, and a fresh database holds TWO service rows, both OPD consultation. The
 * spike's own ruling for that answer is that this task ships behind a category vocabulary it does
 * NOT invent — the vocabulary belongs to tariff — so the browse is flat and the finding is routed.
 *
 * What is asserted here is the half that must not drift: the price list is a READ of the active
 * tariff version (no discounts, no GST, no clamp — those need a payer and a patient), and an
 * advised test is stored on the encounter through the consult note, which already gates on the
 * treating doctor and an `in_consultation` state.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("advised investigations (07d T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let base: Awaited<ReturnType<typeof seedBillingBase>>;
  let deptId: string;
  let room2Id: string;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    room2Id = masters.room2Id;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    // The tariff fixture: an activated version with three priced services.
    base = await seedBillingBase(db);
    patientId = (await mkPatient(db, clerk.actor, { name: "Ramesh Kale", phone: "9876540111" })).id;
  });

  /**
   * THE PRICE LIST IS A READ, AND IT IS THE ONLY ONE A PRESCRIBER GETS. `POST
   * /billing/invoices/preview` prices anything but needs `billing.invoice.issue` — the counter's
   * authority, not a doctor's. This returns the ACTIVE version's list price and computes nothing.
   */
  it("the price list carries every active service at the ACTIVE version's price", async () => {
    const rows = await listPriceList(db, MON);

    expect(rows.length).toBeGreaterThanOrEqual(3);
    const byId = new Map(rows.map((r) => [r.serviceId, r]));
    expect(byId.get(base.genericServiceId)?.pricePaise).toBeGreaterThan(0);
    // Sorted by name, so a picker shows a stable list rather than insertion order.
    expect([...rows].map((r) => r.name)).toEqual([...rows].map((r) => r.name).sort());
  });

  /**
   * A hospital on day one has no activated tariff version. That is the TRUE answer and an empty
   * list is the honest rendering of it — an error would turn a merely empty screen into a broken
   * one, which §1.3 says several panels will be on day one regardless.
   */
  it("a hospital with no activated tariff version gets an empty list, not an error", async () => {
    await truncateAll(db);
    await expect(listPriceList(db, MON)).resolves.toEqual([]);
  });

  it("advised tests are stored on the encounter through the consult note", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    await startConsultation(db, dra.actor, opened.encounter.id, MON);

    const advised = [{ serviceId: base.genericServiceId, code: "GEN", name: "Ultrasound abdomen", pricePaise: 120000 }];
    await saveConsultNote(db, dra.actor, opened.encounter.id, { diagnosis: "Abdominal pain", advisedTests: advised }, MON);

    const row = (await db.select().from(opdEncounters).where(eq(opdEncounters.id, opened.encounter.id)))[0]!;
    expect(row.advisedTests).toEqual(advised);
  });

  /**
   * AND NOBODY ELSE CAN WRITE THEM. This is the whole reason advised tests ride the consult note
   * rather than a route of their own — the gate is `saveConsultNote`'s and is not re-implemented.
   */
  it("a doctor who is not the encounter's own cannot advise tests on it", async () => {
    // The SECOND room from the same seed — calling `seedOpdMasters` again violates the department
    // code's unique index, which is what the first draft of this test did.
    const drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    await startConsultation(db, dra.actor, opened.encounter.id, MON);

    await expect(saveConsultNote(db, drb.actor, opened.encounter.id, {
      advisedTests: [{ serviceId: base.genericServiceId, code: "GEN", name: "X", pricePaise: 100 }],
    }, MON)).rejects.toThrow();
  });

  it("a visit that is not in consultation cannot gain advised tests", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON);

    await expect(saveConsultNote(db, dra.actor, opened.encounter.id, {
      advisedTests: [{ serviceId: base.genericServiceId, code: "GEN", name: "X", pricePaise: 100 }],
    }, MON)).rejects.toMatchObject({ code: "encounter_state_conflict" });
  });
});
