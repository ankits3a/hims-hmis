import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { DIET_INTENTS, DIET_TASK_KINDS, newId } from "@hmis/contracts";
import { dietConsults, dietMealLines, dietMealLists } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { placedCensus } from "../ipd";
import { raiseTask } from "../tasks";
import { DietRefusal } from "./errors";
import { dietListBuilt, dietListDispatched, dietTrayServed } from "./events";
import { requirePermission } from "./guard";
import { DIET_ACTOR, DIET_KITCHEN, DIET_SERVE } from "./names";
import { dueSlots, mealRounds, missedSlots, slotOf } from "./rounds";
import { tellKitchen } from "./notices";
import { exclusiveListsLock, npoCovering, trayFor } from "./trays";
import type { Actor, DietMeal } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { MealSlot } from "./rounds";

/**
 * ═══ THE MEAL LISTS — built at the cut-off, printed, dispatched, delivered ═══
 *
 * One list per ward, IST day and meal (unique). `buildSlot` builds every ward's list for one meal at once, under the
 * exclusive `diet:lists` lock (see `trays.ts`): each placed patient gets one line — active with the tray, or withdrawn
 * `npo` when an NPO covers the serve time (the kitchen sees "NPO, no tray"). The worker's meal clock calls
 * `buildDueLists` every minute (it rides the task clock's tick); the kitchen's "Build now" calls `buildSlot` too.
 * Idempotent: a built list is never rebuilt; changes after the build go through `reconcileIn`.
 *
 * Print → dispatch (only a printed list leaves the kitchen: the labels are on the trays) → the delivery task on the
 * engine (the ward's attendant taps Done; `kinds.ts` marks the list delivered). A ward may tap each tray delivered or
 * refused; two refusals within a day open a dietician consult (DECIDED: the nurse is told on the ward sheet).
 */
function parse<T>(schema: { safeParse: (x: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new DietRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) });
  return r.data;
}

/** Build one meal's list for every ward with a placed patient. Returns the ids of the lists built now. */
export async function buildSlot(db: Db, actor: Actor, slot: MealSlot, now: Date = new Date()): Promise<string[]> {
  return db.transaction(async (t) => {
    await exclusiveListsLock(t);
    const census = await placedCensus(t);
    const existing = new Set((await t.select({ wardId: dietMealLists.wardId }).from(dietMealLists)
      .where(and(eq(dietMealLists.serviceDate, slot.date), eq(dietMealLists.meal, slot.meal)))).map((r) => r.wardId));
    const wards = new Map<string, typeof census>();
    for (const p of census) {
      if (existing.has(p.wardId)) continue;
      wards.set(p.wardId, [...(wards.get(p.wardId) ?? []), p]);
    }
    const built: string[] = [];
    for (const [wardId, people] of wards) {
      const listId = newId();
      await t.insert(dietMealLists).values({
        id: listId, wardId, meal: slot.meal, serviceDate: slot.date, serveAt: slot.serveAt, builtAt: now, builtBy: actor.id,
      });
      let trays = 0;
      for (const p of people) {
        const npo = await npoCovering(t, p.patientId, slot.serveAt);
        const tray = await trayFor(t, p.admissionId);
        await t.insert(dietMealLines).values({
          id: newId(), listId, admissionId: p.admissionId, patientId: p.patientId, bedId: p.bedId, bedCode: p.bedCode,
          code: tray.code, preference: tray.preference, tube: tray.tube, defaulted: tray.defaulted, late: false,
          state: npo === null ? "active" : "withdrawn", withdrawnReason: npo === null ? null : "npo", withdrawnAt: npo === null ? null : now,
          createdAt: now,
        });
        if (npo === null) trays += 1;
      }
      await appendEvent(t, dietListBuilt.make({
        actor, correlationId: listId,
        payload: { listId, wardId, meal: slot.meal, date: slot.date, trays, npo: people.length - trays },
      }));
      built.push(listId);
    }
    return built;
  });
}

