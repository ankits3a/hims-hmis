import { and, eq } from "drizzle-orm";
import { DIET_TASK_KINDS } from "@hmis/contracts";
import { alerts, dietMealLines, dietMealLists, dietNpo, patients, tasks } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { mkOtPatient, seedOtBase } from "../../../../test/helpers/ot";
import { bookCase, cancelCase, postponeCase } from "../../ot";
import { getTask } from "../../tasks";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ist, mkDietWorld, otEvent } from "../../../../test/helpers/diet";
import {
  DIET_DELIVERY_TASK, DietRefusal, backfillOtNpo, buildSlot, dispatchList, handleDietEvent, istDayStart, kitchenBoard, markPrinted, orderDiet,
  readList, startNpo,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { DietWorld } from "../../../../test/helpers/diet";

/**
 * E4.4 DIET (#736) — "DONE MEANS" (SPEC-ipd-companions §7, §11; decision 0072), plus the two safety rules the brief
 * names: NPO always wins, and a sealed patient's tray label carries the alias only. Every act takes an explicit
 * instant (`ist(...)`, IST); nothing here reads the real clock.
 */
jest.setTimeout(240_000);

describe("E4.4 diet — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DietWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkDietWorld(db); });

  const activeTrays = async (listId: string) =>
    (await db.select().from(dietMealLines).where(and(eq(dietMealLines.listId, listId), eq(dietMealLines.state, "active")))).map((l) => l.admissionId);

  it("(i) an NPO order removes the patient from the next meal list — after the list was built too", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const b = await w.admitAt("general", ist("2026-03-10T09:05:00"));
    const lunch = await w.slot("lunch", "2026-03-11");
    const [listId] = await buildSlot(db, w.kitchen, lunch, ist("2026-03-11T10:31:00"));
    expect((await activeTrays(listId!)).sort()).toEqual([a.admissionId, b.admissionId].sort());

    // A nurse sets NPO at 10:45 (before lunch is served): the tray is withdrawn from the built list at once.
    await startNpo(db, w.nurse, { admissionId: a.admissionId, reason: "USG abdomen" }, ist("2026-03-11T10:45:00"));
    expect(await activeTrays(listId!)).toEqual([b.admissionId]);
    const line = (await db.select().from(dietMealLines).where(and(eq(dietMealLines.listId, listId!), eq(dietMealLines.admissionId, a.admissionId))))[0]!;
    expect(line).toMatchObject({ state: "withdrawn", withdrawnReason: "npo" });

    // The board says so: one tray, one NPO.
    const board = await kitchenBoard(db, w.kitchen, ist("2026-03-11T10:50:00"), { meal: "lunch", date: "2026-03-11" });
    expect(board.lists[0]!.counts).toMatchObject({ trays: 1, npo: 1 });

    // An NPO set BEFORE the build keeps the patient off the next list from the start (dinner).
    const dinner = await w.slot("dinner", "2026-03-11");
    const [dinnerId] = await buildSlot(db, w.kitchen, dinner, ist("2026-03-11T17:31:00"));
    expect(await activeTrays(dinnerId!)).toEqual([b.admissionId]);
  });

  it("(ii) an OT booking removes the patient from the next meal list; a cancelled booking lifts the NPO and tells the ward", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    // Booked on the 10th for surgery on the 11th: NPO from 00:00 IST on the 11th.
    await handleDietEvent(db, otEvent("daycare.booked", { caseId: "01J0000000000000000000CASE", patientId: a.patientId, listDate: "2026-03-11" }, ist("2026-03-10T15:00:00")), ist("2026-03-10T15:00:00"));
    const [dinner10] = await buildSlot(db, w.kitchen, await w.slot("dinner", "2026-03-10"), ist("2026-03-10T17:31:00"));
    expect(await activeTrays(dinner10!)).toEqual([a.admissionId]); // the evening before surgery is served
    const [bf11] = await buildSlot(db, w.kitchen, await w.slot("breakfast", "2026-03-11"), ist("2026-03-11T06:01:00"));
    expect(await activeTrays(bf11!)).toEqual([]); // surgery day: no tray

    await markPrinted(db, w.kitchen, bf11!, ist("2026-03-11T06:05:00"));
    await handleDietEvent(db, otEvent("case.cancelled", { caseId: "01J0000000000000000000CASE" }, ist("2026-03-11T06:30:00")), ist("2026-03-11T06:30:00"));
    expect(await activeTrays(bf11!)).toEqual([a.admissionId]); // NPO lifted: the tray is back (late)
    const told = await db.select().from(tasks).where(and(eq(tasks.kind, DIET_TASK_KINDS.wardNotice), eq(tasks.placeResourceId, w.wardId)));
    expect(told).toHaveLength(1);
    expect(told[0]!.note).toContain("OT cancelled");
  });

  it("(iii) a transfer after the list was printed updates the list and tells the OLD ward", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const lunch = await w.slot("lunch", "2026-03-11");
    const built = await buildSlot(db, w.kitchen, lunch, ist("2026-03-11T10:31:00"));
    expect(built).toHaveLength(1);
    const oldList = built[0]!;
    await markPrinted(db, w.kitchen, oldList, ist("2026-03-11T10:40:00"));

    const target = await w.bed2("D-W2-B1");
    await w.transfer(a.admissionId, target, ist("2026-03-11T11:00:00"));
    await w.deliver(a.admissionId, ist("2026-03-11T11:02:00"));

    // The old ward's list loses the tray (withdrawn, kept for the record) …
    const line = (await db.select().from(dietMealLines).where(and(eq(dietMealLines.listId, oldList), eq(dietMealLines.admissionId, a.admissionId))))[0]!;
    expect(line).toMatchObject({ state: "withdrawn", withdrawnReason: "transferred" });
    // … and the old ward is told on the task engine, once (a second delivery tells no one again).
    await w.deliver(a.admissionId, ist("2026-03-11T11:03:00"));
    const told = await db.select().from(tasks).where(eq(tasks.kind, DIET_TASK_KINDS.wardNotice));
    expect(told).toHaveLength(1);
    expect(told[0]!.placeResourceId).toBe(w.wardId);
    expect(told[0]!.note).toContain("moved to F-T-W2");

    // The new ward's lunch list (built late by the kitchen) carries the patient.
    const [newList] = await buildSlot(db, w.kitchen, lunch, ist("2026-03-11T11:05:00"));
    expect(await activeTrays(newList!)).toEqual([a.admissionId]);
  });

  it("(iv) NPO always wins: no diet order, set before or after, puts a tray in front of an NPO patient", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await orderDiet(db, w.dietDoctor, { admissionId: a.admissionId, code: "diabetic", preference: "veg" }, ist("2026-03-11T08:00:00"));
    await startNpo(db, w.nurse, { admissionId: a.admissionId, reason: "Endoscopy", startsAt: ist("2026-03-11T09:00:00").toISOString(), endsAt: ist("2026-03-11T14:00:00").toISOString() }, ist("2026-03-11T08:30:00"));
    const [lunch] = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    expect(await activeTrays(lunch!)).toEqual([]);
    // A new diet ordered while NPO is live does not bring the tray back.
    await orderDiet(db, w.dietDoctor, { admissionId: a.admissionId, code: "soft", preference: "veg" }, ist("2026-03-11T11:00:00"));
    expect(await activeTrays(lunch!)).toEqual([]);
    // NPO ends at 14:00: the evening tray comes, with the newest diet.
    const [evening] = await buildSlot(db, w.kitchen, await w.slot("evening", "2026-03-11"), ist("2026-03-11T15:01:00"));
    const lines = await db.select().from(dietMealLines).where(eq(dietMealLines.listId, evening!));
    expect(lines.map((l) => [l.state, l.code])).toEqual([["active", "soft"]]);
  });

  it("(v) a sealed patient's tray label carries the alias only — no name, no UHID — and still the bed", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    await db.update(patients).set({ sensitiveContext: true, alias: "Guest K" }).where(eq(patients.id, a.patientId));
    const real = (await db.select().from(patients).where(eq(patients.id, a.patientId)))[0]!;
    expect(real.uhid.length).toBeGreaterThan(3); // a real UHID exists, so its absence below means something
    const [listId] = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    const view = (await readList(db, w.kitchen, listId!))!;
    const label = view.lines.find((l) => l.admissionId === a.admissionId)!;
    expect(label.patient).toEqual({ name: "Guest K", uhid: "", sealed: true });
    expect(JSON.stringify(view)).not.toContain(real.uhid);
    expect(JSON.stringify(view)).not.toContain(real.name);
    expect(label.bedCode).not.toBeNull();
  });

  // ═══ Review of 01d53113 — the printed paper must never be stale at dispatch (DECIDED) ═══

  const listRow = async (id: string) => (await db.select().from(dietMealLists).where(eq(dietMealLists.id, id)))[0]!;
  const lineOf = async (listId: string, admissionId: string) =>
    (await db.select().from(dietMealLines).where(and(eq(dietMealLines.listId, listId), eq(dietMealLines.admissionId, admissionId))))[0]!;
  const bells = async (userId: string, kind: string) => db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.kind, kind)));
  const refusalCode = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { if (e instanceof DietRefusal) return e.code; throw e; }
    throw new Error("expected a refusal");
  };

  it("(vi) NPO after print: the list is marked changed, the kitchen and the ward are told, dispatch waits for the reprint", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const [listId] = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    await markPrinted(db, w.kitchen, listId!, ist("2026-03-11T10:40:00"));
    await startNpo(db, w.nurse, { admissionId: a.admissionId, reason: "CT abdomen" }, ist("2026-03-11T11:00:00"));
    expect((await listRow(listId!)).changedSincePrint).toBe(true);
    expect((await lineOf(listId!, a.admissionId)).changedAt?.toISOString()).toBe(ist("2026-03-11T11:00:00").toISOString());
    expect(await bells(w.kitchen.id, "diet.kitchen_change")).toHaveLength(1);
    expect(await bells(w.nurse.id, "diet.ward_change")).toHaveLength(1);
    const told = await db.select().from(tasks).where(eq(tasks.kind, DIET_TASK_KINDS.wardNotice));
    expect(told.map((t) => t.placeResourceId)).toEqual([w.wardId]);
    expect(told[0]!.note).toContain("NPO");
    expect(await refusalCode(dispatchList(db, w.kitchen, listId!, ist("2026-03-11T11:10:00")))).toBe("list_changed_since_print");
    await markPrinted(db, w.kitchen, listId!, ist("2026-03-11T11:15:00"));
    await dispatchList(db, w.kitchen, listId!, ist("2026-03-11T11:20:00"));
  });

  it("(vii) a diet change after print goes the same way: changed, told, gated; the reprint carries the new diet", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const [listId] = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    await markPrinted(db, w.kitchen, listId!, ist("2026-03-11T10:40:00"));
    await orderDiet(db, w.dietDoctor, { admissionId: a.admissionId, code: "renal", preference: "veg" }, ist("2026-03-11T11:00:00"));
    expect(await lineOf(listId!, a.admissionId)).toMatchObject({ code: "renal", state: "active" });
    expect((await listRow(listId!)).changedSincePrint).toBe(true);
    expect(await bells(w.kitchen.id, "diet.kitchen_change")).toHaveLength(1);
    expect(await refusalCode(dispatchList(db, w.kitchen, listId!, ist("2026-03-11T11:10:00")))).toBe("list_changed_since_print");
  });

  it("(viii) a transfer INTO a printed list adds a late tray, tells the kitchen and the NEW ward, and gates dispatch", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const other = await w.bed2("D-W2-B9");
    // Ward 2 already has a patient, so its lunch list exists and is printed before the move.
    const b = await w.admitAt("general", ist("2026-03-10T09:05:00"));
    await w.transfer(b.admissionId, other, ist("2026-03-10T12:00:00"));
    const lists = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    expect(lists).toHaveLength(2);
    for (const l of lists) await markPrinted(db, w.kitchen, l, ist("2026-03-11T10:40:00"));
    const target = await w.bed2("D-W2-B1");
    await w.transfer(a.admissionId, target, ist("2026-03-11T11:00:00"));
    await w.deliver(a.admissionId, ist("2026-03-11T11:02:00"));
    const newList = (await db.select().from(dietMealLists).where(eq(dietMealLists.wardId, w.ward2Id)))[0]!;
    expect(await lineOf(newList.id, a.admissionId)).toMatchObject({ state: "active", late: true });
    expect(newList.changedSincePrint).toBe(true);
    const notices = await db.select().from(tasks).where(eq(tasks.kind, DIET_TASK_KINDS.wardNotice));
    expect(notices.map((t) => t.placeResourceId).sort()).toEqual([w.wardId, w.ward2Id].sort()); // old ward AND new ward
    expect(await bells(w.kitchen.id, "diet.kitchen_change")).toHaveLength(2);
    expect(await refusalCode(dispatchList(db, w.kitchen, newList.id, ist("2026-03-11T11:10:00")))).toBe("list_changed_since_print");
  });

  it("(ix) a tray added after DISPATCH (late admission) gets its own tray task; the trolley's Done does not mark it delivered", async () => {
    await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const [listId] = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    await markPrinted(db, w.kitchen, listId!, ist("2026-03-11T10:40:00"));
    const { taskId } = await dispatchList(db, w.kitchen, listId!, ist("2026-03-11T12:00:00"));
    const late = await w.admitAt("general", ist("2026-03-11T12:05:00"));
    await w.deliver(late.admissionId, ist("2026-03-11T12:06:00"));
    const line = await lineOf(listId!, late.admissionId);
    expect(line).toMatchObject({ state: "active", late: true, onLoad: false });
    expect(line.trayTaskId).not.toBeNull();
    expect(await bells(w.kitchen.id, "diet.kitchen_change")).toHaveLength(1);
    await withTx(db, async (tx) => DIET_DELIVERY_TASK.onDone!(tx, (await getTask(tx, taskId))!, w.dietician, ist("2026-03-11T12:25:00")));
    expect((await lineOf(listId!, late.admissionId)).served).toBeNull();
    await withTx(db, async (tx) => DIET_DELIVERY_TASK.onDone!(tx, (await getTask(tx, line.trayTaskId!))!, w.dietician, ist("2026-03-11T12:30:00")));
    expect((await lineOf(listId!, late.admissionId)).served).toBe("delivered");
  });

  it("(x) a transfer OUT of a dispatched list: do not serve, the old ward and the kitchen told", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const [listId] = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    await markPrinted(db, w.kitchen, listId!, ist("2026-03-11T10:40:00"));
    await dispatchList(db, w.kitchen, listId!, ist("2026-03-11T12:00:00"));
    await w.transfer(a.admissionId, await w.bed2("D-W2-B1"), ist("2026-03-11T12:05:00"));
    await w.deliver(a.admissionId, ist("2026-03-11T12:07:00"));
    expect(await lineOf(listId!, a.admissionId)).toMatchObject({ state: "withdrawn", withdrawnReason: "transferred" });
    const told = await db.select().from(tasks).where(eq(tasks.kind, DIET_TASK_KINDS.wardNotice));
    expect(told[0]!.note).toContain("do not serve");
    expect(await bells(w.kitchen.id, "diet.kitchen_change")).toHaveLength(1);
  });
});

