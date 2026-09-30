import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { acquireStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import {
  events, imagingCriticalCallAttempts, imagingCriticalFindings, imagingDefinitions, orders,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { acknowledgeCritical, draftReport, flagCritical, signReport } from "./reports";
import { criticalCallBoard, readBackNamesFinding, recordCallAttempt } from "./critical-ladder";
import { sweepCriticalChaser } from "./chasers";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8b T2 — **the critical-call ladder.** Treating doctor → unit head → duty RMO → HOD;
 * a "no answer" moves the call up one rung; the chaser moves it up one rung per tier window; the call
 * closes ONLY on a read-back that names the finding (`read_back_mismatch` otherwise).
 */
describe("the critical-call ladder (18-S RS8b T2)", () => {
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
    await db.insert(imagingDefinitions).values({
      id: `def-crit-${String(Date.now())}`, kind: "critical_categories", version: 1, status: "active",
      draftedBy: "t", publishedBy: "t", publishedAt: NOW,
      body: {
        categories: [
          { category: "red", communicate_within_min: 15, requires_read_back: true, examples: [] },
          { category: "orange", communicate_within_min: 120, requires_read_back: false, examples: [] },
        ],
      },
    });
  });
  afterEach(() => { fx.unregister(); });

  /** A signed report stating a RED finding, flagged, on a study the fixture doctor ordered. */
  const redCall = async (impression = "Large left extradural haematoma with midline shift.") => {
    seq += 1;
    const study = await acquireStudy(db, fx, {
      idemKey: `cl${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000),
      slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, study.orderId));
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId, body: { findings: "Biconvex hyperdense collection, left temporal." }, impression,
    }));
    const signed = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId: d.reportId, secondFactorAt: FRESH, now: NOW, criticalCategory: "red",
    }));
    const [c] = await db.select().from(imagingCriticalFindings).where(eq(imagingCriticalFindings.reportId, signed.reportId));
    return { ...study, reportId: signed.reportId, criticalId: c!.id };
  };
  const call = (criticalId: string, rung: number, outcome: "no_answer" | "answered", calledName = "Dr on the phone") =>
    withTx(db, (tx) => recordCallAttempt(tx, fx.radiologist, { criticalId, rung, calledName, outcome, now: NOW }));
  const ack = (criticalId: string, readBack: string, now: Date = NOW) =>
    withTx(db, (tx) => acknowledgeCritical(tx, fx.radiologist, {
      criticalId, acknowledgedByClinicianId: fx.doctor.id, readBack, now,
    }));
  const finding = async (id: string) =>
    (await db.select().from(imagingCriticalFindings).where(eq(imagingCriticalFindings.id, id)))[0]!;
  const after = async (id: string, minutes: number) => new Date((await finding(id)).createdAt.getTime() + minutes * 60_000);

  /* ═══════════════════════ the read-back names the finding ═══════════════════════ */

  it("readBackNamesFinding: the clinician's words must name what the report found", () => {
    const report = { impression: "Large left extradural haematoma with midline shift.", findings: null };
    expect(readBackNamesFinding("left EDH — extradural hematoma, taking to theatre", report)).toBe(true);
    expect(readBackNamesFinding("haematoma on the left, shifting to OT", report)).toBe(true);
    expect(readBackNamesFinding("noted", report)).toBe(false);
    expect(readBackNamesFinding("OK sir, will see the patient", report)).toBe(false);
    expect(readBackNamesFinding("left side, large, acute", report)).toBe(false);
    /** A critical term the report states counts even in other words around it. */
    expect(readBackNamesFinding("tension pneumothorax, inserting a drain", { impression: "Right tension pneumothorax.", findings: null })).toBe(true);
    /** A negated critical term is not a read-back of it. */
    expect(readBackNamesFinding("no pneumothorax", { impression: "Right tension pneumothorax.", findings: null })).toBe(false);
    expect(readBackNamesFinding("pneumothorax excluded, right side clear", { impression: "Right tension pneumothorax.", findings: null })).toBe(false);
    /** Nothing to name → any words close it (the RED rule that a read-back EXISTS is separate). */
    expect(readBackNamesFinding("noted", { impression: "", findings: null })).toBe(true);
  });

  it("acknowledgeCritical refuses a read-back that names nothing (read_back_mismatch) and accepts one that names the finding", async () => {
    const c = await redCall();
    await expect(ack(c.criticalId, "noted, thank you")).rejects.toMatchObject({ code: "read_back_mismatch" });
    expect((await finding(c.criticalId)).acknowledgedAt).toBeNull();
    await ack(c.criticalId, "Left extradural haematoma — shifting to theatre");
    const f = await finding(c.criticalId);
    expect(f.acknowledgedBy).toBe(fx.doctor.id);
    const rows = await db.select().from(imagingCriticalCallAttempts).where(eq(imagingCriticalCallAttempts.criticalId, c.criticalId));
    expect(rows.map((r) => [r.rung, r.outcome, r.calledUserId])).toEqual([[0, "read_back_ok", fx.doctor.id]]);
  });

  /* ═══════════════════════ the rungs ═══════════════════════ */

  it("no answer moves the call up one rung at a time to the HOD, and stays there; answered does not move it", async () => {
    const c = await redCall();
    expect((await call(c.criticalId, 0, "answered")).ladderRung).toBe(0);
    expect((await call(c.criticalId, 0, "no_answer")).ladderRung).toBe(1);
    expect((await call(c.criticalId, 1, "no_answer")).ladderRung).toBe(2);
    expect((await call(c.criticalId, 2, "no_answer")).ladderRung).toBe(3);
    expect((await call(c.criticalId, 3, "no_answer")).ladderRung).toBe(3);
    const rows = await db.select().from(imagingCriticalCallAttempts).where(eq(imagingCriticalCallAttempts.criticalId, c.criticalId));
    expect(rows.map((r) => [r.rung, r.outcome])).toEqual([
      [0, "answered"], [0, "no_answer"], [1, "no_answer"], [2, "no_answer"], [3, "no_answer"],
    ]);
    /** The read-back on the HOD's rung closes it there. */
    await ack(c.criticalId, "extradural haematoma, neurosurgeon informed");
    const last = (await db.select().from(imagingCriticalCallAttempts).where(eq(imagingCriticalCallAttempts.criticalId, c.criticalId))).at(-1)!;
    expect([last.rung, last.outcome]).toEqual([3, "read_back_ok"]);
  });

  it("a call recorded on a rung the ladder has left is stale_state; a call on a closed critical is refused; a call names somebody", async () => {
    const c = await redCall();
    await call(c.criticalId, 0, "no_answer");
    await expect(call(c.criticalId, 0, "no_answer")).rejects.toMatchObject({ code: "stale_state" });
    await expect(withTx(db, (tx) => recordCallAttempt(tx, fx.radiologist, { criticalId: c.criticalId, rung: 1, outcome: "answered", now: NOW })))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    await ack(c.criticalId, "extradural haematoma");
    await expect(call(c.criticalId, 1, "answered")).rejects.toMatchObject({ code: "already_signed" });
  });

  /* ═══════════════════════ the chaser climbs by the tier's windows ═══════════════════════ */

  it("the chaser escalates one rung per window (red 15 min) up to the HOD, one event each, never more than three", async () => {
    const c = await redCall();
    expect((await sweepCriticalChaser(db, await after(c.criticalId, 10))).chased).toEqual([]);
    expect((await sweepCriticalChaser(db, await after(c.criticalId, 16))).chased.map((x) => x.rung)).toEqual(["unit_head"]);
    expect((await sweepCriticalChaser(db, await after(c.criticalId, 20))).chased).toEqual([]);
    expect((await sweepCriticalChaser(db, await after(c.criticalId, 31))).chased.map((x) => x.rung)).toEqual(["duty_rmo"]);
    expect((await sweepCriticalChaser(db, await after(c.criticalId, 46))).chased.map((x) => x.rung)).toEqual(["hod"]);
    expect((await sweepCriticalChaser(db, await after(c.criticalId, 120))).chased).toEqual([]);
    expect((await finding(c.criticalId)).ladderRung).toBe(3);
    const overdue = (await db.select().from(events)).filter((e) => e.name === "imaging.critical_overdue");
    expect(overdue.map((e) => (e.payload as { rung: string }).rung)).toEqual(["unit_head", "duty_rmo", "hod"]);
  });

  it("the chaser never moves the rung DOWN: a call already moved by a no-answer keeps its rung", async () => {
    const c = await redCall();
    await call(c.criticalId, 0, "no_answer");
    await call(c.criticalId, 1, "no_answer");
    const chased = (await sweepCriticalChaser(db, await after(c.criticalId, 16))).chased;
    expect(chased.map((x) => x.rung)).toEqual(["duty_rmo"]);
    expect((await finding(c.criticalId)).ladderRung).toBe(2);
  });

  /* ═══════════════════════ the board's read ═══════════════════════ */

  it("the board: open calls with the ladder (treating doctor by name, HOD by role), then the acknowledged log", async () => {
    const open = await redCall();
    const closed = await redCall("Right tension pneumothorax.");
    /** The log reaches back 48 h from the board's clock, which (like the rows') is the real one. */
    await ack(closed.criticalId, "tension pneumothorax on the right, draining", await after(closed.criticalId, 5));
    const board = await criticalCallBoard(db, fx.radiologist, await after(open.criticalId, 20), {});
    expect(board.open.map((c) => c.criticalId)).toEqual([open.criticalId]);
    const o = board.open[0]!;
    expect(o).toMatchObject({ category: "red", windowMin: 15, overdue: true, ladderRung: 0 });
    expect(o.finding).toContain("extradural");
    expect(o.rungs.map((r) => [r.key, r.source])).toEqual([
      ["treating_doctor", "order"], ["unit_head", "role"], ["duty_rmo", "role"], ["hod", "role"],
    ]);
    expect(o.rungs[0]!.people).toEqual([{ userId: fx.doctor.id, name: "dr.mehra" }]);
    expect(o.rungs[3]!.people.map((p) => p.name)).toContain("ms.iyer");
    expect(board.acknowledged.map((c) => [c.criticalId, c.acknowledgedByName, c.readBack]))
      .toEqual([[closed.criticalId, "dr.mehra", "tension pneumothorax on the right, draining"]]);
  });

  it("flagging after the fact still works and starts the ladder at the treating doctor", async () => {
    const c = await redCall();
    const again = await withTx(db, (tx) => flagCritical(tx, fx.radiologist, { reportId: c.reportId, category: "orange" }));
    expect(again.criticalId).toBe(c.criticalId);
    expect((await finding(c.criticalId)).ladderRung).toBe(0);
  });
});
