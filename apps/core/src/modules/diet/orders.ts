import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { DIET_INTENTS, dietEntry, newId } from "@hmis/contracts";
import { dietConsults, dietMealRounds, dietNpo, dietOrders, ipdAdmissions, otCases } from "../../kernel/db/schema";
import { istDayString } from "../../kernel/approvals/cumulative";
import { caseState } from "../ot";
import { appendEvent } from "../../kernel/events/append";
import { IPD_PLACED_STATES, admissionPlace } from "../ipd";
import { DietRefusal } from "./errors";
import { dietConsultCompleted, dietConsultRequested, dietNpoLifted, dietNpoStarted, dietOrdered } from "./events";
import { holds, requirePermission, sourceOf } from "./guard";
import { DIET_ACTOR, DIET_MANAGE, DIET_NPO, DIET_ORDER } from "./names";
import { istDayStart, mealRounds, nextIstDate } from "./rounds";
import { liveOrderOf, lockAdmission, reconcileIn } from "./trays";
import { tellWardAndKitchen } from "./notices";
import type { Actor, DietIntentInput } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * THE PERSON'S DIET ACTS. Each: parse the contract's zod input → re-check the permission → lock the admission →
 * write with provenance → audit event → `reconcileIn` (the lists still ahead follow at once).
 *
 * WHO (DECIDED): a diet is ordered by a doctor or the dietician (`diet.order`); a nurse may set or lift NPO only
 * (`diet.npo`, a safety act) — asking a nurse's door for a diet answers `nurse_npo_only`. Ordering the catalogue's
 * "NPO" entry starts an NPO. A therapeutic diet ordered by a doctor opens a dietician consult.
 */
