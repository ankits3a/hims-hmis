import { and, eq } from "drizzle-orm";
import { DIET_CODES, DIET_MEALS, DIET_TASK_KINDS, DIET_WITHDRAW_REASONS } from "@hmis/contracts";
import { withTx } from "../../kernel/db/client";
import {
  DIET_CODE_VALUES, DIET_MEAL_VALUES, DIET_WITHDRAW_VALUES, dietConsults, dietMealLines, dietMealLists, dietOrders, tasks,
} from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ist, mkDietWorld } from "../../../test/helpers/diet";
import { IPD_ADMISSION_ENDED_EVENT_NAMES, IPD_ADMISSION_BOARD_EVENT_NAMES, IPD_TRANSFER_EVENT_NAMES } from "../ipd";
import { OT_EVENTS } from "../ot";
import { getTask } from "../tasks";
import {
  DIET_DELIVERY_TASK, DietRefusal, buildDueLists, buildSlot, completeConsult, consultQueue, dietConsultsCard, dispatchList, dueSlots, endStay,
  kitchenBoard, markPrinted, mealRounds, nextSlot, orderDiet, requestConsult, serveLine, setMealRound, slotOf, startNpo, wardSheet,
} from "./index";
import { IPD_ADMITTED_EVENT, IPD_BED_SWAPPED_EVENT, OT_BOOKED_EVENT, OT_CANCELLED_EVENT } from "./names";
import { DIET_EVENTS } from "./events";
import type { Db } from "../../kernel/db/client";
import type { DietWorld } from "../../../test/helpers/diet";

jest.setTimeout(240_000);

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DietRefusal) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("diet — pure facts", () => {
  it("schema literals equal the contract's", () => {
    expect([...DIET_CODE_VALUES]).toEqual([...DIET_CODES]);
    expect([...DIET_MEAL_VALUES]).toEqual([...DIET_MEALS]);
    expect([...DIET_WITHDRAW_VALUES]).toEqual([...DIET_WITHDRAW_REASONS]);
  });

  it("the events diet listens to are the names IPD and OT emit", () => {
    expect(IPD_ADMISSION_BOARD_EVENT_NAMES).toContain(IPD_ADMITTED_EVENT);
    expect(IPD_TRANSFER_EVENT_NAMES).toContain(IPD_BED_SWAPPED_EVENT);
    expect(IPD_ADMISSION_ENDED_EVENT_NAMES).toHaveLength(4);
    const ot = OT_EVENTS.map((e) => e.name);
    expect(ot).toContain(OT_BOOKED_EVENT);
    expect(ot).toContain(OT_CANCELLED_EVENT);
    expect(DIET_EVENTS.map((e) => e.name).every((n) => n.startsWith("diet."))).toBe(true);
  });

  it("meal slots are IST: lunch on a day is cut off at 10:30 and served at 12:30 IST", () => {
    const rounds = DIET_MEALS.map((meal) => ({ meal, cutoffMinute: meal === "lunch" ? 630 : 0, serveMinute: meal === "lunch" ? 750 : 1 }));
    const s = slotOf(rounds[1]!, "2026-03-11");
    expect(s.cutoffAt.toISOString()).toBe(ist("2026-03-11T10:30:00").toISOString());
    expect(s.serveAt.toISOString()).toBe(ist("2026-03-11T12:30:00").toISOString());
  });
});

