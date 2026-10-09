import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { newId } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  events, labAnalytes, labOrderableAnalytes, labOrderables, labQuickReports, labReferenceRanges, patients,
  registrationConfig, services,
} from "../../kernel/db/schema";
import { quickCatalogue, quickRanges, quickReportsForPatient, saveQuickReport } from "./quick";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * QUICK ENTRY (decision 0061). The flag comes from the same range book and `flagFor` the bench uses,
 * resolved by the patient's sex and age; an absurd value is refused; the report is editable and the
 * event log records each save without carrying a value.
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

  it("saves a report with server-resolved flags: Hb 9.2 is L, WBC 15000 is H, Hb 4 is LL", async () => {
    const r = await withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      patientId: ASHA, summary: "Hb low", lines: [{ analyteId: hb, value: "9.2" }, { analyteId: wbc, value: "15000" }],
    }, NOW));
    expect(r.lines.map((l) => [l.code, l.value, l.flag])).toEqual([["HB", "9.2", "L"], ["WBC", "15000", "H"]]);
    expect(r.summary).toBe("Hb low");

    const crit = await withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      patientId: ASHA, summary: "", lines: [{ analyteId: hb, value: "4" }],
    }, NOW));
    expect(crit.lines[0]!.flag).toBe("LL");

    const logged = await db.select().from(events).where(eq(events.name, "lab.quick_report_saved"));
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged[0]!.payload)).not.toContain("9.2");
  });

  it("blank values are dropped; a typo outside the absurd envelope and a non-number are refused", async () => {
    const r = await withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      patientId: ASHA, summary: "", lines: [{ analyteId: hb, value: "13" }, { analyteId: wbc, value: "  " }],
    }, NOW));
    expect(r.lines.map((l) => [l.code, l.flag])).toEqual([["HB", "N"]]);

    await expect(withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      patientId: ASHA, summary: "", lines: [{ analyteId: hb, value: "92" }],
    }, NOW))).rejects.toMatchObject({ code: "value_absurd" });
    await expect(withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      patientId: ASHA, summary: "", lines: [{ analyteId: hb, value: "abc" }],
    }, NOW))).rejects.toMatchObject({ code: "value_not_numeric" });
  });

  it("an edit replaces lines and summary; another patient's id cannot reach it", async () => {
    const r = await withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      patientId: ASHA, summary: "first", lines: [{ analyteId: hb, value: "9.2" }],
    }, NOW));
    const edited = await withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      id: r.id, patientId: ASHA, summary: "edited", lines: [{ analyteId: hb, value: "12.5" }],
    }, NOW));
    expect([edited.summary, edited.lines[0]!.flag]).toEqual(["edited", "N"]);

    await expect(withTx(db, (tx) => saveQuickReport(tx, ACTOR, {
      id: r.id, patientId: RAVI, summary: "x", lines: [],
    }, NOW))).rejects.toMatchObject({ code: "report_not_found" });

    expect(await quickReportsForPatient(db, ASHA)).toHaveLength(1);
    expect(await db.select().from(labQuickReports)).toHaveLength(1);
  });
});
