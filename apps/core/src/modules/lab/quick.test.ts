import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  events, labAnalytes, permissions, phiAccessLog, rolePermissions, labOrderableAnalytes, labOrderables, labQuickReports, labReferenceRanges, patients,
  registrationConfig, services,
} from "../../kernel/db/schema";
import { mkUser } from "../../../test/helpers/opd";
import {
  getQuickReport, quickCatalogue, quickQueue, quickRanges, quickReportsForPatient, saveQuickResults, startQuick,
} from "./quick";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * QUICK MODE (decision 0061). Start puts a patient in the queue only with tests and blood collected;
 * the bench's form holds every parameter of the chosen tests; the flag comes from the same range
 * book and `flagFor` the bench uses, by the patient's sex and age; an absurd value is refused; a
 * reported row leaves the waiting list and can be edited; the event log carries no value.
 */
const ACTOR: Actor = { type: "user", id: "01USER0000000000000000001" } as Actor;
const ASHA = "01PATIENT0000000000000001";
const RAVI = "01PATIENT0000000000000002";
const CBC = "01SERVICE0000000000000001";
const NOW = new Date("2026-10-09T06:00:00Z");

describe("lab quick entry", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let hb: string;
  let wbc: string;

  const start = (patientId = ASHA, at = NOW) => withTx(db, (tx) => startQuick(tx, ACTOR, {
    patientId, encounterNo: "V2610090001", serviceIds: [CBC], bloodCollected: true,
  }, at));

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await db.insert(patients).values([
      { id: ASHA, uhid: "HMS-00000001-5", name: "Asha Devi", sex: "female", administrativeGender: "female",
        dob: new Date("1990-01-01T00:00:00Z"), createdBy: ACTOR.id, updatedBy: ACTOR.id },
      { id: RAVI, uhid: "HMS-00000002-3", name: "Ravi Kumar", sex: "male", administrativeGender: "male",
        dob: new Date("1985-01-01T00:00:00Z"), createdBy: ACTOR.id, updatedBy: ACTOR.id },
    ]);
    await db.insert(services).values({
      id: CBC, code: "CBC", name: "Complete blood count", category: "investigation", createdBy: ACTOR.id, updatedBy: ACTOR.id,
    });
    await db.insert(labOrderables).values({
      serviceId: CBC, code: "CBC", nameEn: "Complete blood count", discipline: "haematology",
      specimenType: "whole_blood", container: "edta", tatMinutesRoutine: 240, createdBy: ACTOR.id, updatedBy: ACTOR.id,
    });
    hb = newId();
    wbc = newId();
    await db.insert(labAnalytes).values([
      { id: hb, code: "HB", nameEn: "Haemoglobin", resultType: "numeric", unit: "g/dL", absurdLow: "1", absurdHigh: "25",
        criticalLow: "5", createdBy: ACTOR.id, updatedBy: ACTOR.id },
      { id: wbc, code: "WBC", nameEn: "Total leucocyte count", resultType: "numeric", unit: "/µL",
        createdBy: ACTOR.id, updatedBy: ACTOR.id },
    ]);
    await db.insert(labOrderableAnalytes).values([
      { serviceId: CBC, analyteId: hb, position: 1 }, { serviceId: CBC, analyteId: wbc, position: 2 },
    ]);
    const range = { ageMinDays: 0, ageMaxDays: 40000, source: "test", effectiveFrom: "2026-01-01", createdBy: ACTOR.id };
    await db.insert(labReferenceRanges).values([
      { id: newId(), analyteId: hb, sex: "female", low: "12", high: "15", ...range },
      { id: newId(), analyteId: hb, sex: "male", low: "13", high: "17", ...range },
      { id: newId(), analyteId: wbc, sex: "any", low: "4000", high: "11000", ...range },
    ]);
  });

  it("the catalogue lists the test with its parameters in report order", async () => {
    const c = await quickCatalogue(db);
    expect(c.tests).toEqual([{ serviceId: CBC, code: "CBC", nameEn: "Complete blood count", analyteIds: [hb, wbc] }]);
    expect(c.analytes.map((a) => a.code).sort()).toEqual(["HB", "WBC"]);
  });

  it("ranges resolve by the patient's sex: Asha gets the female band, Ravi the male one", async () => {
    const [asha] = await quickRanges(db, ASHA, [hb], NOW);
    const [ravi] = await quickRanges(db, RAVI, [hb], NOW);
    expect([asha!.low, asha!.high]).toEqual(["12.0000", "15.0000"]);
    expect([ravi!.low, ravi!.high]).toEqual(["13.0000", "17.0000"]);
  });

  it("Start refuses without blood collected or without a test; with both the patient waits in the queue", async () => {
    await expect(withTx(db, (tx) => startQuick(tx, ACTOR, {
      patientId: ASHA, encounterNo: null, serviceIds: [CBC], bloodCollected: false,
    }, NOW))).rejects.toMatchObject({ code: "blood_not_collected" });
    await expect(withTx(db, (tx) => startQuick(tx, ACTOR, {
      patientId: ASHA, encounterNo: null, serviceIds: [], bloodCollected: true,
    }, NOW))).rejects.toMatchObject({ code: "no_tests" });
    await expect(withTx(db, (tx) => startQuick(tx, ACTOR, {
      patientId: ASHA, encounterNo: null, serviceIds: ["01SERVICE0000000000000099"], bloodCollected: true,
    }, NOW))).rejects.toMatchObject({ code: "test_not_found" });

    const row = await start();
    expect(row).toMatchObject({ status: "waiting", encounterNo: "V2610090001", patient: { uhid: "HMS-00000001-5", display: "Asha Devi" } });
    const q = await quickQueue(db, ACTOR, NOW);
    expect(q.waiting.map((r) => r.id)).toEqual([row.id]);
    expect(q.reportedToday).toEqual([]);
  });

  it("the bench's form holds every parameter of the chosen tests in report order", async () => {
    const row = await start();
    const r = await getQuickReport(db, ACTOR, row.id);
    expect(r.analyteIds).toEqual([hb, wbc]);
    expect(r.groups).toEqual([{ title: "Complete blood count", analyteIds: [hb, wbc] }]);
    expect(r.lines).toEqual([]);
  });

  it("saving results flags them on the server (Hb 9.2 L, WBC 15000 H, Hb 4 LL) and moves the row to reported", async () => {
    const row = await start();
    const r = await withTx(db, (tx) => saveQuickResults(tx, ACTOR, {
      id: row.id, summary: "Hb low", lines: [{ analyteId: hb, value: "9.2" }, { analyteId: wbc, value: "15000" }],
    }, NOW));
    expect(r.lines.map((l) => [l.code, l.value, l.flag])).toEqual([["HB", "9.2", "L"], ["WBC", "15000", "H"]]);
    expect([r.status, r.summary, r.reportedBy]).toEqual(["reported", "Hb low", ACTOR.id]);
    const q = await quickQueue(db, ACTOR, NOW);
    expect([q.waiting.length, q.reportedToday.map((x) => x.id)]).toEqual([0, [row.id]]);

    const crit = await withTx(db, (tx) => saveQuickResults(tx, ACTOR, {
      id: row.id, summary: "", lines: [{ analyteId: hb, value: "4" }],
    }, NOW));
    expect(crit.lines[0]!.flag).toBe("LL");

    const logged = await db.select().from(events).where(eq(events.name, "lab.quick_reported"));
    expect(logged.map((e) => (e.payload as { edit: boolean }).edit)).toEqual([false, true]);
    expect(JSON.stringify(logged.map((e) => e.payload))).not.toContain("9.2");
    expect(await db.select().from(events).where(eq(events.name, "lab.quick_started"))).toHaveLength(1);
  });

  it("blank values are dropped; a typo outside the absurd envelope and a non-number are refused", async () => {
    const row = await start();
    const r = await withTx(db, (tx) => saveQuickResults(tx, ACTOR, {
      id: row.id, summary: "", lines: [{ analyteId: hb, value: "13" }, { analyteId: wbc, value: "  " }],
    }, NOW));
    expect(r.lines.map((l) => [l.code, l.flag])).toEqual([["HB", "N"]]);

    await expect(withTx(db, (tx) => saveQuickResults(tx, ACTOR, {
      id: row.id, summary: "", lines: [{ analyteId: hb, value: "92" }],
    }, NOW))).rejects.toMatchObject({ code: "value_absurd" });
    await expect(withTx(db, (tx) => saveQuickResults(tx, ACTOR, {
      id: row.id, summary: "", lines: [{ analyteId: hb, value: "abc" }],
    }, NOW))).rejects.toMatchObject({ code: "value_not_numeric" });
  });

  it("a patient started days ago is still waiting; yesterday's report is not in today's reprint list", async () => {
    const old = await start(ASHA, new Date(NOW.getTime() - 3 * 86_400_000));
    const done = await start(RAVI, new Date(NOW.getTime() - 86_400_000));
    await withTx(db, (tx) => saveQuickResults(tx, ACTOR, { id: done.id, summary: "", lines: [] }, new Date(NOW.getTime() - 86_400_000)));
    const q = await quickQueue(db, ACTOR, NOW);
    expect(q.waiting.map((r) => r.id)).toEqual([old.id]);
    expect(q.reportedToday).toEqual([]);
    expect(await db.select().from(labQuickReports)).toHaveLength(2);
  });

  it("the profile/doctor read: reported reports only, newest first, logged; a sensitive test is omitted without the restricted grant", async () => {
    const HIV = "01SERVICE0000000000000009";
    await db.insert(services).values({ id: HIV, code: "HIV", name: "HIV 1 & 2", category: "investigation", createdBy: ACTOR.id, updatedBy: ACTOR.id });
    await db.insert(labOrderables).values({
      serviceId: HIV, code: "HIV", nameEn: "HIV 1 & 2", discipline: "serology", specimenType: "serum", container: "plain",
      tatMinutesRoutine: 240, sensitive: true, createdBy: ACTOR.id, updatedBy: ACTOR.id,
    });
    const doctor = await mkUser(db, "dr.quick", ["doctor"]);

    const waiting = await start();
    const done = await start(ASHA, new Date(NOW.getTime() - 3_600_000));
    await withTx(db, (tx) => saveQuickResults(tx, ACTOR, { id: done.id, summary: "Hb low", lines: [{ analyteId: hb, value: "9.2" }] }, NOW));
    const hiv = await withTx(db, (tx) => startQuick(tx, ACTOR, { patientId: ASHA, encounterNo: null, serviceIds: [HIV], bloodCollected: true }, NOW));
    await withTx(db, (tx) => saveQuickResults(tx, ACTOR, { id: hiv.id, summary: "Non-reactive", lines: [] }, new Date(NOW.getTime() + 60_000)));

    const seen = await quickReportsForPatient(db, doctor.actor, ASHA, NOW);
    expect(seen.map((r) => r.id)).toEqual([done.id]);
    expect(seen.map((r) => r.id)).not.toContain(waiting.id);
    expect([seen[0]!.summary, seen[0]!.lines[0]!.flag]).toEqual(["Hb low", "L"]);
    expect(await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "lab.quick_reports"))).toHaveLength(1);

    await db.insert(permissions).values({ permission: "orders.read.restricted", module: "orders" }).onConflictDoNothing();
    await db.insert(rolePermissions).values({ roleKey: "doctor", permission: "orders.read.restricted" });
    expect((await quickReportsForPatient(db, doctor.actor, ASHA, NOW)).map((r) => r.id)).toEqual([hiv.id, done.id]);
    expect(await quickReportsForPatient(db, doctor.actor, RAVI, NOW)).toEqual([]);
  });
});