describe("diet — intents and the meal clock", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: DietWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkDietWorld(db); });

  it("the four rounds fall back to the seeded defaults; the next slot after dinner is tomorrow's breakfast", async () => {
    const rounds = await mealRounds(db);
    expect(rounds.map((r) => [r.meal, r.cutoffMinute, r.serveMinute])).toEqual([
      ["breakfast", 360, 450], ["lunch", 630, 750], ["evening", 900, 990], ["dinner", 1050, 1170],
    ]);
    expect(nextSlot(rounds, ist("2026-03-11T20:00:00"))).toMatchObject({ meal: "breakfast", date: "2026-03-12" });
    expect(dueSlots(rounds, ist("2026-03-11T10:45:00")).map((s) => s.meal)).toEqual(["lunch"]);
    expect(dueSlots(rounds, ist("2026-03-11T09:00:00"))).toEqual([]);
    expect(await refusal(setMealRound(db, w.dietician, { meal: "lunch", cutoffMinute: 800, serveMinute: 750 }))).toBe("cutoff_after_serve");
    expect(await refusal(setMealRound(db, w.kitchen, { meal: "lunch", cutoffMinute: 600, serveMinute: 750 }))).toBe("forbidden");
    await setMealRound(db, w.dietician, { meal: "lunch", cutoffMinute: 600, serveMinute: 720 });
    expect((await mealRounds(db))[1]).toEqual({ meal: "lunch", cutoffMinute: 600, serveMinute: 720 });
  });

  it("the meal clock builds every due list once (a second tick builds nothing) and nothing before the cut-off", async () => {
    await w.admitAt("general", ist("2026-03-10T09:00:00"));
    expect(await buildDueLists(db, ist("2026-03-11T10:00:00"))).toBe(0);
    expect(await buildDueLists(db, ist("2026-03-11T10:31:00"))).toBe(1);
    expect(await buildDueLists(db, ist("2026-03-11T10:32:00"))).toBe(0);
    expect(await db.select().from(dietMealLists)).toHaveLength(1);
  });

  it("a nurse may set NPO but not order a diet; a tube feed needs volume and frequency; provenance is recorded", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    expect(await refusal(orderDiet(db, w.nurse, { admissionId: a.admissionId, code: "soft" }, ist("2026-03-11T08:00:00")))).toBe("nurse_npo_only");
    expect(await refusal(orderDiet(db, w.kitchen, { admissionId: a.admissionId, code: "soft" }, ist("2026-03-11T08:00:00")))).toBe("forbidden");
    expect((await orderDiet(db, w.nurse, { admissionId: a.admissionId, code: "npo", note: "Fasting for CT" }, ist("2026-03-11T08:00:00"))).kind).toBe("npo");
    expect(await refusal(orderDiet(db, w.dietDoctor, { admissionId: a.admissionId, code: "ryles_feed" }, ist("2026-03-11T08:05:00")))).toBe("tube_feed_needs_volume");
    await orderDiet(db, w.dietDoctor, { admissionId: a.admissionId, code: "ryles_feed", tubeVolumeMl: 200, tubeEveryHours: 3 }, ist("2026-03-11T08:10:00"));
    await orderDiet(db, w.dietician, { admissionId: a.admissionId, code: "renal", preference: "jain" }, ist("2026-03-11T08:20:00"));
    const orders = await db.select().from(dietOrders).where(eq(dietOrders.admissionId, a.admissionId)).orderBy(dietOrders.startedAt);
    expect(orders.map((o) => [o.code, o.source, o.endedAt === null])).toEqual([["ryles_feed", "doctor", false], ["renal", "dietician", true]]);
    // A doctor's therapeutic order opened ONE consult (the dietician's own did not open a second).
    expect(await db.select().from(dietConsults)).toHaveLength(1);
  });

  it("dispatch needs a printed list, raises one delivery task; its Done marks the list delivered", async () => {
    await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const [listId] = await buildSlot(db, w.kitchen, slotOf((await mealRounds(db))[1]!, "2026-03-11"), ist("2026-03-11T10:31:00"));
    expect(await refusal(dispatchList(db, w.kitchen, listId!, ist("2026-03-11T12:00:00")))).toBe("list_not_printed");
    expect(await refusal(dispatchList(db, w.nurse, listId!, ist("2026-03-11T12:00:00")))).toBe("forbidden");
    await markPrinted(db, w.kitchen, listId!, ist("2026-03-11T11:50:00"));
    const { taskId } = await dispatchList(db, w.kitchen, listId!, ist("2026-03-11T12:00:00"));
    expect(await refusal(dispatchList(db, w.kitchen, listId!, ist("2026-03-11T12:01:00")))).toBe("list_already_dispatched");
    const task = (await getTask(db, taskId))!;
    expect(task).toMatchObject({ kind: DIET_TASK_KINDS.delivery, placeResourceId: w.wardId });
    await withTx(db, (tx) => DIET_DELIVERY_TASK.onDone!(tx, task, w.dietician, ist("2026-03-11T12:25:00")));
    const list = (await db.select().from(dietMealLists).where(eq(dietMealLists.id, listId!)))[0]!;
    expect(list.deliveredAt?.toISOString()).toBe(ist("2026-03-11T12:25:00").toISOString());
    const lines = await db.select().from(dietMealLines).where(eq(dietMealLines.listId, listId!));
    expect(lines.map((l) => l.served)).toEqual(["delivered"]);
  });

  it("two refused trays within a day open a dietician consult; the dietician closes it", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const rounds = await mealRounds(db);
    for (const [i, at] of [[1, "2026-03-11T10:31:00"], [2, "2026-03-11T15:01:00"]] as const) {
      const [listId] = await buildSlot(db, w.kitchen, slotOf(rounds[i]!, "2026-03-11"), ist(at));
      await markPrinted(db, w.kitchen, listId!, ist(at));
      await dispatchList(db, w.kitchen, listId!, ist(at));
      const line = (await db.select().from(dietMealLines).where(eq(dietMealLines.listId, listId!)))[0]!;
      const r = await serveLine(db, w.nurse, { lineId: line.id, outcome: "refused" }, ist(at));
      expect(r.consultOpened).toBe(i === 2);
    }
    const queue = await consultQueue(db, w.dietician, ist("2026-03-11T16:00:00"));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ admissionId: a.admissionId, reason: "Refused 2 meals in 24 h" });
    const card = await dietConsultsCard({ db, actor: w.dietician, reader: w.dietician, date: "2026-03-11", now: ist("2026-03-11T16:00:00") });
    expect(card[0]?.rows).toHaveLength(1);
    expect(await refusal(requestConsult(db, w.nurse, { admissionId: a.admissionId, reason: "again" }, ist("2026-03-11T16:05:00")))).toBe("consult_open");
    await completeConsult(db, w.dietician, { consultId: queue[0]!.id, note: "High-calorie soft diet, small meals" }, ist("2026-03-11T16:30:00"));
    expect(await consultQueue(db, w.dietician, ist("2026-03-11T16:31:00"))).toEqual([]);
  });

  it("discharge takes the patient off every list still ahead; the ward sheet and kitchen board say why", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T09:00:00"));
    const b = await w.admitAt("general", ist("2026-03-10T09:05:00"));
    await startNpo(db, w.nurse, { admissionId: b.admissionId, reason: "Pre-op" }, ist("2026-03-11T09:00:00"));
    const [listId] = await buildSlot(db, w.kitchen, slotOf((await mealRounds(db))[1]!, "2026-03-11"), ist("2026-03-11T10:31:00"));
    const sheet = await wardSheet(db, w.nurse, w.wardId, ist("2026-03-11T10:40:00"));
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows.find((r) => r.admissionId === b.admissionId)!.npo?.live).toBe(true);
    expect(sheet.rows.find((r) => r.admissionId === a.admissionId)!.nextLine).toMatchObject({ state: "active", defaulted: true, code: "normal" });

    await w.discharge(a.admissionId, ist("2026-03-11T11:00:00"));
    await endStay(db, a.admissionId, ist("2026-03-11T11:00:00"));
    const line = (await db.select().from(dietMealLines).where(and(eq(dietMealLines.listId, listId!), eq(dietMealLines.admissionId, a.admissionId))))[0]!;
    expect(line).toMatchObject({ state: "withdrawn", withdrawnReason: "discharged" });
    const board = await kitchenBoard(db, w.kitchen, ist("2026-03-11T11:05:00"), { meal: "lunch", date: "2026-03-11" });
    expect(board.lists[0]!.counts).toMatchObject({ trays: 0, npo: 1, withdrawn: 1 });
    expect(JSON.stringify(board)).not.toMatch(/paise|price|amount/i); // decision 0058: no money on a diet surface
    expect(await db.select().from(tasks)).toHaveLength(0); // an unprinted list changes without telling anyone
  });
});
