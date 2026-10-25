import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { labReportDeliveries, orderItems, orders } from "../../kernel/db/schema";
import { DOCTOR_SCREEN } from "./doctor-read";
import { getReport, publishReport } from "./reports";
import { myReportBack, myReportsBack } from "./reports-back";
import { labWaitingMine } from "./waiting";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * #930 — A LAB REPORT OPENED ON THE PHONE IS THE DOCTOR'S READ. The phone's viewer opens a report
 * through `GET /lab/results/mine/:reportId` (`myReportBack`); since #682 the web's report read stamps
 * the treating doctor's first read (`doctor-read.ts`), and the phone's did not, so a report seen only
 * on the phone stayed in "Lab reports back" and Open loops. The same rule as the web: the whole report
 * seen (DD11's restricted panels respected), never the signer's read, first read only.
 * Every instant is passed in; nothing here reads the clock.
 */
const AT = new Date("2026-08-30T06:00:00Z");
const H = 3_600_000;

describe("#930 a lab report opened on the phone records the doctor's read", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let doctor: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    doctor = await mkUser(db, "dr.treating", ["doctor"]);
    await grantPermissionToRole(db, fx.registry, "doctor", "lab.results.read");
  });
  afterEach(() => { fx.unregister(); });

  /** A published report on an order the treating doctor is responsible for (the fixture's pathologist signs it). */
  const reportBack = async (codes: string[], o: { restricted?: string; encounterNo?: string } = {}) => {
    const run = await runLabOrder(db, fx, codes, { at: AT, encounterNo: o.encounterNo });
    await db.update(orders).set({ orderingClinicianId: doctor.id }).where(eq(orders.id, run.orderId));
    if (o.restricted !== undefined) {
      await db.execute(sql`update order_items oi set restricted = true from lab_orderables lo
        where lo.service_id = oi.service_id and oi.order_id = ${run.orderId} and lo.code = ${o.restricted}`);
    }
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    return { ...run, reportId: report.reportId };
  };
  const doctorReads = async () => db.select().from(labReportDeliveries).where(eq(labReportDeliveries.channel, DOCTOR_SCREEN));
  const reportsBack = async (now: Date) => {
    const items = await labWaitingMine.waiting!({ db, actor: doctor.actor, reader: doctor.actor, date: "2026-08-30", now });
    return items.find((i) => i.kind === "lab.reportsBack")?.count ?? 0;
  };

  it("#930 opening a report on the phone stamps ONE doctor_screen read, who and when; a second open stamps nothing", async () => {
    const r = await reportBack(["TSH"]);
    const readAt = new Date(AT.getTime() + 2 * H);
    await myReportBack(db, doctor.actor, r.reportId, readAt);
    expect((await doctorReads()).map((d) => [d.reportId, d.deliveredBy, d.at.toISOString()]))
      .toEqual([[r.reportId, doctor.id, readAt.toISOString()]]);
    await myReportBack(db, doctor.actor, r.reportId, new Date(AT.getTime() + 3 * H));
    expect(await doctorReads()).toHaveLength(1);
  });

  it("#930 the phone list and Open loops drop the report once it is opened on the phone", async () => {
    const opened = await reportBack(["TSH"]);
    const waiting = await reportBack(["TSH"], { encounterNo: fx.newVisit() });
    const now = new Date(AT.getTime() + H);
    expect((await myReportsBack(db, doctor.actor, now)).map((x) => x.reportId).sort()).toEqual([opened.reportId, waiting.reportId].sort());
    expect(await reportsBack(now)).toBe(2);

    await myReportBack(db, doctor.actor, opened.reportId, now);
    expect((await myReportsBack(db, doctor.actor, now)).map((x) => x.reportId)).toEqual([waiting.reportId]);
    expect(await reportsBack(now)).toBe(1);
  });

  it("#930 a restricted test is part of the whole report its ordering doctor sees: the phone open stamps it", async () => {
    const r = await reportBack(["TSH", "B12"], { restricted: "B12" });
    expect((await db.select().from(orderItems).where(eq(orderItems.orderId, r.orderId))).filter((i) => i.restricted)).toHaveLength(1);
    const view = await myReportBack(db, doctor.actor, r.reportId, AT);
    expect(view.panels).toHaveLength(2);
    expect((await doctorReads()).map((d) => d.reportId)).toEqual([r.reportId]);
  });

  it("#930 the same rule as the web: the signer opening an order of their own on the phone is not the doctor's read", async () => {
    /* `runLabOrder`'s own order: the pathologist is its responsible clinician AND its signer. */
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const { reportId } = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    await myReportBack(db, fx.pathologist.actor, reportId, AT);
    expect(await doctorReads()).toEqual([]);
    expect((await myReportsBack(db, fx.pathologist.actor, AT)).map((x) => x.reportId)).toEqual([reportId]);
  });

  it("#930 a report already read on the web keeps that first read: the phone writes no second one", async () => {
    const r = await reportBack(["TSH"]);
    await getReport(db, doctor.actor, r.reportId, AT);
    await myReportBack(db, doctor.actor, r.reportId, new Date(AT.getTime() + H));
    expect((await doctorReads()).map((d) => d.at.toISOString())).toEqual([AT.toISOString()]);
  });
});
