import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { mkDoctor, mkUser, seedOpdMasters } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  events, imagingCriticalFindings, imagingReportDelivery, opdEncounters, orders,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { amendReport, draftReport, flagCritical, publishReport, signReport } from "./reports";
import { reportView } from "./read";
import { doctorReadBack, doctorResultsInbox, markActedUpon } from "./closed-loop";
import { sweepUnreadWatchman, UNREAD_REPORT_HOURS } from "./chasers";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS9 T1 + T3 — **the closed loop.** The north star is order → report ACTED UPON: the
 * clock stops when the TREATING doctor records what the report changed. These pin who that doctor
 * is, what an act needs, that an amendment re-opens the loop, that only the treating doctor's read
 * lands, and the order of the doctor's inbox.
 */
describe("the closed loop (18-S RS9 T1/T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let other: Actor;

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
    const registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "Rad", menu: [],
      permissions: ["radiology.worklist.read", "radiology.reports.read"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    for (const p of ["radiology.worklist.read", "radiology.reports.read"]) {
      await grantPermissionToRole(db, registry, "radiologist", p);
      await grantPermissionToRole(db, registry, "radiographer", p);
    }
    await grantPermissionToRole(db, registry, "doctor", "radiology.reports.read");
    ({ actor: other } = await mkUser(db, "dr.other", ["doctor"]));
  });
  afterEach(() => { fx.unregister(); });

  /** A released report on a study whose ORDERING CLINICIAN is `treating` (default: the fixture doctor). */
  const released = async (treating: string | null = fx.doctor.id) => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `cl${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    await db.update(orders).set({ orderingClinicianId: treating }).where(eq(orders.id, study.orderId));
    const draft = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Right lower lobe consolidation." }, impression: "Pneumonia, right lower lobe.",
    }));
    const { reportId, version } = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: draft.reportId, secondFactorAt: FRESH, now: NOW,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: study.studyId, now: NOW }));
    return { ...study, reportId, version };
  };

  const act = (actor: Actor, reportId: string, outcome = "changed_treatment", note = "Started antibiotics; review in 5 days") =>
    withTx(db, (tx) => markActedUpon(tx, actor, { reportId, outcome, note, now: NOW }));

  const delivery = async (reportId: string) =>
    (await db.select().from(imagingReportDelivery).where(eq(imagingReportDelivery.reportId, reportId)))[0];

  /* ═══════════════════════ T1 — acted upon ═══════════════════════ */

  it("the ordering clinician records what the report changed — outcome, line, person, instant, and the read with it", async () => {
    const s = await released();
    const out = await act(fx.doctor, s.reportId);
    expect(out.outcome).toBe("changed_treatment");

    const row = await delivery(s.reportId);
    expect([row?.actedBy, row?.actedOutcome, row?.actedNote, row?.actedAt?.toISOString()])
      .toEqual([fx.doctor.id, "changed_treatment", "Started antibiotics; review in 5 days", NOW.toISOString()]);
    /** An act implies a read: the first read is stamped when it was empty. */
    expect([row?.firstReadBy, row?.firstReadAt?.toISOString()]).toEqual([fx.doctor.id, NOW.toISOString()]);

    const ev = await db.select().from(events).where(eq(events.name, "imaging.report_acted_upon"));
    expect(ev).toHaveLength(1);
    /** The payload carries the outcome CODE and never the doctor's sentence. */
    expect(JSON.stringify(ev[0]!.payload)).not.toContain("antibiotics");
  });

  it("a doctor who is not treating this patient is refused by name, and nothing is written", async () => {
    const s = await released();
    await expect(act(other, s.reportId)).rejects.toMatchObject({ code: "not_treating_doctor" });
    await expect(act(other, s.reportId)).rejects.toThrow(/dr\.mehra/);
    /** The radiologist who signed it is not the treating doctor either. */
    await expect(act(fx.radiologist, s.reportId)).rejects.toMatchObject({ code: "not_treating_doctor" });
    expect(await delivery(s.reportId)).toBeUndefined();
  });

  it("the doctor of the visit the study belongs to may act, as well as the ordering clinician", async () => {
    const s = await released("dr-consultant-not-a-user");
    const masters = await seedOpdMasters(db);
    const visitDoctor = await mkDoctor(db, { username: "dr.visit", departmentId: masters.deptId, roomId: masters.roomId });
    await db.update(opdEncounters).set({ doctorId: visitDoctor.doctorId }).where(eq(opdEncounters.visitNo, fx.visitNo));

    await act(visitDoctor.actor, s.reportId, "no_change", "Consolidation expected; continue plan");
    expect((await delivery(s.reportId))?.actedBy).toBe(visitDoctor.userId);
  });

  it("a line of what changed is required — at least four characters — and the outcome is from the list", async () => {
    const s = await released();
    await expect(act(fx.doctor, s.reportId, "changed_treatment", "ok")).rejects.toMatchObject({ code: "acted_note_required" });
    await expect(act(fx.doctor, s.reportId, "changed_treatment", "    ")).rejects.toMatchObject({ code: "acted_note_required" });
    await expect(act(fx.doctor, s.reportId, "cured", "Started antibiotics")).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(await delivery(s.reportId)).toBeUndefined();
  });

  it("acts once per version: a second act is refused, and an unreleased report cannot be acted on", async () => {
    const s = await released();
    await act(fx.doctor, s.reportId);
    await expect(act(fx.doctor, s.reportId, "referred", "Referred to chest")).rejects.toMatchObject({ code: "already_resolved" });

    seq += 1;
    const unreleased = await acquireStudy(db, fx, {
      idemKey: `un${String(seq)}`, now: new Date(NOW.getTime() + 90 * 3_600_000), slot: new Date(SLOT.getTime() + 20 * 3_600_000),
    });
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, unreleased.orderId));
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, { studyId: unreleased.studyId, body: { findings: "Normal." } }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: unreleased.studyId, reportId: d.reportId, secondFactorAt: FRESH, now: NOW,
    }));
    await expect(act(fx.doctor, signed.reportId)).rejects.toMatchObject({ code: "report_not_published" });
  });

  it("DECIDED: an amendment re-opens the loop — acted on v1 does not count for v2, and v1 can no longer be acted on", async () => {
    const s = await released();
    await act(fx.doctor, s.reportId);

    const v2 = await withTx(db, (tx) => amendReport(tx, fx.radiologist, {
      studyId: s.studyId, secondFactorAt: FRESH, reason: "Missed a 6 mm nodule on the first read", now: NOW,
      body: { findings: "Right lower lobe consolidation. 6 mm nodule, left upper lobe." }, impression: "Pneumonia; LUL nodule.",
    }));
    expect(await delivery(v2.reportId)).toBeUndefined();
    const inbox = await doctorResultsInbox(db, fx.doctor, NOW);
    expect(inbox.map((r) => [r.reportId, r.state, r.amended])).toEqual([[v2.reportId, "unread", true]]);

    await expect(act(fx.doctor, s.reportId, "referred", "Referred to chest")).rejects.toMatchObject({ code: "report_superseded" });
    await act(fx.doctor, v2.reportId, "followup_booked", "CT chest in 3 months booked");
    expect((await delivery(v2.reportId))?.actedOutcome).toBe("followup_booked");
  });

  /* ═══════════════════════ T1 — whose read lands ═══════════════════════ */

  it("a technologist opening the report does NOT count as it having landed; the treating doctor's read does", async () => {
    const s = await released();
    await reportView(db, fx.radiographer, s.reportId);
    await reportView(db, other, s.reportId);
    expect(await delivery(s.reportId)).toBeUndefined();
    const later = new Date(NOW.getTime() + (UNREAD_REPORT_HOURS + 1) * 3_600_000);
    expect((await sweepUnreadWatchman(db, later)).chased.map((c) => c.reportId)).toEqual([s.reportId]);

    const s2 = await released();
    await reportView(db, fx.doctor, s2.reportId);
    expect((await delivery(s2.reportId))?.firstReadBy).toBe(fx.doctor.id);
  });

  /* ═══════════════════════ T3 — the inbox and the read-back ═══════════════════════ */

  it("the inbox: open criticals first, then unread, then read-not-acted, then acted — only the doctor's own patients", async () => {
    const acted = await released();
    const read = await released();
    const unread = await released();
    const critical = await released();
    await act(fx.doctor, acted.reportId);
    await reportView(db, fx.doctor, read.reportId);
    await withTx(db, (tx) => flagCritical(tx, fx.radiologist, { reportId: critical.reportId, category: "red", now: NOW }));
    const notMine = await released("dr-consultant-not-a-user");

    const inbox = await doctorResultsInbox(db, fx.doctor, NOW);
    expect(inbox.map((r) => r.reportId)).toEqual([critical.reportId, unread.reportId, read.reportId, acted.reportId]);
    expect(inbox.map((r) => r.state)).toEqual(["unread", "unread", "read", "acted"]);
    expect(inbox[0]!.critical).toMatchObject({ category: "red", acknowledgedAt: null });
    expect(inbox[3]!.acted).toMatchObject({ outcome: "changed_treatment" });
    expect(inbox.map((r) => r.reportId)).not.toContain(notMine.reportId);
    expect(await doctorResultsInbox(db, other, NOW)).toEqual([]);
  });

  it("the doctor reads back a RED critical in their own words; the same critical row closes, and only for the treating doctor", async () => {
    const s = await released();
    const { criticalId } = await withTx(db, (tx) => flagCritical(tx, fx.radiologist, { reportId: s.reportId, category: "red", now: NOW }));

    await expect(withTx(db, (tx) => doctorReadBack(tx, other, { reportId: s.reportId, readBack: "free gas", now: NOW })))
      .rejects.toMatchObject({ code: "not_treating_doctor" });
    await expect(withTx(db, (tx) => doctorReadBack(tx, fx.doctor, { reportId: s.reportId, readBack: "  ", now: NOW })))
      .rejects.toMatchObject({ code: "reason_required" });

    await withTx(db, (tx) => doctorReadBack(tx, fx.doctor, {
      reportId: s.reportId, readBack: "Right lower lobe pneumonia, starting antibiotics", now: NOW,
    }));
    const row = (await db.select().from(imagingCriticalFindings).where(eq(imagingCriticalFindings.id, criticalId)))[0]!;
    expect([row.acknowledgedBy, row.recordedBy, row.readBackText])
      .toEqual([fx.doctor.id, fx.doctor.id, "Right lower lobe pneumonia, starting antibiotics"]);
    expect((await delivery(s.reportId))?.firstReadBy).toBe(fx.doctor.id);
    const inbox = await doctorResultsInbox(db, fx.doctor, NOW);
    expect(inbox[0]!.critical?.acknowledgedAt).not.toBeNull();
  });
});