describe("E4.4 diet — OT bookings made before the deploy (review items 7 and 9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  it("(xi) the deploy backfill gives a booked case its NPO once; a postponement moves it; a cancellation lifts it", async () => {
    await truncateAll(db);
    const f = await seedOtBase(db);
    const patientId = await mkOtPatient(db, f.coordinator, "Sunita Devi");
    const kase = await bookCase(db, f.coordinator, {
      patientId, procedureCode: "GYN-DNC-01", procedureClass: "gynae_dnc", surgeonId: f.surgeon.id, listDate: "2026-09-02", payerClass: "self_pay",
    });
    const now = ist("2026-09-01T10:00:00");
    expect(await db.select().from(dietNpo)).toHaveLength(0); // booked before diet's consumer existed
    expect(await backfillOtNpo(db, now)).toBe(1);
    expect(await backfillOtNpo(db, now)).toBe(0); // idempotent on the case's source_ref
    const [npo] = await db.select().from(dietNpo);
    expect(npo).toMatchObject({ patientId, sourceRef: `ot-case:${kase.caseId}`, liftedAt: null });
    expect(npo!.startsAt.toISOString()).toBe(istDayStart("2026-09-02").toISOString());

    await postponeCase(db, f.coordinator, { caseId: kase.caseId, reason: "patient_unfit", newListDate: "2026-09-04" });
    await handleDietEvent(db, otEvent("list.published", { listDate: "2026-09-04" }, now), now);
    const moved = await db.select().from(dietNpo);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.startsAt.toISOString()).toBe(istDayStart("2026-09-04").toISOString());

    await cancelCase(db, f.coordinator, { caseId: kase.caseId, reason: "patient declined", attribution: "patient" });
    await backfillOtNpo(db, now);
    expect((await db.select().from(dietNpo))[0]!.liftedAt).not.toBeNull();
  });
});
