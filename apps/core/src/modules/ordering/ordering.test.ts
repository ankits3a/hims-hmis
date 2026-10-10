import { and, eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase, serviceIdForLabCode } from "../../../test/helpers/lab";
import { openOpdVisit } from "../../../test/helpers/opd";
import { setupRadiologyFixture } from "../../../test/helpers/radiology";
import { seedBillingBase } from "../../../test/helpers/billing";
import { events, invoices, opdEncounters, orderItems, orders, outsideTests, services } from "../../kernel/db/schema";
import { registerEncounterResolver } from "../../kernel/episodes/encounter-resolvers";
import { setFeeSwitch } from "../billing";
import { getEncounter } from "../opd";
import { imagingFreeAt } from "../radiology";
import { orderFreeTests } from "./auto-order";
import { OutsideTestError, OUTSIDE_TEST_SEEDS, saveOutsideTest, seedOutsideTests, serviceIdForOutsideCode } from "./outside";
import { routeTests, searchOrderableTests } from "./route";
import { orderTests } from "./seam";
import type { Actor } from "@hmis/contracts";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * DECISION 0065 (owner 2026-10-10): free tests order themselves at "Complete consult", outside tests
 * have a catalogue and print, and one seam routes any episode's tests to lab, imaging or outside.
 */
const owner: Actor = { type: "user", id: "the-owner" };
const seedActor: Actor = { type: "system", id: "seed-outside-tests" };

