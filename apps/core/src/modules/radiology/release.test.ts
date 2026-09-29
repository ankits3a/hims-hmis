import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import {
  events, imagingMediaRequests, imagingReportDelivery, imagingReportHandovers, notifications, orders,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { notificationTemplates } from "../../kernel/notify/templates";
import { amendReport, draftReport, publishReport, signReport } from "./reports";
import { handOverReport, markMediaPrinted, releaseRegister, requestMedia } from "./release";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { HandoverInput } from "./release";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS9 T4 + T5 — **the report hand-over desk and the patient's notice.** One register,
 * rows that need the desk first; a hand-over names its collector as the type needs; film and CD per
 * ruling 1 (an X-ray's first film is included); an amendment after a hand-over is a row to act on.
 */
describe("the release register (18-S RS9 T4/T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

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
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  const released = async (opts: { xray?: boolean; critical?: "red" | null } = {}) => {
    seq += 1;
    const s = await acquireStudy(db, fx, {
      idemKey: `rel${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
      ...(opts.xray === true ? { serviceCode: "XR-CHEST", deviceKey: "xray", dose: true } : {}),
    });
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: s.studyId, body: { findings: "Findings." }, impression: "Impression.",
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: FRESH, now: NOW, criticalCategory: opts.critical ?? null,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: s.studyId, now: NOW }));
    return { ...s, reportId: signed.reportId };
  };
  const hand = (input: HandoverInput) => withTx(db, (tx) => handOverReport(tx, fx.radiographer, { now: NOW, ...input }));
  const register = (at = NOW) => releaseRegister(db, fx.radiographer, at);

  it("a released report is on the register as not collected; a relative must be named, related and identified", async () => {
    const s = await released();
    const [row] = await register();
    expect([row?.reportId, row?.needs]).toEqual([s.reportId, ["notice_not_sent", "not_collected"]]);
    expect(row?.doctor).toBe("unread");

    await expect(hand({ reportId: s.reportId, collectorKind: "relative", collectorName: "Rakesh Munda" }))
      .rejects.toMatchObject({ code: "collector_details_required" });
    await expect(hand({ reportId: s.reportId, collectorKind: "relative", collectorName: "Rakesh Munda", collectorRelation: "Son" }))
      .rejects.toMatchObject({ code: "collector_details_required" });
    await expect(hand({ reportId: s.reportId, collectorKind: "courier" })).rejects.toMatchObject({ code: "collector_details_required" });

    await hand({
      reportId: s.reportId, collectorKind: "relative", collectorName: "Rakesh Munda", collectorRelation: "Son",
      collectorIdType: "aadhaar", collectorIdLast4: "4821",
    });
    const [after] = await register();
    expect(after?.needs).toEqual([]);
    expect(after?.handovers.map((h) => [h.collectorKind, h.collectorName, h.collectorRelation])).toEqual([["relative", "Rakesh Munda", "Son"]]);

    const ev = await db.select().from(events).where(eq(events.name, "imaging.report_handed_over"));
    expect(ev).toHaveLength(1);
    /** The event carries the collector's TYPE, never the name or the ID digits. */
    expect(JSON.stringify(ev[0]!.payload)).not.toMatch(/Rakesh|4821/);
    /** A study with an in-house treating doctor: the desk's hand-over is not the doctor's read. */
    expect((await db.select().from(imagingReportDelivery).where(eq(imagingReportDelivery.reportId, s.reportId)))).toEqual([]);
  });

  it("ruling 1: an X-ray's first film sheet is included, further sheets and a CD are charged; printed, then handed over", async () => {
    const s = await released({ xray: true });
    const film = await withTx(db, (tx) => requestMedia(tx, fx.radiographer, { studyId: s.studyId, kind: "film", quantity: 2, now: NOW }));
    expect(film.included).toBe(true);
    const cd = await withTx(db, (tx) => requestMedia(tx, fx.radiographer, { studyId: s.studyId, kind: "cd", now: NOW }));
    const rows = await db.select().from(imagingMediaRequests).where(eq(imagingMediaRequests.studyId, s.studyId));
    expect(rows.map((r) => [r.kind, r.quantity, r.included]).sort()).toEqual([["cd", 1, false], ["film", 1, false], ["film", 1, true]]);
    /** A second film request is charged — the one included sheet is spent. */
    const again = await withTx(db, (tx) => requestMedia(tx, fx.radiographer, { studyId: s.studyId, kind: "film", now: NOW }));
    expect(again.included).toBe(false);

    const [row] = await register();
    expect(row?.needs[0]).toBe("media_to_print");
    expect(row?.filmIncluded).toBe(true);

    const ids = [...film.requestIds, ...cd.requestIds];
    await expect(hand({ reportId: s.reportId, collectorKind: "patient", mediaRequestIds: ids }))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    for (const id of ids) await withTx(db, (tx) => markMediaPrinted(tx, fx.radiographer, { requestId: id, now: NOW }));
    await expect(withTx(db, (tx) => markMediaPrinted(tx, fx.radiographer, { requestId: ids[0]!, now: NOW })))
      .rejects.toMatchObject({ code: "already_resolved" });

    const out = await hand({ reportId: s.reportId, collectorKind: "patient", mediaRequestIds: ids });
    expect([out.filmSheets, out.cd]).toEqual([2, true]);
    const [done] = await register();
    /** The third (unprinted) film request is still to print; nothing else is owed. */
    expect(done?.needs).toEqual(["media_to_print"]);
  });

  it("a film or CD is printed only for a released report", async () => {
    seq += 1;
    const s = await acquireStudy(db, fx, { idemKey: "unrel", now: NOW, slot: SLOT });
    await expect(withTx(db, (tx) => requestMedia(tx, fx.radiographer, { studyId: s.studyId, kind: "cd", now: NOW })))
      .rejects.toMatchObject({ code: "report_not_published" });
  });

  it("an amendment after the hand-over is a row to act on, and the old version cannot be handed over", async () => {
    const s = await released();
    await hand({ reportId: s.reportId, collectorKind: "patient" });
    const v2 = await withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      studyId: s.studyId, secondFactorAt: FRESH, reason: "Laterality corrected", now: NOW,
      body: { findings: "Corrected findings." }, impression: "Corrected.",
    }));
    const [row] = await register();
    expect([row?.reportId, row?.needs[0]]).toEqual([v2.reportId, "amended_after_handover"]);
    await expect(hand({ reportId: s.reportId, collectorKind: "patient" })).rejects.toMatchObject({ code: "report_superseded" });
    await hand({ reportId: v2.reportId, collectorKind: "patient" });
    expect((await register())[0]?.needs).toEqual([]);
  });

  it("an abnormal report uncollected for 24 h comes first; ward staff are named", async () => {
    const normal = await released();
    const abnormal = await released({ critical: "red" });
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const rows = await register(later);
    expect(rows.map((r) => r.reportId)).toEqual([abnormal.reportId, normal.reportId]);
    expect(rows[0]?.needs[0]).toBe("abnormal_uncollected");
    await hand({ reportId: abnormal.reportId, collectorKind: "ward_staff", collectorName: "Sister Rekha" });
    expect((await db.select().from(imagingReportHandovers)).map((h) => h.collectorName)).toEqual(["Sister Rekha"]);
  });

  it("DECIDED: with no in-house treating doctor (an outside prescription names none), the hand-over is the first read", async () => {
    const s = await released();
    /** `authority` is immutable after insert; no ordering clinician and no visit doctor is the same fact for the rule. */
    await db.update(orders).set({ orderingClinicianId: null }).where(eq(orders.id, s.orderId));
    await hand({ reportId: s.reportId, collectorKind: "patient" });
    const d = (await db.select().from(imagingReportDelivery).where(eq(imagingReportDelivery.reportId, s.reportId)))[0];
    expect(d?.firstReadBy).toBe(fx.radiographer.id);
    expect((await register())[0]?.doctor).toBe("none");
  });

  /**
   * T5 — the patient's notice is 18a T2's, and this pins what RS9 relies on: recorded at release (a
   * RED critical sends regardless of the bill), token-only in English and Hindi — the order number,
   * never the study — and the register shows its RECORDED state, never "sent".
   */
  it("T5: the report-ready notice is recorded at release, names no study in either language, and the register shows its state", async () => {
    const s = await released({ critical: "red" });
    const queued = await db.select().from(notifications).where(eq(notifications.dedupeKey, `imaging_report_ready:${s.reportId}`));
    expect(queued.map((n) => [n.templateKey, n.status])).toEqual([["imaging_report_ready", "queued"]]);
    const tpl = notificationTemplates.imaging_report_ready!;
    const params = queued[0]!.params as Record<string, unknown>;
    for (const text of [tpl.render.en(params), tpl.render.hi(params)]) {
      expect(text).not.toMatch(/USG|ultrasound|Imaging USG-ABDO|abdomen/i);
      expect(text).toContain(String(params.orderNo));
    }
    const [row] = await register();
    expect([row?.notice, row?.needs.includes("notice_not_sent")]).toEqual(["queued", false]);
  });
});
