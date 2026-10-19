import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { orderItems, patients, phiAccessLog } from "../../kernel/db/schema";
import { LabError } from "./errors";
import { publishReport } from "./reports";
import { REPORTS_BACK_LIMIT, myReportBack, myReportsBack } from "./reports-back";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * #681 — the phone's "Lab reports back": the set Open loops counts (`waiting.ts` `lab.reportsBack`),
 * listed and opened read-only. The fixture's ordering clinician is its pathologist (`runLabOrder`).
 * Every instant is passed in; nothing here reads the clock.
 */
const AT = new Date("2026-08-30T06:00:00Z");
const SOON = new Date(AT.getTime() + 3600_000);
const NEXT_DAY = new Date(AT.getTime() + 25 * 3600_000);

describe("#681 lab reports back — the doctor's list and one report", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let other: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    other = await mkUser(db, "dr.other", ["doctor"]);
  });
  afterEach(() => { fx.unregister(); });

  const published = async (codes: string[] = ["TSH"], values?: Record<string, string>) => {
    const run = await runLabOrder(db, fx, codes, { at: AT, values });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    return { run, reportId: report.reportId };
  };

  it("lists my published report of the last day with its tests, and nothing once the day has passed", async () => {
    const { run, reportId } = await published();
    const rows = await myReportsBack(db, fx.pathologist.actor, SOON);
    expect(rows.map((r) => r.reportId)).toEqual([reportId]);
    expect(rows[0]!.orderNo).toBe(run.orderNo);
    expect(rows[0]!.tests.length).toBe(1);
    expect(rows[0]!.publishedAt).toBe(AT.toISOString());
    expect(await myReportsBack(db, fx.pathologist.actor, NEXT_DAY)).toEqual([]);
    expect(REPORTS_BACK_LIMIT).toBeGreaterThan(0);
  });

  it("another doctor sees none of it, and opening it by id is refused as unknown", async () => {
    const { reportId } = await published();
    expect(await myReportsBack(db, other.actor, SOON)).toEqual([]);
    await expect(myReportBack(db, other.actor, reportId, SOON)).rejects.toMatchObject({ code: "unknown_report" });
    await expect(myReportBack(db, other.actor, reportId, SOON)).rejects.toBeInstanceOf(LabError);
  });

  it("opening shows the values read-only, carries no money, and writes one PHI read", async () => {
    const { reportId } = await published();
    const before = await db.select().from(phiAccessLog).where(eq(phiAccessLog.actorId, fx.pathologist.id));
    const view = await myReportBack(db, fx.pathologist.actor, reportId, SOON);
    expect(view.panels.length).toBe(1);
    expect(view.panels[0]!.lines.length).toBeGreaterThan(0);
    expect(Object.keys(view).sort()).toEqual(["amended", "encounterNo", "orderNo", "panels", "partial", "patientName", "publishedAt", "reportId", "signedAt", "signedBy", "uhid"]);
    expect(JSON.stringify(view)).not.toMatch(/paise|delivery|invoice|amount/i);
    const after = await db.select().from(phiAccessLog).where(and(eq(phiAccessLog.actorId, fx.pathologist.id), eq(phiAccessLog.surface, "lab.report")));
    expect(after.length).toBe(before.filter((r) => r.surface === "lab.report").length + 1);
  });

  it("a confidential patient is shown by alias to a doctor not cleared for the name", async () => {
    const { reportId } = await published();
    await db.update(patients).set({ isConfidential: true, alias: "Patient K" }).where(eq(patients.id, fx.patientId));
    const rows = await myReportsBack(db, fx.pathologist.actor, SOON);
    expect(rows[0]!.patientName).toBe("Patient K");
    expect((await myReportBack(db, fx.pathologist.actor, reportId, SOON)).patientName).toBe("Patient K");
  });

  it("a restricted test stays visible to its ordering clinician (DD11's ordering-clinician leg)", async () => {
    const { run, reportId } = await published();
    await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.id, run.itemIds[0]!));
    expect((await myReportsBack(db, fx.pathologist.actor, SOON)).map((r) => r.reportId)).toEqual([reportId]);
    expect((await myReportBack(db, fx.pathologist.actor, reportId, SOON)).panels.length).toBe(1);
  });
});
