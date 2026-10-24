import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { alerts, erAdmissionDisputes, tasks } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErMlcWorld } from "../../../../test/helpers/emergency";
import {
  arbitrateAdmission, assignErDoctor, handToUnit, placeInBay, recordSpecialtyRefusal, registerArrival, sweepErBoarding, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErMlcWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 5 follow-up (#812, spec §3.2 decision-to-bed ≤ 2 h, §4.5 edge "specialty refuses the admission → MS
 * arbitration task"). A boarding patient past 2 h is a task for the bed manager; past 4 h it climbs to the MS; a
 * specialty's refusal is recorded and the MS's ruling closes the arbitration task.
 */

jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 5 — decision to bed and the MS's arbitration", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErMlcWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    w = await mkErMlcWorld(db);
  });

  const inTreatment = async (gate: Date) => {
    const p = await w.patient("male", 61, "Bhola Paswan");
    const a = await registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in", arrivedAt: gate.toISOString() }, { now: gate });
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, level: 2, decision: { lifeSaving: false, highRisk: true, resources: "many", dangerVitals: false } }, { now: gate });
    const bay = await w.bed("ER-R7", { class: "emergency" });
    await placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: bay }, { now: gate });
    await assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, doctorId: w.erDoctor.id }, { now: gate });
    return a;
  };

  it("a boarding patient past 2 h is a task for the bed manager; past 4 h it climbs once to the MS", async () => {
    const t0 = new Date(Date.now() - 5 * 60 * MIN);
    const a = await inTreatment(t0);
    await handToUnit(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: a.episodeId, reason: "Needs ward care", consultantId: w.doctor.id, requestedClass: "general", provisionalDiagnosis: "CAP",
    }, { now: t0 });
    const boardingTasks = () => db.select().from(tasks).where(eq(tasks.kind, "er_boarding"));
    expect(await sweepErBoarding(db, new Date(t0.getTime() + 119 * MIN))).toMatchObject({ tasks: 0, climbs: 0 });
    expect(await sweepErBoarding(db, new Date(t0.getTime() + 120 * MIN))).toMatchObject({ tasks: 1, climbs: 0 });
    expect(await sweepErBoarding(db, new Date(t0.getTime() + 121 * MIN))).toMatchObject({ tasks: 0, climbs: 0 });
    const [task] = await boardingTasks();
    expect(task).toMatchObject({ patientId: a.patientId, priority: "urgent" });
    expect(task!.note).toContain(a.episodeNo);
    expect(await sweepErBoarding(db, new Date(t0.getTime() + 239 * MIN))).toMatchObject({ climbs: 0 });
    expect(await sweepErBoarding(db, new Date(t0.getTime() + 240 * MIN))).toMatchObject({ climbs: 1 });
    expect(await sweepErBoarding(db, new Date(t0.getTime() + 241 * MIN))).toMatchObject({ tasks: 0, climbs: 0 });
    const told = await db.select().from(alerts).where(and(eq(alerts.userId, w.ms.id), eq(alerts.kind, "er.boarding_long")));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).not.toContain("Bhola");
  });

  it("a specialty's refusal is recorded and becomes the MS's task; only the MS rules, once, and the task closes", async () => {
    const t0 = new Date(Date.now() - 60 * MIN);
    const a = await inTreatment(t0);
    const r = await recordSpecialtyRefusal(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, departmentCode: "sur", reason: "Not a surgical abdomen" });
    await expect(recordSpecialtyRefusal(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, departmentCode: "MED", reason: "x" }))
      .rejects.toMatchObject({ code: "dispute_open" });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, r.taskId));
    expect(task).toMatchObject({ kind: "er_arbitration", priority: "urgent" });
    await expect(arbitrateAdmission(db, w.mortuary, { idempotencyKey: key(), disputeId: r.disputeId, ruling: "admit_under", departmentCode: "SUR", note: "x" }))
      .rejects.toMatchObject({ code: "not_the_ms" });
    const ruled = await arbitrateAdmission(db, w.ms, { idempotencyKey: key(), disputeId: r.disputeId, ruling: "admit_under", departmentCode: "sur", note: "Admit under surgery for observation" });
    expect(ruled.ruling).toBe("admit_under");
    expect((await db.select().from(erAdmissionDisputes).where(eq(erAdmissionDisputes.id, r.disputeId)))[0])
      .toMatchObject({ ruling: "admit_under", rulingDepartmentCode: "SUR", ruledBy: w.ms.id });
    expect((await db.select().from(tasks).where(eq(tasks.id, r.taskId)))[0]!.state).toBe("cancelled");
    await expect(arbitrateAdmission(db, w.ms, { idempotencyKey: key(), disputeId: r.disputeId, ruling: "refer_out", note: "again" }))
      .rejects.toMatchObject({ code: "dispute_ruled" });
  });
});
