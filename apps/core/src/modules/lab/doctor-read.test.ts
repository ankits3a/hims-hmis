import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor } from "../../../test/helpers/billing";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase, settleInvoice } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { labReportDeliveries, orders } from "../../kernel/db/schema";
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
