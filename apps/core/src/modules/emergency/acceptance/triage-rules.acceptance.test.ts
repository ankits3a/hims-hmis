import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { alerts, erEpisodes, resources, tasks } from "../../../kernel/db/schema";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkErWorld } from "../../../../test/helpers/emergency";
import {
  assignErDoctor, listErBays, moveBay, placeInBay, preAlert, readErBoard, readErEpisode, recordErVitals, registerUnidentified,
  sweepErTriageClocks, triage,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ErWorld } from "../../../../test/helpers/emergency";

/**
 * ER lane 2 (#809) — the lane section's rules (spec §3.2, §3.3, §4.2, §6 edge 7), through the intents: bays from the bed
 * registry under the IPD lock, the doctor who stops the clocks, a worse vital set, the board, the OPD red flag.
 */

jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;
const URGENT = { lifeSaving: false, highRisk: false, resources: "many" as const, dangerVitals: false };

describe("ER lane 2 er-triage — the triage rules", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErWorld(db); });

  const unknown = (now = new Date()) => registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "female", ageBand: "adult", arrivalMode: "walk_in" }, { now });

  it("bays are emergency beds of the registry: one patient per bay, one bay per patient, a move leaves the old bay to cleaning", async () => {
    const r1 = await w.bed("ER-R1", { class: "emergency" });
    const r2 = await w.bed("ER-R2", { class: "emergency" });
    const ward = await w.bed("W-G1", { class: "general" });
    const a = await unknown();
    const b = await unknown();
    await expect(placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: ward })).rejects.toMatchObject({ code: "bay_not_emergency" });
    await expect(placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: r1 })).resolves.toMatchObject({ bayCode: "ER-R1" });
    // Placed again elsewhere: "already in ER-R1" (§6 edge 7). Another patient into ER-R1: just taken.
    await expect(placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: r2 }))
      .rejects.toMatchObject({ code: "already_in_bay", detail: { bayCode: "ER-R1" } });
    await expect(placeInBay(db, w.erNurse, { idempotencyKey: key(), episodeId: b.episodeId, bedId: r1 })).rejects.toMatchObject({ code: "bay_not_available" });
    const bed1 = (await db.select().from(resources).where(eq(resources.id, r1)))[0]!;
    expect(bed1).toMatchObject({ status: "occupied", occupantType: "er_episode", occupantRef: a.episodeId });
    // Move: the new bay first, then the old to cleaning.
    await expect(moveBay(db, w.erNurse, { idempotencyKey: key(), episodeId: a.episodeId, bedId: r2, reason: "to resus" })).resolves.toMatchObject({ bayCode: "ER-R2", fromBedId: r1 });
    expect((await db.select().from(resources).where(eq(resources.id, r1)))[0]).toMatchObject({ status: "cleaning", occupantRef: null });
    const bays = await listErBays(db, w.erNurse);
    expect(bays.find((x) => x.code === "ER-R2")).toMatchObject({ status: "occupied", episodeId: a.episodeId });
    expect(bays.find((x) => x.code === "ER-R1")).toMatchObject({ status: "cleaning", episodeId: null });
    expect(bays.map((x) => x.code)).not.toContain("W-G1");
    expect((await readErBoard(db, w.erDesk)).waiting.find((t) => t.episodeId === a.episodeId)!.bayCode).toBe("ER-R2");
  });

  it("the doctor of record stops the door-to-doctor and re-triage clocks; only a doctor can be named", async () => {
    const t0 = new Date();
    const u = await unknown(t0);
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, decision: URGENT, level: 3 }, { now: t0 });
    let tile = (await readErBoard(db, w.erDesk, { now: t0 })).inTreatment[0]!;
    expect(tile).toMatchObject({ esi: 3, doctorDueAt: new Date(new Date(u.arrivedAt).getTime() + 30 * MIN).toISOString(), retriageDueAt: new Date(t0.getTime() + 30 * MIN).toISOString() });
    await sweepErTriageClocks(db, new Date(t0.getTime() + 31 * MIN));
    expect(await db.select().from(tasks).where(like(tasks.sourceRef, `er_retriage:${u.episodeId}:%`))).toHaveLength(1);
    await expect(assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, doctorId: w.erNurse.id }))
      .rejects.toMatchObject({ code: "not_a_doctor" });
    await expect(assignErDoctor(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, doctorId: w.erDoctor.id }, { now: new Date(t0.getTime() + 32 * MIN) }))
      .resolves.toMatchObject({ state: "in_treatment" });
    tile = (await readErBoard(db, w.erDesk, { now: t0 })).inTreatment[0]!;
    expect(tile).toMatchObject({ state: "in_treatment", doctor: "er.doctor", doctorDueAt: null, retriageDueAt: null });
    expect((await db.select().from(tasks).where(like(tasks.sourceRef, `er_retriage:${u.episodeId}:%`)))[0]!.state).toBe("cancelled");
    // A later sweep raises nothing for a patient the doctor has seen.
    expect(await sweepErTriageClocks(db, new Date(t0.getTime() + 90 * MIN))).toEqual({ tasks: 0, climbs: 0 });
  });

  it("a worse early-warning band re-triages at once; the score rides beside the level", async () => {
    const t0 = new Date();
    const u = await unknown(t0);
    await triage(db, w.erNurse, {
      idempotencyKey: key(), episodeId: u.episodeId, decision: { ...URGENT, resources: "one" }, level: 4,
      vitals: { respRate: 16, spo2: 98, systolic: 124, pulse: 80, temperatureC: 37, consciousness: "alert" },
    }, { now: t0 });
    const t1 = new Date(t0.getTime() + 10 * MIN);
    const v = await recordErVitals(db, w.erNurse, {
      idempotencyKey: key(), episodeId: u.episodeId, vitals: { respRate: 26, spo2: 90, systolic: 88, pulse: 128, temperatureC: 39.4, consciousness: "confused" },
    }, { now: t1 });
    expect(v).toMatchObject({ worse: true, retriageDueAt: t1.toISOString(), ews: { kind: "news2", band: "high" } });
    const view = await readErEpisode(db, w.erNurse, u.episodeId, { now: t1 });
    expect(view.tile.ews).toMatchObject({ kind: "news2", band: "high" });
    expect(view.history.map((h) => h.kind)).toEqual(["vitals", "triage"]);
  });

  it("the OPD red flag puts the named patient on the board as Expected from OPD", async () => {
    const p = await w.patient("male", 61, "Ram Prasad");
    const call = await preAlert(db, w.erDesk, { idempotencyKey: key(), mode: "opd_red_flag", etaMinutes: 5, count: 1, patientId: p, redFlagKey: "opdTriage.redFlag.chestPain", complaint: "seene mein dard" });
    const board = await readErBoard(db, w.erDoctor);
    expect(board.expected.find((c) => c.preAlertId === call.preAlertId)).toMatchObject({ mode: "opd_red_flag", patientId: p, patientLabel: "Ram Prasad" });
    expect((await readErBoard(db, w.erDoctor, { wall: true })).expected[0]).toMatchObject({ patientId: null, patientLabel: "R. P." });
    await expect(preAlert(db, w.erDesk, { idempotencyKey: key(), mode: "opd_red_flag", etaMinutes: 5, count: 1 })).rejects.toThrow();
  });

  it("triage is the casualty nurse's or a doctor's act; the desk may not", async () => {
    const u = await unknown();
    await expect(triage(db, w.erDesk, { idempotencyKey: key(), episodeId: u.episodeId, decision: URGENT, level: 3 })).rejects.toMatchObject({ code: "er_forbidden" });
    await expect(triage(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, decision: URGENT, level: 3 })).resolves.toMatchObject({ level: 3 });
    await expect(triage(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, decision: URGENT, level: 3 })).rejects.toMatchObject({ code: "episode_wrong_state" });
    expect((await db.select().from(erEpisodes).where(eq(erEpisodes.id, u.episodeId)))[0]!.state).toBe("triaged");
  });
  it("door-to-triage (5 min from the gate) breached becomes a task once, then climbs on the re-triage ladder; triage closes it", async () => {
    const t0 = new Date();
    await ensureRole(db, "nursing_supervisor");
    const supervisor = (await mkUser(db, "er.ns2", ["nursing_supervisor"])).actor;
    const u = await unknown(t0);
    const triageTasks = () => db.select().from(tasks).where(like(tasks.sourceRef, `er_triage:${u.episodeId}:%`));
    await sweepErTriageClocks(db, new Date(t0.getTime() + 4 * MIN));
    expect(await triageTasks()).toHaveLength(0);
    await sweepErTriageClocks(db, new Date(t0.getTime() + 5 * MIN));
    await sweepErTriageClocks(db, new Date(t0.getTime() + 6 * MIN));
    const raised = await triageTasks();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: "er_triage_due", priority: "stat", dueAt: new Date(t0.getTime() + 5 * MIN) });
    const climbs = () => db.select().from(alerts).where(and(eq(alerts.userId, supervisor.id), eq(alerts.kind, "er.triage_overdue"), eq(alerts.refId, u.episodeId)));
    await sweepErTriageClocks(db, new Date(t0.getTime() + 19 * MIN));
    expect(await climbs()).toHaveLength(0);
    await sweepErTriageClocks(db, new Date(t0.getTime() + 20 * MIN));
    await sweepErTriageClocks(db, new Date(t0.getTime() + 21 * MIN));
    expect(await climbs()).toHaveLength(1);
    // Triage — the act the task asked for — closes it; nothing more is raised for the door-to-triage clock.
    await triage(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, decision: URGENT, level: 3 }, { now: new Date(t0.getTime() + 22 * MIN) });
    expect((await triageTasks())[0]!.state).toBe("cancelled");
    await sweepErTriageClocks(db, new Date(t0.getTime() + 23 * MIN));
    expect(await triageTasks()).toHaveLength(1);
  });
});