/** The kitchen's "Build now" for one meal of one IST day (before the cut-off too). */
export async function buildLists(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<string[]> {
  await requirePermission(db, actor, DIET_KITCHEN);
  const input = parse(DIET_INTENTS.build_lists, raw);
  const round = (await mealRounds(db)).find((r) => r.meal === input.meal)!;
  return buildSlot(db, actor, slotOf(round, input.date), now);
}

/** THE MEAL CLOCK (worker, every minute on the task clock's tick): every meal past its cut-off and not yet served. */
export async function buildDueLists(db: Db, now: Date = new Date()): Promise<number> {
  const rounds = await mealRounds(db);
  let n = 0;
  for (const slot of dueSlots(rounds, now)) n += (await buildSlot(db, DIET_ACTOR, slot, now)).length;
  // Review item 12: a meal whose serve time passed in the last two hours with a ward that had patients and no list
  // (the worker was down through the cut-off) is a MISSED list — the kitchen is told once per meal.
  for (const slot of missedSlots(rounds, now)) {
    const built = new Set((await listsOfSlot(db, slot.date, slot.meal)).map((l) => l.wardId));
    const wards = new Map((await placedCensus(db)).map((p) => [p.wardId, p.wardName] as const));
    const missing = [...wards].filter(([id]) => !built.has(id)).map(([, name]) => name);
    if (missing.length === 0) continue;
    await db.transaction((t) => tellKitchen(t, `Meal list missed · ${slot.meal}`, `${slot.date} ${slot.meal}: no list for ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
      `${slot.date}:${slot.meal}`, `diet-missed:${slot.date}:${slot.meal}`, now));
  }
  return n;
}

async function lockedList(t: Tx, listId: string): Promise<typeof dietMealLists.$inferSelect> {
  const list = (await t.select().from(dietMealLists).where(eq(dietMealLists.id, listId)).for("update"))[0];
  if (list === undefined) throw new DietRefusal("list_not_found", { listId });
  return list;
}

/** The kitchen confirmed the A4 list and the tray labels came out ("Printed OK?" on the screen). */
export async function markPrinted(db: Db, actor: Actor, listId: string, now: Date = new Date()): Promise<{ id: string; printedAt: string }> {
  await requirePermission(db, actor, DIET_KITCHEN);
  return db.transaction(async (t) => {
    const list = await lockedList(t, listId);
    // The first print is kept in `printed_at`; every print (a reprint of the changes) moves `last_printed_at` and clears
    // `changed_since_print`, which re-opens dispatch.
    await t.update(dietMealLists).set({
      printedAt: list.printedAt ?? now, printedBy: list.printedBy ?? actor.id, lastPrintedAt: now, changedSincePrint: false,
    }).where(eq(dietMealLists.id, list.id));
    return { id: list.id, printedAt: (list.printedAt ?? now).toISOString() };
  });
}

/** The trolley leaves: the list is dispatched and the ward's delivery task is raised on the engine. */
export async function dispatchList(db: Db, actor: Actor, listId: string, now: Date = new Date()): Promise<{ id: string; taskId: string }> {
  await requirePermission(db, actor, DIET_KITCHEN);
  return db.transaction(async (t) => {
    const list = await lockedList(t, listId);
    if (list.dispatchedAt !== null) throw new DietRefusal("list_already_dispatched", { listId });
    if (list.printedAt === null) throw new DietRefusal("list_not_printed", { listId });
    // Review item 1: the paper on the trolley must be the truth — a change after print waits for the reprint.
    if (list.changedSincePrint) throw new DietRefusal("list_changed_since_print", { listId });
    const due = list.serveAt.getTime() > now.getTime() ? new Date(list.serveAt.getTime() + 15 * 60_000) : new Date(now.getTime() + 30 * 60_000);
    const { task } = await raiseTask(t, DIET_ACTOR, {
      kind: DIET_TASK_KINDS.delivery, placeResourceId: list.wardId, sourceRef: `diet-list:${list.id}`, dueAt: due.toISOString(),
      note: `${list.meal} trolley`,
    }, now);
    await t.update(dietMealLists).set({ dispatchedAt: now, dispatchedBy: actor.id, deliveryTaskId: task.id }).where(eq(dietMealLists.id, list.id));
    // Review item 6: the load's task covers exactly the trays on this trolley.
    await t.update(dietMealLines).set({ onLoad: true }).where(and(eq(dietMealLines.listId, list.id), eq(dietMealLines.state, "active")));
    await appendEvent(t, dietListDispatched.make({ actor, correlationId: list.id, payload: { listId: list.id, wardId: list.wardId, taskId: task.id } }));
    return { id: list.id, taskId: task.id };
  });
}

/** DECIDED: two refused trays within 24 hours open a dietician consult. */
export const REFUSALS_FOR_CONSULT = 2;

/** One tray tapped at the bed: delivered or refused. */
export async function serveLine(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ id: string; served: string; consultOpened: boolean }> {
  await requirePermission(db, actor, DIET_SERVE);
  const input = parse(DIET_INTENTS.serve_line, raw);
  return db.transaction(async (t) => {
    const line = (await t.select().from(dietMealLines).where(eq(dietMealLines.id, input.lineId)).for("update"))[0];
    if (line === undefined) throw new DietRefusal("line_not_found", { lineId: input.lineId });
    if (line.state !== "active") throw new DietRefusal("line_withdrawn", { lineId: line.id, reason: line.withdrawnReason });
    const list = (await t.select().from(dietMealLists).where(eq(dietMealLists.id, line.listId)))[0]!;
    if (list.dispatchedAt === null) throw new DietRefusal("list_not_dispatched", { listId: list.id });
    await t.update(dietMealLines).set({ served: input.outcome, servedAt: now, servedBy: actor.id }).where(eq(dietMealLines.id, line.id));
    await appendEvent(t, dietTrayServed.make({
      actor, correlationId: line.admissionId, patientId: line.patientId,
      payload: { lineId: line.id, listId: list.id, admissionId: line.admissionId, outcome: input.outcome },
    }));
    let consultOpened = false;
    if (input.outcome === "refused") {
      const refused = (await t.select({ n: count() }).from(dietMealLines).where(and(
        eq(dietMealLines.admissionId, line.admissionId), eq(dietMealLines.served, "refused"),
        gte(dietMealLines.servedAt, new Date(now.getTime() - 86_400_000)),
      )))[0]?.n ?? 0;
      if (refused >= REFUSALS_FOR_CONSULT) {
        const ins = await t.insert(dietConsults).values({
          id: newId(), admissionId: line.admissionId, patientId: line.patientId, reason: `Refused ${String(refused)} meals in 24 h`,
          state: "open", source: "system", requestedBy: DIET_ACTOR.id, requestedAt: now,
        }).onConflictDoNothing().returning({ id: dietConsults.id });
        consultOpened = ins.length > 0;
      }
    }
    return { id: line.id, served: input.outcome, consultOpened };
  });
}

/** Lists of one meal of one day, by ward (for the board and the tests). */
export async function listsOfSlot(exec: Db | Tx, date: string, meal: DietMeal): Promise<(typeof dietMealLists.$inferSelect)[]> {
  return (exec as Db).select().from(dietMealLists).where(and(eq(dietMealLists.serviceDate, date), eq(dietMealLists.meal, meal)));
}

export async function linesOfLists(exec: Db | Tx, listIds: readonly string[]): Promise<(typeof dietMealLines.$inferSelect)[]> {
  if (listIds.length === 0) return [];
  return (exec as Db).select().from(dietMealLines).where(inArray(dietMealLines.listId, [...listIds])).orderBy(sql`${dietMealLines.bedCode} nulls last`);
}
