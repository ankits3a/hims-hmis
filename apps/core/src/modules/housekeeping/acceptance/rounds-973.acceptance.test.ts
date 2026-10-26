import { HK_IN_HOUSE, HK_ROUND_GRACE_MIN, HOUSEKEEPING_KINDS, hkShiftAt } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { deliverBedEvents, mkHkWorld, releaseBed } from "../../../../test/helpers/housekeeping";
import { assignBed } from "../../ipd";
import { acceptTask, assignTask, completeTask, findTasks, getTask, myTasks, returnToPool, startTask } from "../../tasks";
import {
  addContractor, areaQrToken, confirmClean, defineArea, doorRequestOf, finishWork, publishRota, raiseDoorRequest,
  revokeAreaQr, roundsOf, runRoundsClock, saveChecklist, saveRota, setHkStaff, storeWorkPhoto, supervisorBoard, workOf,
} from "../index";
import { newId } from "@hmis/contracts";
import { randomUUID } from "node:crypto";
import type { Actor, HkAreaClass, IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { HkWorld } from "../../../../test/helpers/housekeeping";
import type { TaskRow } from "../../tasks";

/**
 * HK-1 (issue #973, decision 0086) — "DONE MEANS" of docs/specs/973-housekeeping-rounds.md, D1..D8. Every check calls
 * the module's intents (setup, rota, rounds clock, work, confirm, door request, board) — never a screen. No date is
 * pinned: every instant is the real clock's or a fixed offset from it, and nothing asserted depends on which one.
 */
jest.setTimeout(120_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };
const MIN = 60_000;

describe("HK-1 housekeeping — rounds, rota, proof, confirm, door requests (#973)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: HkWorld;
  let now: Date;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkHkWorld(db); now = new Date(); });

  const checklist = (name: string) => saveChecklist(db, w.supervisor, { name, items: [{ text: "Floor mopped" }, { text: "Bin emptied" }] });

  /** An area with a two-item checklist; returns the area and its door QR token. */
  async function area(resourceId: string, areaClass: HkAreaClass): Promise<{ areaId: string; token: string; itemIds: string[] }> {
    const list = await checklist(`List ${areaClass}`);
    const a = await defineArea(db, w.supervisor, { resourceId, areaClass, checklistId: list.id });
    return { areaId: a.id, token: await areaQrToken(db, w.key, a.id), itemIds: list.items.map((i) => i.id) };
  }

  /** Publish this shift's rota with the given places. */
  async function rota(places: unknown[]): Promise<{ warnings: { userId: string; code: string }[] }> {
    const shift = hkShiftAt(now);
    const draft = await saveRota(db, w.supervisor, { shiftStartsAt: shift.startsAt.toISOString(), places });
    return publishRota(db, w.supervisor, { rotaId: draft.id }, now);
  }

  const photo = async (taskId: string, by: Actor) =>
    (await storeWorkPhoto(db, w.store, by, { taskId, mime: "image/jpeg", bytes: Buffer.from("not-a-patient") })).photoKey;

  /** The worker's road with full proof: accept, start, scan, every item answered, a photo when asked. */
  async function work(task: TaskRow, by: Actor, token: string, itemIds: string[], withPhoto = true): Promise<TaskRow> {
    const state = (await getTask(db, task.id))!.state;
    if (state !== "accepted" && state !== "in_progress") await acceptTask(db, by, { taskId: task.id }, now);
    if ((await getTask(db, task.id))!.state === "accepted") await startTask(db, by, { taskId: task.id }, now);
    return finishWork(db, w.key, by, {
      taskId: task.id, scan: token, answers: itemIds.map((itemId) => ({ itemId, ok: true })),
      ...(withPhoto ? { photoKey: await photo(task.id, by) } : {}),
    }, now);
  }

  async function roundTask(areaId: string): Promise<TaskRow> {
    await runRoundsClock(db, now);
    const rounds = await roundsOf(db, areaId);
    expect(rounds.length).toBeGreaterThan(0);
    return (await getTask(db, rounds[rounds.length - 1]!.taskId))!;
  }

  /** An occupied bed in the bed world's ward, released, its clean raised by the consumer. */
  async function releasedBed(code: string, attrs: Record<string, unknown> = {}): Promise<{ bedId: string; task: TaskRow }> {
    const bedId = await w.bed(code, attrs);
    await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId: await w.patient("male"), need: GENERAL });
    await releaseBed(db, w.dutyManager, bedId);
    await deliverBedEvents(db, bedId);
    const [task] = await findTasks(db, { kinds: [HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.terminal], placeResourceId: bedId });
    return { bedId, task: task! };
  }

  it("spec #973 D1: an area gets a class and a QR code; its round appears at shift start with its due time", async () => {
    const { areaId, token } = await area(w.roomId, "B");
    expect(token).toMatch(/^a1\./);
    await runRoundsClock(db, now);
    const rounds = await roundsOf(db, areaId);
    expect(rounds).toHaveLength(1);
    const shift = hkShiftAt(now);
    expect(new Date(rounds[0]!.slotStart).getTime()).toBe(shift.startsAt.getTime());
    expect(new Date(rounds[0]!.dueAt).getTime()).toBeGreaterThan(shift.startsAt.getTime());
    expect((await getTask(db, rounds[0]!.taskId))!.dueAt.getTime()).toBe(new Date(rounds[0]!.dueAt).getTime());
    // The clock runs every minute: running it again raises nothing new.
    await runRoundsClock(db, new Date(now.getTime() + MIN));
    expect(await roundsOf(db, areaId)).toHaveLength(1);
    // Revoking the QR (a reprint) makes the old token worthless.
    await revokeAreaQr(db, w.supervisor, { areaId });
    expect(await areaQrToken(db, w.key, areaId)).not.toBe(token);
  });

  it("spec #973 D2: a published rota puts each task on its owner's phone list; a discharge clean goes to the floor team", async () => {
    const toilet = await area(w.toiletId, "C_toilet");
    await area(w.room2Id, "B");
    const { warnings } = await rota([
      { userId: w.hk1.id, mode: "route", areaIds: [toilet.areaId] },
      { userId: w.hk2.id, mode: "floor", floorId: w.floor2Id },
      { userId: w.hkC.id, mode: "floor", floorId: w.floorId },
    ]);
    expect(warnings).toEqual([]);
    const toiletRound = await roundTask(toilet.areaId);
    expect(toiletRound).toMatchObject({ state: "assigned", assigneeId: w.hk1.id });
    expect((await myTasks(db, w.hk1.id, now)).mine.map((t) => t.id)).toContain(toiletRound.id);
    expect((await myTasks(db, w.hk2.id, now)).mine.map((t) => t.id)).not.toContain(toiletRound.id);

    // The bed is on floor F-T: its clean waits in the pool of that floor's team, assigned to nobody.
    const { task } = await releasedBed("HK-D2");
    expect(task).toMatchObject({ state: "created", assigneeId: null });
    expect((await myTasks(db, w.hkC.id, now)).pool.map((t) => t.id)).toContain(task.id);
    expect((await myTasks(db, w.hk1.id, now)).pool.map((t) => t.id)).toContain(task.id);
    expect((await myTasks(db, w.hk2.id, now)).pool.map((t) => t.id)).not.toContain(task.id);
    await expect(acceptTask(db, w.hk2, { taskId: task.id }, now)).rejects.toMatchObject({ code: "not_your_area" });
    await expect(acceptTask(db, w.hkC, { taskId: task.id }, now)).resolves.toMatchObject({ assigneeId: w.hkC.id });
  });

  it("spec #973 D3: done needs the QR scan at the place and every item answered; a bed or toilet also needs a photo", async () => {
    const toilet = await area(w.toiletId, "C_toilet");
    const hall = await area(w.hallId, "C_public");
    await rota([{ userId: w.hk1.id, mode: "floor", floorId: w.floorId }]);
    const round = await roundTask(toilet.areaId);
    await acceptTask(db, w.hk1, { taskId: round.id }, now);
    await startTask(db, w.hk1, { taskId: round.id }, now);
    const all = toilet.itemIds.map((itemId) => ({ itemId, ok: true }));
    const pic = await photo(round.id, w.hk1);
    // The generic engine door cannot close it with a tap.
    await expect(completeTask(db, w.hk1, { taskId: round.id, proof: { kind: "tap" } }, now)).rejects.toMatchObject({ code: expect.any(String) });
    // The hall's QR is not the toilet's.
    await expect(finishWork(db, w.key, w.hk1, { taskId: round.id, scan: hall.token, answers: all, photoKey: pic }, now))
      .rejects.toMatchObject({ code: "wrong_place" });
    await expect(finishWork(db, w.key, w.hk1, { taskId: round.id, scan: "a1.forged.1.xxxx", answers: all, photoKey: pic }, now))
      .rejects.toMatchObject({ code: "bad_qr" });
    await expect(finishWork(db, w.key, w.hk1, { taskId: round.id, scan: toilet.token, answers: all.slice(1), photoKey: pic }, now))
      .rejects.toMatchObject({ code: "checklist_incomplete" });
    await expect(finishWork(db, w.key, w.hk1, { taskId: round.id, scan: toilet.token, answers: all }, now))
      .rejects.toMatchObject({ code: "photo_missing" });
    expect((await getTask(db, round.id))!.state).toBe("in_progress");
    await expect(finishWork(db, w.key, w.hk1, { taskId: round.id, scan: toilet.token, answers: all, photoKey: pic }, now))
      .resolves.toMatchObject({ state: "done", doneBy: w.hk1.id });

    // A bed in a ward that is an area: its clean needs the ward's scan and a photo too.
    const ward = await area(w.wardId, "B");
    const { task } = await releasedBed("HK-D3");
    await acceptTask(db, w.hk1, { taskId: task.id }, now);
    await startTask(db, w.hk1, { taskId: task.id }, now);
    await expect(completeTask(db, w.hk1, { taskId: task.id, proof: { kind: "tap" } }, now)).rejects.toMatchObject({ code: expect.any(String) });
    await expect(work(task, w.hk1, ward.token, ward.itemIds, false)).rejects.toMatchObject({ code: "photo_missing" });
    await expect(work(task, w.hk1, ward.token, ward.itemIds)).resolves.toMatchObject({ state: "done" });
  });

  it("spec #973 D4: a fail needs a reason and reopens the task; after a second fail it is in the supervisor's Needs you", async () => {
    const ward = await area(w.wardId, "B");
    await rota([{ userId: w.hk1.id, mode: "floor", floorId: w.floorId }]);
    const { task } = await releasedBed("HK-D4");
    await work(task, w.hk1, ward.token, ward.itemIds);
    await expect(confirmClean(db, w.nurse, { taskId: task.id, result: "fail" }, now)).rejects.toMatchObject({ code: "reason_required" });
    const reopened = await confirmClean(db, w.nurse, { taskId: task.id, result: "fail", reason: "Bin not emptied" }, now);
    // Rework goes back to the same attendant, who is still on duty.
    expect(reopened).toMatchObject({ state: "assigned", assigneeId: w.hk1.id });
    expect((await supervisorBoard(db, now)).needsYou.map((n) => n.taskId)).not.toContain(task.id);
    await work(reopened, w.hk1, ward.token, ward.itemIds);
    await confirmClean(db, w.nurse, { taskId: task.id, result: "fail", reason: "Still dusty" }, now);
    const needs = (await supervisorBoard(db, now)).needsYou;
    expect(needs).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: task.id, fails: 2, reason: "Still dusty" })]));
  });

  it("spec #973 D5: the cleaner never confirms their own clean; a terminal clean is confirmed only by the supervisor or infection control", async () => {
    const ward = await area(w.wardId, "B");
    await rota([
      { userId: w.cleanerNurse.id, mode: "floor", floorId: w.floorId },
      { userId: w.hk1.id, mode: "floor", floorId: w.floorId },
    ]);
    const { task } = await releasedBed("HK-D5");
    await assignTask(db, w.supervisor, { taskId: task.id, userId: w.cleanerNurse.id }, now);
    await work(task, w.cleanerNurse, ward.token, ward.itemIds);
    await expect(confirmClean(db, w.cleanerNurse, { taskId: task.id, result: "pass" }, now)).rejects.toMatchObject({ code: "verifier_is_doer" });
    // Failed, then reworked by someone else: the first cleaner is still a doer of this task.
    const back = await confirmClean(db, w.nurse, { taskId: task.id, result: "fail", reason: "Linen not changed" }, now);
    if (back.assigneeId !== null) await returnToPool(db, w.supervisor, { taskId: task.id }, now, { asSupervisor: true });
    await assignTask(db, w.supervisor, { taskId: task.id, userId: w.hk1.id }, now);
    await work((await getTask(db, task.id))!, w.hk1, ward.token, ward.itemIds);
    await expect(confirmClean(db, w.cleanerNurse, { taskId: task.id, result: "pass" }, now)).rejects.toMatchObject({ code: "verifier_is_doer" });
    await expect(confirmClean(db, w.nurse, { taskId: task.id, result: "pass" }, now)).resolves.toMatchObject({ state: "verified" });

    // Terminal: the ward nurse is refused; infection control passes it.
    const iso = await releasedBed("HK-D5-ISO", { isolation: "contact" });
    expect(iso.task.kind).toBe(HOUSEKEEPING_KINDS.terminal);
    await assignTask(db, w.supervisor, { taskId: iso.task.id, userId: w.hk1.id }, now);
    await work(iso.task, w.hk1, ward.token, ward.itemIds);
    await expect(confirmClean(db, w.nurse, { taskId: iso.task.id, result: "pass" }, now)).rejects.toMatchObject({ code: "terminal_needs_supervisor" });
    await expect(confirmClean(db, w.infection, { taskId: iso.task.id, result: "pass" }, now)).resolves.toMatchObject({ state: "verified" });
  });

  it("spec #973 D6: a round not scanned by its due time shows as missed on the supervisor board", async () => {
    const toilet = await area(w.toiletId, "C_toilet");
    await runRoundsClock(db, now);
    const [round] = await roundsOf(db, toilet.areaId);
    const due = new Date(round!.dueAt).getTime();
    // Inside the grace: not missed yet.
    await runRoundsClock(db, new Date(due + (HK_ROUND_GRACE_MIN - 1) * MIN));
    expect((await roundsOf(db, toilet.areaId)).find((r) => r.taskId === round!.taskId)!.status).toBe("due");
    const later = new Date(due + (HK_ROUND_GRACE_MIN + 1) * MIN);
    await runRoundsClock(db, later);
    expect((await roundsOf(db, toilet.areaId)).find((r) => r.taskId === round!.taskId)!.status).toBe("missed");
    const board = await supervisorBoard(db, later);
    expect(board.missed).toEqual(expect.arrayContaining([expect.objectContaining({ areaId: toilet.areaId, taskId: round!.taskId })]));
    // The missed round's task stays open as late work.
    expect(["created", "assigned", "accepted", "in_progress"]).toContain((await getTask(db, round!.taskId))!.state);
  });

  it("spec #973 D7: a request from a door QR, with no login, reaches the floor team and can be closed", async () => {
    const hall = await area(w.hallId, "C_public");
    await rota([{ userId: w.hk1.id, mode: "floor", floorId: w.floorId }, { userId: w.hk2.id, mode: "floor", floorId: w.floor2Id }]);
    await expect(raiseDoorRequest(db, w.key, { token: "a1.nothing.1.sig", need: "bin" }, { address: "203.0.113.9" }, now))
      .rejects.toMatchObject({ code: "bad_qr" });
    const req = await raiseDoorRequest(db, w.key, { token: hall.token, need: "bin" }, { address: "203.0.113.9" }, now);
    const task = (await getTask(db, req.taskId))!;
    expect(task).toMatchObject({ placeResourceId: w.hallId, patientId: null, assigneeId: w.hk1.id });
    expect((await myTasks(db, w.hk1.id, now)).mine.map((t) => t.id)).toContain(task.id);
    expect((await myTasks(db, w.hk2.id, now)).mine.map((t) => t.id)).not.toContain(task.id);
    await work(task, w.hk1, hall.token, hall.itemIds, false);
    expect(await doorRequestOf(db, req.requestId)).toMatchObject({ closed: true, need: "bin" });
    // A door QR cannot flood the floor: four an hour per area.
    for (let i = 0; i < 3; i += 1) await raiseDoorRequest(db, w.key, { token: hall.token, need: "clean" }, { address: `203.0.113.${String(20 + i)}` }, now);
    await expect(raiseDoorRequest(db, w.key, { token: hall.token, need: "clean" }, { address: "203.0.113.40" }, now))
      .rejects.toMatchObject({ code: "too_many_requests" });
  });

  it("spec #973 D8: contractor staff do the same tasks with the same proof; every task records the company", async () => {
    const contractor = await addContractor(db, w.supervisor, { name: "Shine Facility Services" });
    await setHkStaff(db, w.supervisor, { userId: w.hkC.id, contractorId: contractor.id, skills: ["spill"] });
    await setHkStaff(db, w.supervisor, { userId: w.hk1.id, contractorId: null, skills: [] });
    const toilet = await area(w.toiletId, "C_toilet");
    const hall = await area(w.hallId, "C_public");
    await rota([
      { userId: w.hkC.id, mode: "route", areaIds: [toilet.areaId] },
      { userId: w.hk1.id, mode: "route", areaIds: [hall.areaId] },
    ]);
    const byContractor = await roundTask(toilet.areaId);
    expect(byContractor.assigneeId).toBe(w.hkC.id);
    await expect(work(byContractor, w.hkC, toilet.token, toilet.itemIds, false)).rejects.toMatchObject({ code: "photo_missing" });
    await work(byContractor, w.hkC, toilet.token, toilet.itemIds);
    expect(await workOf(db, byContractor.id)).toMatchObject({ doneBy: w.hkC.id, company: "Shine Facility Services" });
    const inHouse = await roundTask(hall.areaId);
    await work(inHouse, w.hk1, hall.token, hall.itemIds, false);
    expect(await workOf(db, inHouse.id)).toMatchObject({ doneBy: w.hk1.id, company: HK_IN_HOUSE });
    const people = (await supervisorBoard(db, now)).people;
    expect(people).toEqual(expect.arrayContaining([expect.objectContaining({ userId: w.hkC.id, company: "Shine Facility Services" })]));
  });
});