function parse<T>(schema: { safeParse: (x: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new DietRefusal("bad_input", { issues: r.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`) });
  return r.data;
}

async function placedOrRefuse(exec: Db | Tx, admissionId: string): Promise<NonNullable<Awaited<ReturnType<typeof admissionPlace>>>> {
  const place = await admissionPlace(exec, admissionId);
  if (place === null) throw new DietRefusal("admission_not_found", { admissionId });
  if (!place.placed) throw new DietRefusal("admission_not_placed", { admissionId, state: place.state });
  return place;
}

export type OrderResult = { kind: "order"; id: string } | { kind: "npo"; id: string };

export async function orderDiet(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<OrderResult> {
  const input = parse(DIET_INTENTS.order_diet, raw);
  if (!(await holds(db, actor, DIET_ORDER))) {
    if (input.code === "npo" && (await holds(db, actor, DIET_NPO))) {
      return { kind: "npo", id: await startNpo(db, actor, { admissionId: input.admissionId, reason: input.note ?? "NPO ordered" }, now) };
    }
    throw new DietRefusal((await holds(db, actor, DIET_NPO)) ? "nurse_npo_only" : "forbidden", { permission: DIET_ORDER });
  }
  if (input.code === "npo") {
    return { kind: "npo", id: await startNpo(db, actor, { admissionId: input.admissionId, reason: input.note ?? "NPO ordered" }, now) };
  }
  const entry = dietEntry(input.code);
  if (entry.tubeFeed && (input.tubeVolumeMl === undefined || input.tubeEveryHours === undefined)) {
    throw new DietRefusal("tube_feed_needs_volume");
  }
  const source = await sourceOf(db, actor);
  return db.transaction(async (t) => {
    await lockAdmission(t, input.admissionId);
    const place = await placedOrRefuse(t, input.admissionId);
    const prior = await liveOrderOf(t, input.admissionId);
    if (prior !== null) {
      await t.update(dietOrders).set({ endedAt: now, endedReason: "replaced" }).where(eq(dietOrders.id, prior.id));
    }
    const id = newId();
    await t.insert(dietOrders).values({
      id, admissionId: input.admissionId, patientId: place.patientId, code: input.code, preference: input.preference,
      tubeVolumeMl: entry.tubeFeed ? input.tubeVolumeMl! : null, tubeEveryHours: entry.tubeFeed ? input.tubeEveryHours! : null,
      note: input.note ?? null, startedAt: now, source, orderedBy: actor.id,
    });
    await appendEvent(t, dietOrdered.make({
      actor, correlationId: input.admissionId, patientId: place.patientId, occurredAt: now,
      payload: { orderId: id, admissionId: input.admissionId, code: input.code, source, replaces: prior?.id ?? null },
    }));
    if (entry.therapeutic && source === "doctor") {
      await openConsultIn(t, actor, { admissionId: input.admissionId, patientId: place.patientId, reason: `${entry.label} diet ordered`, source }, now);
    }
    await reconcileIn(t, input.admissionId, now);
    return { kind: "order" as const, id };
  });
}

export async function startNpo(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<string> {
  await requirePermission(db, actor, DIET_NPO);
  const input = parse(DIET_INTENTS.start_npo, raw);
  const startsAt = input.startsAt === undefined ? now : new Date(input.startsAt);
  const endsAt = input.endsAt === undefined ? null : new Date(input.endsAt);
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) throw new DietRefusal("npo_end_before_start");
  const source = await sourceOf(db, actor);
  return db.transaction(async (t) => {
    await lockAdmission(t, input.admissionId);
    const place = await placedOrRefuse(t, input.admissionId);
    const id = newId();
    await t.insert(dietNpo).values({
      id, patientId: place.patientId, admissionId: input.admissionId, startsAt, endsAt, reason: input.reason, source,
      setBy: actor.id, setAt: now,
    });
    await appendEvent(t, dietNpoStarted.make({
      actor, correlationId: input.admissionId, patientId: place.patientId, occurredAt: now,
      payload: {
        npoId: id, patientId: place.patientId, admissionId: input.admissionId, startsAt: startsAt.toISOString(),
        endsAt: endsAt?.toISOString() ?? null, source, sourceRef: null,
      },
    }));
    await reconcileIn(t, input.admissionId, now);
    return id;
  });
}

/** Who acts for an OT booking (the NPO it sets, the lift its cancellation makes). */
const OT_ACTOR: Actor = { type: "system", id: "diet-ot-booking" };

/** The patient's placed admission, if any (an OT booking names a patient, not an admission). */
async function placedAdmissionOf(exec: Db | Tx, patientId: string): Promise<string | null> {
  const row = (await (exec as Db).select({ id: ipdAdmissions.id }).from(ipdAdmissions)
    .where(and(eq(ipdAdmissions.patientId, patientId), inArray(ipdAdmissions.state, [...IPD_PLACED_STATES]))).limit(1))[0];
  return row?.id ?? null;
}

async function liftIn(t: Tx, actor: Actor, npo: typeof dietNpo.$inferSelect, reason: string, now: Date): Promise<{ admissionId: string | null; told: number }> {
  const source = await sourceOf(t, actor);
  await t.update(dietNpo).set({ liftedAt: now, liftedBy: actor.id, liftReason: reason }).where(eq(dietNpo.id, npo.id));
  await appendEvent(t, dietNpoLifted.make({
    actor, correlationId: npo.admissionId ?? npo.patientId, patientId: npo.patientId, occurredAt: now,
    payload: { npoId: npo.id, patientId: npo.patientId, source: actor.id === OT_ACTOR.id ? "ot_booking" : source },
  }));
  const admissionId = npo.admissionId ?? (await placedAdmissionOf(t, npo.patientId));
  let told = 0;
  if (admissionId !== null) {
    await lockAdmission(t, admissionId);
    told = (await reconcileIn(t, admissionId, now, `${reason} — NPO lifted`)).told;
  }
  return { admissionId, told };
}

export async function liftNpo(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ id: string }> {
  await requirePermission(db, actor, DIET_NPO);
  const input = parse(DIET_INTENTS.lift_npo, raw);
  return db.transaction(async (t) => {
    const npo = (await t.select().from(dietNpo).where(eq(dietNpo.id, input.npoId)).for("update"))[0];
    if (npo === undefined) throw new DietRefusal("npo_not_found", { npoId: input.npoId });
    if (npo.liftedAt !== null || (npo.endsAt !== null && npo.endsAt.getTime() <= now.getTime())) throw new DietRefusal("npo_not_live", { npoId: npo.id });
    await liftIn(t, actor, npo, input.reason, now);
    return { id: npo.id };
  });
}

// ─────────────────────────────────────────── OT ───────────────────────────────────────────


/**
 * An OT booking for `listDate` → NPO from 00:00 IST that day to the end of that IST day (DECIDED: the surgeon's
 * post-op order resumes the diet; a day-end bound means a forgotten NPO cannot starve a patient for days). ONE row per
 * case (`source_ref`): a redelivery with the same date writes nothing; the same case on a NEW date (a rebooking, a
 * postponement seen by the list sync) or a lifted row brought back moves that row to the new window — the row is
 * replaced in place, never duplicated. A patient already on a bed has the lists still ahead fixed now.
 */
export async function npoForOtBooking(
  db: Db, input: { caseId: string; patientId: string; listDate: string }, now: Date = new Date(),
): Promise<string | null> {
  return db.transaction(async (t) => {
    const admissionId = await placedAdmissionOf(t, input.patientId);
    if (admissionId !== null) await lockAdmission(t, admissionId);
    const sourceRef = `ot-case:${input.caseId}`;
    const startsAt = istDayStart(input.listDate);
    const endsAt = istDayStart(nextIstDate(input.listDate));
    const reason = `OT booked for ${input.listDate}`;
    const prior = (await t.select().from(dietNpo).where(eq(dietNpo.sourceRef, sourceRef)).for("update"))[0];
    let id: string;
    if (prior === undefined) {
      id = newId();
      const ins = await t.insert(dietNpo).values({
        id, patientId: input.patientId, admissionId, startsAt, endsAt, reason, source: "ot_booking", sourceRef, setBy: OT_ACTOR.id, setAt: now,
      }).onConflictDoNothing().returning({ id: dietNpo.id });
      if (ins.length === 0) return null;
    } else {
      if (prior.liftedAt === null && prior.startsAt.getTime() === startsAt.getTime()) return null;
      id = prior.id;
      await t.update(dietNpo).set({
        startsAt, endsAt, reason, admissionId: admissionId ?? prior.admissionId, setAt: now, liftedAt: null, liftedBy: null, liftReason: null,
      }).where(eq(dietNpo.id, prior.id));
    }
    await appendEvent(t, dietNpoStarted.make({
      actor: OT_ACTOR, correlationId: admissionId ?? input.patientId, patientId: input.patientId, occurredAt: now,
      payload: {
        npoId: id, patientId: input.patientId, admissionId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
        source: "ot_booking", sourceRef,
      },
    }));
    if (admissionId !== null) await reconcileIn(t, admissionId, now);
    return id;
  });
}

/** The OT case was cancelled: its NPO lifts, the lists follow, and the patient's ward (and the kitchen) are told. */
export async function liftOtNpo(db: Db, caseId: string, now: Date = new Date()): Promise<string | null> {
  return db.transaction(async (t) => {
    const npo = (await t.select().from(dietNpo).where(eq(dietNpo.sourceRef, `ot-case:${caseId}`)).for("update"))[0];
    if (npo === undefined || npo.liftedAt !== null) return null;
    const { admissionId, told } = await liftIn(t, OT_ACTOR, npo, "OT cancelled", now);
    // A printed list that changed has already told the ward and the kitchen (`reconcileIn`); otherwise say it once here.
    if (admissionId !== null && told === 0 && (npo.endsAt === null || npo.endsAt.getTime() > now.getTime())) {
      const place = await admissionPlace(t, admissionId);
      if (place?.placed === true && place.wardId !== null) {
        await tellWardAndKitchen(t, {
          wardId: place.wardId, wardName: place.wardName ?? "ward", bedCode: place.bedCode, admissionId, patientId: place.patientId,
          meal: "next meal", words: "OT cancelled — NPO lifted; diet as ordered", key: `npo-lift:${npo.id}:${String(now.getTime())}`,
        }, now);
      }
    }
    return npo.id;
  });
}

/**
 * THE OT SYNC. Diet re-reads the CASES: one case on `case.postponed` (2026-10-14 — before it, `postponeCase` wrote the
 * new `list_date` and emitted nothing), that day's cases on `list.published`, and at deploy (`workerBackfills`) every
 * case from today on (`list.resequenced` only re-orders a day). A live case gets its NPO for its CURRENT date (the
 * row moves if the date moved); a cancelled one has its NPO lifted. Idempotent.
 */
export async function syncOtNpo(db: Db, q: { listDate?: string; fromDate?: string; caseId?: string }, now: Date = new Date()): Promise<number> {
  const where = q.caseId !== undefined ? eq(otCases.id, q.caseId)
    : q.listDate !== undefined ? eq(otCases.listDate, q.listDate) : gte(otCases.listDate, q.fromDate ?? istDayString(now));
  const cases = await db.select({ id: otCases.id, patientId: otCases.patientId, listDate: otCases.listDate }).from(otCases).where(where);
  let n = 0;
  for (const c of cases) {
    const state = await caseState(db, c.id);
    if (state === "cancelled") {
      if ((await liftOtNpo(db, c.id, now)) !== null) n += 1;
    } else if ((await npoForOtBooking(db, { caseId: c.id, patientId: c.patientId, listDate: c.listDate }, now)) !== null) n += 1;
  }
  return n;
}

// ─────────────────────────────────────────── consults ───────────────────────────────────────────

async function openConsultIn(
  t: Tx, actor: Actor, c: { admissionId: string; patientId: string; reason: string; source: string }, now: Date,
): Promise<string | null> {
  const id = newId();
  const ins = await t.insert(dietConsults).values({
    id, admissionId: c.admissionId, patientId: c.patientId, reason: c.reason, state: "open", source: c.source,
    requestedBy: actor.id, requestedAt: now,
  }).onConflictDoNothing().returning({ id: dietConsults.id });
  if (ins.length === 0) return null;
  await appendEvent(t, dietConsultRequested.make({
    actor, correlationId: c.admissionId, patientId: c.patientId, occurredAt: now,
    payload: { consultId: id, admissionId: c.admissionId, source: c.source as "doctor" },
  }));
  return id;
}

export async function requestConsult(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ id: string }> {
  if (!(await holds(db, actor, DIET_ORDER)) && !(await holds(db, actor, DIET_NPO))) throw new DietRefusal("forbidden", { permission: DIET_ORDER });
  const input = parse(DIET_INTENTS.request_consult, raw);
  const source = await sourceOf(db, actor);
  return db.transaction(async (t) => {
    await lockAdmission(t, input.admissionId);
    const place = await placedOrRefuse(t, input.admissionId);
    const id = await openConsultIn(t, actor, { admissionId: input.admissionId, patientId: place.patientId, reason: input.reason, source }, now);
    if (id === null) throw new DietRefusal("consult_open", { admissionId: input.admissionId });
    return { id };
  });
}

export async function completeConsult(db: Db, actor: Actor, raw: unknown, now: Date = new Date()): Promise<{ id: string }> {
  await requirePermission(db, actor, DIET_MANAGE);
  const input = parse(DIET_INTENTS.complete_consult, raw);
  return db.transaction(async (t) => {
    const done = await t.update(dietConsults).set({ state: "done", closedBy: actor.id, closedAt: now, note: input.note })
      .where(and(eq(dietConsults.id, input.consultId), eq(dietConsults.state, "open")))
      .returning({ id: dietConsults.id, admissionId: dietConsults.admissionId, patientId: dietConsults.patientId });
    const row = done[0];
    if (row === undefined) throw new DietRefusal("consult_not_found", { consultId: input.consultId });
    await appendEvent(t, dietConsultCompleted.make({
      actor, correlationId: row.admissionId, patientId: row.patientId, occurredAt: now, payload: { consultId: row.id, admissionId: row.admissionId },
    }));
    return { id: row.id };
  });
}

// ─────────────────────────────────────────── settings ───────────────────────────────────────────

export async function setMealRound(db: Db, actor: Actor, raw: DietIntentInput<"set_meal_round"> | unknown, now: Date = new Date()): Promise<void> {
  await requirePermission(db, actor, DIET_MANAGE);
  const input = parse(DIET_INTENTS.set_meal_round, raw);
  if (input.cutoffMinute >= input.serveMinute) throw new DietRefusal("cutoff_after_serve");
  // Review item 11: the four rounds run in order and do not overlap — each serve is at or before the next cut-off.
  const rounds = (await mealRounds(db)).map((r) => (r.meal === input.meal ? { ...r, cutoffMinute: input.cutoffMinute, serveMinute: input.serveMinute } : r));
  for (let i = 1; i < rounds.length; i += 1) {
    if (rounds[i - 1]!.serveMinute > rounds[i]!.cutoffMinute) throw new DietRefusal("rounds_overlap", { before: rounds[i - 1]!.meal, after: rounds[i]!.meal });
  }
  await db.insert(dietMealRounds).values({ meal: input.meal, cutoffMinute: input.cutoffMinute, serveMinute: input.serveMinute, updatedBy: actor.id, updatedAt: now })
    .onConflictDoUpdate({ target: dietMealRounds.meal, set: { cutoffMinute: input.cutoffMinute, serveMinute: input.serveMinute, updatedBy: actor.id, updatedAt: now } });
}

// ─────────────────────────────────────────── the stay ends ───────────────────────────────────────────

/**
 * Discharge, LAMA, absconding, death, refer-out: the live order ends, the admission's own NPOs are lifted, an open
 * consult is cancelled, and every list still ahead loses the tray (`reconcileIn` reads the ended state).
 */
export async function endStay(db: Db, admissionId: string, now: Date = new Date()): Promise<void> {
  await db.transaction(async (t) => {
    await lockAdmission(t, admissionId);
    const place = await admissionPlace(t, admissionId);
    if (place === null || !place.ended) return;
    await t.update(dietOrders).set({ endedAt: now, endedReason: place.state }).where(and(eq(dietOrders.admissionId, admissionId), isNull(dietOrders.endedAt)));
    // Review item 10: also the patient's NPOs written before the admission existed (admission id null).
    await t.update(dietNpo).set({ liftedAt: now, liftedBy: DIET_ACTOR.id, liftReason: `stay ended (${place.state})` })
      .where(and(or(eq(dietNpo.admissionId, admissionId), and(isNull(dietNpo.admissionId), eq(dietNpo.patientId, place.patientId))), isNull(dietNpo.liftedAt), sql`(${dietNpo.endsAt} is null or ${dietNpo.endsAt} > ${now.toISOString()}::timestamptz)`));
    await t.update(dietConsults).set({ state: "cancelled", closedBy: DIET_ACTOR.id, closedAt: now, note: `stay ended (${place.state})` })
      .where(and(eq(dietConsults.admissionId, admissionId), eq(dietConsults.state, "open")));
    await reconcileIn(t, admissionId, now);
  });
}
