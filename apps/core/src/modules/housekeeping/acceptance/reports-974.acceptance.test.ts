import { eq } from "drizzle-orm";
import {
  HK_INSPECTION_ITEMS, HK_INSPECT_PASS_PCT, HK_IN_HOUSE, HK_ROUND_GRACE_MIN, HOUSEKEEPING_KINDS, hkMonthOf, hkMonthWindow, hkShiftAt, newId,
} from "@hmis/contracts";
import { randomUUID } from "node:crypto";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { deliverBedEvents, mkHkWorld, releaseBed } from "../../../../test/helpers/housekeeping";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../../kernel/auth/permissions";
import { withTx } from "../../../kernel/db/client";
import { ipdBedStays, stockBatches } from "../../../kernel/db/schema";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { KERNEL_RESOURCE_KINDS, createResource } from "../../../kernel/resources";
import { assignBed } from "../../ipd";
import { createStore, getIndent, getTransfer, issueIndent, postMovements, raiseIndent, receiveStock, registerItem, setStoreCustodianRoles } from "../../materials";
import { acceptTask, assignTask, findTasks, getTask, myTasks, startTask } from "../../tasks";
import {
  addContractor, areaQrToken, confirmClean, contractorSla, dailyReport, defineArea, drawInspections, finishWork, floorConsumables,
  inspectionsOf, linkFloorStore, publishRota, raiseDoorRequest, recordInspection, roundsOf, runRoundsClock, saveChecklist, saveRota,
  setHkStaff, storeInspectionPhoto, storeWorkPhoto,
} from "../index";
import type { Actor, HkAreaClass, HkSlaRow, IpdBedNeed } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";
import type { HkWorld } from "../../../../test/helpers/housekeeping";
import type { TaskRow } from "../../tasks";

/**
 * HK-2 (issue #974, decision 0086) — "DONE MEANS" of docs/specs/974-housekeeping-reports.md, D1..D5 (D6 is the staff app's:
 * apps/mobile/__tests__/acceptance/housekeeping-974.test.tsx). Every check calls the module's intents — never a screen.
 * No date is pinned: every instant is the real clock's or a fixed offset from it; a monthly check reads the month that
 * holds the instant it wrote, so a run near a month's end reads the right one.
 */
jest.setTimeout(180_000);

