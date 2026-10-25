import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { istDayString } from "../../kernel/approvals/cumulative";
import { hasPermission } from "../../kernel/auth/permissions";
import { IPD_OPEN_ADMISSION_STATES, ipdAdmissions, ipdBedReservations } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { WorkflowError, transition } from "../../kernel/workflow/instances";
import { withIdempotency } from "../billing";
import { admissionReserved } from "./admission-events";
import { IpdError, IpdRefusal } from "./errors";
import type { Actor, IpdAdmissionState, IpdBedClass, IpdBedNeed, IpdIntentName } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * E1.2 (#719) — THE ADMISSION ROW'S SHARED HELPERS: lock, move (workflow instance and mirror together), the IP number,
 * and the links the bed intents call so a hold or a placement on a real admission keeps the admission honest.
 * LOCK ORDER (review #8): every act on an admission first takes that admission's transaction-scoped ADVISORY lock
 * (`admissionAdvisoryLock` — the bed intents take the same one), which serialises all acts on one admission. After it:
 * the placing acts take room → bed → admission row (`admit`, the emergency lane, the back-fill); `cancelAdmission`
 * takes the admission row and then the beds of its holds; the money acts take the admission row and then billing's
 * rows. With the advisory lock first, two acts on one admission never interleave, so these orders cannot cycle.
 */
export async function admissionAdvisoryLock(tx: Tx, admissionId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ipd_admission:${admissionId}`}))`);
}

export type AdmissionRow = typeof ipdAdmissions.$inferSelect;

/** Classes whose beds are ICU-flagged in the bed registry (the planning layout: icu, nicu, picu). HDU is not ICU. */
const ICU_CLASSES: ReadonlySet<IpdBedClass> = new Set(["icu", "nicu", "picu"]);
export const isIcuClass = (c: IpdBedClass): boolean => ICU_CLASSES.has(c);

export function provenanceOf(actor: Actor): "person" | "agent" | "system" {
  if (actor.type === "agent") return "agent";
  if (actor.type === "system") return "system";
  return "person";
}

export async function holdsPermission(db: Db, actor: Actor, permission: string): Promise<boolean> {
  if (actor.type === "system") return true;
  return hasPermission(db, actor.id, permission, "hospital");
}

export async function requireIpdPermission(db: Db, actor: Actor, permission: string): Promise<void> {
  if (!(await holdsPermission(db, actor, permission))) {
    throw new IpdError("ipd_forbidden", `this act needs the permission ${permission}`, { permission });
  }
}

/** The contract's idempotency key scopes the act: a retry with the same key and body answers the first result. */
export function onceIpd<T>(db: Db, actor: Actor, intent: IpdIntentName, key: string, body: unknown, work: () => Promise<T>, now: Date): Promise<T> {
  return withIdempotency(db, { actorId: actor.id, route: `ipd:${intent}`, key: key.toLowerCase() }, body, work, now);
}

export function needOf(a: Pick<AdmissionRow, "requestedClass" | "isolation" | "icu" | "placeAs">): IpdBedNeed {
  const need: IpdBedNeed = {
    requestedClass: a.requestedClass as IpdBedClass,
    isolation: a.isolation as IpdBedNeed["isolation"],
    icu: a.icu,
  };
  if (a.placeAs === "male" || a.placeAs === "female") need.placeAs = a.placeAs;
  return need;
}

export async function lockAdmission(tx: Tx, admissionId: string): Promise<AdmissionRow> {
  await admissionAdvisoryLock(tx, admissionId);
  const row = (await tx.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)).for("update"))[0];
  if (row === undefined) throw new IpdRefusal("admission_not_found");
  return row;
}

export async function readAdmission(db: Db | Tx, admissionId: string): Promise<AdmissionRow> {
  const row = (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)))[0];
  if (row === undefined) throw new IpdRefusal("admission_not_found");
  return row;
}

/** The patient's open admission (any open state), other than `exceptId`. */
export async function openAdmissionOf(db: Db | Tx, patientId: string, exceptId?: string): Promise<AdmissionRow | undefined> {
  const where = and(
    eq(ipdAdmissions.patientId, patientId),
    inArray(ipdAdmissions.state, [...IPD_OPEN_ADMISSION_STATES]),
    ...(exceptId === undefined ? [] : [ne(ipdAdmissions.id, exceptId)]),
  );
  return (await db.select().from(ipdAdmissions).where(where))[0];
}

/** The refusal that shows the first admission (§6: "refused and shows the first"). */
export function alreadyOpen(first: AdmissionRow): IpdRefusal {
  return new IpdRefusal("admission_already_open", undefined, {
    admissionId: first.id, state: first.state, admissionNo: first.admissionNo, requestedAt: first.requestedAt.toISOString(),
  });
}

/** True for a unique violation on the one-open-admission-per-patient index (a race the pre-check lost). */
export function isOpenAdmissionRace(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = err.cause ?? err;
  return c.code === "23505" && c.constraint === "ipd_admissions_open_patient_ux";
}

/**
 * Moves the workflow instance AND the mirror in the caller's transaction. The engine is the single-winner arbiter
 * (conditional update on the state it read); its refusals become IPD words: no role → `ipd_forbidden`, a concurrent
 * move → `state_changed`, an edge that does not exist → `admission_wrong_state`.
 */