describe("ordering: the lab side (decision 0065)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  /** 10:30 IST on the fixture's service date. */
  const AT = new Date("2026-08-29T05:00:00Z");
  const BEFORE = new Date("2026-08-29T04:00:00Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    /** The REAL OPD reader answers for the `V` series, the desk test's A2 shape. */
    fx.unregister();
    fx.unregister = registerEncounterResolver("V", async (exec, no) => {
      const e = await getEncounter(exec, no);
      return e ? { patientId: e.patientId, intendedPayer: e.intendedPayer } : null;
    });
    await seedOutsideTests(db, seedActor);
  });
  afterEach(() => { fx.unregister(); });

  async function visitAdvising(codes: string[]): Promise<{ encounterId: string; visitNo: string }> {
    const v = await openOpdVisit(db, {
      clerk: fx.desk.actor, patientId: fx.patientId, departmentId: fx.labDepartmentId, doctorId: fx.pathologist.doctorId,
    }, AT);
    const advisedTests = codes.map((c) => {
      const serviceId = c.startsWith("OUT:") ? serviceIdForOutsideCode(c.slice(4)) : serviceIdForLabCode(c);
      return { serviceId, code: c, name: c, pricePaise: 0 };
    });
    await db.update(opdEncounters).set({ advisedTests }).where(eq(opdEncounters.id, v.encounterId));
    return { encounterId: v.encounterId, visitNo: (await getEncounter(db, v.encounterId))!.visitNo };
  }

  async function itemsOf(visitNo: string) {
    return db.select({ serviceId: orderItems.serviceId, status: orderItems.status, kind: orders.kind, orderedByType: orders.orderedByType, authority: orders.authority })
      .from(orderItems).innerJoin(orders, eq(orders.id, orderItems.orderId)).where(eq(orders.encounterNo, visitNo));
  }

  it("routes by id: lab tests to the lab, ECG outside, an unclaimed tariff line to unknown", async () => {
    const routed = await routeTests(db, [serviceIdForLabCode("CBC"), serviceIdForOutsideCode("ECG"), "NO-SUCH-SERVICE"]);
    expect(routed).toEqual({
      lab: [serviceIdForLabCode("CBC")], imaging: [], outside: [serviceIdForOutsideCode("ECG")], inHospital: [], unknown: ["NO-SUCH-SERVICE"],
    });
    const found = await searchOrderableTests(db, "ecg");
    expect(found.map((r) => [r.code, r.department])).toContainEqual(["ECG", "outside"]);
    expect((await searchOrderableTests(db, "cbc")).map((r) => r.department)).toContain("lab");
  });

  it("lab fee Free: completing the consult orders the advised lab tests at ₹0, once — ECG is not ordered", async () => {
    await setFeeSwitch(db, owner, "lab", true, BEFORE);
    const v = await visitAdvising(["CBC", "HBA1C", "OUT:ECG"]);
    const result = await orderFreeTests(db, v.encounterId, fx.pathologist.doctorId, AT, fx.decls);
    expect(result?.lab?.itemIds).toHaveLength(2);
    expect(result?.routed.outside).toEqual([serviceIdForOutsideCode("ECG")]);
    expect(result?.lab?.invoice.netPayablePaise).toBe(0);
    const items = await itemsOf(v.visitNo);
    expect(items.map((i) => i.serviceId).sort()).toEqual([serviceIdForLabCode("CBC"), serviceIdForLabCode("HBA1C")].sort());
    /** Placed by the system under the free-test protocol, for the doctor who advised. */
    expect(new Set(items.map((i) => `${i.kind}/${i.orderedByType}/${i.authority}`))).toEqual(new Set(["lab/system/protocol"]));
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, result!.lab!.invoice.invoiceId));
    expect(inv).toBeDefined();
    const ev = await db.select().from(events).where(eq(events.name, "ordering.free_tests_ordered"));
    expect(ev.map((e) => e.payload)).toEqual([{ encounterNo: v.visitNo, labTests: 2, imagingTests: 0, outsideTests: 1, skipped: 0 }]);

    /** A redelivered completion, or a consult completed again, orders nothing more. */
    expect(await orderFreeTests(db, v.encounterId, fx.pathologist.doctorId, AT, fx.decls)).toBeNull();
    /** The lab removed HbA1c: a later completion does not bring it back. */
    await db.update(orderItems).set({ status: "cancelled" }).where(eq(orderItems.serviceId, serviceIdForLabCode("HBA1C")));
    expect(await orderFreeTests(db, v.encounterId, fx.pathologist.doctorId, AT, fx.decls)).toBeNull();
    expect(await itemsOf(v.visitNo)).toHaveLength(2);
  });

  it("lab fee charged: nothing is ordered automatically — the desk converts and bills as before", async () => {
    const v = await visitAdvising(["CBC"]);
    expect(await orderFreeTests(db, v.encounterId, fx.pathologist.doctorId, AT, fx.decls)).toBeNull();
    /** Switched off only AFTER the consult was completed: that completion was charged. */
    await setFeeSwitch(db, owner, "lab", true, new Date(AT.getTime() + 60_000));
    expect(await orderFreeTests(db, v.encounterId, fx.pathologist.doctorId, AT, fx.decls)).toBeNull();
    expect(await itemsOf(v.visitNo)).toEqual([]);
  });

  it("a consent test (HIV) is never ordered by the system: it is skipped and the rest still go", async () => {
    await setFeeSwitch(db, owner, "lab", true, BEFORE);
    const v = await visitAdvising(["CBC", "HIV"]);
    const result = await orderFreeTests(db, v.encounterId, fx.pathologist.doctorId, AT, fx.decls);
    expect(result?.lab?.itemIds).toHaveLength(1);
    expect(result?.skipped.map((s) => [s.code, s.serviceIds])).toEqual([["consent_required", [serviceIdForLabCode("HIV")]]]);
    expect((await itemsOf(v.visitNo)).map((i) => i.serviceId)).toEqual([serviceIdForLabCode("CBC")]);
  });

  it("the seam takes any registered episode series: a doctor orders a CBC on an IPD-style `I` number", async () => {
    const unregister = registerEncounterResolver("I", async (_e, no) => (no === "I2608290001" ? { patientId: fx.patientId, intendedPayer: "self" } : null));
    try {
      const result = await orderTests(db, fx.pathologist.actor, fx.decls, {
        patientId: fx.patientId, encounterNo: "I2608290001", serviceDate: "2026-08-29",
        orderingClinicianId: fx.pathologist.doctorId, serviceIds: [serviceIdForLabCode("CBC"), serviceIdForOutsideCode("ECG")],
        indication: "fever",
      }, AT);
      expect(result.skipped).toEqual([]);
      expect(result.lab?.encounterNo).toBe("I2608290001");
      expect(result.routed.outside).toEqual([serviceIdForOutsideCode("ECG")]);
      const items = await itemsOf("I2608290001");
      expect(items.map((i) => [i.serviceId, i.kind, i.orderedByType])).toEqual([[serviceIdForLabCode("CBC"), "lab", "user"]]);
    } finally {
      unregister();
    }
  });
});

