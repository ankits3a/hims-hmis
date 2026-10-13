import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { DIET_TASK_KINDS, newId } from "@hmis/contracts";
import { dietMealLines, dietMealLists, dietNpo, dietOrders } from "../../kernel/db/schema";
import { admissionPlace } from "../ipd";
import { raiseTask } from "../tasks";
import "./kinds";
import { DIET_ACTOR } from "./names";
import type { DietCode, DietPreference, DietWithdrawReason } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ THE TRAY RULES — one place decides what a patient gets for one meal ═══
 *
 * NPO ALWAYS WINS: a live NPO (not lifted, started at or before the meal's serve time, not ended by it) covering the
 * serve instant means NO TRAY, whatever the diet order says. Otherwise the live diet order's diet; no order → a normal
 * vegetarian tray, flagged `defaulted` so the ward and the dietician see it.
 *
 * `reconcileIn` is the ONE function every change goes through (an order, NPO set or lifted, an OT booking or its
 * cancellation, an admission, a transfer, a swap, the end of a stay): for the admission, every list still ahead
 * (not delivered, served no more than `OPEN_LIST_GRACE_MS` ago) is brought to the rules above — a tray in the wrong
 * ward is withdrawn and the ward it left is TOLD if its list was already printed; a tray an NPO now covers is withdrawn
 * and the ward told if printed; a patient missing from their ward's built list is added `late`. Idempotent: a second
 * delivery of the same event writes nothing.
 *
 * THE LIST LOCK: building takes `diet:lists` exclusively, every reconcile takes it shared — so an NPO committed while
 * a list is being built is either seen by the build or sees the built list. Never neither (the tray that slips through).
 */
export const OPEN_LIST_GRACE_MS = 2 * 3_600_000;
export const LISTS_LOCK = "diet:lists";

export type Tray = { code: DietCode; preference: DietPreference; tube: string | null; defaulted: boolean };

export async function lockAdmission(tx: Tx, admissionId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`diet:adm:${admissionId}`}))`);
}

export async function sharedListsLock(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${LISTS_LOCK}))`);
}

