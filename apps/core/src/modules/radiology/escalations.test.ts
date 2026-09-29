import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import {
  aerbLicences, events, imagingBillDecisions, imagingCriticalFindings, imagingStudies, resources, workflowInstances,
  workflowTimers,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { runDueTimers } from "../../kernel/workflow/timers";
import { checkIn } from "./checkin";
import { scheduleStudy } from "./schedule";
import { requireStudyGate, satisfyGate } from "./gates";
import { draftReport, publishReport, signReport } from "./reports";
import { stampFirstRead } from "./closed-loop";
import {
  ESCALATION_SPECS, IMAGING_ESCALATION_CAUSES, RADIOLOGY_ESCALATION_DEFINITIONS, ensureEscalationDefinitions,
  escalationCauses, escalationDefKey, escalationList, sweepImagingEscalations,
} from "./escalations";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS10 T2 — **escalations ride the kernel obligation spine**: a cause becomes a workflow
 * instance whose ladder the kernel fires, and the instance resolves when the cause clears. Every
 * cause is placed by the test at a FIXED clock and the sweep is asked at a fixed `now`.
 */
describe("the HOD's escalations on the obligation spine (18-S RS10 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const MIN = 60_000;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    await ensureEscalationDefinitions(db, fx.radiologist);
  });
  afterEach(() => { fx.unregister(); });

  const active = async (cause: string) => db.select().from(workflowInstances).where(and(
    eq(workflowInstances.defKey, `imaging_esc_${cause}`), eq(workflowInstances.status, "active"),
  ));

  it("one class-C definition per cause, each with a ladder that ends at a named role and a respond clock", () => {
    expect(RADIOLOGY_ESCALATION_DEFINITIONS.map((d) => d.key)).toEqual(IMAGING_ESCALATION_CAUSES.map(escalationDefKey));
    for (const def of RADIOLOGY_ESCALATION_DEFINITIONS) {
      expect(def.changeClass).toBe("C");
      const open = def.states.find((s) => s.name === "open")!;
      expect(open.sla?.alerting).toBe("active");
      expect(open.sla?.respondMinutes).toBeLessThanOrEqual(open.sla!.minutes);
      expect(open.sla?.ladder?.[0]?.atPercent).toBe(1);
      expect(open.sla?.ladder?.at(-1)?.atPercent).toBe(100);
      expect(def.transitions).toEqual([{ from: "open", to: "resolved", roles: ["system"] }]);
    }
  });

  it("a STAT study unread past 15 minutes is raised once, the kernel's ladder tells the radiologists, and a signature resolves it", async () => {
    const s = await acquireStudy(db, fx, { idemKey: "stat1", now: NOW, slot: SLOT });

    // Inside the window: nothing.
    expect((await sweepImagingEscalations(db, new Date(NOW.getTime() + 10 * MIN))).raised).toEqual([]);

    const later = new Date(NOW.getTime() + 16 * MIN);
    const first = await sweepImagingEscalations(db, later);
    expect(first.raised).toEqual([expect.objectContaining({ cause: "stat_unread", subjectId: s.studyId })]);
    // A second cycle raises nothing more — one obligation per cause.
    expect((await sweepImagingEscalations(db, later)).raised).toEqual([]);
    expect(await active("stat_unread")).toHaveLength(1);

    // The spine does the rest: rung 0 (1 % of 15 min) fires as `escalation.triggered` to the radiologist role.
    await runDueTimers(db, new Date(Date.now() + 60_000));
    const escalated = await db.select().from(events).where(eq(events.name, "escalation.triggered"));
    const payload = escalated.map((e) => e.payload as { instanceId: string; role: string; resolvedUserIds: string[] });
    expect(payload).toEqual([expect.objectContaining({
      instanceId: first.raised[0]!.instanceId, role: "radiologist", resolvedUserIds: [fx.radiologist.id],
    })]);

    // The HOD's list shows it with the seat that closes it — accession, no patient.
    const list = await escalationList(db, fx.radiologist, later);
    expect(list.rows).toEqual([expect.objectContaining({
      cause: "stat_unread", accessionNo: s.accessionNo, instanceId: first.raised[0]!.instanceId, ageMin: 16,
      seat: `/radiology/read?study=${s.studyId}`, title: ESCALATION_SPECS.stat_unread.title,
    })]);
    expect(JSON.stringify(list.rows)).not.toContain("Asha");

    // The radiologist signs: the cause clears, the next sweep resolves it and its timers stop.
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Normal." }, impression: "Normal study." }));
    await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(later.getTime() - MIN), now: later,
    }));
    const cleared = await sweepImagingEscalations(db, new Date(later.getTime() + MIN));
    expect(cleared.resolved).toEqual([expect.objectContaining({ cause: "stat_unread", subjectId: s.studyId })]);
    expect(await active("stat_unread")).toHaveLength(0);
    const live = await db.select().from(workflowTimers).where(and(
      eq(workflowTimers.instanceId, first.raised[0]!.instanceId), isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt),
    ));
    expect(live).toEqual([]);
  });

  it("a patient held at an open gate past 30 minutes is raised, and satisfying the gate resolves it", async () => {
    const s = await placeAndCreateStudy(db, fx, "USG-ABDO", "held1", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: s.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: SLOT }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: s.studyId, now: NOW }));
    expect(checked.gates.length).toBeGreaterThan(0);

    expect((await sweepImagingEscalations(db, new Date(NOW.getTime() + 29 * MIN))).raised).toEqual([]);
    const raised = await sweepImagingEscalations(db, new Date(NOW.getTime() + 31 * MIN));
    expect(raised.raised).toEqual([expect.objectContaining({ cause: "held_study", subjectId: s.studyId })]);
    const causes = await escalationCauses(db, new Date(NOW.getTime() + 31 * MIN));
    expect(causes[0]!.detail).toContain("open:");

    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
      pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
      laterality_confirm: { patientStated: "na" },
    };
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, s.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, NOW));
    }
    const after = await sweepImagingEscalations(db, new Date(NOW.getTime() + 32 * MIN));
    expect(after.resolved).toEqual([expect.objectContaining({ cause: "held_study", subjectId: s.studyId })]);
  });

  it("a machine down is raised with its booked count; back in service resolves it", async () => {
    await db.update(resources).set({ status: "down" }).where(eq(resources.id, fx.devices.ct!));
    const r = await sweepImagingEscalations(db, NOW);
    expect(r.raised).toEqual([expect.objectContaining({ cause: "machine_down", subjectId: fx.devices.ct })]);
    const list = await escalationList(db, fx.radiologist, NOW);
    expect(list.rows[0]).toMatchObject({ cause: "machine_down", deviceCode: "DEV-CT", seat: "/radiology/room?view=downtime" });
    expect(list.rows[0]!.detail).toContain("nobody booked on it");

    await db.update(resources).set({ status: "available" }).where(eq(resources.id, fx.devices.ct!));
    expect((await sweepImagingEscalations(db, NOW)).resolved).toEqual([expect.objectContaining({ cause: "machine_down" })]);
  });

  it("a licence that lapses under a booked patient is raised; a machine with nobody booked is not", async () => {
    const s = await placeAndCreateStudy(db, fx, "XR-CHEST", "gap1", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: s.studyId, deviceResourceId: fx.devices.xray!, scheduledAt: SLOT }));
    // The CT's licence lapses too, but nobody is booked on the CT.
    await db.update(aerbLicences).set({ validTo: "2026-08-30" });
    const r = await sweepImagingEscalations(db, NOW);
    expect(r.raised).toEqual([expect.objectContaining({ cause: "licence_gap", subjectId: fx.devices.xray })]);

    await db.update(imagingStudies).set({ status: "cancelled" }).where(eq(imagingStudies.id, s.studyId));
    expect((await sweepImagingEscalations(db, NOW)).resolved).toEqual([expect.objectContaining({ cause: "licence_gap" })]);
  });

  it("a bill decision open more than a day is raised; resolving it clears it", async () => {
    const s = await acquireStudy(db, fx, { idemKey: "bill1", now: NOW, slot: SLOT });
    const [decision] = await db.select().from(imagingBillDecisions).where(eq(imagingBillDecisions.studyId, s.studyId));
    expect(decision).toBeDefined();
    await db.update(imagingBillDecisions).set({ raisedAt: new Date(NOW.getTime() - 25 * 60 * MIN) })
      .where(eq(imagingBillDecisions.id, decision!.id));
    // Signed, so the STAT clock is not what this test is about.
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Normal." }, impression: "Normal study." }));
    await withTx(db, (tx) => signReport(tx, fx.radiologist, { studyId: s.studyId, reportId: d.reportId, secondFactorAt: NOW, now: NOW }));

    const r = await sweepImagingEscalations(db, NOW);
    expect(r.raised).toEqual([expect.objectContaining({ cause: "bill_decision_stale", subjectId: decision!.id })]);
    await db.update(imagingBillDecisions).set({ resolvedAt: NOW, resolvedBy: fx.radiologist.id, resolution: "posted" })
      .where(eq(imagingBillDecisions.id, decision!.id));
    expect((await sweepImagingEscalations(db, NOW)).resolved).toEqual([expect.objectContaining({ cause: "bill_decision_stale" })]);
  });

  it("a red critical past its window is raised; the read-back resolves it", async () => {
    const s = await acquireStudy(db, fx, { idemKey: "red1", now: NOW, slot: SLOT });
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Normal." }, impression: "Normal study." }));
    await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: NOW, now: NOW, criticalCategory: "red",
    }));
    const [finding] = await db.select().from(imagingCriticalFindings);
    expect(finding).toBeDefined();
    // No `critical_categories` book in this fixture: the chaser's overdue mark is the window.
    expect((await sweepImagingEscalations(db, NOW)).raised.filter((x) => x.cause === "red_critical")).toEqual([]);
    await db.update(imagingCriticalFindings).set({ chasedAt: NOW }).where(eq(imagingCriticalFindings.id, finding!.id));
    const r = await sweepImagingEscalations(db, NOW);
    expect(r.raised).toEqual([expect.objectContaining({ cause: "red_critical", subjectId: finding!.id })]);

    await db.update(imagingCriticalFindings).set({ acknowledgedAt: NOW, acknowledgedBy: fx.doctor.id, recordedBy: fx.radiologist.id })
      .where(eq(imagingCriticalFindings.id, finding!.id));
    expect((await sweepImagingEscalations(db, NOW)).resolved).toEqual([expect.objectContaining({ cause: "red_critical" })]);
  });

  it("an abnormal report the doctor has not opened in 24 hours is raised; the doctor's first read resolves it", async () => {
    const s = await acquireStudy(db, fx, { idemKey: "abn1", now: NOW, slot: SLOT });
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: s.studyId, body: { findings: "Nodule." }, impression: "Indeterminate nodule." }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: NOW, now: NOW, criticalCategory: "yellow",
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: s.studyId, now: NOW }));

    expect((await sweepImagingEscalations(db, new Date(NOW.getTime() + 23 * 60 * MIN))).raised
      .filter((x) => x.cause === "abnormal_unopened")).toEqual([]);
    const r = await sweepImagingEscalations(db, new Date(NOW.getTime() + 25 * 60 * MIN));
    expect(r.raised.filter((x) => x.cause === "abnormal_unopened")).toEqual([
      expect.objectContaining({ subjectId: signed.reportId }),
    ]);
    await stampFirstRead(db, signed.reportId, fx.doctor.id, new Date(NOW.getTime() + 26 * 60 * MIN));
    const after = await sweepImagingEscalations(db, new Date(NOW.getTime() + 26 * 60 * MIN));
    expect(after.resolved.filter((x) => x.cause === "abnormal_unopened")).toHaveLength(1);
  });

  it("a cause whose definition was never activated is reported, not silently dropped", async () => {
    await truncateAll(db);
    fx.unregister();
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    await db.update(resources).set({ status: "down" }).where(eq(resources.id, fx.devices.ct!));
    const r = await sweepImagingEscalations(db, NOW);
    expect(r.raised).toEqual([]);
    expect(r.notActive).toEqual(["machine_down"]);
    expect((await escalationList(db, fx.radiologist, NOW)).notActive).toEqual(["machine_down"]);
  });
});
