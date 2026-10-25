import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor } from "../../../test/helpers/billing";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase, settleInvoice } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { labReportDeliveries, opdDoctors, opdEncounters, orderItems, orders } from "../../kernel/db/schema";
import { getReport, listResultsForEncounter, printReport, publishReport, reportsForPatient } from "./reports";
import { labWaitingMine } from "./waiting";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * #682 — THE TREATING DOCTOR'S READ OF A LAB REPORT, and the "lab reports back" loop it closes.
 *
 * Every instant here is the fixture's (`AT` and offsets from it). The waiting reader takes `now`
 * from its context and the read stamp takes the read's `now`, so nothing below depends on the
 * real clock.
 */
const AT = new Date("2026-08-30T06:00:00Z");
const H = 3_600_000;

describe("lab — the treating doctor's read (#682)", () => {
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

  /** A published report on an order whose responsible clinician is the treating doctor. */
  const reportBack = async (code: string, at: Date, encounterNo?: string) => {
    const run = await runLabOrder(db, fx, [code], { at, encounterNo });
    await db.update(orders).set({ orderingClinicianId: doctor.id }).where(eq(orders.id, run.orderId));
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, at);
    return { ...run, reportId: report.reportId };
  };

  const doctorReads = async () => db.select().from(labReportDeliveries)
    .where(eq(labReportDeliveries.channel, "doctor_screen"));

  const reportsBack = async (now: Date) => {
    const items = await labWaitingMine.waiting!({ db, actor: doctor.actor, reader: doctor.actor, date: "2026-08-30", now });
    return items.find((i) => i.kind === "lab.reportsBack")?.count ?? 0;
  };

  it("(a) opening the report stamps ONE doctor_screen read — who and when; a second open stamps nothing", async () => {
    const r = await reportBack("TSH", AT);
    const readAt = new Date(AT.getTime() + 2 * H);
    await getReport(db, doctor.actor, r.reportId, readAt);
    const reads = await doctorReads();
    expect(reads.map((d) => [d.reportId, d.deliveredBy, d.at.toISOString(), d.collectorIdentity]))
      .toEqual([[r.reportId, doctor.id, readAt.toISOString(), null]]);

    await getReport(db, doctor.actor, r.reportId, new Date(AT.getTime() + 3 * H));
    await listResultsForEncounter(db, doctor.actor, fx.encounterNo, new Date(AT.getTime() + 4 * H));
    expect(await doctorReads()).toHaveLength(1);
  });

  it("(a) the consult's results panel is the doctor's read too — once", async () => {
    await reportBack("TSH", AT);
    await listResultsForEncounter(db, doctor.actor, fx.encounterNo, AT);
    await listResultsForEncounter(db, doctor.actor, fx.encounterNo, AT);
    expect(await doctorReads()).toHaveLength(1);
  });

  it("(a) two simultaneous opens still stamp one read", async () => {
    const r = await reportBack("TSH", AT);
    await Promise.all([1, 2, 3].map(() => getReport(db, doctor.actor, r.reportId, AT)));
    expect(await doctorReads()).toHaveLength(1);
  });

  it("(b) the reports-back count drops by one when the doctor opens one report", async () => {
    const first = await reportBack("TSH", AT);
    await reportBack("TSH", AT, fx.newVisit());
    const now = new Date(AT.getTime() + H);
    expect(await reportsBack(now)).toBe(2);
    await getReport(db, doctor.actor, first.reportId, now);
    expect(await reportsBack(now)).toBe(1);
  });

  it("(c) a report published 30 h ago and never read STILL counts", async () => {
    await reportBack("TSH", AT);
    expect(await reportsBack(new Date(AT.getTime() + 30 * H))).toBe(1);
  });

  it("(c) reports from before the read stamp existed do not flood the line: unread past the 7-day horizon drops off", async () => {
    await reportBack("TSH", AT);
    expect(await reportsBack(new Date(AT.getTime() + 6 * 24 * H))).toBe(1);
    expect(await reportsBack(new Date(AT.getTime() + 8 * 24 * H))).toBe(0);
  });

  it("(d) the lab's own handling — print, the counter's read, the signer's read — is not the doctor's read", async () => {
    const cashier = await mkCashier(db, "lab.cashier");
    await openSessionFor(db, cashier, 0);
    const r = await reportBack("TSH", AT);
    await settleInvoice(db, cashier, fx.patientId, r.invoiceId, r.netPayablePaise, AT);
    await printReport(db, fx.desk.actor, { reportId: r.reportId, channel: "print", collectorIdentity: "the patient, card seen" }, AT);
    await getReport(db, fx.desk.actor, r.reportId, AT);
    await getReport(db, fx.pathologist.actor, r.reportId, AT);
    await listResultsForEncounter(db, fx.pathologist.actor, fx.encounterNo, AT);
    expect(await doctorReads()).toEqual([]);
    expect(await reportsBack(new Date(AT.getTime() + H))).toBe(1);
  });

  it("a doctor who does not treat the patient opening the report stamps nothing", async () => {
    const other = await mkUser(db, "dr.other", ["doctor"]);
    const r = await reportBack("TSH", AT);
    await getReport(db, other.actor, r.reportId, AT);
    expect(await doctorReads()).toEqual([]);
  });

  /** The OPD visit's doctor — a treating doctor who did NOT order, so the restricted-test rule hides restricted panels from them. */
  const visitDoctorOn = async (visitNo: string) => {
    const visit = await mkUser(db, "dr.visit", ["doctor"]);
    const doctorId = newId();
    await db.insert(opdDoctors).values({
      id: doctorId, userId: visit.id, displayName: "Dr Visit", code: "DR-VISIT", departmentId: fx.labDepartmentId, createdBy: "t", updatedBy: "t",
    });
    await db.insert(opdEncounters).values({
      id: newId(), patientId: fx.patientId, workflowInstanceId: "wf-visit", serviceDate: "2026-08-30", visitType: "new",
      openedBy: "t", updatedBy: "t", visitNo, doctorId,
    } as typeof opdEncounters.$inferInsert);
    return visit;
  };

  it("restricted-test rule: the visit doctor's read stamps an ordinary report, but not one whose restricted panel they could not see", async () => {
    const plainVisit = fx.newVisit();
    const plain = await reportBack("TSH", AT, plainVisit);
    const visit = await visitDoctorOn(plainVisit);
    await getReport(db, visit.actor, plain.reportId, AT);
    expect((await doctorReads()).map((d) => d.reportId)).toEqual([plain.reportId]);

    /* One order, two panels: TSH and a B12 marked restricted (a stand-in: HIV itself needs recorded consent to order). The visit doctor sees the TSH panel only. */
    const mixedVisit = fx.newVisit();
    await db.insert(opdEncounters).values({
      id: newId(), patientId: fx.patientId, workflowInstanceId: "wf-visit-2", serviceDate: "2026-08-30", visitType: "new",
      openedBy: "t", updatedBy: "t", visitNo: mixedVisit,
      doctorId: (await db.select({ id: opdDoctors.id }).from(opdDoctors).where(eq(opdDoctors.userId, visit.id)))[0]!.id,
    } as typeof opdEncounters.$inferInsert);
    const run = await runLabOrder(db, fx, ["TSH", "B12"], { at: AT, encounterNo: mixedVisit });
    await db.update(orders).set({ orderingClinicianId: doctor.id }).where(eq(orders.id, run.orderId));
    const items = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, run.orderId));
    expect(items).toHaveLength(2);
    const hivItem = (await db.execute<{ id: string }>(sql`select oi.id from order_items oi
      join lab_orderables lo on lo.service_id = oi.service_id where oi.order_id = ${run.orderId} and lo.code = 'B12'`)).rows[0]!.id;
    await db.update(orderItems).set({ restricted: true }).where(inArray(orderItems.id, [hivItem]));
    const mixed = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);

    const seen = await getReport(db, visit.actor, mixed.reportId, AT);
    expect(seen.snapshot.panels).toHaveLength(1);
    await listResultsForEncounter(db, visit.actor, mixedVisit, AT);
    expect((await doctorReads()).map((d) => d.reportId)).toEqual([plain.reportId]);
    expect(await reportsBack(AT)).toBe(1); // the orderer still has the mixed report waiting

    await getReport(db, doctor.actor, mixed.reportId, AT); // the orderer sees all of it: that read lands
    expect((await doctorReads()).map((d) => d.reportId).sort()).toEqual([plain.reportId, mixed.reportId].sort());
  });

  it("a screen read is not a hand-over: the counter's reader does not list it as a delivery", async () => {
    const r = await reportBack("TSH", AT);
    await getReport(db, doctor.actor, r.reportId, AT);
    expect(await db.select().from(labReportDeliveries).where(and(
      eq(labReportDeliveries.reportId, r.reportId), eq(labReportDeliveries.channel, "doctor_screen"),
    ))).toHaveLength(1);
    const centre = await reportsForPatient(db, fx.desk.actor, fx.patientId, AT);
    expect(centre.reports.flatMap((x) => x.deliveries)).toEqual([]);
  });
});
