import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase, serviceIdForLabCode } from "../../../test/helpers/lab";
import { LAB_CATALOGUE_STANDARD_DATA, seedLabCatalogue } from "../../../scripts/seed-lab-catalogue";
import { withTx } from "../../kernel/db/client";
import { labAnalytes, labQuickReports } from "../../kernel/db/schema";
import { getQuickReport, QuickEntryError, saveQuickResults, startQuick } from "./quick";
import { quickHttp } from "./lab-quick.controller";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { SaveQuickResultsInput } from "./quick";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER 2026-10-12 — THE ANTIBIOTIC SENSITIVITY TABLE (spec `SPEC-lab-ast-table-2026-10-12.md`): a
 * culture's rows are saved with the quick report and read back; blank rows are dropped; a result
 * other than S/I/R or a MIC that is not a plain number is refused naming the row (400 over HTTP);
 * a "No growth" culture stores no table; only a C&S test of the report carries one.
 */
describe("quick report — antibiotic sensitivity table (owner 2026-10-12)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  const URINE = serviceIdForLabCode("CS_URINE");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  /** The golden fixture holds no culture; the standard menu's C&S and fungal culture tests are added. */
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    const S = LAB_CATALOGUE_STANDARD_DATA;
    const orderables = S.orderables.filter((o) => ["CS_URINE", "CS_BLOOD", "FUNG_CUL"].includes(o.code));
    const codes = new Set(orderables.flatMap((o) => o.analyteCodes));
    await seedLabCatalogue(db, fx.desk.actor, {
      analytes: S.analytes.filter((a) => codes.has(a.code)), orderables,
      referenceRanges: S.referenceRanges.filter((r) => codes.has(r.analyteCode)), reflexRules: [],
    });
  });
  afterEach(() => { fx.unregister(); });

  const start = (codes: string[] = ["CS_URINE"]) => withTx(db, (tx) => startQuick(tx, fx.desk.actor, {
    patientId: fx.patientId, encounterNo: fx.encounterNo, serviceIds: codes.map(serviceIdForLabCode), bloodCollected: true,
  }));
  const save = (input: SaveQuickResultsInput) => withTx(db, (tx) => saveQuickResults(tx, fx.desk.actor, input));
  async function organismId(): Promise<string> {
    const [a] = await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, "MIC_ORG"));
    return a!.id;
  }
  async function refusal(p: Promise<unknown>): Promise<QuickEntryError> {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(QuickEntryError);
    return e as QuickEntryError;
  }

  it("saves 3 S and 2 R with MICs, drops the blank rows, and reads them back in order", async () => {
    const { id } = await start();
    const org = await organismId();
    const saved = await save({
      id, summary: "", lines: [{ analyteId: org, value: "Escherichia coli" }],
      ast: [{
        serviceId: URINE, rows: [
          { antibiotic: "AMP", result: "R", mic: "32" },
          { antibiotic: "AMC", result: "", mic: null },
          { antibiotic: "NIT", result: "S", mic: null },
          { antibiotic: "CIP", result: "R", mic: " 4 " },
          { antibiotic: "FOS", result: null, mic: "8" },
          { antibiotic: "MEM", result: "S", mic: "0.25" },
          { antibiotic: "Cefixime (local)", result: "S", mic: null },
        ],
      }],
    });
    const want = [
      { antibiotic: "AMP", result: "R", mic: "32" },
      { antibiotic: "NIT", result: "S", mic: null },
      { antibiotic: "CIP", result: "R", mic: "4" },
      { antibiotic: "MEM", result: "S", mic: "0.25" },
      { antibiotic: "Cefixime (local)", result: "S", mic: null },
    ];
    expect(saved.ast).toEqual([{ serviceId: URINE, rows: want }]);
    expect((await getQuickReport(db, fx.desk.actor, id)).ast).toEqual([{ serviceId: URINE, rows: want }]);
    const [row] = await db.select({ ast: labQuickReports.ast }).from(labQuickReports).where(eq(labQuickReports.id, id));
    expect(row!.ast).toEqual([{ serviceId: URINE, rows: want }]);

    /** A screen that sends no `ast` (an older app) leaves the stored table as it is. */
    const again = await save({ id, summary: "x", lines: [{ analyteId: org, value: "Escherichia coli" }] });
    expect(again.ast).toEqual([{ serviceId: URINE, rows: want }]);
  });

  it("refuses a result other than S, I or R, and a MIC that is not a plain number, naming the row", async () => {
    const { id } = await start();
    const bad = await refusal(save({
      id, summary: "", lines: [],
      ast: [{ serviceId: URINE, rows: [{ antibiotic: "AMP", result: "S", mic: null }, { antibiotic: "CIP", result: "X", mic: null }] }],
    }));
    expect(bad.code).toBe("ast_invalid");
    expect(bad.message).toContain("Antibiotic row 2 (Ciprofloxacin): the result must be S, I or R");
    for (const mic of ["≤0.25", ">32", "0.5 µg/mL", "abc"]) {
      const e = await refusal(save({ id, summary: "", lines: [], ast: [{ serviceId: URINE, rows: [{ antibiotic: "MEM", result: "S", mic }] }] }));
      expect(e.code).toBe("ast_invalid");
      expect(e.message).toContain("row 1 (Meropenem): the MIC must be a plain number");
    }
    /** Over HTTP the refusal is a 400 that carries the same words. */
    let status = 0; let body: unknown = null;
    try { quickHttp(bad); } catch (h) { status = (h as { getStatus(): number }).getStatus(); body = (h as { getResponse(): unknown }).getResponse(); }
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "ast_invalid", message: bad.message });
    /** Nothing was stored by any refused save. */
    expect((await getQuickReport(db, fx.desk.actor, id)).ast).toEqual([]);
  });

  it("stores no table when the organism reads “No growth” or “Sterile”", async () => {
    const { id } = await start();
    const org = await organismId();
    const rows = [{ antibiotic: "AMP", result: "R", mic: null }];
    for (const word of ["No growth after 48 hours", "STERILE"]) {
      const out = await save({ id, summary: "", lines: [{ analyteId: org, value: word }], ast: [{ serviceId: URINE, rows }] });
      expect(out.ast).toEqual([]);
    }
    /** A table saved before, then the organism changed to "No growth" by a screen that sends no table: cleared. */
    await save({ id, summary: "", lines: [{ analyteId: org, value: "Klebsiella pneumoniae" }], ast: [{ serviceId: URINE, rows }] });
    expect((await getQuickReport(db, fx.desk.actor, id)).ast).toHaveLength(1);
    expect((await save({ id, summary: "", lines: [{ analyteId: org, value: "no growth" }] })).ast).toEqual([]);
  });

  it("a table belongs only to a C&S test of this report — not fungal culture, not another report's test", async () => {
    const { id } = await start(["CS_URINE", "FUNG_CUL"]);
    const rows = [{ antibiotic: "AMP", result: "S", mic: null }];
    for (const serviceId of [serviceIdForLabCode("FUNG_CUL"), serviceIdForLabCode("CS_BLOOD")]) {
      expect((await refusal(save({ id, summary: "", lines: [], ast: [{ serviceId, rows }] }))).code).toBe("ast_invalid");
    }
    const tooMany = Array.from({ length: 41 }, (_, i) => ({ antibiotic: `Drug ${String(i)}`, result: "S", mic: null }));
    expect((await refusal(save({ id, summary: "", lines: [], ast: [{ serviceId: URINE, rows: tooMany }] }))).message).toContain("At most 40");
  });
});
