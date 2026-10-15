import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { erMlcObligations, opdDepartments, opdDoctors } from "../../kernel/db/schema";
import { taskKind } from "../tasks";
import { mkUser } from "../../../test/helpers/opd";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErMlcWorld } from "../../../test/helpers/emergency";
import {
  ER_MLC_INTIMATION_TASK, addMlcAddendum, countersignMlc, erTopicsFor, handOverEvidence, mlcOfEpisode, openMlc, recordPoliceIntimation,
  registerArrival, registerUnidentified, sweepErMlcClocks,
} from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErMlcWorld } from "../../../test/helpers/emergency";

/**
 * ER review (2026-10-15) — lane 4 follow-ups, through the intents and the database:
 * - the MLC event never travels on a board topic (the gateway forwards whole payloads: category, MLC number);
 * - the faculty countersign is a consultant's (the IPD consultant rule), never the opener's nor an addendum author's;
 * - the intimation task's own rung bells the casualty nurses; the duty manager hears once, from the MLC climb;
 * - the obligations' stamps are written once and never removed (database trigger);
 * - the minute sweep leaves alone an obligation with nothing left to raise;
 * - an intimation is never dated before the patient's arrival;
 * - police who bring a patient by ambulance still make it an MLC by rule;
 * - a seal is collected once.
 */
jest.setTimeout(240_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 4 — review follow-ups", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErMlcWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErMlcWorld(db); });

  const walkIn = async (now = new Date()) => {
    const p = await w.patient("female", 28, "Anita Kumari");
    return registerArrival(db, w.erDesk, { idempotencyKey: key(), patientId: p, arrivalMode: "walk_in" }, { now });
  };
  const consultant = async (username: string) => {
    const u = (await mkUser(db, username, ["doctor"])).actor;
    const deptId = newId();
    await db.insert(opdDepartments).values({ id: deptId, code: `D${username.slice(-3).toUpperCase()}`, name: "Test", createdBy: "t", updatedBy: "t" });
    await db.insert(opdDoctors).values({ id: newId(), userId: u.id, displayName: username, code: `DR-${username}`, registrationNo: "BMC/9", departmentId: deptId, createdBy: "t", updatedBy: "t" });
    return u;
  };

  it("the MLC-opened event reaches no board topic", () => {
    expect(erTopicsFor({ name: "er.mlc_opened" })).toEqual([]);
  });

  it("the countersign is a consultant's — not a doctor off the master, not the author of an addendum", async () => {
    const now = new Date();
    const u = await registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "male", ageBand: "adult", arrivalMode: "walk_in" }, { now });
    const m = (await mlcOfEpisode(db, u.episodeId))!;
    const junior = (await mkUser(db, "er.mo", ["doctor"])).actor;
    await expect(countersignMlc(db, junior, { idempotencyKey: key(), mlcId: m.id }, { now })).rejects.toMatchObject({ code: "cosigner_not_senior" });
    const examiner = await consultant("er.examiner");
    await addMlcAddendum(db, examiner, { idempotencyKey: key(), mlcId: m.id, text: "Abrasion 3 x 2 cm left forearm." }, { now });
    await expect(countersignMlc(db, examiner, { idempotencyKey: key(), mlcId: m.id }, { now })).rejects.toMatchObject({ code: "countersign_own_mlc" });
    const faculty = await consultant("er.faculty");
    await expect(countersignMlc(db, faculty, { idempotencyKey: key(), mlcId: m.id }, { now })).resolves.toMatchObject({ withinTarget: true });
  });

  it("the intimation task's own rung is the casualty nurses', not the duty manager's", () => {
    expect(taskKind(ER_MLC_INTIMATION_TASK)).toMatchObject({ escalateTo: "er_nurse" });
  });

  it("an obligation's stamps are written once and never removed", async () => {
    const now = new Date();
    const a = await walkIn(now);
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "assault" }, { now });
    await recordPoliceIntimation(db, w.erDesk, { idempotencyKey: key(), mlcId: m.mlcId, mode: "written", station: "PS Kotwali", receiverName: "HC Ram" }, { now });
    const ob = (await db.select().from(erMlcObligations).where(and(eq(erMlcObligations.mlcId, m.mlcId), eq(erMlcObligations.kind, "police_intimation"))))[0]!;
    expect(ob.metAt).not.toBeNull();
    await expect(db.execute(sql`update er_mlc_obligations set met_by = 'someone-else' where id = ${ob.id}`)).rejects.toThrow(/er_mlc_append_only/);
    await expect(db.execute(sql`update er_mlc_obligations set met_at = null where id = ${ob.id}`)).rejects.toThrow(/er_mlc_append_only/);
    await expect(db.execute(sql`delete from er_mlc_obligations where id = ${ob.id}`)).rejects.toThrow(/er_mlc_append_only/);
  });

  it("the sweep does not lock an MLC whose obligations have nothing left to raise", async () => {
    const t0 = new Date(Date.now() - 3 * 60 * MIN);
    const a = await walkIn(t0);
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "assault" }, { now: t0 });
    expect(await sweepErMlcClocks(db, new Date(t0.getTime() + 95 * MIN))).toMatchObject({ tasks: 1, climbs: 1 });
    let letGo!: () => void;
    const held = new Promise<void>((r) => { letGo = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = db.transaction(async (t) => {
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`er_mlc:${m.mlcId}`}))`);
      locked();
      await held;
    });
    await isLocked;
    const sweep = sweepErMlcClocks(db, new Date(t0.getTime() + 96 * MIN));
    const outcome = await Promise.race([sweep.then(() => "done"), new Promise((r) => setTimeout(() => r("waited"), 3000))]);
    letGo();
    await holder;
    await sweep;
    expect(outcome).toBe("done");
  });

  it("an intimation dated before the arrival is refused", async () => {
    const now = new Date();
    const a = await walkIn(new Date(now.getTime() - 30 * MIN));
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "assault" }, { now });
    await expect(recordPoliceIntimation(db, w.erDesk, {
      idempotencyKey: key(), mlcId: m.mlcId, mode: "phone_then_written", station: "PS Kotwali", receiverName: "HC Ram",
      intimatedAt: new Date(now.getTime() - 3 * 60 * MIN).toISOString(),
    }, { now })).rejects.toMatchObject({ code: "intimation_before_arrival" });
  });

  it("police who bring the patient by ambulance make it an MLC by rule", async () => {
    const p = await w.patient("male", 33, "Raju Paswan");
    const a = await registerArrival(db, w.erDesk, {
      idempotencyKey: key(), patientId: p, arrivalMode: "ambulance_108",
      broughtBy: { kind: "police", name: "ASI Mehta", policeStation: "PS Patliputra" },
    });
    expect(await mlcOfEpisode(db, a.episodeId)).toMatchObject({ category: "police_brought", openedByRule: true });
  });

  it("a seal is collected once", async () => {
    const now = new Date();
    const a = await walkIn(now);
    const m = await openMlc(db, w.erDoctor, { idempotencyKey: key(), episodeId: a.episodeId, category: "assault" }, { now });
    const ev = () => handOverEvidence(db, w.erDoctor, {
      idempotencyKey: key(), mlcId: m.mlcId, kind: "clothes", description: "Torn kurta", sealNo: "S-7", action: "collected", secondPerson: w.pins.nurse2,
    }, { now });
    await ev();
    await expect(ev()).rejects.toMatchObject({ code: "seal_already_collected" });
  });
});
