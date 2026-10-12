import { and, asc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { IPD_BED_CLASS_INFO, IPD_INTENTS, IPD_RESERVATION_HOLD_MINUTES, ipdIsInFuture, newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { ipdBedBlocks, ipdBedReservations, ipdBedStays, resources } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import {
  KERNEL_RESOURCE_KINDS, assignResource, changeResourceStatus, releaseResource, retireResource, updateResource,
} from "../../kernel/resources";
import { withIdempotency } from "../billing";
import { getPatientSummaries } from "../patients";
import { IpdBedAttributesSchema } from "./bed-attributes";
import { linkPlacement, linkReservation, linkReservationEnded } from "./admission-core";
import {
  bedAssigned, bedBlocked, bedCleaned, bedIncumbentReleased, bedOccupied, bedReservationReleased, bedReserved,
  bedUnblocked,
} from "./bed-events";
import { ageInYears, checkBedRules, placementGender } from "./bed-rules";
import { IpdError, IpdRefusal } from "./errors";
import { IPD_BEDS_CLEAN, IPD_BEDS_MANAGE, IPD_BEDS_OVERFLOW } from "./manifest";
import type { Actor, IpdBedClass, IpdBedNeed, IpdIntentName } from "@hmis/contracts";
import type { z } from "zod";
import type { Db, Tx } from "../../kernel/db/client";
import type { IpdBedAttributes } from "./bed-attributes";
import type { BedRulePatient } from "./bed-rules";

/**
 * E1.1 (#718) — THE BED INTENTS (spec SPEC-ipd-core §4.1; contracts `packages/contracts/src/ipd/intents-admit.ts`).
 *
 * Each intent is ONE module function: it parses the contract's zod input, re-checks the actor's permission (the
 * route guard is not the only door — the copilot and later agents call these too), runs under the contract's
 * idempotency key (a retried request acts once), takes the bed's row lock, re-checks state and the bed rules
 * (`bed-rules.ts`), and refuses with a contract code, its rule and its fix (`IpdRefusal`).
 *
 * The bed's kernel status stays in the kernel's vocabulary (available, occupied, cleaning, blocked, retired). A
 * reservation and a block live in IPD's own tables; the board overlays them. Lock order is ROOM, then BED, then
 * IPD rows, everywhere, so two acts never wait on each other in a circle.
 */

const OCCUPANT_ADMISSION = "ipd_admission";
const OCCUPANT_INCUMBENT = "incumbent";
/** G3 reads these reasons on a bed's move into cleaning (`goals/goal-events.ts` IPD_GOAL_CLEAN_REASONS). */
const CLEAN_ROUTINE = "clean:routine";
const CLEAN_TERMINAL = "clean:terminal";
/** The 48-hour billed-class protection when the booked class is full (§4.2). */
const PROTECT_HOURS = 48;

export const IPD_SYSTEM_ACTOR: Actor = { type: "system", id: "ipd-reservation-lapse" };

type BedRow = typeof resources.$inferSelect;
type Input<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["input"]>;
type Output<N extends IpdIntentName> = z.infer<(typeof IPD_INTENTS)[N]["output"]>;
type Opts = { now?: Date };

function provenanceOf(actor: Actor): "person" | "agent" | "system" {
  if (actor.type === "agent") return "agent";
  if (actor.type === "system") return "system";
  return "person";
}

async function holds(db: Db, actor: Actor, permission: string): Promise<boolean> {
  if (actor.type === "system") return true;
  return hasPermission(db, actor.id, permission, "hospital");
}

async function requirePermission(db: Db, actor: Actor, permission: string): Promise<void> {
  if (!(await holds(db, actor, permission))) {
    throw new IpdError("ipd_forbidden", `this act needs the permission ${permission}`, { permission });
  }
}

/** The contract's idempotency key scopes the act: a retry with the same key and body answers the first result. */
function once<T>(db: Db, actor: Actor, intent: IpdIntentName, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${intent}`, key: key.toLowerCase() }, body, work, now);
}

function bedAttributes(row: BedRow): IpdBedAttributes | null {
  if (row.kind !== "bed") return null;
  const parsed = IpdBedAttributesSchema.safeParse(row.attributes);
  return parsed.success ? parsed.data : null;
}

function isIncumbent(row: BedRow): boolean {
  return row.attributes.incumbent === true && row.occupantType === OCCUPANT_INCUMBENT;
}

type LockedBed = { row: BedRow; attrs: IpdBedAttributes; roomId: string | null };

/**
 * Locks the bed's twin-share ROOM (when it has one) and then the bed. The room lock serialises two placements into
 * one room, so "the first occupant fixes the room's gender" holds even when two desks fill its two beds at once.
 */
async function lockBed(tx: Tx, bedId: string): Promise<LockedBed> {
  const peek = (await tx.select({ parentId: resources.parentId, kind: resources.kind }).from(resources)
    .where(eq(resources.id, bedId)))[0];
  if (peek === undefined || peek.kind !== "bed") throw new IpdRefusal("bed_not_found");
  let roomId: string | null = null;
  if (peek.parentId !== null) {
    const parent = (await tx.select({ id: resources.id, kind: resources.kind }).from(resources)
      .where(eq(resources.id, peek.parentId)).for("update"))[0];
    if (parent?.kind === "room") roomId = parent.id;
  }
  const row = (await tx.select().from(resources).where(eq(resources.id, bedId)).for("update"))[0];
  const attrs = row === undefined ? null : bedAttributes(row);
  if (row === undefined || attrs === null) throw new IpdRefusal("bed_not_found");
  return { row, attrs, roomId };
}

async function liveReservation(tx: Tx, bedId: string) {
  return (await tx.select().from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.bedId, bedId), eq(ipdBedReservations.status, "active"))))[0];
}

async function liveBlock(tx: Tx, bedId: string) {
  return (await tx.select().from(ipdBedBlocks)
    .where(and(eq(ipdBedBlocks.bedId, bedId), inArray(ipdBedBlocks.status, ["pending_release", "active"]))))[0];
}

/** The patient's facts the rules read. Merged records resolve to the survivor. */
async function patientFacts(db: Db, actor: Actor, patientId: string, at: Date): Promise<BedRulePatient & { id: string }> {
  const [p] = await getPatientSummaries(db, actor, [patientId]);
  if (p === undefined) throw new IpdRefusal("patient_not_found");
  const g = p.administrativeGender;
  const gender = g === "male" || g === "female" || g === "other" ? g : "unknown";
  return { id: p.id, gender, ageYears: ageInYears(p.dob, at) };
}

/**
 * The twin-share room's gender: the gender of its earliest occupant or holder (an open stay, an active reservation,
 * or an incumbent bed that recorded one). Null when the room is empty. Called with the room locked.
 */
async function roomGender(tx: Tx, roomId: string | null, bedId: string): Promise<"male" | "female" | "unknown" | null> {
  if (roomId === null) return null;
  const siblings = await tx.select().from(resources)
    .where(and(eq(resources.parentId, roomId), eq(resources.kind, "bed"), ne(resources.id, bedId)));
  if (siblings.length === 0) return null;
  const ids = siblings.map((s) => s.id);
  const holders: { at: Date; gender: "male" | "female" | "unknown" }[] = [];
  const known = (g: unknown): "male" | "female" | "unknown" => (g === "male" || g === "female" ? g : "unknown");
  // An incumbent with no recorded gender is a holder too: the room is "unknown" until someone records it.
  for (const s of siblings) if (isIncumbent(s)) holders.push({ at: s.since ?? new Date(0), gender: known(s.attributes.incumbentGender) });
  const stays = await tx.select().from(ipdBedStays).where(and(inArray(ipdBedStays.bedId, ids), isNull(ipdBedStays.endedAt)));
  for (const s of stays) holders.push({ at: s.startedAt, gender: known(s.placedAs) });
  const holds_ = await tx.select().from(ipdBedReservations)
    .where(and(inArray(ipdBedReservations.bedId, ids), eq(ipdBedReservations.status, "active")));
  for (const r of holds_) holders.push({ at: r.reservedAt, gender: known(r.placedAs) });
  holders.sort((a, b) => a.at.getTime() - b.at.getTime());
  return holders[0]?.gender ?? null;
}

/** Serialises every act on one admission (one bed per admission), taken before the room and bed locks. */
async function lockAdmission(tx: Tx, admissionId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ipd_admission:${admissionId}`}))`);
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

/** A live hold whose time has passed is lapsed here and now, even if the minute job has not run yet. */
async function currentHold(tx: Tx, bed: BedRow, at: Date) {
  const held = await liveReservation(tx, bed.id);
  if (held === undefined || held.expiresAt.getTime() > at.getTime()) return held;
  await endReservation(tx, IPD_SYSTEM_ACTOR, held, bed.code, "lapsed", at);
  return undefined;
}

function notAvailableRule(row: BedRow): string {
  if (isIncumbent(row)) return "Held by the old system";
  if (row.occupantRef !== null) return "Bed is occupied";
  if (row.status === "cleaning") return "Bed is being cleaned";
  if (row.status === "blocked") return "Bed is blocked";
  return "Bed is not free";
}

/**
 * §4.1 edge: "bed just taken" answers with the next three rule-valid beds — same ward first, then the hospital.
 * Read outside the refused transaction, so it shows what is free now.
 */
export async function nextRuleValidBeds(
  db: Db, actor: Actor,
  args: { bedId: string; patientId: string; need: IpdBedNeed; classChange?: "upgrade" | "downgrade"; at: Date },
): Promise<{ bedId: string; code: string }[]> {
  const patient = await patientFacts(db, actor, args.patientId, args.at);
  const mayUseOverflow = await holds(db, actor, IPD_BEDS_OVERFLOW);
  const asked = (await db.select().from(resources).where(eq(resources.id, args.bedId)))[0];
  const free = await db.select().from(resources)
    .where(and(eq(resources.kind, "bed"), eq(resources.status, "available"), isNull(resources.occupantRef), ne(resources.id, args.bedId)))
    .orderBy(asc(resources.code));
  const reserved = new Set((await db.select({ bedId: ipdBedReservations.bedId }).from(ipdBedReservations)
    .where(eq(ipdBedReservations.status, "active"))).map((r) => r.bedId));
  const sameWard = (b: BedRow): number => (asked !== undefined && b.parentId === asked.parentId ? 0 : 1);
  const candidates = free.filter((b) => !reserved.has(b.id)).sort((a, b) => sameWard(a) - sameWard(b));
  const out: { bedId: string; code: string }[] = [];
  for (const b of candidates) {
    const attrs = bedAttributes(b);
    if (attrs === null) continue;
    // Room gender is not re-derived per candidate here: a proposal, not an act — the act re-checks it under lock.
    const breach = checkBedRules({ code: b.code, attributes: attrs }, patient, args.need, args.classChange, { roomGender: null, mayUseOverflow });
    if (breach !== null) continue;
    out.push({ bedId: b.id, code: b.code });
    if (out.length === 3) break;
  }
  return out;
}

const EQUIPMENT_WORDS: Record<string, string> = {
  monitor: "Monitor", ventilator_ready: "Ventilator ready", oxygen_point: "Oxygen point", suction: "Suction", infusion_pumps: "Infusion pumps",
};
const GENDER_WORDS: Record<string, string> = { male: "Male bay", female: "Female bay", any: "Any gender", paediatric: "Paediatric" };

/**
 * E1.2 — the Admit sheet's "top three beds" (§4.9 B): free, unheld, rule-valid beds of the requested class, the
 * admission's own held bed first, then by code; each with its reasons in words. A proposal, not an act: the act
 * re-checks every rule under lock. `freeByClass` counts the rule-valid free beds per class for the class cards.
 */
export async function proposeBeds(
  db: Db, actor: Actor, args: { patientId: string; need: IpdBedNeed; at: Date; heldBedId?: string | null; limit?: number },
): Promise<{ beds: { bedId: string; code: string; wardName: string | null; class: IpdBedClass; reasons: string[] }[]; freeByClass: Record<string, number> }> {
  const patient = await patientFacts(db, actor, args.patientId, args.at);
  const mayUseOverflow = await holds(db, actor, IPD_BEDS_OVERFLOW);
  const free = await db.select().from(resources)
    .where(and(eq(resources.kind, "bed"), eq(resources.status, "available"), isNull(resources.occupantRef)))
    .orderBy(asc(resources.code));
  const holdsRows = await db.select({ bedId: ipdBedReservations.bedId }).from(ipdBedReservations).where(eq(ipdBedReservations.status, "active"));
  const reserved = new Set(holdsRows.map((r) => r.bedId).filter((b) => b !== args.heldBedId));
  const parents = new Map((await db.select({ id: resources.id, name: resources.name, kind: resources.kind, parentId: resources.parentId })
    .from(resources).where(inArray(resources.kind, ["ward", "hall", "room"]))).map((r) => [r.id, r] as const));
  const wardOf = (b: BedRow): string | null => {
    let p = b.parentId === null ? undefined : parents.get(b.parentId);
    if (p?.kind === "room") p = p.parentId === null ? undefined : parents.get(p.parentId);
    return p?.name ?? null;
  };
  const freeByClass: Record<string, number> = {};
  const beds: { bedId: string; code: string; wardName: string | null; class: IpdBedClass; reasons: string[] }[] = [];
  const ordered = [...free].sort((a, b) => (a.id === args.heldBedId ? -1 : b.id === args.heldBedId ? 1 : 0));
  for (const b of ordered) {
    if (reserved.has(b.id)) continue;
    const attrs = bedAttributes(b);
    if (attrs === null) continue;
    const icuNeed = { ...args.need, requestedClass: attrs.class, icu: attrs.icu };
    if (checkBedRules({ code: b.code, attributes: attrs }, patient, icuNeed, undefined, { roomGender: null, mayUseOverflow }) === null) {
      freeByClass[attrs.class] = (freeByClass[attrs.class] ?? 0) + 1;
    }
    if (beds.length >= (args.limit ?? 3)) continue;
    if (checkBedRules({ code: b.code, attributes: attrs }, patient, args.need, undefined, { roomGender: null, mayUseOverflow }) !== null) continue;
    const reasons = [GENDER_WORDS[attrs.genderRule] ?? attrs.genderRule, ...attrs.equipment.map((e) => EQUIPMENT_WORDS[e] ?? e)];
    if (attrs.isolation !== "none") reasons.push(`Isolation: ${attrs.isolation}`);
    if (b.id === args.heldBedId) reasons.unshift("Held for this patient");
    beds.push({ bedId: b.id, code: b.code, wardName: wardOf(b), class: attrs.class, reasons });
  }
  return { beds, freeByClass };
}

async function withNextBeds<T>(
  db: Db, actor: Actor, args: Parameters<typeof nextRuleValidBeds>[2], work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof IpdRefusal && e.code === "bed_not_available") {
      const nextBeds = await nextRuleValidBeds(db, actor, args);
      throw new IpdRefusal(e.code, e.bedRule, { ...(e.detail ?? {}), nextBeds });
    }
    throw e;
  }
}

/** Ends a live reservation inside the caller's transaction (the reservation row is locked by the update). */
async function endReservation(
  tx: Tx, actor: Actor, r: typeof ipdBedReservations.$inferSelect, bedCode: string,
  reason: "plan_changed" | "lapsed" | "bed_unsuitable" | "other", at: Date,
): Promise<void> {
  const status = reason === "lapsed" ? "lapsed" : "released";
  await tx.update(ipdBedReservations)
    .set({ status, endedBy: actor.id, endedAt: at, endReason: reason })
    .where(eq(ipdBedReservations.id, r.id));
  await appendEvent(tx, bedReservationReleased.make({
    payload: { reservationId: r.id, bedId: r.bedId, bedCode, admissionId: r.admissionId, reason, provenance: provenanceOf(actor) },
    actor, correlationId: r.admissionId, patientId: r.patientId, occurredAt: at,
  }));
}

/** An admission holds one bed at a time: a new hold or placement elsewhere ends its other live reservation. */
async function endOtherReservations(tx: Tx, actor: Actor, admissionId: string, keepBedId: string, at: Date): Promise<void> {
  const others = await tx.select().from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.admissionId, admissionId), eq(ipdBedReservations.status, "active"), ne(ipdBedReservations.bedId, keepBedId)))
    .for("update");
  for (const r of others) {
    const code = (await tx.select({ code: resources.code }).from(resources).where(eq(resources.id, r.bedId)))[0]?.code ?? r.bedId;
    await endReservation(tx, actor, r, code, "plan_changed", at);
  }
}

// ═══════════════════════════════════════════ reserve_bed ═══════════════════════════════════════════

/**
 * Holds a bed for two hours (§4.1). DECIDED (E1.1): an available OR cleaning bed may be held — the desk holds the
 * bed being cleaned for the patient who will lie in it; assignment still waits for it to be clean.
 */
export async function reserveBed(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"reserve_bed">> {
  const input: Input<"reserve_bed"> = IPD_INTENTS.reserve_bed.input.parse(raw);
  await requirePermission(db, actor, IPD_BEDS_MANAGE);
  const at = opts.now ?? new Date();
  return once(db, actor, "reserve_bed", input.idempotencyKey, input, () => withNextBeds(db, actor, { ...input, at }, async () => {
    const patient = await patientFacts(db, actor, input.patientId, at);
    const mayUseOverflow = await holds(db, actor, IPD_BEDS_OVERFLOW);
    return withTx(db, async (tx) => {
      await lockAdmission(tx, input.admissionId);
      const { row, attrs, roomId } = await lockBed(tx, input.bedId);
      if (row.status === "retired") throw new IpdRefusal("bed_retired", "Retired bed");
      const held = await currentHold(tx, row, at);
      if (held !== undefined) {
        throw new IpdRefusal("bed_not_available", "Bed is reserved", { reservationId: held.id, expiresAt: held.expiresAt.toISOString() });
      }
      if (row.occupantRef !== null || (row.status !== "available" && row.status !== "cleaning")) {
        throw new IpdRefusal("bed_not_available", notAvailableRule(row));
      }
      if (await liveBlock(tx, row.id) !== undefined) throw new IpdRefusal("bed_not_available", "Bed is blocked");
      const breach = checkBedRules({ code: row.code, attributes: attrs }, patient, input.need, input.classChange, {
        roomGender: await roomGender(tx, roomId, row.id), mayUseOverflow,
      });
      if (breach !== null) throw new IpdRefusal(breach.code, breach.bedRule);

      await endOtherReservations(tx, actor, input.admissionId, row.id, at);
      const reservationId = newId();
      const expiresAt = new Date(at.getTime() + IPD_RESERVATION_HOLD_MINUTES * 60_000);
      await tx.insert(ipdBedReservations).values({
        id: reservationId, bedId: row.id, admissionId: input.admissionId, patientId: patient.id, status: "active",
        reservedBy: actor.id, reservedAt: at, expiresAt, placedAs: placementGender(patient, input.need),
      });
      await appendEvent(tx, bedReserved.make({
        payload: {
          reservationId, bedId: row.id, bedCode: row.code, admissionId: input.admissionId, patientId: patient.id,
          expiresAt: expiresAt.toISOString(), provenance: provenanceOf(actor),
        },
        actor, correlationId: input.admissionId, patientId: patient.id, occurredAt: at,
      }));
      // E1.2: on a real admission the hold moves it requested → reserved (and checks the caller's copy of it).
      await linkReservation(tx, actor, { admissionId: input.admissionId, patientId: patient.id, need: input.need, bedId: row.id, reservationId }, at);
      return { reservationId, bedId: row.id, state: "reserved" as const, expiresAt: expiresAt.toISOString() };
    });
  }), at);
}

// ═══════════════════════════════════════ release_reservation ═══════════════════════════════════════

async function releaseReservationCore(
  db: Db, actor: Actor, input: { reservationId: string; reason: "plan_changed" | "lapsed" | "bed_unsuitable" | "other" }, at: Date,
): Promise<Output<"release_reservation">> {
  return withTx(db, async (tx) => {
    const peek = (await tx.select().from(ipdBedReservations).where(eq(ipdBedReservations.id, input.reservationId)))[0];
    if (peek === undefined) throw new IpdRefusal("reservation_not_found");
    const { row } = await lockBed(tx, peek.bedId);
    const r = (await tx.select().from(ipdBedReservations).where(eq(ipdBedReservations.id, input.reservationId)).for("update"))[0]!;
    if (r.status !== "active") throw new IpdRefusal("reservation_ended", undefined, { status: r.status });
    // The lapse job only ends what has actually lapsed: a reservation renewed or re-read late is never cut short.
    if (input.reason === "lapsed" && r.expiresAt.getTime() > at.getTime()) throw new IpdRefusal("reservation_ended");
    await endReservation(tx, actor, r, row.code, input.reason, at);
    // E1.2: a real admission with no other live hold goes reserved → requested (§0B: the lapse's edge). A request id
    // with no admission row is reported back at `requested`, as E1.1 did.
    const admissionState = await linkReservationEnded(tx, actor, r.admissionId, at);
    return { bedId: row.id, bedStatus: row.status as Output<"release_reservation">["bedStatus"], admissionState };
  });
}

/** A person releases a hold (or the lapse job does, as the system actor, with reason `lapsed`). */
export async function releaseReservation(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"release_reservation">> {
  const input: Input<"release_reservation"> = IPD_INTENTS.release_reservation.input.parse(raw);
  await requirePermission(db, actor, IPD_BEDS_MANAGE);
  const at = opts.now ?? new Date();
  return once(db, actor, "release_reservation", input.idempotencyKey, input, () => releaseReservationCore(db, actor, input, at), at);
}

/**
 * THE 2-HOUR LAPSE (§4.1) — the worker's job, every minute. Ends every active reservation whose `expiresAt` is at or
 * before `now`, each in its own transaction, as the system actor. Idempotent: a reservation already ended is
 * skipped, so two overlapping runs end each one once. `now` is an argument so tests drive the clock.
 */
export async function lapseBedReservations(db: Db, now: Date): Promise<{ lapsed: number }> {
  const due = await db.select({ id: ipdBedReservations.id }).from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.status, "active"), lte(ipdBedReservations.expiresAt, now)))
    .orderBy(asc(ipdBedReservations.expiresAt)).limit(500);
  let lapsed = 0;
  for (const { id } of due) {
    try {
      await releaseReservationCore(db, IPD_SYSTEM_ACTOR, { reservationId: id, reason: "lapsed" }, now);
      lapsed += 1;
    } catch (e) {
      if (e instanceof IpdRefusal && e.code === "reservation_ended") continue; // a person released it first
      throw e;
    }
  }
  return { lapsed };
}

// ═══════════════════════════════════════════ assign_bed ═══════════════════════════════════════════

/**
 * Puts a patient on a bed (§4.1). The function ipd-admit's `admit` and ipd-transfer call. Refuses on every bed
 * rule; a bed reserved for THIS admission is taken (the hold is consumed), a bed held for anyone else is not.
 */
export async function assignBed(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"assign_bed">> {
  const input: Input<"assign_bed"> = IPD_INTENTS.assign_bed.input.parse(raw);
  await requirePermission(db, actor, IPD_BEDS_MANAGE);
  const at = opts.now ?? new Date();
  return once(db, actor, "assign_bed", input.idempotencyKey, input, () => withNextBeds(db, actor, { ...input, at }, async () => {
    const ctx = await placementContext(db, actor, input.patientId, at);
    return withTx(db, (tx) => assignBedIn(tx, db, actor, input, at, ctx)).catch((e: unknown) => {
      // Belt to the admission lock: the open-stay unique index answers as the rule, never as a raw 500.
      if (isUniqueViolation(e)) throw new IpdRefusal("admission_wrong_state", "Already on a bed");
      throw e;
    });
  }), at);
}

export type BedPlacementInput = {
  admissionId: string; bedId: string; patientId: string; need: IpdBedNeed;
  classChange?: "upgrade" | "downgrade"; protectBookedClass?: IpdBedClass;
};
export type PlacementContext = { patient: BedRulePatient & { id: string }; mayUseOverflow: boolean };

/** The patient's rule facts and the overflow gate, read before the placing transaction. */
export async function placementContext(db: Db, actor: Actor, patientId: string, at: Date): Promise<PlacementContext> {
  return { patient: await patientFacts(db, actor, patientId, at), mayUseOverflow: await holds(db, actor, IPD_BEDS_OVERFLOW) };
}

/** `withNextBeds` for callers outside this file (admit): "bed just taken" answers with the next three beds. */
export function withNextRuleValidBeds<T>(db: Db, actor: Actor, args: Parameters<typeof nextRuleValidBeds>[2], work: () => Promise<T>): Promise<T> {
  return withNextBeds(db, actor, args, work);
}

/**
 * THE PLACEMENT, inside the caller's transaction — `assign_bed`'s body, and what `admit`, the emergency lane and the
 * downtime back-fill call so the bed and the admission move in ONE transaction (E1.2). Locks the room and the bed
 * (lock order: room, bed, then IPD rows), re-checks every rule, occupies the bed and opens the stay.
 * `viaAdmit`: the caller is moving the admission itself, so the "only an admitted patient is placed this way" link is
 * skipped.
 */
export async function assignBedIn(
  tx: Tx, db: Db, actor: Actor, input: BedPlacementInput, at: Date, ctx: PlacementContext, opts: { viaAdmit?: boolean } = {},
): Promise<Output<"assign_bed">> {
  const { patient, mayUseOverflow } = ctx;
  await lockAdmission(tx, input.admissionId);
  const { row, attrs, roomId } = await lockBed(tx, input.bedId);
  if (row.status === "retired") throw new IpdRefusal("bed_retired", "Retired bed");
  const elsewhere = (await tx.select().from(ipdBedStays)
    .where(and(eq(ipdBedStays.admissionId, input.admissionId), isNull(ipdBedStays.endedAt))))[0];
  if (elsewhere !== undefined) {
    // Moving an admitted patient is a transfer (ipd-transfer), never a second assignment.
    throw new IpdRefusal("admission_wrong_state", "Already on a bed", { bedId: elsewhere.bedId });
  }
  const held = await currentHold(tx, row, at);
  if (held !== undefined && held.admissionId !== input.admissionId) {
    throw new IpdRefusal("bed_not_available", "Bed is reserved", { reservationId: held.id, expiresAt: held.expiresAt.toISOString() });
  }
  if (row.occupantRef !== null || row.status !== "available") throw new IpdRefusal("bed_not_available", notAvailableRule(row));
  if (await liveBlock(tx, row.id) !== undefined) throw new IpdRefusal("bed_not_available", "Bed is blocked");
  const breach = checkBedRules({ code: row.code, attributes: attrs }, patient, input.need, input.classChange, {
    roomGender: await roomGender(tx, roomId, row.id), mayUseOverflow,
  });
  if (breach !== null) throw new IpdRefusal(breach.code, breach.bedRule);
  if (opts.viaAdmit !== true) await linkPlacement(tx, { admissionId: input.admissionId, patientId: patient.id, need: input.need });

  await assignResource(tx, actor, KERNEL_RESOURCE_KINDS, row.id, {
    occupantType: OCCUPANT_ADMISSION, occupantRef: input.admissionId, at, reason: "assign",
  });
  if (held !== undefined) {
    await tx.update(ipdBedReservations)
      .set({ status: "consumed", endedBy: actor.id, endedAt: at, endReason: "assigned" })
      .where(eq(ipdBedReservations.id, held.id));
  }
  await endOtherReservations(tx, actor, input.admissionId, row.id, at);

  const billedClass: IpdBedClass = input.protectBookedClass ?? IPD_BED_CLASS_INFO[attrs.class].billsAs ?? attrs.class;
  const protectedUntil = input.protectBookedClass === undefined ? null : new Date(at.getTime() + PROTECT_HOURS * 3_600_000);
  const stayId = newId();
  await tx.insert(ipdBedStays).values({
    id: stayId, bedId: row.id, admissionId: input.admissionId, patientId: patient.id, placedAs: placementGender(patient, input.need),
    bedClass: attrs.class, billedClass, protectedUntil, classChange: input.classChange ?? null, startedBy: actor.id, startedAt: at,
  });
  const provenance = provenanceOf(actor);
  await appendEvent(tx, bedAssigned.make({
    payload: {
      stayId, bedId: row.id, bedCode: row.code, admissionId: input.admissionId, patientId: patient.id,
      bedClass: attrs.class, billedClass, classChange: input.classChange ?? null, reservationId: held?.id ?? null, provenance,
    },
    actor, correlationId: input.admissionId, patientId: patient.id, occurredAt: at,
  }));
  await appendEvent(tx, bedOccupied.make({
    payload: { bedId: row.id, bedCode: row.code, admissionId: input.admissionId, patientId: patient.id, provenance },
    actor, correlationId: input.admissionId, patientId: patient.id, occurredAt: at,
  }));
  return { admissionId: input.admissionId, bedId: row.id, billedClass, protectedUntil: protectedUntil?.toISOString() ?? null };
}

/** A bed's class and ICU flag (the emergency lane derives the patient's need from the bed it is given). */
export async function readBedFacts(db: Db | Tx, bedId: string): Promise<{ id: string; code: string; class: IpdBedClass; icu: boolean }> {
  const row = (await db.select().from(resources).where(eq(resources.id, bedId)))[0];
  const attrs = row === undefined ? null : bedAttributes(row);
  if (row === undefined || attrs === null) throw new IpdRefusal("bed_not_found");
  return { id: row.id, code: row.code, class: attrs.class, icu: attrs.icu };
}

/**
 * Ends every live hold of one admission inside the caller's transaction (cancel_admission). Lock order: each bed
 * (room, bed), then its reservation — the caller locks the admission row only after this returns.
 */
export async function endAdmissionHolds(tx: Tx, actor: Actor, admissionId: string, at: Date): Promise<string | null> {
  const live = await tx.select().from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.admissionId, admissionId), eq(ipdBedReservations.status, "active")));
  let released: string | null = null;
  for (const r of live) {
    const { row } = await lockBed(tx, r.bedId);
    const fresh = (await tx.select().from(ipdBedReservations).where(eq(ipdBedReservations.id, r.id)).for("update"))[0]!;
    if (fresh.status !== "active") continue;
    await endReservation(tx, actor, fresh, row.code, "plan_changed", at);
    released = row.id;
  }
  return released;
}

// ═══════════════════════════════════════════ releasing a bed ═══════════════════════════════════════════

/**
 * THE RELEASE SEAM — the one way a bed is emptied. ipd-discharge and ipd-transfer call it inside their own
 * transaction. The bed goes to cleaning (`terminal` for an isolation or death clean, G3's split), the open stay
 * ends, and a block waiting for the release (maintenance asked on an occupied bed) applies now.
 */
export async function releaseBedOccupant(
  tx: Tx, actor: Actor, bedId: string, at: Date, opts: { terminal?: boolean } = {},
): Promise<{ bedStatus: "cleaning" | "blocked" }> {
  await lockBed(tx, bedId); // ROOM, then BED: the room's gender is re-derived by the next placement
  await releaseResource(tx, actor, KERNEL_RESOURCE_KINDS, bedId, { at, reason: opts.terminal === true ? CLEAN_TERMINAL : CLEAN_ROUTINE });
  await tx.update(ipdBedStays).set({ endedBy: actor.id, endedAt: at })
    .where(and(eq(ipdBedStays.bedId, bedId), isNull(ipdBedStays.endedAt)));
  const pending = (await tx.select().from(ipdBedBlocks)
    .where(and(eq(ipdBedBlocks.bedId, bedId), eq(ipdBedBlocks.status, "pending_release"))).for("update"))[0];
  if (pending === undefined) return { bedStatus: "cleaning" };
  await changeResourceStatus(tx, actor, KERNEL_RESOURCE_KINDS, bedId, "blocked", { at, reason: `block:${pending.reason}` });
  await tx.update(ipdBedBlocks).set({ status: "active", appliedAt: at }).where(eq(ipdBedBlocks.id, pending.id));
  return { bedStatus: "blocked" };
}

/** §4.1: an incumbent-occupied bed is released by a tap when the old system discharges its patient. */
export async function releaseIncumbentBed(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"release_incumbent_bed">> {
  const input: Input<"release_incumbent_bed"> = IPD_INTENTS.release_incumbent_bed.input.parse(raw);
  await requirePermission(db, actor, IPD_BEDS_MANAGE);
  const at = opts.now ?? new Date();
  return once(db, actor, "release_incumbent_bed", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { row } = await lockBed(tx, input.bedId);
    if (!isIncumbent(row)) throw new IpdRefusal("bed_not_incumbent");
    const { bedStatus } = await releaseBedOccupant(tx, actor, row.id, at);
    const rest = Object.fromEntries(Object.entries(row.attributes).filter(([k]) => k !== "incumbent" && k !== "incumbentGender"));
    await updateResource(tx, actor, KERNEL_RESOURCE_KINDS, row.id, { attributes: rest }, { at });
    await appendEvent(tx, bedIncumbentReleased.make({
      payload: { bedId: row.id, bedCode: row.code, bedStatus, provenance: provenanceOf(actor) },
      actor, correlationId: row.id, occurredAt: at,
    }));
    return { bedId: row.id, bedStatus };
  }), at);
}

// ═══════════════════════════════════════════ block / unblock ═══════════════════════════════════════════

/**
 * Blocks an available or cleaning bed with a reason and an expected return (§4.1). On an occupied bed it records a
 * request instead (`block_on_release`) that `releaseBedOccupant` applies when the bed empties.
 */
export async function blockBed(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"block_bed">> {
  const input: Input<"block_bed"> = IPD_INTENTS.block_bed.input.parse(raw);
  await requirePermission(db, actor, IPD_BEDS_MANAGE);
  const at = opts.now ?? new Date();
  return once(db, actor, "block_bed", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { row } = await lockBed(tx, input.bedId);
    if (row.status === "retired") throw new IpdRefusal("bed_retired", "Retired bed");
    const held = await currentHold(tx, row, at);
    if (held !== undefined) throw new IpdRefusal("bed_reserved", "Bed is reserved", { reservationId: held.id });
    const existing = await liveBlock(tx, row.id);
    if (existing !== undefined) throw new IpdRefusal("state_changed", "Bed is already blocked", { blockId: existing.id });
    const occupied = row.occupantRef !== null;
    if (!occupied && row.status !== "available" && row.status !== "cleaning") throw new IpdRefusal("state_changed", notAvailableRule(row));

    const blockId = newId();
    const status = occupied ? "block_on_release" as const : "blocked" as const;
    if (!occupied) {
      await changeResourceStatus(tx, actor, KERNEL_RESOURCE_KINDS, row.id, "blocked", { at, reason: `block:${input.reason}` });
    }
    await tx.insert(ipdBedBlocks).values({
      id: blockId, bedId: row.id, status: occupied ? "pending_release" : "active", reason: input.reason, note: input.note,
      expectedReturnAt: new Date(input.expectedReturnAt), requestedBy: actor.id, requestedAt: at, appliedAt: occupied ? null : at,
    });
    await appendEvent(tx, bedBlocked.make({
      payload: {
        blockId, bedId: row.id, bedCode: row.code, status, reason: input.reason,
        expectedReturnAt: new Date(input.expectedReturnAt).toISOString(), provenance: provenanceOf(actor),
      },
      actor, correlationId: row.id, occurredAt: at,
    }));
    return { blockId, bedId: row.id, status };
  }), at);
}

/**
 * Ends a block. DECIDED (E1.1): a bed back from maintenance, infection control or a deep clean goes to cleaning
 * (infection control and deep clean as a terminal clean); one blocked for staff shortage or other returns available.
 * A block still waiting for release is simply withdrawn; the occupied bed is untouched.
 */
export async function unblockBed(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"unblock_bed">> {
  const input: Input<"unblock_bed"> = IPD_INTENTS.unblock_bed.input.parse(raw);
  await requirePermission(db, actor, IPD_BEDS_MANAGE);
  const at = opts.now ?? new Date();
  return once(db, actor, "unblock_bed", input.idempotencyKey, input, () => withTx(db, async (tx) => {
    const { row } = await lockBed(tx, input.bedId);
    const block = await liveBlock(tx, row.id);
    if (block === undefined) throw new IpdRefusal("bed_not_blocked");
    let bedStatus = row.status;
    if (block.status === "pending_release") {
      await tx.update(ipdBedBlocks).set({ status: "cancelled", endedBy: actor.id, endedAt: at, endNote: input.note ?? null })
        .where(eq(ipdBedBlocks.id, block.id));
    } else {
      const toCleaning = block.reason === "maintenance" || block.reason === "infection_control" || block.reason === "deep_clean";
      bedStatus = toCleaning ? "cleaning" : "available";
      const reason = !toCleaning ? "unblock" : block.reason === "maintenance" ? CLEAN_ROUTINE : CLEAN_TERMINAL;
      if (row.status === "blocked") await changeResourceStatus(tx, actor, KERNEL_RESOURCE_KINDS, row.id, bedStatus, { at, reason });
      await tx.update(ipdBedBlocks).set({ status: "ended", endedBy: actor.id, endedAt: at, endNote: input.note ?? null })
        .where(eq(ipdBedBlocks.id, block.id));
    }
    await appendEvent(tx, bedUnblocked.make({
      payload: { blockId: block.id, bedId: row.id, bedCode: row.code, bedStatus, provenance: provenanceOf(actor) },
      actor, correlationId: row.id, occurredAt: at,
    }));
    return { bedId: row.id, bedStatus: bedStatus as Output<"unblock_bed">["bedStatus"] };
  }), at);
}

// ═══════════════════════════════════════════ mark_bed_clean ═══════════════════════════════════════════

/**
 * THE HOUSEKEEPING SEAM: cleaning → available inside the caller's transaction. The housekeeping lane's task
 * completion calls this; until it lands a nurse or supervisor taps `markBedClean`.
 */
export async function markBedCleanIn(tx: Tx, actor: Actor, bedId: string, cleanedAt: Date): Promise<Output<"mark_bed_clean">> {
  const { row } = await lockBed(tx, bedId);
  if (row.status !== "cleaning") throw new IpdRefusal("bed_not_cleaning", row.status === "available" ? "Bed is already clean" : notAvailableRule(row));
  await changeResourceStatus(tx, actor, KERNEL_RESOURCE_KINDS, row.id, "available", { at: cleanedAt, reason: "cleaned" });
  await appendEvent(tx, bedCleaned.make({
    payload: { bedId: row.id, bedCode: row.code, cleanedAt: cleanedAt.toISOString(), provenance: provenanceOf(actor) },
    actor, correlationId: row.id, occurredAt: cleanedAt,
  }));
  return { bedId: row.id, bedStatus: "available" };
}

export async function markBedClean(db: Db, actor: Actor, raw: unknown, opts: Opts = {}): Promise<Output<"mark_bed_clean">> {
  const input: Input<"mark_bed_clean"> = IPD_INTENTS.mark_bed_clean.input.parse(raw);
  await requirePermission(db, actor, IPD_BEDS_CLEAN);
  const now = opts.now ?? new Date();
  const cleanedAt = new Date(input.cleanedAt);
  // A cleaned-at time ahead of the server clock past the shared skew allowance is a wrong phone clock (§4.10 edge 18).
  if (ipdIsInFuture(input.cleanedAt, now)) throw new IpdRefusal("time_in_future");
  return once(db, actor, "mark_bed_clean", input.idempotencyKey, input, () => withTx(db, (tx) => markBedCleanIn(tx, actor, input.bedId, cleanedAt)), now);
}

// ═══════════════════════════════════════════ retire ═══════════════════════════════════════════

/**
 * Takes a bed out of service for good. §4.1 edge: a bed retired while reserved is refused until the reservation
 * lapses or is released. Not a §0B intent (a bed-master act); IPD's only door to the kernel retire for its beds.
 */
export async function retireBed(db: Db, actor: Actor, input: { bedId: string; reason: string }, opts: Opts = {}): Promise<{ bedId: string }> {
  await requirePermission(db, actor, IPD_BEDS_MANAGE);
  const at = opts.now ?? new Date();
  return withTx(db, async (tx) => {
    const { row } = await lockBed(tx, input.bedId);
    if (row.status === "retired") return { bedId: row.id };
    const held = await currentHold(tx, row, at);
    if (held !== undefined) throw new IpdRefusal("bed_reserved", "Bed is reserved", { reservationId: held.id, expiresAt: held.expiresAt.toISOString() });
    if (row.occupantRef !== null) throw new IpdRefusal("bed_not_available", notAvailableRule(row));
    const block = await liveBlock(tx, row.id);
    if (block !== undefined) {
      await tx.update(ipdBedBlocks).set({ status: "ended", endedBy: actor.id, endedAt: at, endNote: "retired" }).where(eq(ipdBedBlocks.id, block.id));
    }
    await retireResource(tx, actor, KERNEL_RESOURCE_KINDS, row.id, { at, reason: input.reason });
    return { bedId: row.id };
  });
}

// ═══════════════════════════════════════════ incumbent beds at cutover ═══════════════════════════════════════════

export type IncumbentBedLine = { code: string; gender?: "male" | "female" };
export type IncumbentBedReport = { mark: string[]; already: string[]; problems: { code: string; problem: string }[] };

/**
 * Cutover (§4.1, §4.10 edge 28): beds still holding the old system's patients are shown occupied as `incumbent`.
 * Validates every line first; with `apply`, marks them all in one transaction or none. Re-running is a no-op.
 */
export async function markIncumbentBeds(
  db: Db, actor: Actor, lines: readonly IncumbentBedLine[], opts: { apply?: boolean; now?: Date } = {},
): Promise<IncumbentBedReport> {
  const at = opts.now ?? new Date();
  if (opts.apply === true) await requirePermission(db, actor, IPD_BEDS_MANAGE);
  // Validation reads without locks: a dry run never waits on, or holds up, a desk at work.
  const report: IncumbentBedReport = { mark: [], already: [], problems: [] };
  const seen = new Set<string>();
  const ready: { id: string; gender?: "male" | "female" }[] = [];
  for (const line of lines) {
    const key = line.code.trim().toLowerCase();
    if (seen.has(key)) { report.problems.push({ code: line.code, problem: "listed twice" }); continue; }
    seen.add(key);
    const row = (await db.select().from(resources).where(and(eq(resources.kind, "bed"), sql`lower(${resources.code}) = ${key}`)))[0];
    const problem = row === undefined || bedAttributes(row) === null ? "no IPD bed has this code" : null;
    if (problem !== null || row === undefined) { report.problems.push({ code: line.code, problem: problem ?? "no IPD bed has this code" }); continue; }
    if (isIncumbent(row)) { report.already.push(row.code); continue; }
    const why = await incumbentProblem(db, row);
    if (why !== null) { report.problems.push({ code: row.code, problem: why }); continue; }
    report.mark.push(row.code);
    ready.push({ id: row.id, ...(line.gender === undefined ? {} : { gender: line.gender }) });
  }
  if (opts.apply !== true || report.problems.length > 0) return report;
  await withTx(db, async (tx) => {
    for (const r of ready) {
      const { row } = await lockBed(tx, r.id); // ROOM, then BED, and re-check under the lock
      const why = await incumbentProblem(tx, row);
      if (why !== null) throw new IpdRefusal("state_changed", `${row.code}: ${why}`);
      await assignResource(tx, actor, KERNEL_RESOURCE_KINDS, row.id, { occupantType: OCCUPANT_INCUMBENT, occupantRef: OCCUPANT_INCUMBENT, at, reason: "incumbent at cutover" });
      const attributes = { ...row.attributes, incumbent: true, ...(r.gender === undefined ? {} : { incumbentGender: r.gender }) };
      await updateResource(tx, actor, KERNEL_RESOURCE_KINDS, row.id, { attributes }, { at });
    }
  });
  return report;
}

async function incumbentProblem(exec: Db | Tx, row: BedRow): Promise<string | null> {
  if (row.occupantRef !== null) return "occupied by an HMIS admission";
  if (row.status !== "available" && row.status !== "cleaning") return `bed is ${row.status}`;
  const held = (await exec.select({ id: ipdBedReservations.id }).from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.bedId, row.id), eq(ipdBedReservations.status, "active"))))[0];
  return held === undefined ? null : "bed is reserved";
}

