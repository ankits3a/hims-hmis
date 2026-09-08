import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedLabDeskBase } from "./helpers/lab";
import {
  labAnalytes, labCatalogueImports, labReferenceRanges, tariffItems,
} from "../src/kernel/db/schema";
import { putReferenceRange, rangesFor, upsertAnalyte } from "../src/modules/lab";
import {
  applyCatalogue, parseCatalogueCsv, planCatalogue, splitCsvLine,
} from "../scripts/import-lab-catalogue";
import { serviceIdForLabCode } from "../scripts/seed-lab-catalogue";
import type { LabDeskFixture } from "./helpers/lab";
import type { Db } from "../src/kernel/db/client";

/**
 * `import:lab-catalogue` — ROADMAP v2 §2's second loader, against
 * `docs/superpowers/specs/2026-09-07-spreadsheet-loader-design.md`.
 *
 * **The suite is organised by the note's rules**, because that is what a successor will be checking
 * this against — and because rule 1's test is the one that separates this loader from the one it is
 * modelled on, which still applies a file row by row.
 */
const PROV = { fileNames: "t.csv", fileHash: "hash-1", importedBy: "dr.curator" };

describe("import:lab-catalogue", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  /* ───────────────── the file, before any database is consulted ───────────────── */

  /**
   * A COMMA INSIDE A QUOTED CELL, which `import-item-master`'s `split(",")` does not survive. For an
   * item master that is a simplification; for a range book it is a defect — `Tietz, 6th ed.` is what
   * a pathologist actually writes in a source column, and losing everything after the comma would
   * silently truncate the provenance of a clinical band.
   */
  it("parses a quoted cell containing a comma", () => {
    expect(splitCsvLine('a,"Tietz, 6th ed.",c')).toEqual(["a", "Tietz, 6th ed.", "c"]);
    expect(splitCsvLine('x,"he said ""hi""",z')).toEqual(["x", 'he said "hi"', "z"]);
  });

  /**
   * §4 — AN UNKNOWN COLUMN REFUSES THE FILE. `critical_lo` where the loader wants `critical_low`
   * would otherwise import every row with a blank critical band and report complete success: a thing
   * that reads green while being false, discovered by a phone call that never came at 02:00.
   */
  it("§4: refuses the file for an unknown column, naming it, and writes nothing", () => {
    const csv = "analyte_code,sex,age_min_days,age_max_days,source,effective_from,critical_lo\n"
      + "GLU,any,0,36500,Tietz,2026-01-01,2.5\n";
    const parsed = parseCatalogueCsv("ranges", csv, "r.csv");
    expect(parsed.reasons).toEqual(["unknown_columns:critical_lo"]);
  });

  /** §4 — the FILE contradicting itself is the operator's to resolve; last-wins would silently pick. */
  it("§4: refuses two rows for the same band rather than choosing a winner", () => {
    const csv = "analyte_code,sex,age_min_days,age_max_days,source,effective_from,low,high\n"
      + "GLU,any,0,36500,Tietz,2026-01-01,70,110\n"
      + "GLU,any,0,36500,Tietz,2026-01-01,70,140\n";
    const parsed = parseCatalogueCsv("ranges", csv, "r.csv");
    expect(parsed.rows[1]!.reasons).toEqual(["duplicate_also_on_line:2"]);
  });

  /**
   * §7 — A RANGE WITH NO SOURCE IS REFUSED, and the interesting half is WHERE.
   * `lab_reference_ranges.source` is already NOT NULL, so the database would refuse it too — but as
   * a raw error at APPLY time, mid-file, after the operator was told the file was fine. Refusing it
   * at parse time is the whole difference, and it is §2's rule in its sharpest instance.
   */
  it("§7: refuses a reference range with a blank source, at parse time", () => {
    const csv = "analyte_code,sex,age_min_days,age_max_days,source,effective_from,low,high\n"
      + "GLU,any,0,36500,,2026-01-01,70,110\n";
    const parsed = parseCatalogueCsv("ranges", csv, "r.csv");
    expect(parsed.rows[0]!.reasons).toEqual(["source_required"]);
  });

  /* ───────────────── the plan, which must know what the write path knows ───────────────── */

  /**
   * §2 — THE JUDGEMENT IS ONLY WORTH WHAT IT KNOWS. `upsertOrderable` throws `unknown_analyte`, so
   * a file naming a code that does not exist would have died at APPLY time, half applied. The
   * planner mirrors the refusal and the operator is told before anything is written.
   */
  it("§2: an orderable naming an unknown analyte is refused at PLAN time", async () => {
    const csv = "code,name_en,discipline,specimen_type,container,tat_minutes_routine,analyte_codes\n"
      + "PANEL1,Panel one,biochemistry,serum,sst,60,NOSUCH\n";
    const plan = await planCatalogue(db, [parseCatalogueCsv("orderables", csv, "o.csv")]);
    expect(plan.refusals).toBe(1);
    expect(plan.rows[0]!.reasons).toEqual(["unknown_analyte_codes:NOSUCH"]);
  });

  /** An analyte arriving in the SAME import counts as known — otherwise a correct file is refused. */
  it("§2: an orderable may name an analyte that arrives in the same import", async () => {
    const analytes = "code,name_en,result_type,unit\nNEWA,New analyte,numeric,mg/dL\n";
    const orderables = "code,name_en,discipline,specimen_type,container,tat_minutes_routine,analyte_codes\n"
      + "PANEL2,Panel two,biochemistry,serum,sst,60,NEWA\n";
    const plan = await planCatalogue(db, [
      parseCatalogueCsv("analytes", analytes, "a.csv"),
      parseCatalogueCsv("orderables", orderables, "o.csv"),
    ]);
    expect(plan.refusals).toBe(0);
    expect(plan.creates).toBe(2);
  });

  /**
   * §7 — THE PRICE IS READ, COUNTED AND NEVER WRITTEN. A figure that reads as a CA-approved tariff
   * while being a guess out of a spreadsheet is the census-row failure with money attached, so the
   * plan reports the column rather than silently ignoring it — silence would let an operator believe
   * a price was loaded.
   */
  it("§7: a price column is counted and reported, and no price is ever written", async () => {
    const analytes = "code,name_en,result_type\nPRA,Priced analyte,numeric\n";
    const orderables = "code,name_en,discipline,specimen_type,container,tat_minutes_routine,analyte_codes,price_paise\n"
      + "PRICED,Priced test,biochemistry,serum,sst,60,PRA,45000\n";
    const files = [
      parseCatalogueCsv("analytes", analytes, "a.csv"),
      parseCatalogueCsv("orderables", orderables, "o.csv"),
    ];
    const plan = await planCatalogue(db, files);
    expect(plan.pricesSeen).toBe(1);
    expect(plan.refusals).toBe(0);

    await applyCatalogue(db, fx.pathologist.actor, files, plan, PROV);
    /**
     * The orderable exists; the price went nowhere. Scoped to THIS service rather than asserting an
     * empty table — `seedLabDeskBase` prices its own catalogue, so a global emptiness assertion
     * would be false for a reason that has nothing to do with the loader.
     */
    const priced = await db.select().from(tariffItems)
      .where(eq(tariffItems.serviceId, serviceIdForLabCode("PRICED")));
    expect(priced).toEqual([]);
  });

  /* ───────────────── §1 — the rule this loader exists to get right ───────────────── */

  /**
   * ═══ THE DISCRIMINATING TEST, AND IT HAD TO BE CHOSEN RATHER THAN WRITTEN THE OBVIOUS WAY ═══
   *
   * Asserting that apply REJECTS passes against both versions — the throw happens either way. What
   * separates one transaction from a transaction per row is **the state of an EARLIER row
   * afterwards**.
   *
   * So the failure is induced the way it would really happen (§1): plan two range creates, let
   * something else take an overlapping band in the window between planning and applying, then apply.
   * `putReferenceRange` refuses the SECOND with `range_overlap` — and the FIRST must be gone with it.
   *
   * Against a per-row loader this test fails: row one is committed and stays.
   */
  it("§1: a failure on the SECOND row leaves the FIRST one unwritten — one transaction, not one per row", async () => {
    const analyteId = await upsertAnalyte(db, fx.pathologist.actor, {
      code: "TXN", nameEn: "Transaction probe", resultType: "numeric", unit: "mg/dL",
    });
    const csv = "analyte_code,sex,age_min_days,age_max_days,source,effective_from,low,high\n"
      + "TXN,male,0,36500,Tietz,2026-01-01,70,110\n"
      + "TXN,female,0,36500,Tietz,2026-01-01,65,100\n";
    const files = [parseCatalogueCsv("ranges", csv, "r.csv")];
    const plan = await planCatalogue(db, files);
    expect(plan.refusals).toBe(0);
    expect(plan.creates).toBe(2);

    /** THE WINDOW. Somebody curates the female band between planning and applying. */
    await putReferenceRange(db, fx.pathologist.actor, {
      analyteId, sex: "female", ageMinDays: 0, ageMaxDays: 36500,
      low: "60", high: "99", source: "curated by hand", effectiveFrom: "2026-01-01",
    });
    const before = await rangesFor(db, analyteId);
    expect(before).toHaveLength(1);

    await expect(applyCatalogue(db, fx.pathologist.actor, files, plan, PROV)).rejects.toThrow();

    /**
     * THE ASSERTION THAT DISCRIMINATES: the MALE band from line 2 must not exist. A loader that
     * opened a transaction per row would have committed it before reaching the row that threw.
     */
    const after = await rangesFor(db, analyteId);
    expect(after.map((r) => r.sex)).toEqual(["female"]);
    expect(after.map((r) => r.source)).toEqual(["curated by hand"]);
    /** And no provenance row survives either — the import did not happen, so it is not recorded. */
    expect(await db.select().from(labCatalogueImports)).toEqual([]);
  });

  /* ───────────────── provenance — the note's own open defect, closed here ───────────────── */

  it("records which file produced the import, per kind, and finishes it", async () => {
    const analytes = "code,name_en,result_type,unit\nPRV,Provenance,numeric,mg/dL\n";
    const ranges = "analyte_code,sex,age_min_days,age_max_days,source,effective_from,low,high\n"
      + "PRV,any,0,36500,\"Tietz, 6th ed.\",2026-01-01,70,110\n";
    const files = [
      parseCatalogueCsv("analytes", analytes, "a.csv"),
      parseCatalogueCsv("ranges", ranges, "r.csv"),
    ];
    const plan = await planCatalogue(db, files);
    expect(plan.refusals).toBe(0);

    const report = await applyCatalogue(db, fx.pathologist.actor, files, plan, PROV);

    const [row] = await db.select().from(labCatalogueImports)
      .where(eq(labCatalogueImports.id, report.importId));
    expect({
      files: row!.fileNames, by: row!.importedBy,
      a: row!.analytesWritten, o: row!.orderablesWritten, r: row!.rangesWritten,
      finished: row!.finishedAt !== null,
    }).toEqual({ files: "t.csv", by: "dr.curator", a: 1, o: 0, r: 1, finished: true });

    /**
     * And the quoted source survived the parser end to end — the comma is still in the database.
     * Selected by THIS analyte: the fixture seeds its own range book, so "the first row in the
     * table" is somebody else's band.
     */
    const [analyte] = await db.select().from(labAnalytes).where(eq(labAnalytes.code, "PRV"));
    const bands = await db.select().from(labReferenceRanges)
      .where(eq(labReferenceRanges.analyteId, analyte!.id));
    expect(bands.map((b) => b.source)).toEqual(["Tietz, 6th ed."]);
  });

  /** The same bytes are the same import: a retried transfer must not read as a second load. */
  it("refuses a second import of the same file hash", async () => {
    const csv = "code,name_en,result_type\nDUP,Dup probe,numeric\n";
    const files = [parseCatalogueCsv("analytes", csv, "a.csv")];
    const plan = await planCatalogue(db, files);
    await applyCatalogue(db, fx.pathologist.actor, files, plan, PROV);

    await expect(applyCatalogue(db, fx.pathologist.actor, files, plan, PROV)).rejects.toThrow();
    expect(await db.select().from(labCatalogueImports)).toHaveLength(1);
  });

  /** A plan carrying refusals may not be applied at all — the guard beside the operator's own. */
  it("refuses to apply a plan that has refusals", async () => {
    const csv = "analyte_code,sex,age_min_days,age_max_days,source,effective_from,low,high\n"
      + "NOSUCH,any,0,36500,Tietz,2026-01-01,70,110\n";
    const files = [parseCatalogueCsv("ranges", csv, "r.csv")];
    const plan = await planCatalogue(db, files);
    expect(plan.refusals).toBe(1);

    await expect(applyCatalogue(db, fx.pathologist.actor, files, plan, PROV)).rejects.toThrow(/refusals/);
    expect(await db.select().from(labAnalytes).where(eq(labAnalytes.code, "NOSUCH"))).toEqual([]);
  });
});
