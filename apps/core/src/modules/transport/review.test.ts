import { eq } from "drizzle-orm";
import { TRANSPORT_KINDS, newId } from "@hmis/contracts";
import { patients, tasks, tempRoleGrants, transportRequests, users } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkUser } from "../../../test/helpers/opd";
import { mkTransportWorld } from "../../../test/helpers/transport";
import { acceptTask, completeTask, startTask } from "../tasks";
import { addEscort, escortCandidates, requestTransport, transportBoard, transportDetails } from "./index";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { TransportWorld } from "../../../test/helpers/transport";

/**
 * E1.6 TRANSPORT — the review findings on PR #757, each red against the code before its fix. Real clock, no pinned date.
 */
jest.setTimeout(90_000);

describe("E1.6 transport — review findings", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: TransportWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkTransportWorld(db); });

  const holder = async (taskId: string): Promise<Actor> => {
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    return { type: "user", id: row.assigneeId! };
  };
  const move = (admissionId: string, extra: Record<string, unknown> = {}) => requestTransport(db, w.requester, {
    kind: TRANSPORT_KINDS.patientMove, admissionId, fromResourceId: w.wardId, toResourceId: w.roomId, ...extra,
  });

  it("1. a merge keeps the stricter isolation and the stronger escort reason", async () => {
    const p = await w.admitted("RV-M1");
    await move(p.admissionId, { isolation: "contact", escortRequired: true });
    const again = await move(p.admissionId, { isolation: "airborne", highRisk: true });
    expect(again.merged).toBe(true);
    expect(again.request.isolation).toBe("airborne");
    expect(again.request.escortReason).toBe("high_risk_flag");
    const third = await move(p.admissionId, { isolation: "none", escortRequired: true });
    expect(third.request.isolation).toBe("airborne");
    expect(third.request.escortReason).toBe("high_risk_flag");
  });

  it("1. the same patient going somewhere else, or another way, is a separate task", async () => {
    const p = await w.admitted("RV-M2");
    const first = await move(p.admissionId, { mode: "wheelchair" });
    const elsewhere = await move(p.admissionId, { mode: "wheelchair", toResourceId: undefined, toNote: "CT scan" });
    expect(elsewhere.merged).toBe(false);
    expect(elsewhere.task.id).not.toBe(first.task.id);
    const otherMode = await move(p.admissionId, { mode: "stretcher" });
    expect(otherMode.merged).toBe(false);
    expect(otherMode.task.id).not.toBe(first.task.id);
  });

  it("2. start refuses an escort who is the porter, or who lost the escort role", async () => {
    const p = await w.admitted("RV-E1");
    // A porter who is also a nurse is recorded as escort while the task sits with someone else, then takes it.
    const porterNurse = (await mkUser(db, "rv.porter.nurse", ["support_staff", "nurse"])).actor;
    const r = await move(p.admissionId, { escortRequired: true });
    await addEscort(db, w.requester, { taskId: r.task.id, escortUserId: porterNurse.id });
    await db.update(tasks).set({ assigneeKind: "person", assigneeId: porterNurse.id, state: "accepted" }).where(eq(tasks.id, r.task.id));
    await expect(startTask(db, porterNurse, { taskId: r.task.id })).rejects.toMatchObject({ code: "escort_is_porter" });

    const q = await w.admitted("RV-E2");
    const r2 = await move(q.admissionId, { escortRequired: true });
    await addEscort(db, w.requester, { taskId: r2.task.id, escortUserId: w.escortNurse.id });
    const porter = await holder(r2.task.id);
    await acceptTask(db, porter, { taskId: r2.task.id });
    await db.update(users).set({ active: false }).where(eq(users.id, w.escortNurse.id));
    await expect(startTask(db, porter, { taskId: r2.task.id })).rejects.toMatchObject({ code: "escort_not_clinical" });
  });

  it("3. card details only for the asker's own tasks and the pool", async () => {
    const p = await w.admitted("RV-D1");
    const r = await move(p.admissionId);
    const porter = await holder(r.task.id);
    const other = porter.id === w.hk1.id ? w.hk2 : w.hk1;
    expect((await transportDetails(db, porter, [r.task.id])).details).toHaveLength(1);
    expect((await transportDetails(db, other, [r.task.id])).details).toHaveLength(0);
  });

  it("4. the wall board shows porters by initials and never the requester's free text", async () => {
    const p = await w.admitted("RV-B1");
    await move(p.admissionId, { toResourceId: undefined, toNote: "CT for Ram Kumar, suspected stroke" });
    const board = await transportBoard(db);
    expect(JSON.stringify(board)).not.toContain("Ram Kumar");
    expect(board.rows[0]!.toName).toBeNull();
    expect(board.workers.length).toBeGreaterThan(0);
    for (const worker of board.workers) expect(worker.name).toMatch(/^([A-Z]\.\s?)+$|^—$/);
  });

  it("5. a QR whose UHID is not the band's patient's is refused", async () => {
    const p = await w.admitted("RV-Q1");
    const r = await move(p.admissionId);
    const porter = await holder(r.task.id);
    await acceptTask(db, porter, { taskId: r.task.id });
    await startTask(db, porter, { taskId: r.task.id });
    await expect(completeTask(db, porter, { taskId: r.task.id, proof: { kind: "scan", code: `IPDBAND1|${p.band}|U99999999` } }))
      .rejects.toMatchObject({ code: "band_mismatch" });
    const uhid = (await db.select({ u: patients.uhid }).from(patients).where(eq(patients.id, p.patientId)))[0]!.u;
    await expect(completeTask(db, porter, { taskId: r.task.id, proof: { kind: "scan", code: `IPDBAND1|${p.band}|${uhid}` } }))
      .resolves.toMatchObject({ state: "done" });
  });

  it("6. inside a caller's transaction the wrong-patient record survives the caller's rollback (recordDb), or the act fails loudly", async () => {
    const p = await w.admitted("RV-T1");
    const other = await w.admitted("RV-T2");
    const r = await move(p.admissionId);
    const porter = await holder(r.task.id);
    await acceptTask(db, porter, { taskId: r.task.id });
    await startTask(db, porter, { taskId: r.task.id });
    const ROLLBACK = new Error("caller rolls back");
    await expect(db.transaction(async (t) => {
      await expect(completeTask(t, porter, { taskId: r.task.id, proof: { kind: "scan", code: other.band } }, new Date(), { recordDb: db }))
        .rejects.toMatchObject({ code: "wrong_patient" });
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    const req = (await db.select().from(transportRequests).where(eq(transportRequests.taskId, r.task.id)))[0]!;
    expect(req.handoverRefusals).toHaveLength(1);
    // Without the root database the refusal cannot be recorded: it fails loudly rather than losing the record.
    await expect(db.transaction(async (t) => {
      await completeTask(t, porter, { taskId: r.task.id, proof: { kind: "scan", code: other.band } });
    })).rejects.toThrow(/must leave a record/);
  });

  it("8. escort candidates use the same role-expiry rule as addEscort", async () => {
    const lapsed = (await mkUser(db, "rv.lapsed", [])).actor;
    await db.insert(tempRoleGrants).values({
      id: newId(), userId: lapsed.id, roleKey: "nurse", grantedBy: w.supervisor.id, kind: "granted", reason: "night cover",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const current = (await mkUser(db, "rv.cover", [])).actor;
    await db.insert(tempRoleGrants).values({
      id: newId(), userId: current.id, roleKey: "nurse", grantedBy: w.supervisor.id, kind: "granted", reason: "night cover",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const ids = (await escortCandidates(db)).map((c) => c.userId);
    expect(ids).toContain(w.escortNurse.id);
    expect(ids).toContain(current.id);
    expect(ids).not.toContain(lapsed.id);
  });
});
