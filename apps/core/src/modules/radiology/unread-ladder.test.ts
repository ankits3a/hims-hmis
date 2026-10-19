import { asc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { alerts, events, imagingReports, orderItems, orders } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { alertsConsumer } from "../../kernel/alerts/consumer";
import { draftReport, publishReport, signReport } from "./reports";
import { reportView } from "./read";
import { sweepUnreadWatchman, UNREAD_ESCALATE_HOURS, UNREAD_REPORT_HOURS } from "./chasers";
import type { DispatchedEvent } from "../../kernel/events/subscriptions";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * DOCTOR DESK DD-0.11 (#890, plan §3.1) — the unread-report chaser reaches the ORDERING DOCTOR first.
 *
 * Rung 1 is the doctor who ordered the study; the duty-manager route (`escalationRecipients`, which a
 * roster target may point at a unit or a department) is rung 2, after `UNREAD_ESCALATE_HOURS` more.
 * A study with no ordering doctor on the order goes straight to rung 2, as before.
 */
describe("the unread chaser's ladder (DD-0.11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let dutyManager: string;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    const registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "Rad", menu: [],
      permissions: ["radiology.worklist.read", "radiology.reports.read"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    for (const p of ["radiology.worklist.read", "radiology.reports.read"]) {
      await grantPermissionToRole(db, registry, "radiologist", p);
      await grantPermissionToRole(db, registry, "doctor", p);
    }
    dutyManager = (await mkUser(db, "dm.verma", ["duty_manager"])).id;
  });
  afterEach(() => { fx.unregister(); });

  /** A signed, published report; `orderedBy` sets the order's ordering clinician (null = none). */
  const signedStudy = async (orderedBy: string | null, restricted = false) => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `u${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    await db.update(orders).set({ orderingClinicianId: orderedBy }).where(eq(orders.id, study.orderId));
    if (restricted) await db.update(orderItems).set({ restricted: true }).where(eq(orderItems.orderId, study.orderId));
    const draft = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Normal.", technique: "Transabdominal." },
      impression: "No abnormality.",
    }));
    const { reportId } = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: draft.reportId, secondFactorAt: NOW, now: NOW,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));
    return { ...study, reportId };
  };

  const hoursAfterPublish = async (reportId: string, hours: number) => {
    const [row] = await db.select().from(imagingReports).where(eq(imagingReports.id, reportId));
    return new Date(row!.publishedAt!.getTime() + hours * 3_600_000);
  };

  /** Hand every `imaging.report_unread` to the alerts consumer twice (at-least-once), in order. */
  const deliver = async (): Promise<void> => {
    const handle = alertsConsumer(db);
    const rows = (await db.select().from(events).orderBy(asc(events.seq))).filter((r) => r.name === "imaging.report_unread");
    for (const r of rows) {
      const e: DispatchedEvent = {
        seq: Number(r.seq), eventId: r.eventId, name: r.name, payload: r.payload,
        patientId: r.patientId, correlationId: r.correlationId, occurredAt: r.occurredAt,
      };
      await handle(e);
      await handle(e);
    }
  };
  const bell = async () => (await db.select().from(alerts).where(eq(alerts.kind, "imaging_chase")))
    .map((a) => ({ to: a.userId, title: a.title, body: a.body ?? "" }));

  it("rung 1: the ordering doctor is alerted, and the duty manager is not — yet", async () => {
    const study = await signedStudy(fx.doctor.id);
    const r = await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    expect(r.chased).toEqual([expect.objectContaining({ reportId: study.reportId, rung: "ordering_clinician" })]);
    await deliver();
    expect((await bell()).map((b) => b.to)).toEqual([fx.doctor.id]);
  });

  it("rung 2: still unread after the escalate window, the duty manager is alerted — once", async () => {
    const study = await signedStudy(fx.doctor.id);
    await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    /** Inside the escalate window nothing more happens. */
    expect((await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 2))).chased).toEqual([]);

    const later = await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + UNREAD_ESCALATE_HOURS + 2);
    expect((await sweepUnreadWatchman(db, later)).chased)
      .toEqual([expect.objectContaining({ reportId: study.reportId, rung: "department" })]);
    expect((await sweepUnreadWatchman(db, new Date(later.getTime() + 48 * 3_600_000))).chased).toEqual([]);

    await deliver();
    const rows = await bell();
    expect(rows.map((b) => b.to)).toEqual([fx.doctor.id, dutyManager]);
  });

  it("a read by the ordering doctor after rung 1 stops rung 2", async () => {
    const study = await signedStudy(fx.doctor.id);
    await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    await reportView(db, fx.doctor, study.reportId);
    expect((await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + UNREAD_ESCALATE_HOURS + 2))).chased)
      .toEqual([]);
  });

  it("no ordering doctor on the order: straight to the duty-manager route, as before", async () => {
    const study = await signedStudy(null);
    const r = await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    expect(r.chased).toEqual([expect.objectContaining({ rung: "department" })]);
    await deliver();
    expect((await bell()).map((b) => b.to)).toEqual([dutyManager]);
  });

  it("an ordering clinician id that is not an active user goes straight to the duty-manager route", async () => {
    const study = await signedStudy("01NOTAUSER000000000000000");
    const r = await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    expect(r.chased).toEqual([expect.objectContaining({ rung: "department" })]);
  });

  it("a restricted study: the ordering doctor is alerted, and no bell names the patient or the study", async () => {
    const study = await signedStudy(fx.doctor.id, true);
    await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + UNREAD_ESCALATE_HOURS + 2));
    await deliver();
    const rows = await bell();
    expect(rows.map((b) => b.to)).toEqual([fx.doctor.id, dutyManager]);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Asha|HMS-00000001|Imaging USG|USG-ABDO|abdomen|Normal|abnormality/i);
  });

  it("the payload carries staff ids and hours, nothing clinical", async () => {
    const study = await signedStudy(fx.doctor.id);
    await sweepUnreadWatchman(db, await hoursAfterPublish(study.reportId, UNREAD_REPORT_HOURS + 1));
    const [row] = (await db.select().from(events)).filter((e) => e.name === "imaging.report_unread");
    expect(row!.payload).toEqual({
      reportId: study.reportId, studyId: study.studyId, unreadHours: UNREAD_REPORT_HOURS + 1,
      rung: "ordering_clinician", notifyUserIds: [fx.doctor.id],
    });
  });
});