export async function moveAdmission(
  tx: Tx, actor: Actor, a: AdmissionRow, to: IpdAdmissionState, at: Date, set: Partial<AdmissionRow> = {}, note?: string,
): Promise<void> {
  try {
    await transition(tx, a.workflowInstanceId, to, actor, note === undefined ? {} : { note });
  } catch (e) {
    throw workflowRefusal(e);
  }
  const done = await tx.update(ipdAdmissions).set({ ...set, state: to, updatedAt: at })
    .where(and(eq(ipdAdmissions.id, a.id), eq(ipdAdmissions.state, a.state)))
    .returning({ id: ipdAdmissions.id });
  if (done.length === 0) throw new IpdRefusal("state_changed");
}

export function workflowRefusal(e: unknown): unknown {
  if (!(e instanceof WorkflowError)) return e;
  if (e.code === "role_denied") return new IpdError("ipd_forbidden", e.message, { workflow: "role_denied" });
  if (e.code === "stale_transition") return new IpdRefusal("state_changed");
  if (e.code === "unknown_transition" || e.code === "instance_not_active") return new IpdRefusal("admission_wrong_state");
  if (e.code === "no_active_definition") {
    return new IpdError("admission_workflow_inactive", "the inpatient admission workflow is not active yet: a go-live step activates it");
  }
  return e;
}

/** IST calendar year of an instant (the IP number restarts every year). */
function istYear(at: Date): number {
  return Number(istDayString(at).slice(0, 4));
}

/**
 * The IP number: `IP` + two-digit year + `-` + a six-digit serial that restarts every IST year (`IP26-000123`).
 * Serialised by a transaction-scoped advisory lock on the year; the partial unique index is the backstop.
 */
export async function mintAdmissionNo(tx: Tx, at: Date): Promise<{ year: number; serial: number; admissionNo: string }> {
  const year = istYear(at);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ipd_admission_no:${String(year)}`}))`);
  const rows = (await tx.execute(sql`
    select coalesce(max(admission_serial), 0) + 1 as next from ipd_admissions where admission_year = ${year}
  `)).rows as { next: number | string }[];
  const serial = Number(rows[0]!.next);
  return { year, serial, admissionNo: `IP${String(year % 100).padStart(2, "0")}-${String(serial).padStart(6, "0")}` };
}

// ═══════════════════════════════ the links the bed intents call (E1.1 seams, filled by E1.2) ═══════════════════════════════

function needMatches(a: AdmissionRow, need: IpdBedNeed): boolean {
  return a.requestedClass === need.requestedClass && a.isolation === need.isolation && a.icu === need.icu;
}

/**
 * reserve_bed on a REAL admission: the caller's copy of patient and need must match the record (else
 * `state_changed`), the advice must be live, and `requested → reserved` moves the workflow. A request id with no
 * admission row (a cutover or a caller from before E1.2) keeps the E1.1 behaviour.
 */
export async function linkReservation(
  tx: Tx, actor: Actor, args: { admissionId: string; patientId: string; need: IpdBedNeed; bedId: string; reservationId: string }, at: Date,
): Promise<void> {
  const a = (await tx.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, args.admissionId)).for("update"))[0];
  if (a === undefined) return;
  if (a.patientId !== args.patientId || !needMatches(a, args.need)) throw new IpdRefusal("state_changed", "Request changed");
  if (a.state !== "requested" && a.state !== "reserved") throw new IpdRefusal("admission_wrong_state");
  if (a.source !== "er" && a.expiresAt.getTime() < at.getTime()) throw new IpdRefusal("advice_expired"); // ER: never while boarding
  if (a.state === "requested") await moveAdmission(tx, actor, a, "reserved", at);
  await appendEvent(tx, admissionReserved.make({
    payload: { admissionId: a.id, bedId: args.bedId, reservationId: args.reservationId, provenance: provenanceOf(actor) },
    actor, correlationId: a.id, patientId: a.patientId, occurredAt: at,
  }));
}

/** A hold ended (released or lapsed): with no other live hold, `reserved → requested`. Returns the admission's state. */
export async function linkReservationEnded(tx: Tx, actor: Actor, admissionId: string, at: Date): Promise<IpdAdmissionState> {
  const a = (await tx.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, admissionId)).for("update"))[0];
  if (a === undefined) return "requested";
  if (a.state !== "reserved") return a.state as IpdAdmissionState;
  const other = await tx.select({ id: ipdBedReservations.id }).from(ipdBedReservations)
    .where(and(eq(ipdBedReservations.admissionId, admissionId), eq(ipdBedReservations.status, "active")));
  if (other.length > 0) return "reserved";
  await moveAdmission(tx, actor, a, "requested", at);
  return "requested";
}

/**
 * assign_bed (the bed intent, not admit) on a REAL admission: only an admitted patient not yet on a bed is placed
 * this way, and the caller's copy must match the record.
 */
export async function linkPlacement(tx: Tx, args: { admissionId: string; patientId: string; need: IpdBedNeed }): Promise<void> {
  const a = (await tx.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, args.admissionId)).for("update"))[0];
  if (a === undefined) return;
  if (a.patientId !== args.patientId || !needMatches(a, args.need)) throw new IpdRefusal("state_changed", "Request changed");
  if (a.state !== "admitted") throw new IpdRefusal("admission_wrong_state");
}
