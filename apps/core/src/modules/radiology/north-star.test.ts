import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { imagingStudies, orders } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { draftReport, publishReport, signReport } from "./reports";
import { markActedUpon, stampFirstRead } from "./closed-loop";
import { northStar, percentiles, sourceOf } from "./north-star";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS9 T2 — **the north star: order → acted, per modality and source**, on a FIXED clock.
 * Every instant below is placed by the test (order, sign, publish, read, act) and the read model is
 * asked at a fixed `now`, so nothing here depends on the day it runs (the F28 lesson).
 */
describe("the north-star read model (18-S RS9 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const AT = new Date("2026-09-10T06:00:00.000Z");
  const MIN = 60_000;
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  /** A study placed at NOW + seq·25 h (the helper's spacing), acquired, and the placed instant. */
  const study = async (opts: { xray?: boolean; priority?: "routine" | "stat" } = {}) => {
    seq += 1;
    const placedAt = new Date(NOW.getTime() + seq * 25 * 3_600_000);
    const s = await acquireStudy(db, fx, {
      idemKey: `ns${String(seq)}`, now: placedAt, slot: new Date(SLOT.getTime() + seq * 3_600_000),
      ...(opts.xray === true ? { serviceCode: "XR-CHEST", deviceKey: "xray", dose: true } : {}),
    });
    await db.update(imagingStudies).set({ priority: opts.priority ?? "routine" }).where(eq(imagingStudies.id, s.studyId));
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    return { ...s, placedAt };
  };
  const signAndPublish = async (s: { studyId: string; placedAt: Date }, afterMin: number) => {
    const at = new Date(s.placedAt.getTime() + afterMin * MIN);
    // MERGE RS9+RS8a: RS8a's pre-sign check refuses an empty impression (`impression_required`),
    // so a report this test signs now carries one — the new truth, not a weakened guard.
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Normal." }, impression: "Normal study." }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(at.getTime() - MIN), now: at,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: s.studyId, now: at }));
    return signed.reportId;
  };

  it("counts, medians and 90th percentiles per modality and source, and the two overdue counts, at a fixed now", async () => {
    const a = await study();
    const aReport = await signAndPublish(a, 60);
    await stampFirstRead(db, aReport, fx.doctor.id, new Date(a.placedAt.getTime() + 120 * MIN));
    await withTx(db, (tx) => markActedUpon(tx, fx.doctor, {
      reportId: aReport, outcome: "changed_treatment", note: "Started treatment", now: new Date(a.placedAt.getTime() + 180 * MIN),
    }));

    const b = await study();
    const bReport = await signAndPublish(b, 30);
    await stampFirstRead(db, bReport, fx.doctor.id, new Date(b.placedAt.getTime() + 90 * MIN));

    const c = await study({ xray: true, priority: "stat" });
    await signAndPublish(c, 10);

    /** Placed on 4 Sep IST — outside a window that ends on 3 Sep. */
    await study();

    const ns = await northStar(db, { from: "2026-09-01", to: "2026-09-03", now: AT });
    expect(ns.rows).toEqual([
      {
        modality: "usg", source: "OPD", ordered: 2,
        orderToSigned: { n: 2, medianMin: 30, p90Min: 60 },
        signedToFirstRead: { n: 2, medianMin: 60, p90Min: 60 },
        orderToActed: { n: 1, medianMin: 180, p90Min: 180 },
        signedUnreadOver24h: 0, publishedNotActedOver72h: 1,
      },
      {
        modality: "xray", source: "ER", ordered: 1,
        orderToSigned: { n: 1, medianMin: 10, p90Min: 10 },
        signedToFirstRead: { n: 0, medianMin: null, p90Min: null },
        orderToActed: { n: 0, medianMin: null, p90Min: null },
        signedUnreadOver24h: 1, publishedNotActedOver72h: 1,
      },
    ].sort((x, y) => x.modality.localeCompare(y.modality)));
    expect(ns.total).toMatchObject({ ordered: 3, signedUnreadOver24h: 1, publishedNotActedOver72h: 2 });
    expect(ns.total.orderToActed).toEqual({ n: 1, medianMin: 180, p90Min: 180 });

    /** Asked at a `now` before the 24 h / 72 h marks, nothing is overdue yet. */
    const early = await northStar(db, { from: "2026-09-01", to: "2026-09-03", now: new Date(c.placedAt.getTime() + 60 * MIN) });
    expect([early.total.signedUnreadOver24h, early.total.publishedNotActedOver72h]).toEqual([0, 0]);
  });

  it("refuses a malformed or backwards window", async () => {
    await expect(northStar(db, { from: "2026-9-1", to: "2026-09-03", now: AT })).rejects.toMatchObject({ code: "invalid_date" });
    await expect(northStar(db, { from: "2026-09-05", to: "2026-09-03", now: AT })).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("percentiles are nearest-rank over whole minutes, and empty is null rather than zero", () => {
    expect(percentiles([100, 10, 90, 20, 80, 30, 70, 40, 60, 50])).toEqual({ n: 10, medianMin: 50, p90Min: 90 });
    expect(percentiles([])).toEqual({ n: 0, medianMin: null, p90Min: null });
  });

  it("DECIDED source: outside prescription → OUT, day-care or bedside → IPD, STAT → ER, else OPD", () => {
    const base = { authority: "clinician", encounterNo: "V2609010001", bedsideLocation: null, priority: "routine" };
    expect(sourceOf(base)).toBe("OPD");
    expect(sourceOf({ ...base, priority: "stat" })).toBe("ER");
    expect(sourceOf({ ...base, bedsideLocation: "Ward 3 · bed 12", priority: "stat" })).toBe("IPD");
    expect(sourceOf({ ...base, encounterNo: "D2609010001" })).toBe("IPD");
    expect(sourceOf({ ...base, authority: "external_prescription", priority: "stat" })).toBe("OUT");
    expect(sourceOf({ ...base, authority: "self" })).toBe("OUT");
  });
});