const GENERAL: IpdBedNeed = { requestedClass: "general", isolation: "none", icu: false };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("HK-2 housekeeping — floor stores, inspections, contractor SLA, daily and monthly reports (#974)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: HkWorld;
  let now: Date;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkHkWorld(db); now = new Date(); });

  const SETUP: Actor = { type: "system", id: "test-hk2" };
  const place = (kind: string, code: string, parentId: string | null) =>
    withTx(db, (tx) => createResource(tx, SETUP, KERNEL_RESOURCE_KINDS, { kind, code, name: code, parentId })).then((r) => r.resourceId);

  async function area(resourceId: string, areaClass: HkAreaClass): Promise<{ areaId: string; token: string; itemIds: string[] }> {
    const list = await saveChecklist(db, w.supervisor, { name: `List ${areaClass} ${resourceId}`, items: [{ text: "Floor mopped" }, { text: "Bin emptied" }] });
    const a = await defineArea(db, w.supervisor, { resourceId, areaClass, checklistId: list.id });
    return { areaId: a.id, token: await areaQrToken(db, w.key, a.id), itemIds: list.items.map((i) => i.id) };
  }
  async function rota(places: unknown[]): Promise<void> {
    const draft = await saveRota(db, w.supervisor, { shiftStartsAt: hkShiftAt(now).startsAt.toISOString(), places });
    await publishRota(db, w.supervisor, { rotaId: draft.id }, now);
  }
  const photo = async (taskId: string, by: Actor, at = now) =>
    (await storeWorkPhoto(db, w.store, by, { taskId, mime: "image/jpeg", bytes: Buffer.from(`place-${at.getTime()}`) })).photoKey;
  async function work(task: TaskRow, by: Actor, token: string, itemIds: string[], at = now, withPhoto = true): Promise<TaskRow> {
    let state = (await getTask(db, task.id))!.state;
    if (state === "created" || state === "assigned") { await acceptTask(db, by, { taskId: task.id }, at); state = "accepted"; }
    if (state === "accepted") await startTask(db, by, { taskId: task.id }, at);
    return finishWork(db, w.key, by, {
      taskId: task.id, scan: token, answers: itemIds.map((itemId) => ({ itemId, ok: true })),
      ...(withPhoto ? { photoKey: await photo(task.id, by, at) } : {}),
    }, at);
  }
  async function roundOf(areaId: string): Promise<TaskRow> {
    const rounds = await roundsOf(db, areaId);
    expect(rounds.length).toBeGreaterThan(0);
    return (await getTask(db, rounds[rounds.length - 1]!.taskId))!;
  }
  async function releasedBed(code: string): Promise<{ bedId: string; task: TaskRow }> {
    const bedId = await w.bed(code);
    await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId: await w.patient("male"), need: GENERAL });
    await releaseBed(db, w.dutyManager, bedId);
    await deliverBedEvents(db, bedId);
    const [task] = await findTasks(db, { kinds: [HOUSEKEEPING_KINDS.routine, HOUSEKEEPING_KINDS.terminal], placeResourceId: bedId });
    return { bedId, task: task! };
  }
  const allYes = () => HK_INSPECTION_ITEMS.map((i) => ({ itemId: i.id, ok: true }));
  async function inspect(inspectionId: string, token: string, answers = allYes(), withPhoto = true, at = now) {
    const photoKey = withPhoto ? (await storeInspectionPhoto(db, w.store, w.supervisor, { inspectionId, mime: "image/jpeg", bytes: Buffer.from("area") })).photoKey : undefined;
    return recordInspection(db, w.key, w.supervisor, { inspectionId, scan: token, answers, ...(photoKey === undefined ? {} : { photoKey }) }, at);
  }

  /**
   * The stores: a central store kept by the store keeper, with gloves and floor cleaner at a known landed cost, and the
   * floor's housekeeping cupboard kept by the floor supervisor (`services_supervisor`).
   */
  async function stores(): Promise<{ keeper: Actor; central: string; floorStore: string; gloves: string; cleaner: string }> {
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    const grants: Record<string, string[]> = {
      storekeeper: ["materials.stock.read", "materials.stock.issue"],
      services_supervisor: ["materials.stock.read", "materials.stock.receive"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    }
    const keeper = (await mkUser(db, "hk2.keeper", ["storekeeper"])).actor;
    const { resourceId: central } = await withTx(db, (tx) => createStore(tx, keeper, { code: "CENTRAL", name: "Central store" }));
    const { resourceId: floorStore } = await withTx(db, (tx) => createStore(tx, keeper, { code: "HK-F-T", name: "Housekeeping F-T" }));
    await withTx(db, (tx) => setStoreCustodianRoles(tx, keeper, central, ["storekeeper"]));
    await withTx(db, (tx) => setStoreCustodianRoles(tx, keeper, floorStore, ["services_supervisor"]));
    const item = async (code: string, costPaise: number) => {
      const { itemId } = await withTx(db, (tx) => registerItem(tx, keeper, { code, name: code, class: "consumable", baseUom: "piece", batchTracked: true, uoms: [] }));
      const batchId = newId();
      await db.insert(stockBatches).values({ id: batchId, itemId, batchNo: `${code}-1`, expiryDate: "2099-12-31", landedCostPaise: costPaise, ownership: "owned", createdBy: keeper.id });
      await withTx(db, (tx) => postMovements(tx, keeper, [{ resourceId: central, batchId, qtyDelta: 1000, reason: "grn", occurredAt: new Date(now.getTime() - 400 * DAY) }]));
      return itemId;
    };
    return { keeper, central, floorStore, gloves: await item("GLOVES-HK", 250), cleaner: await item("FLOOR-CLEANER", 9000) };
  }

  /** Indent, issue and receive at `at`: the existing materials flow, no new stock path. */
  async function supply(s: Awaited<ReturnType<typeof stores>>, lines: { itemId: string; qtyBase: number }[], at: Date): Promise<void> {
    const indent = await raiseIndent(db, w.supervisor, { fromResourceId: s.floorStore, toResourceId: s.central, lines }, at);
    await issueIndent(db, s.keeper, indent.id, {}, at);
    const transferId = (await getIndent(db, indent.id))!.transfer!.id;
    const t = (await getTransfer(db, transferId))!;
    await withTx(db, (tx) => receiveStock(tx, w.supervisor, transferId, t.lines.map((l) => ({ lineId: l.id, qtyReceived: l.qtyIssued })), at));
  }

  /** The month before the one holding now: whole, so its bed-days do not depend on the hour the suite runs. */
  const lastMonth = (): string => hkMonthOf(new Date(hkMonthWindow(hkMonthOf(now)).start.getTime() - DAY));

  it("spec #974 D1: an indent raised for a floor store, issued and received, shows on the floor's month report with quantities and value", async () => {
    const s = await stores();
    await linkFloorStore(db, w.supervisor, { floorId: w.floorId, storeId: s.floorStore });
    const month = lastMonth();
    const inMonth = new Date(hkMonthWindow(month).start.getTime() + 10 * DAY);
    await supply(s, [{ itemId: s.gloves, qtyBase: 40 }, { itemId: s.cleaner, qtyBase: 3 }], inMonth);
    // A receipt this month belongs to this month's report, not last month's.
    await supply(s, [{ itemId: s.gloves, qtyBase: 7 }], now);

    const report = await floorConsumables(db, month, now);
    const floor = report.floors.find((f) => f.floorId === w.floorId)!;
    expect(floor.storeId).toBe(s.floorStore);
    expect(floor.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: s.gloves, qty: 40, valuePaise: 40 * 250 }),
      expect.objectContaining({ itemId: s.cleaner, qty: 3, valuePaise: 3 * 9000 }),
    ]));
    expect(floor.items).toHaveLength(2);
    expect(floor.totalPaise).toBe(40 * 250 + 3 * 9000);
    // A floor with no IPD bed shows the total only.
    expect(floor.beds).toBe(0);
    expect(floor.costPerBedDayPaise).toBeNull();

    const thisMonth = (await floorConsumables(db, hkMonthOf(now), now)).floors.find((f) => f.floorId === w.floorId)!;
    expect(thisMonth.items).toEqual([expect.objectContaining({ itemId: s.gloves, qty: 7, valuePaise: 7 * 250 })]);
  });

  it("spec #974 D2: the monthly consumables report shows the cost per occupied bed-day for a ward floor", async () => {
    const s = await stores();
    await linkFloorStore(db, w.supervisor, { floorId: w.floorId, storeId: s.floorStore });
    const month = lastMonth();
    const { start, end } = hkMonthWindow(month);
    await supply(s, [{ itemId: s.gloves, qtyBase: 100 }, { itemId: s.cleaner, qtyBase: 5 }], new Date(start.getTime() + 3 * DAY));
    // Two patients lay on this ward floor through the whole of last month (the midnight census counts each night).
    for (const code of ["HK2-B1", "HK2-B2"]) {
      const bedId = await w.bed(code);
      await assignBed(db, w.desk, { idempotencyKey: randomUUID(), admissionId: newId(), bedId, patientId: await w.patient("female"), need: GENERAL });
      await db.update(ipdBedStays).set({ startedAt: new Date(start.getTime() - DAY) }).where(eq(ipdBedStays.bedId, bedId));
    }
    // An empty bed on the floor counts as a bed, never as a bed-day.
    await w.bed("HK2-B3");
    const nights = Math.round((end.getTime() - start.getTime()) / DAY);

    const floor = (await floorConsumables(db, month, now)).floors.find((f) => f.floorId === w.floorId)!;
    const total = 100 * 250 + 5 * 9000;
    expect(floor.totalPaise).toBe(total);
    expect(floor.beds).toBe(3);
    expect(floor.occupiedBedDays).toBe(2 * nights);
    expect(floor.costPerBedDayPaise).toBe(Math.round(total / (2 * nights)));
  });

  it("spec #974 D3: each shift draws random C or D areas for inspection; a failed inspection opens a rework task for the floor team", async () => {
    const storeRoom = await place("room", "F-T-STORE", w.floorId);
    const byArea = new Map<string, { resourceId: string; token: string; itemIds: string[] }>();
    for (const [resourceId, cls] of [[w.toiletId, "C_toilet"], [w.hallId, "C_public"], [storeRoom, "D"]] as const) {
      const a = await area(resourceId, cls);
      byArea.set(a.areaId, { resourceId, token: a.token, itemIds: a.itemIds });
    }
    await area(w.roomId, "B"); // a clinical area is checked per round, never drawn
    await area(w.room2Id, "B"); // floor 2 has no C or D area: nothing to draw there
    await rota([{ userId: w.hk1.id, mode: "floor", floorId: w.floorId }]);

    await drawInspections(db, now);
    const drawn = (await inspectionsOf(db, now)).inspections;
    expect(drawn).toHaveLength(2);
    expect(new Set(drawn.map((d) => d.areaId)).size).toBe(2);
    for (const d of drawn) {
      expect(byArea.has(d.areaId)).toBe(true);
      expect(d).toMatchObject({ floorId: w.floorId, status: "due", shiftStartsAt: hkShiftAt(now).startsAt.toISOString() });
    }
    // The clock runs every minute: drawing again in the same shift draws nothing new.
    await drawInspections(db, new Date(now.getTime() + MIN));
    expect((await inspectionsOf(db, now)).inspections.map((d) => d.id).sort()).toEqual(drawn.map((d) => d.id).sort());

    const [bad, good] = drawn as [typeof drawn[number], typeof drawn[number]];
    const at = byArea.get(bad.areaId)!;
    // The proof: the area's own QR, every item, a photo.
    await expect(inspect(bad.id, byArea.get(good.areaId)!.token)).rejects.toMatchObject({ code: "wrong_place" });
    await expect(inspect(bad.id, at.token, allYes().slice(1))).rejects.toMatchObject({ code: "checklist_incomplete" });
    await expect(inspect(bad.id, at.token, allYes(), false)).rejects.toMatchObject({ code: "photo_missing" });

    // Two items of eight answered No: 75 %, under the 80 % pass mark.
    const answers = HK_INSPECTION_ITEMS.map((i, n) => ({ itemId: i.id, ok: n >= 2 }));
    const failed = await inspect(bad.id, at.token, answers);
    expect(failed).toMatchObject({ status: "failed", scorePct: 75 });
    expect(failed.scorePct!).toBeLessThan(HK_INSPECT_PASS_PCT);
    expect(failed.reworkTaskId).not.toBeNull();
    await expect(inspect(bad.id, at.token)).rejects.toMatchObject({ code: "inspection_done" });
    const rework = (await getTask(db, failed.reworkTaskId!))!;
    expect(rework).toMatchObject({ kind: HOUSEKEEPING_KINDS.rework, placeResourceId: at.resourceId, assigneeId: null });
    // The floor team sees it in its pool; the rework is proved like any other housekeeping task, then the supervisor checks it.
    expect((await myTasks(db, w.hk1.id, now)).pool.map((t) => t.id)).toContain(rework.id);
    expect((await work(rework, w.hk1, at.token, at.itemIds)).state).toBe("done");
    await expect(confirmClean(db, w.supervisor, { taskId: rework.id, result: "pass" }, now)).resolves.toMatchObject({ state: "verified" });

    const passed = await inspect(good.id, byArea.get(good.areaId)!.token);
    expect(passed).toMatchObject({ status: "passed", scorePct: 100, reworkTaskId: null });
  });

  it("spec #974 D4: the contractor SLA report shows rounds on time, late or missed, turnaround median and p90, first-time pass and inspection score — no money", async () => {
    const shine = await addContractor(db, w.supervisor, { name: "Shine Facility Services" });
    await setHkStaff(db, w.supervisor, { userId: w.hkC.id, contractorId: shine.id, skills: [] });
    await setHkStaff(db, w.supervisor, { userId: w.hk1.id, contractorId: null, skills: [] });
    const toilet = await area(w.toiletId, "C_toilet");
    const hall = await area(w.hallId, "C_public");
    const store = await area(await place("room", "F-T-STORE", w.floorId), "D");
    const room2 = await area(w.room2Id, "B");
    await rota([
      { userId: w.hkC.id, mode: "route", areaIds: [toilet.areaId, hall.areaId, store.areaId] },
      { userId: w.hk1.id, mode: "floor", floorId: w.floor2Id },
    ]);
    await runRoundsClock(db, now);

    // Contractor: the toilet round on time, the hall round after its due time, the store round never.
    const toiletRound = await roundOf(toilet.areaId);
    await work(toiletRound, w.hkC, toilet.token, toilet.itemIds, now);
    const hallRound = await roundOf(hall.areaId);
    const lateAt = new Date(hallRound.dueAt!.getTime() + 5 * MIN);
    await work(hallRound, w.hkC, hall.token, hall.itemIds, lateAt, false);
    const storeRound = await roundOf(store.areaId);
    const missAt = new Date(Math.max(storeRound.dueAt!.getTime(), lateAt.getTime()) + (HK_ROUND_GRACE_MIN + 1) * MIN);
    await runRoundsClock(db, missAt);
    // In-house: floor 2's round on time.
    const room2Round = await roundOf(room2.areaId);
    await work(room2Round, w.hk1, room2.token, room2.itemIds, now, false);

    // Bed cleans (the ward is an area): the contractor's first fails once then passes at 40 min, the second passes at 20;
    // the in-house clean passes first time at 30.
    const ward = await area(w.wardId, "B");
    const bed1 = await releasedBed("HK2-SLA-1");
    const bed2 = await releasedBed("HK2-SLA-2");
    const bed3 = await releasedBed("HK2-SLA-3");
    for (const [b, who] of [[bed1, w.hkC], [bed2, w.hkC], [bed3, w.hk1]] as const) await assignTask(db, w.supervisor, { taskId: b.task.id, userId: who.id }, now);
    const at = (m: number) => new Date(now.getTime() + m * MIN);
    await work(bed1.task, w.hkC, ward.token, ward.itemIds, at(5));
    await confirmClean(db, w.nurse, { taskId: bed1.task.id, result: "fail", reason: "Bin full" }, at(10));
    await work((await getTask(db, bed1.task.id))!, w.hkC, ward.token, ward.itemIds, at(30));
    await confirmClean(db, w.nurse, { taskId: bed1.task.id, result: "pass" }, at(40));
    await work(bed2.task, w.hkC, ward.token, ward.itemIds, at(10));
    await confirmClean(db, w.nurse, { taskId: bed2.task.id, result: "pass" }, at(20));
    await work(bed3.task, w.hk1, ward.token, ward.itemIds, at(10));
    await confirmClean(db, w.nurse, { taskId: bed3.task.id, result: "pass" }, at(30));

    // Inspections on the contractor's floor: two of its three areas, both clean (100 %), scored after all the work above.
    await drawInspections(db, now);
    const inspectAt = new Date(missAt.getTime() + MIN);
    const tokens = new Map([[toilet.areaId, toilet.token], [hall.areaId, hall.token], [store.areaId, store.token]]);
    const scored: number[] = [];
    for (const d of (await inspectionsOf(db, now)).inspections) {
      const r = await inspect(d.id, tokens.get(d.areaId)!, allYes(), true, inspectAt);
      if (r.company === shine.name) scored.push(r.scorePct!);
    }
    expect(scored.length).toBeGreaterThan(0); // the toilet or the hall was drawn: both were last worked by the contractor

    const sla = async (when: Date): Promise<{ shine: HkSlaRow; house: HkSlaRow; json: string }> => {
      const v = await contractorSla(db, hkMonthOf(when), missAt);
      const json = JSON.stringify(v);
      return { shine: v.rows.find((r) => r.contractorId === shine.id)!, house: v.rows.find((r) => r.inHouse)!, json };
    };
    expect((await sla(toiletRound.dueAt!)).shine.rounds.onTime).toBe(1);
    expect((await sla(hallRound.dueAt!)).shine.rounds.late).toBe(1);
    expect((await sla(storeRound.dueAt!)).shine.rounds.missed).toBe(1);
    expect((await sla(room2Round.dueAt!)).house.rounds.onTime).toBe(1);

    const { shine: s, house: h, json } = await sla(bed1.task.raisedAt ?? now);
    expect(s).toMatchObject({ company: "Shine Facility Services", inHouse: false });
    expect(s.turnaround).toEqual({ count: 2, medianMin: 30, p90Min: 40 });
    expect(s.firstPass).toEqual({ checked: 2, passedFirstTime: 1, ratePct: 50 });
    expect(h).toMatchObject({ company: HK_IN_HOUSE, inHouse: true });
    expect(h.turnaround).toEqual({ count: 1, medianMin: 30, p90Min: 30 });
    expect(h.firstPass).toEqual({ checked: 1, passedFirstTime: 1, ratePct: 100 });
    const inspected = (await sla(inspectAt)).shine.inspections;
    expect(inspected).toEqual({ count: scored.length, avgScorePct: 100 });

    // A report only: no money, no deduction, and no attendant's name (company names only).
    expect(json).not.toMatch(/paise|amount|deduct|penalt|rupee|₹/i);
    for (const person of ["hk.contract", "hk.one", "hk.two"]) expect(json).not.toContain(person);
  });

  it("spec #974 D5: the daily report for a floor and shift counts rounds, turnarounds, requests, fails and inspections, matching the tasks behind each", async () => {
    const toilet = await area(w.toiletId, "C_toilet");
    const hall = await area(w.hallId, "C_public");
    const ward = await area(w.wardId, "B");
    const room2 = await area(w.room2Id, "B");
    await rota([{ userId: w.hk1.id, mode: "floor", floorId: w.floorId }, { userId: w.hk2.id, mode: "floor", floorId: w.floor2Id }]);
    await runRoundsClock(db, now);
    const toiletRound = await roundOf(toilet.areaId);
    const hallRound = await roundOf(hall.areaId);
    const wardRound = await roundOf(ward.areaId);
    const otherFloor = await roundOf(room2.areaId);
    await work(toiletRound, w.hk1, toilet.token, toilet.itemIds);
    // The hall round is never done: missed after its grace.
    await runRoundsClock(db, new Date(hallRound.dueAt!.getTime() + (HK_ROUND_GRACE_MIN + 1) * MIN));

    // A discharge clean that fails once, then passes: one turnaround, one fail.
    const bed = await releasedBed("HK2-DAY-1");
    await work(bed.task, w.hk1, ward.token, ward.itemIds);
    await confirmClean(db, w.nurse, { taskId: bed.task.id, result: "fail", reason: "Stain" }, now);
    await work((await getTask(db, bed.task.id))!, w.hk1, ward.token, ward.itemIds);
    await confirmClean(db, w.nurse, { taskId: bed.task.id, result: "pass" }, now);
    // Two door requests: one closed, one still open.
    const closedReq = await raiseDoorRequest(db, w.key, { token: hall.token, need: "bin" }, { address: "203.0.113.7" }, now);
    const openReq = await raiseDoorRequest(db, w.key, { token: toilet.token, need: "toilet" }, { address: "203.0.113.8" }, now);
    await work((await getTask(db, closedReq.taskId))!, w.hk1, hall.token, hall.itemIds, now, false);
    // Inspections: both C areas drawn; one fails (rework raised), one passes.
    await drawInspections(db, now);
    const drawn = (await inspectionsOf(db, now)).inspections;
    const tokens = new Map([[toilet.areaId, toilet.token], [hall.areaId, hall.token]]);
    const failed = await inspect(drawn[0]!.id, tokens.get(drawn[0]!.areaId)!, HK_INSPECTION_ITEMS.map((i) => ({ itemId: i.id, ok: i.id !== "floor" && i.id !== "bins" })));
    await inspect(drawn[1]!.id, tokens.get(drawn[1]!.areaId)!);

    const r = await dailyReport(db, w.floorId, now);
    expect(r).toMatchObject({ floorId: w.floorId, shiftStartsAt: hkShiftAt(now).startsAt.toISOString() });
    const buckets = [
      r.rounds.due, r.rounds.done, r.rounds.missed, r.turnarounds, r.requests.raised, r.requests.closed, r.fails, r.rework,
      r.inspections.drawn, r.inspections.passed, r.inspections.failed,
    ];
    for (const b of buckets) { expect(b.count).toBe(b.ids.length); expect(new Set(b.ids).size).toBe(b.ids.length); }
    expect(r.rounds.due.ids).toEqual(expect.arrayContaining([toiletRound.id, hallRound.id, wardRound.id]));
    expect(r.rounds.due.ids).not.toContain(otherFloor.id);
    expect(r.rounds.done.ids).toContain(toiletRound.id);
    expect(r.rounds.done.ids).not.toContain(hallRound.id);
    expect(r.rounds.missed.ids).toContain(hallRound.id);
    expect(r.rounds.missed.ids).not.toContain(toiletRound.id);
    expect(r.turnarounds.ids).toEqual([bed.task.id]);
    expect(r.requests.raised.ids.sort()).toEqual([closedReq.taskId, openReq.taskId].sort());
    expect(r.requests.closed.ids).toEqual([closedReq.taskId]);
    expect(r.fails.ids).toContain(bed.task.id);
    expect(r.rework.ids).toEqual([failed.reworkTaskId]);
    expect(r.inspections.drawn.ids.sort()).toEqual(drawn.map((d) => d.id).sort());
    expect(r.inspections.failed.ids).toEqual([failed.id]);
    expect(r.inspections.passed.ids).toEqual([drawn[1]!.id]);
    // Every task behind a count is on this floor and is what the count says it is.
    for (const id of r.rounds.done.ids) expect(["done", "verified"]).toContain((await getTask(db, id))!.state);
    for (const id of r.requests.raised.ids) expect((await getTask(db, id))!.kind).toBe(HOUSEKEEPING_KINDS.request);
    for (const id of r.turnarounds.ids) expect((await getTask(db, id))!.state).toBe("verified");
  });
});
