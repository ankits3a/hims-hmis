import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { labAnalytes, labResults } from "../../kernel/db/schema";
import { LabError } from "./errors";
import { getReport, publishReport } from "./reports";
import { enterResult } from "./results";
import { verifyResult } from "./verify";
import { verifyWorklist } from "./worklist";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * #703 — FULL lab mode's culture report carries the same structured antibiotic sensitivity table as the quick chain
 * (#704): entered at the bench on the `MIC_AST` line (S / I / R per antibiotic, optional MIC), shown on the bench and
 * verify worklists, and carried into the signed report's snapshot for printing. The line's text value becomes a short
 * summary, so every reader that only knows text keeps working.
 */
const AT = new Date("2026-08-30T06:00:00Z");

describe("Full lab mode — antibiotic sensitivity table (#703)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db, "V2608290001", { standardCodes: ["CS_URINE"] });
    await grantLabResultPermissions(db, fx);
  });
  afterEach(() => { fx.unregister(); });

  const analyteId = async (code: string): Promise<string> =>
    (await db.select({ id: labAnalytes.id }).from(labAnalytes).where(eq(labAnalytes.code, code)))[0]!.id;
  const ROWS = [
    { antibiotic: "AMP", result: "R", mic: "32" },
    { antibiotic: "AMC", result: "", mic: null },
    { antibiotic: "NIT", result: "S", mic: null },
    { antibiotic: "CIP", result: "R", mic: " 4 " },
    { antibiotic: "MEM", result: "S", mic: "0.25" },
  ];
  const CLEAN = [
    { antibiotic: "AMP", result: "R", mic: "32" },
    { antibiotic: "NIT", result: "S", mic: null },
    { antibiotic: "CIP", result: "R", mic: "4" },
    { antibiotic: "MEM", result: "S", mic: "0.25" },
  ];

  it("the MIC_AST line saves the table, its value is a summary, and the verify worklist shows the rows", async () => {
    const run = await runLabOrder(db, fx, ["CS_URINE"], { at: AT, verify: false, skip: ["MIC_AST"] });
    const out = await enterResult(db, fx.bench.actor, {
      orderItemId: run.itemIds[0]!, analyteId: await analyteId("MIC_AST"), value: "table", entryMode: "manual", ast: ROWS,
    }, AT);
    const [row] = await db.select().from(labResults).where(eq(labResults.id, out.resultId));
    expect(row!.ast).toEqual(CLEAN);
    expect(row!.valueText).toBe("Resistant: Ampicillin, Ciprofloxacin · Sensitive: Nitrofurantoin, Meropenem");
    const line = (await verifyWorklist(db, fx.pathologist.actor)).find((r) => r.orderItemId === run.itemIds[0])!
      .analytes.find((a) => a.code === "MIC_AST")!;
    expect(line.ast).toEqual(CLEAN);
  });

  it("refuses a bad row naming it, a table on any other line, and a table with no filled row", async () => {
    const run = await runLabOrder(db, fx, ["CS_URINE"], { at: AT, verify: false, skip: ["MIC_AST"] });
    const item = run.itemIds[0]!;
    const code = async (p: Promise<unknown>): Promise<[string, string]> => {
      const e = await p.then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(LabError);
      return [(e as LabError).code, (e as LabError).message];
    };
    const bad = await code(enterResult(db, fx.bench.actor, {
      orderItemId: item, analyteId: await analyteId("MIC_AST"), value: "t", entryMode: "manual", ast: [{ antibiotic: "AMP", result: "X", mic: null }],
    }, AT));
    expect(bad[0]).toBe("catalogue_invalid");
    expect(bad[1]).toContain("Ampicillin");
    expect((await code(enterResult(db, fx.bench.actor, {
      orderItemId: item, analyteId: await analyteId("MIC_AST"), value: "t", entryMode: "manual", ast: [{ antibiotic: "AMP", result: "", mic: null }],
    }, AT)))[0]).toBe("catalogue_invalid");
    // MIC_ORG was keyed by the run; the table on another analyte of the item refuses.
    const other = await analyteId("MIC_RESMK");
    const run2 = await runLabOrder(db, fx, ["CS_URINE"], { at: AT, verify: false, skip: ["MIC_AST", "MIC_RESMK"], encounterNo: fx.newVisit() });
    expect((await code(enterResult(db, fx.bench.actor, {
      orderItemId: run2.itemIds[0]!, analyteId: other, value: "t", entryMode: "manual", ast: CLEAN,
    }, AT)))[0]).toBe("catalogue_invalid");
  });

  it("the signed report's snapshot carries the table on the MIC_AST line", async () => {
    const run = await runLabOrder(db, fx, ["CS_URINE"], { at: AT, verify: false, skip: ["MIC_AST"] });
    const ast = await enterResult(db, fx.bench.actor, {
      orderItemId: run.itemIds[0]!, analyteId: await analyteId("MIC_AST"), value: "t", entryMode: "manual", ast: ROWS,
    }, AT);
    for (const id of [...run.resultIds, ast.resultId]) await verifyResult(db, fx.pathologist.actor, fx.decls, { resultId: id }, AT);
    const published = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    const report = await getReport(db, fx.pathologist.actor, published.reportId, AT);
    const line = report.snapshot.panels[0]!.analytes.find((a) => a.analyteCode === "MIC_AST")!;
    expect(line.ast).toEqual(CLEAN);
    expect(report.snapshot.panels[0]!.analytes.find((a) => a.analyteCode === "MIC_ORG")!.ast).toBeNull();
  });
});
