import { and, eq } from "drizzle-orm";
import { DIET_TASK_KINDS } from "@hmis/contracts";
import { dietMealLines, patients, tasks } from "../../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { ist, mkDietWorld, otEvent } from "../../../../test/helpers/diet";
import { buildSlot, handleDietEvent, kitchenBoard, markPrinted, orderDiet, readList, startNpo } from "../index";
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
    const [listId] = await buildSlot(db, w.kitchen, await w.slot("lunch", "2026-03-11"), ist("2026-03-11T10:31:00"));
    const view = (await readList(db, w.kitchen, listId!))!;
    const label = view.lines.find((l) => l.admissionId === a.admissionId)!;
    expect(label.patient).toEqual({ name: "Guest K", uhid: "", sealed: true });
    expect(JSON.stringify(view)).not.toContain(real.uhid);
    expect(JSON.stringify(view)).not.toContain(real.name);
    expect(label.bedCode).not.toBeNull();
  });
});
