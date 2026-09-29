import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, placeAndCreateStudy, setupRadiologyFixture, startStudyOnMachine } from "../../../test/helpers/radiology";
import { aerbLicences, imagingImageViews, phiAccessLog, resources } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { checkIn } from "./checkin";
import { scheduleStudy } from "./schedule";
import { draftReport } from "./reports";
import { ensureEscalationDefinitions, sweepImagingEscalations } from "./escalations";
import { ACCESS_LOG_REVIEW_REASON, supervisorAccessLog, supervisorFloor, supervisorQuality, targetFor } from "./supervisor";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS10 T1 — **the HOD's floor**, on a FIXED clock: every study is placed, booked, checked
 * in, started or acquired by the test at a known instant, and the read model is asked at NOW + 20 min.
 */
describe("the supervisor's floor read model (18-S RS10 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z"); // 11:30 IST
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const MIN = 60_000;
  const T = new Date(NOW.getTime() + 20 * MIN);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const perms = ["radiology.reports.write"];
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: perms, subscriptions: [] });
    await syncPermissions(db, registry);
    for (const p of perms) await grantPermissionToRole(db, registry, "radiologist", p);
  });
  afterEach(() => { fx.unregister(); });

  /** One study in every live stage the floor names, each on its own machine. */
  const floorDay = async () => {
    // A USG acquired STAT at NOW and a draft written — "drafted", images in 20 min ago.
    const usg = await acquireStudy(db, fx, { idemKey: "f-usg", now: NOW, slot: SLOT });
    await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: usg.studyId, body: { findings: "…" }, impression: "…" }));
    // The radiologist opened its images five minutes ago — the reading room's claim.
    await db.insert(imagingImageViews).values({
      id: newId(), studyId: usg.studyId, viewerId: fx.radiologist.id, via: "external_pacs", urlHost: "pacs.local",
      viewedAt: new Date(T.getTime() - 5 * MIN),
    });
    // An X-ray checked in at NOW with its gates still open — held 20 min.
    const xr = await placeAndCreateStudy(db, fx, "XR-CHEST", "f-xr", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: xr.studyId, deviceResourceId: fx.devices.xray!, scheduledAt: SLOT }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: xr.studyId, now: NOW }));
    // A CT on the table since NOW + 10.
    const ct = await startStudyOnMachine(db, fx, {
      serviceCode: "CT-HEAD", deviceKey: "ct", idemKey: "f-ct", now: new Date(NOW.getTime() + 10 * MIN), slot: SLOT,
    });
    // An MRI booked for 14:30 IST today, and then the MRI goes down.
    const mri = await placeAndCreateStudy(db, fx, "MRI-BRAIN", "f-mri", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: mri.studyId, deviceResourceId: fx.devices.mri!, scheduledAt: SLOT }));
    await db.update(resources).set({ status: "down" }).where(eq(resources.id, fx.devices.mri!));
    // The X-ray's licence lapsed yesterday, with the patient checked in on it.
    await db.update(aerbLicences).set({ validTo: "2026-08-30" }).where(eq(aerbLicences.deviceResourceId, fx.devices.xray!));
    return { usg, xr, ct, mri };
  };

  it("pipeline by stage with the oldest wait, rooms, readers' load and the gaps, at a fixed now", async () => {
    const { usg, xr, ct, mri } = await floorDay();
    const floor = await supervisorFloor(db, T);

    expect(floor.day).toBe(DAY);
    expect(floor.pipeline.map((p) => [p.stage, p.count, p.held, p.oldest?.accessionNo ?? null, p.oldest?.waitMin ?? null])).toEqual([
      ["scheduled", 1, 0, null, null], // 14:30 IST has not come yet — nobody is late
      ["checked_in", 1, 1, xr.accessionNo, 20],
      ["ready", 0, 0, null, null],
      ["in_acquisition", 1, 0, ct.accessionNo, 10],
      ["to_read", 0, 0, null, null],
      ["drafted", 1, 0, usg.accessionNo, 20],
      ["reported", 0, 0, null, null],
      ["published", 0, 0, null, null],
    ]);
    void mri;

    const room = (code: string) => floor.rooms.find((r) => r.code === code)!;
    expect(room("DEV-MRI")).toMatchObject({ status: "down", nextFreeAt: null, queue: 1, technologist: null });
    expect(room("DEV-CT")).toMatchObject({ onTable: ct.accessionNo });
    expect(room("DEV-XRAY")).toMatchObject({ queue: 1, licensedNow: false, nextFreeAt: T.toISOString() });

    expect(floor.readers).toMatchObject({ toRead: 0, drafted: 1, stat: 1, unclaimed: 0 });
    expect(floor.readers.claimed).toEqual([{ userId: fx.radiologist.id, name: "dr.rao", studies: 1 }]);

    expect(floor.licenceGaps).toEqual([expect.objectContaining({ code: "DEV-XRAY", booked: 1 })]);
    expect(floor.criticals).toEqual({ openRed: 0, openAll: 0, oldestRedMin: null });
    expect(floor.unmatchedPacs).toMatchObject({ open: 0, olderThan24h: 0 });
    expect(floor.qaOverdue).toEqual([]);
    // The STAT USG acquired with no invoice line raises `acquired_unbilled` — leakage, unpriced here (no tariff).
    expect(floor.leakage).toMatchObject({ open: 1, unpriced: 1, estimatedPaise: 0 });
    expect(floor.leakage.rows[0]).toMatchObject({ accessionNo: usg.accessionNo });
    // The machine down, the licence gap under a booked patient, and the STAT USG with only a draft
    // 20 minutes after its images came in are escalation causes.
    expect(floor.escalations.open).toBe(3);

    // No patient on the floor: accession numbers only.
    expect(JSON.stringify(floor)).not.toContain("Asha");
  });

  it("turnaround carries the north star's percentiles against the RS8a target for each source", async () => {
    await floorDay();
    const floor = await supervisorFloor(db, T);
    expect(floor.turnaround.from).toBe("2026-08-25");
    expect(floor.turnaround.to).toBe(DAY);
    for (const r of floor.turnaround.rows) expect(r.targetMin).toBe(targetFor(r.source));
    expect(targetFor("ER")).toBe(30);
    expect(targetFor("IPD")).toBe(360);
    expect(targetFor("OPD")).toBe(1440);
    // Nothing signed yet: no percentile, so no verdict — never a false "within target".
    expect(floor.turnaround.rows.every((r) => r.withinTarget === null)).toBe(true);
  });

  it("escalations raised on the spine are counted as raised", async () => {
    await floorDay();
    await ensureEscalationDefinitions(db, fx.radiologist);
    await sweepImagingEscalations(db, T);
    expect((await supervisorFloor(db, T)).escalations).toEqual({ open: 3, raised: 3 });
  });

  it("quality: a number is shown only where data exists — peer review and critical read-back say not measured", async () => {
    await floorDay();
    const q = await supervisorQuality(db, { from: DAY, to: DAY, now: T });
    const by = new Map(q.indicators.map((i) => [i.key, i] as const));
    expect(by.get("peer_review_discrepancy")).toMatchObject({ value: null, status: "not_measured" });
    // No critical_categories book in this fixture: the windows are the book's, so nothing is judged.
    expect(by.get("critical_communication")).toMatchObject({ value: null, status: "not_measured" });
    // Two scans started (the USG at NOW, the CT at NOW+10), each checked in at its own start: waits 0.
    expect(by.get("waiting_time")).toMatchObject({ value: 0, denominator: 2, status: "ok" });
    expect(by.get("tat_compliance")).toMatchObject({ value: null, denominator: 0, status: "not_measured" });
    expect(by.get("waiting_time")!.days).toEqual([{ day: DAY, value: 0, status: "ok" }]);
    await expect(supervisorQuality(db, { from: DAY, to: "2026-08-01" })).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("the access log names who opened whose images, logs its own read, and keeps that read out of the list", async () => {
    const { usg } = await floorDay();
    const log = await supervisorAccessLog(db, fx.radiologist, { from: DAY, to: DAY });
    const images = log.rows.filter((r) => r.kind === "images");
    expect(images).toEqual([expect.objectContaining({
      whoName: "dr.rao", roles: ["radiologist"], accessionNo: usg.accessionNo, patientUhid: "HMS-00000001-5",
      patientName: "Asha Devi", breakGlass: false,
    })]);
    const mine = await db.select().from(phiAccessLog).where(eq(phiAccessLog.reason, ACCESS_LOG_REVIEW_REASON));
    expect(mine).toHaveLength(1);
    const again = await supervisorAccessLog(db, fx.radiologist, { from: DAY, to: DAY });
    expect(again.rows.some((r) => r.reason === ACCESS_LOG_REVIEW_REASON)).toBe(false);
  });
});
