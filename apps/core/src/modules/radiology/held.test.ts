import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { issueDuesInvoice, mkBillingManager, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import {
  events, imagingMediaRequests, imagingReportHandovers, imagingStudies, invoiceLines, notifications, opdEncounters, orders,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { allocateReceipt, billingManifest, invoiceSettlement, recordReceipt } from "../billing";
import { tariffManifest } from "../tariff";
import { patientsManifest } from "../patients";
import { registerRadiologyApprovalTypes } from "./approval-types";
import { draftReport, publishReport, signReport } from "./reports";
import { reportView } from "./read";
import { handOverReport, markMediaPrinted, releaseRegister, requestMedia } from "./release";
import { requestUnpaidRelease } from "./held";
import { handleSettlementEvent } from "./ready-on-payment";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { HandoverInput } from "./release";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS9b — **the patient's copy is held for dues; the doctor's never is; only the owner
 * releases it unpaid; and "report ready" is sent when the bill is paid after release.**
 *
 * The study is made self-pay and routine with a REAL unpaid invoice line (issued through billing's
 * `holdUntilPaid` path) and paid through the REAL receipt path, so settlement is the ledger's answer
 * and not a flag. The line is attached to the study by a direct update — the fixture's generic
 * service is not the study's, and `linkInvoiceLine`'s own checks are `money.test.ts`'s subject.
 */
describe("the held patient copy and the ready message on payment (18-S RS9b)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let base: BillingBaseFixture;
  let cashier: { id: string; actor: Actor };

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const FRESH = new Date(NOW.getTime() - 60_000);
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    base = await seedBillingBase(db);
    const registry = new ModuleRegistry();
    registry.install(patientsManifest);
    registry.install(tariffManifest);
    registry.install(billingManifest);
    registry.install({ key: "radiology", title: "Rad", menu: [], permissions: ["radiology.reports.read"], subscriptions: [] });
    await syncPermissions(db, registry);
    /** The doctor's read grant (DD16) — what the treating doctor holds in production. */
    await grantPermissionToRole(db, registry, "doctor", "radiology.reports.read");
    for (const p of ["billing.invoice.issue", "billing.invoice.read", "billing.receipt.record", "billing.session.own", "patients.read"]) {
      await grantPermissionToRole(db, registry, "cashier", p);
    }
    cashier = await mkCashier(db, "cash.one");
    await openSessionFor(db, cashier, 0);
    await registerRadiologyApprovalTypes(db, base.activator);
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  /** A released report on a study that is self-pay, routine, and billed on an UNPAID line. */
  const releasedUnpaid = async (opts: { billed?: boolean; xray?: boolean } = {}) => {
    seq += 1;
    const s = await acquireStudy(db, fx, {
      idemKey: `held${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
      ...(opts.xray === true ? { serviceCode: "XR-CHEST", deviceKey: "xray", dose: true } : {}),
    });
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    let invoiceId: string | null = null;
    let netPayablePaise = 0;
    if (opts.billed !== false) {
      const inv = await issueDuesInvoice(db, cashier, { patientId: fx.patientId, serviceId: base.genericServiceId });
      const line = (await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.invoiceId)))[0]!;
      await db.update(imagingStudies).set({ invoiceLineId: line.id }).where(eq(imagingStudies.id, s.studyId));
      invoiceId = inv.invoiceId;
      netPayablePaise = inv.totals.netPayablePaise;
    }
    await db.update(imagingStudies).set({ priority: "routine" }).where(eq(imagingStudies.id, s.studyId));
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: s.studyId, body: { findings: "Findings." }, impression: "Impression.",
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: FRESH, now: NOW, criticalCategory: null,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: s.studyId, now: NOW }));
    return { ...s, reportId: signed.reportId, invoiceId, netPayablePaise };
  };
  const hand = (input: HandoverInput) => withTx(db, (tx) => handOverReport(tx, fx.radiographer, { now: NOW, ...input }));
  const pay = async (invoiceId: string, amountPaise: number) => {
    const receipt = await recordReceipt(db, cashier.actor, { patientId: fx.patientId, tenders: [{ mode: "cash", amountPaise }] }, NOW);
    await allocateReceipt(db, cashier.actor, { receiptId: receipt.receiptId, invoiceId, amountPaise }, NOW);
  };
  const ready = (reportId: string) => db.select().from(notifications)
    .where(eq(notifications.dedupeKey, `imaging_report_ready:${reportId}`));

  /* ───────────────────────────── T1 — the hold ───────────────────────────── */

  it("T1: a self-pay report with dues is HELD at the window, the refusal names the amount, and the register shows it", async () => {
    const s = await releasedUnpaid();
    const due = `₹${(s.netPayablePaise / 100).toLocaleString("en-IN")}`;
    await expect(hand({ reportId: s.reportId, collectorKind: "patient" }))
      .rejects.toMatchObject({ code: "report_held_for_dues", message: expect.stringContaining(due) as unknown });
    expect(await db.select().from(imagingReportHandovers)).toEqual([]);

    const [row] = await releaseRegister(db, fx.radiographer, NOW);
    expect(row?.hold).toMatchObject({ outstandingPaise: s.netPayablePaise, release: { state: "none" } });
    expect(row?.needs).toContain("held_for_dues");
  });

  it("T1: film and CD collection rides the same hold", async () => {
    const s = await releasedUnpaid({ xray: true });
    const film = await withTx(db, (tx) => requestMedia(tx, fx.radiographer, { studyId: s.studyId, kind: "film", now: NOW }));
    for (const id of film.requestIds) await withTx(db, (tx) => markMediaPrinted(tx, fx.radiographer, { requestId: id, now: NOW }));
    await expect(hand({ reportId: s.reportId, collectorKind: "patient", mediaRequestIds: film.requestIds }))
      .rejects.toMatchObject({ code: "report_held_for_dues" });
    const media = await db.select().from(imagingMediaRequests).where(eq(imagingMediaRequests.studyId, s.studyId));
    expect(media.every((m) => m.handoverId === null)).toBe(true);
  });

  it("T1: the DOCTOR's copy is never held — the treating doctor reads the held report", async () => {
    const s = await releasedUnpaid();
    const view = await reportView(db, fx.doctor, s.reportId);
    expect(view).toMatchObject({ reportId: s.reportId });
  });

  it("T1: ER/STAT, a corporate payer, a ward bedside study and an unbilled study are not held", async () => {
    const stat = await releasedUnpaid();
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, stat.studyId));
    await hand({ reportId: stat.reportId, collectorKind: "patient" });

    const ward = await releasedUnpaid();
    await db.update(imagingStudies).set({ bedsideLocation: "Ward 3 · Bed 12" }).where(eq(imagingStudies.id, ward.studyId));
    await hand({ reportId: ward.reportId, collectorKind: "ward_staff", collectorName: "Sister Mary" });

    const unbilled = await releasedUnpaid({ billed: false });
    await hand({ reportId: unbilled.reportId, collectorKind: "patient" });

    const corporate = await releasedUnpaid();
    await db.update(opdEncounters).set({ intendedPayer: "corporate" }).where(eq(opdEncounters.visitNo, fx.visitNo));
    await hand({ reportId: corporate.reportId, collectorKind: "patient" });
    expect(await db.select().from(imagingReportHandovers)).toHaveLength(4);
  });

  it("T1: paid in full at billing, the copy is handed over", async () => {
    const s = await releasedUnpaid();
    await pay(s.invoiceId!, s.netPayablePaise);
    await hand({ reportId: s.reportId, collectorKind: "patient" });
    const [row] = await releaseRegister(db, fx.radiographer, NOW);
    expect([row?.hold, row?.needs]).toEqual([null, []]);
  });

  it("T1: only the OWNER releases unpaid — the desk asks with a reason, a billing manager cannot decide, the grant is spent once and audited, the dues stay", async () => {
    const s = await releasedUnpaid();
    await expect(withTx(db, (tx) => requestUnpaidRelease(tx, fx.radiographer, { reportId: s.reportId, reason: "" })))
      .rejects.toMatchObject({ code: "reason_required" });
    const asked = await withTx(db, (tx) => requestUnpaidRelease(tx, fx.radiographer, {
      reportId: s.reportId, reason: "Patient referred on to AIIMS tonight; family pays tomorrow",
    }));
    expect(asked.status).toBe("pending");
    /** Idempotent while pending: the same request comes back. */
    const again = await withTx(db, (tx) => requestUnpaidRelease(tx, fx.radiographer, { reportId: s.reportId, reason: "again please" }));
    expect(again.approvalId).toBe(asked.approvalId);

    /** Pending is not a release. */
    await expect(hand({ reportId: s.reportId, collectorKind: "patient" })).rejects.toMatchObject({ code: "release_not_authorised" });

    /** The billing manager is not the approver of this type (credit ruling 28 Sep). */
    const bm = await mkBillingManager(db, "bm.one");
    await expect(approveRequest(db, bm.actor, { approvalId: asked.approvalId, note: "ok" })).rejects.toThrow();

    await approveRequest(db, base.owner, { approvalId: asked.approvalId, note: "Release; collect tomorrow" });
    const out = await hand({ reportId: s.reportId, collectorKind: "patient" });
    const [h] = await db.select().from(imagingReportHandovers).where(eq(imagingReportHandovers.id, out.handoverId));
    expect(h?.releaseApprovalId).toBe(asked.approvalId);
    const ev = await db.select().from(events).where(eq(events.name, "imaging.report_released_unpaid"));
    expect(ev.map((e) => e.payload)).toEqual([expect.objectContaining({
      approvalId: asked.approvalId, reportId: s.reportId, outstandingPaise: s.netPayablePaise,
    })]);

    /** The dues stay on the account, and the grant is SPENT: a second hand-over needs a second decision. */
    expect(await invoiceSettlement(db, s.invoiceId!)).toMatchObject({ state: "unpaid", outstandingPaise: s.netPayablePaise });
    await expect(hand({ reportId: s.reportId, collectorKind: "patient" })).rejects.toMatchObject({ code: "report_held_for_dues" });
  });

  it("T1: a refused release says so; a report nothing holds needs no release", async () => {
    const s = await releasedUnpaid();
    const asked = await withTx(db, (tx) => requestUnpaidRelease(tx, fx.radiographer, { reportId: s.reportId, reason: "cannot pay today" }));
    await rejectRequest(db, base.owner, { approvalId: asked.approvalId, note: "Collect first" });
    await expect(hand({ reportId: s.reportId, collectorKind: "patient" }))
      .rejects.toMatchObject({ code: "release_not_authorised", message: expect.stringContaining("Collect first") as unknown });

    const free = await releasedUnpaid({ billed: false });
    await expect(withTx(db, (tx) => requestUnpaidRelease(tx, fx.radiographer, { reportId: free.reportId, reason: "just in case" })))
      .rejects.toMatchObject({ code: "release_not_needed" });
  });

  /* ─────────────────────── T2 — "report ready" on later payment ─────────────────────── */

  it("T2: publish while unpaid queues no message; payment after release queues it once, through the worker's event", async () => {
    const s = await releasedUnpaid();
    expect(await ready(s.reportId)).toEqual([]);

    /** A part-payment settles nothing and queues nothing. */
    await pay(s.invoiceId!, 100);
    const partEvents = await db.select().from(events).where(eq(events.name, "payment.received"));
    for (const e of partEvents) await withTx(db, (tx) => handleSettlementEvent(tx, e));
    expect(await ready(s.reportId)).toEqual([]);

    await pay(s.invoiceId!, s.netPayablePaise - 100);
    const all = await db.select().from(events).where(eq(events.name, "payment.received"));
    const first = await withTx(db, (tx) => handleSettlementEvent(tx, all[all.length - 1]!));
    expect(first.queued).toEqual([s.reportId]);
    /** Redelivery, and every earlier event replayed: nothing more — exactly once per version. */
    for (const e of all) {
      const again = await withTx(db, (tx) => handleSettlementEvent(tx, e));
      expect(again.queued).toEqual([]);
    }
    const rows = await ready(s.reportId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ templateKey: "imaging_report_ready", patientId: fx.patientId });
  });

  it("T2: a bill for something else, and an event for an unrelated invoice, queue nothing", async () => {
    const s = await releasedUnpaid();
    const other = await issueDuesInvoice(db, cashier, { patientId: fx.patientId, serviceId: base.genericServiceId });
    await pay(other.invoiceId, other.totals.netPayablePaise);
    const all = await db.select().from(events).where(eq(events.name, "payment.received"));
    for (const e of all) expect((await withTx(db, (tx) => handleSettlementEvent(tx, e))).queued).toEqual([]);
    expect(await ready(s.reportId)).toEqual([]);
  });
});