export async function exclusiveListsLock(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LISTS_LOCK}))`);
}

export function tubeWords(volumeMl: number | null, everyHours: number | null): string | null {
  return volumeMl === null || everyHours === null ? null : `${String(volumeMl)} ml every ${String(everyHours)} h`;
}

export async function liveOrderOf(exec: Db | Tx, admissionId: string): Promise<typeof dietOrders.$inferSelect | null> {
  return (await (exec as Db).select().from(dietOrders).where(and(eq(dietOrders.admissionId, admissionId), isNull(dietOrders.endedAt))))[0] ?? null;
}

/** The live NPO covering instant `at` for this patient, the earliest-started first. */
export async function npoCovering(exec: Db | Tx, patientId: string, at: Date): Promise<typeof dietNpo.$inferSelect | null> {
  return (await (exec as Db).select().from(dietNpo).where(and(
    eq(dietNpo.patientId, patientId), isNull(dietNpo.liftedAt), lte(dietNpo.startsAt, at),
    or(isNull(dietNpo.endsAt), gt(dietNpo.endsAt, at)),
  )).orderBy(dietNpo.startsAt).limit(1))[0] ?? null;
}

export async function trayFor(exec: Db | Tx, admissionId: string): Promise<Tray> {
  const o = await liveOrderOf(exec, admissionId);
  if (o === null) return { code: "normal", preference: "veg", tube: null, defaulted: true };
  return { code: o.code as DietCode, preference: o.preference as DietPreference, tube: tubeWords(o.tubeVolumeMl, o.tubeEveryHours), defaulted: false };
}

const END_REASON: Record<string, DietWithdrawReason> = {
  discharged: "discharged", lama: "lama", absconded: "absconded", deceased: "deceased", transferred_out: "transferred_out",
};

const MEAL_WORDS: Record<string, string> = { breakfast: "breakfast", lunch: "lunch", evening: "evening tea", dinner: "dinner" };

/** Tell a ward on the task engine (its own list changed after it was printed). One task per line and cause. */
export async function tellWard(
  tx: Tx, wardId: string, patientId: string, note: string, sourceRef: string, now: Date,
): Promise<void> {
  await raiseTask(tx, DIET_ACTOR, {
    kind: DIET_TASK_KINDS.wardNotice, placeResourceId: wardId, patientId, note: note.slice(0, 280), sourceRef, priority: "urgent",
  }, now);
}

export type ReconcileResult = { withdrawn: number; added: number; told: number };

/** Bring every list still ahead to the tray rules for this admission. Call inside the caller's transaction. */
export async function reconcileIn(tx: Tx, admissionId: string, now: Date): Promise<ReconcileResult> {
  const out: ReconcileResult = { withdrawn: 0, added: 0, told: 0 };
  await sharedListsLock(tx);
  const place = await admissionPlace(tx, admissionId);
  if (place === null) return out;
  const since = new Date(now.getTime() - OPEN_LIST_GRACE_MS);
  const mine = tx.select({ id: dietMealLines.listId }).from(dietMealLines).where(eq(dietMealLines.admissionId, admissionId));
  const lists = await tx.select().from(dietMealLists).where(and(
    isNull(dietMealLists.deliveredAt), gt(dietMealLists.serveAt, since),
    place.placed && place.wardId !== null ? or(eq(dietMealLists.wardId, place.wardId), inArray(dietMealLists.id, mine)) : inArray(dietMealLists.id, mine),
  )).orderBy(dietMealLists.serveAt);
  if (lists.length === 0) return out;
  const lines = await tx.select().from(dietMealLines).where(and(
    eq(dietMealLines.admissionId, admissionId), inArray(dietMealLines.listId, lists.map((l) => l.id)),
  ));
  const lineOf = new Map(lines.map((l) => [l.listId, l] as const));
  const tray = await trayFor(tx, admissionId);

  for (const list of lists) {
    const line = lineOf.get(list.id);
    const meal = MEAL_WORDS[list.meal] ?? list.meal;
    const here = place.placed && place.wardId === list.wardId;
    if (!here) {
      if (line === undefined || line.state !== "active") continue;
      const reason: DietWithdrawReason = place.ended ? (END_REASON[place.state] ?? "discharged") : "transferred";
      await tx.update(dietMealLines).set({ state: "withdrawn", withdrawnReason: reason, withdrawnAt: now }).where(eq(dietMealLines.id, line.id));
      out.withdrawn += 1;
      // DONE MEANS: a transfer after the list was printed updates the list AND tells the old ward.
      if (reason === "transferred" && list.printedAt !== null) {
        const to = place.wardName ?? "another ward";
        await tellWard(tx, list.wardId, place.patientId,
          `Bed ${line.bedCode ?? "?"}: patient moved to ${to}. Do not serve ${meal} here${list.dispatchedAt !== null ? " — take the tray back" : ""}.`,
          `diet-moved:${line.id}`, now);
        out.told += 1;
      }
      continue;
    }
    const npo = await npoCovering(tx, place.patientId, list.serveAt);
    if (line === undefined) {
      await tx.insert(dietMealLines).values({
        id: newId(), listId: list.id, admissionId, patientId: place.patientId, bedId: place.bedId, bedCode: place.bedCode,
        code: tray.code, preference: tray.preference, tube: tray.tube, defaulted: tray.defaulted, late: true,
        state: npo === null ? "active" : "withdrawn", withdrawnReason: npo === null ? null : "npo", withdrawnAt: npo === null ? null : now,
        createdAt: now,
      }).onConflictDoNothing();
      if (npo === null) out.added += 1;
      continue;
    }
    if (npo !== null && line.state === "active") {
      await tx.update(dietMealLines).set({ state: "withdrawn", withdrawnReason: "npo", withdrawnAt: now }).where(eq(dietMealLines.id, line.id));
      out.withdrawn += 1;
      if (list.printedAt !== null) {
        await tellWard(tx, list.wardId, place.patientId,
          `Bed ${line.bedCode ?? "?"}: NPO. Do not serve ${meal}${list.dispatchedAt !== null ? " — take the tray back" : ""}.`,
          `diet-npo:${line.id}:${npo.id}`, now);
        out.told += 1;
      }
      continue;
    }
    if (npo === null && line.state === "withdrawn") {
      await tx.update(dietMealLines).set({
        state: "active", withdrawnReason: null, withdrawnAt: null, late: true, bedId: place.bedId, bedCode: place.bedCode,
        code: tray.code, preference: tray.preference, tube: tray.tube, defaulted: tray.defaulted,
      }).where(eq(dietMealLines.id, line.id));
      out.added += 1;
      continue;
    }
    // Same ward, same state: keep the bed current; change the diet only while the trolley has not left.
    const bedMoved = line.bedId !== place.bedId;
    const dietMoved = list.dispatchedAt === null && line.state === "active"
      && (line.code !== tray.code || line.preference !== tray.preference || line.tube !== tray.tube || line.defaulted !== tray.defaulted);
    if (bedMoved || dietMoved) {
      await tx.update(dietMealLines).set({
        bedId: place.bedId, bedCode: place.bedCode,
        ...(dietMoved ? { code: tray.code, preference: tray.preference, tube: tray.tube, defaulted: tray.defaulted } : {}),
      }).where(eq(dietMealLines.id, line.id));
    }
  }
  return out;
}

export async function reconcileAdmission(db: Db, admissionId: string, now: Date = new Date()): Promise<ReconcileResult> {
  return db.transaction(async (t) => {
    await lockAdmission(t, admissionId);
    return reconcileIn(t, admissionId, now);
  });
}

/** The newest diet orders of an admission (the sheet's history). */
export async function ordersOf(exec: Db | Tx, admissionId: string, limit = 10): Promise<(typeof dietOrders.$inferSelect)[]> {
  return (exec as Db).select().from(dietOrders).where(eq(dietOrders.admissionId, admissionId)).orderBy(desc(dietOrders.startedAt)).limit(limit);
}