describe("ordering: the outside catalogue (decision 0065)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  it("seeds the owner's ten once, never overwriting an edit; in-hospital needs a department", async () => {
    expect(await seedOutsideTests(db, seedActor)).toEqual({ added: OUTSIDE_TEST_SEEDS.length });
    await saveOutsideTest(db, owner, { code: "ECG", nameEn: "ECG", site: "in_hospital", department: "Cardiology" });
    expect(await seedOutsideTests(db, seedActor)).toEqual({ added: 0 });
    const [ecg] = await db.select().from(outsideTests).where(eq(outsideTests.code, "ECG"));
    expect([ecg?.site, ecg?.department, ecg?.nameEn]).toEqual(["in_hospital", "Cardiology", "ECG"]);
    const [svc] = await db.select().from(services).where(eq(services.id, serviceIdForOutsideCode("ECG")));
    expect([svc?.code, svc?.category, svc?.name]).toEqual(["OUT-ECG", "investigation", "ECG"]);
    await expect(saveOutsideTest(db, owner, { code: "EEG", nameEn: "EEG", site: "in_hospital" })).rejects.toBeInstanceOf(OutsideTestError);
    /** Switched off: no longer routed outside, so the slip and the search drop it. */
    await saveOutsideTest(db, owner, { code: "TMT", nameEn: "Treadmill test (TMT)", active: false });
    expect((await routeTests(db, [serviceIdForOutsideCode("TMT")])).unknown).toEqual([serviceIdForOutsideCode("TMT")]);
    expect(await db.select().from(events).where(and(eq(events.name, "ordering.outside_test_saved")))).toHaveLength(OUTSIDE_TEST_SEEDS.length + 2);
  });
});

describe("ordering: the imaging side (decision 0065)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); });

  it("imaging fee Free: the advised X-ray is ordered by itself, and a study ordered while free is authorised `free`", async () => {
    const fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    try {
      await seedBillingBase(db);
      await setFeeSwitch(db, owner, "imaging", true, new Date(NOW.getTime() - 60_000));
      const [enc] = await db.select().from(opdEncounters).where(eq(opdEncounters.visitNo, fx.visitNo));
      await db.update(opdEncounters).set({
        advisedTests: [{ serviceId: fx.services["XR-CHEST"]!, code: "XR-CHEST", name: "X-ray chest", pricePaise: 0 }],
        diagnosis: "cough for three weeks",
      }).where(eq(opdEncounters.id, enc!.id));
      const result = await orderFreeTests(db, enc!.id, "dr-consultant", NOW, fx.decls);
      expect(result?.imaging?.itemIds).toHaveLength(1);
      expect(result?.lab).toBeNull();
      const rows = await db.select({ kind: orders.kind, indication: orders.indication, by: orders.orderedByType })
        .from(orders).where(inArray(orders.encounterNo, [fx.visitNo]));
      expect(rows).toEqual([{ kind: "imaging", indication: "cough for three weeks", by: "system" }]);
      expect(await imagingFreeAt(db, NOW)).toBe(true);
      expect(await imagingFreeAt(db, new Date(NOW.getTime() - 120_000))).toBe(false);
    } finally {
      fx.unregister();
    }
  });
});
