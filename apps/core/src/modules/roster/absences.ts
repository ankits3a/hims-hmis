import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { STAFF_ABSENCE_KINDS, staffAbsences } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { hasPermission } from "../../kernel/auth/permissions";
import { RosterError } from "./errors";
import { ROSTER_MANAGE, requireRosterAct } from "./access";
import type { RosterVia } from "./policy";
import { rosterAbsenceApproved, rosterAbsenceRequested } from "./events";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { StaffAbsenceKind } from "../../kernel/db/schema/roster";

/**
 * PHASE R (R4) — **WHO IS AWAY, FOR EVERY MEMBER OF STAFF.**
 *
 * Read `kernel/db/schema/roster.ts`'s R4 header first: why this could not be `opd_doctor_leaves`,
 * and why the reason belongs to the approver alone.
 *
 * ═══ THE CLOCK IS THE DATABASE'S (V6) ═══
 *
 * `decided_at` is stamped from `now()`, like every other instant this module writes. A leave
 * approved "at" a time the client supplied is a leave whose record can be moved by the client.
 */

export type StaffAbsenceRow = typeof staffAbsences.$inferSelect;

const HOUR_MS = 3_600_000;

async function dbNow(exec: Db | Tx): Promise<Date> {
  const r = await (exec as Db).execute(sql`select now() as "now"`);
  const raw = (r.rows[0] as { now: unknown }).now;
  return raw instanceof Date ? raw : new Date(String(raw));
}

function assertWindow(startsAt: Date, endsAt: Date): void {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new RosterError("invalid_window", "the start or the end of that absence is not a real instant");
  }
  if (endsAt <= startsAt) {
    throw new RosterError("invalid_window", "an absence cannot end before it begins", {
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    });
  }
}

function assertKind(kind: string): asserts kind is StaffAbsenceKind {
  if (!(STAFF_ABSENCE_KINDS as readonly string[]).includes(kind)) {
    throw new RosterError("unknown_absence_kind", undefined, { kind });
  }
}

async function assertStaff(exec: Db | Tx, userId: string): Promise<void> {
  const person = (await (exec as Db).select({ id: users.id, active: users.active }).from(users).where(eq(users.id, userId)))[0];
  if (person === undefined || !person.active) throw new RosterError("unknown_user", undefined, { userId });
}

/* ═══════════════════════════════ requesting ═══════════════════════════════ */

export interface RequestAbsenceInput {
  userId: string;
  kind: StaffAbsenceKind;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
  source?: "manual" | "import" | "opd" | "academic";
}

/**
 * ═══ YOU MAY ALWAYS FILE YOUR OWN ═══
 *
 * A junior resident asking for two days holds no roster permission and must not need one. Filing
 * somebody ELSE's absence is a different act — a clerk entering the department's leave book, a
 * head recording a deputation — and needs `roster.periods.manage`. The matrix's `open` cell cannot
 * express "your own", so it is enforced here, in the one place, and tested both ways.
 */
export async function requestAbsence(
  tx: Tx, actor: Actor, input: RequestAbsenceInput, via: RosterVia = "direct",
): Promise<{ absenceId: string }> {
  await requireRosterAct(tx, actor, "request_absence", {}, via);
  if (actor.type !== "user") {
    // Unreachable through the matrix today; kept because `open` is a cell somebody may widen.
    throw new RosterError("act_not_available_to_actor", undefined, { act: "request_absence", actorType: actor.type });
  }
  if (actor.id !== input.userId
    && !(await hasPermission(tx as Db, actor.id, ROSTER_MANAGE, "hospital"))) {
    throw new RosterError("not_permitted", "filing somebody else's absence needs the roster's manage permission", {
      permission: ROSTER_MANAGE, userId: input.userId,
    });
  }

  assertKind(input.kind);
  assertWindow(input.startsAt, input.endsAt);
  await assertStaff(tx, input.userId);
  const reason = input.reason?.trim() ?? null;
  if (reason !== null && reason.length > 500) {
    throw new RosterError("invalid_window", "a reason is 500 characters or fewer", { reasonLength: reason.length });
  }

  const absenceId = newId();
  await tx.insert(staffAbsences).values({
    id: absenceId, userId: input.userId, kind: input.kind,
    startsAt: input.startsAt, endsAt: input.endsAt, status: "requested",
    requestedBy: actor.id, reason, source: input.source ?? "manual",
    createdBy: actor.id, updatedBy: actor.id,
  });
  await appendEvent(tx, rosterAbsenceRequested.make({
    payload: {
      absenceId, userId: input.userId, kind: input.kind,
      startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(),
    },
    actor, correlationId: absenceId,
  }));
  return { absenceId };
}

/* ═══════════════════════════════ deciding ═══════════════════════════════ */

async function decide(
  tx: Tx, actor: Actor, absenceId: string, status: "approved" | "rejected",
): Promise<StaffAbsenceRow> {
  const row = (await tx.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId)).for("update"))[0];
  if (row === undefined) throw new RosterError("unknown_absence", undefined, { absenceId });
  // "Approve a leave" is in the matrix's PUBLISH row: it is a governed act, because it decides
  // whether a ward has somebody in it.
  await requireRosterAct(tx, actor, "publish");
  if (row.status !== "requested") {
    throw new RosterError("absence_already_decided", undefined, { absenceId, status: row.status });
  }
  /**
   * SEGREGATION: the person who asked is not the person who allows. The engine's own
   * requester-vs-approver rule, applied here because a leave nobody but the taker signed off is
   * the commonest way a ward discovers at 20:00 that it is empty.
   */
  if (row.userId === actor.id || row.requestedBy === actor.id) {
    throw new RosterError("absence_self_approval", undefined, { absenceId });
  }

  const now = await dbNow(tx);
  await tx.update(staffAbsences)
    .set({ status, approvedBy: actor.id, decidedAt: now, updatedBy: actor.id, updatedAt: now })
    .where(eq(staffAbsences.id, absenceId));
  return { ...row, status, approvedBy: actor.id, decidedAt: now };
}

export async function approveAbsence(tx: Tx, actor: Actor, absenceId: string): Promise<void> {
  const row = await decide(tx, actor, absenceId, "approved");
  // The OPD's `needs_rebooking` cascade subscribes to this: an approved absence is the moment a
  // clinic's appointments stop being answerable.
  await appendEvent(tx, rosterAbsenceApproved.make({
    payload: {
      absenceId, userId: row.userId, kind: row.kind,
      startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(),
      decidedAt: row.decidedAt!.toISOString(),
    },
    actor, correlationId: absenceId,
  }));
}

export async function rejectAbsence(tx: Tx, actor: Actor, absenceId: string): Promise<void> {
  await decide(tx, actor, absenceId, "rejected");
}

/** Cancelling is the taker's own, or a manager's. A decided absence may still be cancelled. */
export async function cancelAbsence(
  tx: Tx, actor: Actor, absenceId: string, via: RosterVia = "direct",
): Promise<void> {
  const row = (await tx.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId)).for("update"))[0];
  if (row === undefined) throw new RosterError("unknown_absence", undefined, { absenceId });
  await requireRosterAct(tx, actor, "request_absence", {}, via);
  if (actor.type !== "user") throw new RosterError("act_not_available_to_actor", undefined, { act: "request_absence" });
  if (actor.id !== row.userId && !(await hasPermission(tx as Db, actor.id, ROSTER_MANAGE, "hospital"))) {
    throw new RosterError("not_permitted", "cancelling somebody else's absence needs the roster's manage permission", { permission: ROSTER_MANAGE });
  }
  if (row.status === "cancelled") return;
  const now = await dbNow(tx);
  await tx.update(staffAbsences)
    .set({ status: "cancelled", updatedBy: actor.id, updatedAt: now })
    .where(eq(staffAbsences.id, absenceId));
}

/**
 * ═══ THE WRITER THAT DOES NOT CHECK, AND THE NAME IS THE WARNING ═══
 *
 * `modules/opd`'s leave screen has had its OWN authority — `opd.masters.manage` — since long
 * before this table existed, and an OPD admin scheduling a consultant's leave does not hold
 * `roster.periods.publish` and should not need to. Requiring it would mean the act they have
 * always been allowed to perform now fails, and the realistic repair for that is somebody granting
 * the OPD admin the roster's publish string — which would hand them every rota in the hospital.
 *
 * So this writer takes the caller's word, and **its name is the control**: every call site reads
 * `recordAbsenceUnchecked`, a reviewer sees it, and `absences.test.ts` pins the number of call
 * sites in the tree so a second one cannot appear quietly. `recordAbsence` below is the checked
 * front door and is what everything else uses.
 *
 * The caller owes two things, and the OPD seam does both: it has already authorised the act under
 * its own permission, and it calls this INSIDE its own transaction, so `opd_doctor_leaves` and the
 * absence row are written together or not at all.
 */
export async function recordAbsenceUnchecked(
  tx: Tx, actor: Actor, input: RequestAbsenceInput,
): Promise<{ absenceId: string }> {
  assertKind(input.kind);
  assertWindow(input.startsAt, input.endsAt);
  await assertStaff(tx, input.userId);

  const absenceId = newId();
  const now = await dbNow(tx);
  await tx.insert(staffAbsences).values({
    id: absenceId, userId: input.userId, kind: input.kind,
    startsAt: input.startsAt, endsAt: input.endsAt, status: "approved",
    requestedBy: actor.id, approvedBy: actor.id, decidedAt: now,
    reason: input.reason?.trim() ?? null, source: input.source ?? "manual",
    createdBy: actor.id, updatedBy: actor.id,
  });
  await appendEvent(tx, rosterAbsenceApproved.make({
    payload: {
      absenceId, userId: input.userId, kind: input.kind,
      startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(),
      decidedAt: now.toISOString(),
    },
    actor, correlationId: absenceId,
  }));
  return { absenceId };
}

/**
 * ═══ THE CHECKED FRONT DOOR ═══
 *
 * Approving a leave is in the matrix's PUBLISH row: it decides whether a ward has somebody in it.
 * Everything inside the roster uses this; only the OPD seam uses the unchecked writer above, and
 * only because it has already checked its own.
 */
export async function recordAbsence(
  tx: Tx, actor: Actor, input: RequestAbsenceInput,
): Promise<{ absenceId: string }> {
  await requireRosterAct(tx, actor, "publish");
  return recordAbsenceUnchecked(tx, actor, input);
}

/**
 * A strike or a deputation is not filed one person at a time. Whole-list, one transaction, and the
 * SAME per-row path — so a bulk act cannot become a way round the checks a single one goes through.
 */
export async function recordAbsences(
  tx: Tx, actor: Actor, userIds: readonly string[], input: Omit<RequestAbsenceInput, "userId">,
): Promise<{ absenceIds: string[] }> {
  const ids: string[] = [];
  for (const userId of [...new Set(userIds)]) {
    ids.push((await recordAbsence(tx, actor, { ...input, userId })).absenceId);
  }
  return { absenceIds: ids };
}

/** The biometric filing mark. Not a decision — a record that the decision reached AEBAS. */
export async function markAebasEntered(tx: Tx, actor: Actor, absenceId: string): Promise<void> {
  await requireRosterAct(tx, actor, "publish");
  const row = (await tx.select().from(staffAbsences).where(eq(staffAbsences.id, absenceId)).for("update"))[0];
  if (row === undefined) throw new RosterError("unknown_absence", undefined, { absenceId });
  const now = await dbNow(tx);
  await tx.update(staffAbsences)
    .set({ aebasEnteredAt: now, aebasEnteredBy: actor.id, updatedBy: actor.id, updatedAt: now })
    .where(eq(staffAbsences.id, absenceId));
}

/* ═══════════════════════════════ reads, and D6 ═══════════════════════════════ */

/**
 * ═══ THE REASON IS NULLED FOR EVERYBODY IT DOES NOT BELONG TO (D6) ═══
 *
 * Three people may read it: the person it is about, the person who asked for it, and the person who
 * decided it. Everyone else — the senior resident drawing next month's rota, the validator, a
 * screen, a copilot — gets the row with `reason: null`. It is **redacted in the read**, not left to
 * each caller, because the caller that forgets is the one that renders it on a noticeboard.
 */
export function redactReason(row: StaffAbsenceRow, readerUserId: string | null): StaffAbsenceRow {
  const mayRead = readerUserId !== null
    && (readerUserId === row.userId || readerUserId === row.requestedBy || readerUserId === row.approvedBy);
  return mayRead ? row : { ...row, reason: null };
}

export interface AbsenceQuery {
  userId?: string;
  from?: Date;
  to?: Date;
  statuses?: readonly string[];
}

export async function listAbsences(
  exec: Db | Tx, reader: Actor, q: AbsenceQuery = {},
): Promise<StaffAbsenceRow[]> {
  const where = [
    q.userId === undefined ? undefined : eq(staffAbsences.userId, q.userId),
    q.to === undefined ? undefined : lt(staffAbsences.startsAt, q.to),
    q.from === undefined ? undefined : gt(staffAbsences.endsAt, q.from),
    inArray(staffAbsences.status, [...(q.statuses ?? ["requested", "approved"])]),
  ].filter((c) => c !== undefined);

  const rows = await (exec as Db).select().from(staffAbsences)
    .where(and(...where)).orderBy(asc(staffAbsences.startsAt), asc(staffAbsences.id));
  const readerId = reader.type === "user" ? reader.id : null;
  return rows.map((r) => redactReason(r, readerId));
}

/** Everybody APPROVED-absent across a window — what the resolver subtracts and the validator reads. */
export async function absentUserIds(exec: Db | Tx, from: Date, to: Date): Promise<string[]> {
  const rows = await (exec as Db).select({ userId: staffAbsences.userId }).from(staffAbsences)
    .where(and(
      eq(staffAbsences.status, "approved"),
      lt(staffAbsences.startsAt, to),
      gt(staffAbsences.endsAt, from),
    ));
  return [...new Set(rows.map((r) => r.userId))].sort();
}

/* ═══════════════════════════════ the attendance projection ═══════════════════════════════ */

export interface AttendanceProjection {
  termHours: number;
  absentHours: number;
  /** Present hours as a fraction of the term, projected over the WHOLE term. */
  projectedFraction: number;
  /** TRUE when the projection is below the threshold — a FINDING, never a refusal. */
  belowThreshold: boolean;
  thresholdFraction: number;
}

/**
 * ═══ A PROJECTION, AND IT IS A FINDING RATHER THAN A REFUSAL ═══
 *
 * PGMER requires **80 % attendance** to sit the examination, and CRMI allows an intern 15 days in
 * the year. Somebody who will miss the mark needs to be told in October, not in March — so this
 * projects the whole term from the absence already recorded, and R8 turns it into a finding.
 *
 * **It never refuses anything.** A resident whose father is dying takes the leave; the hospital's
 * job is to know early enough to do something about the consequence. A system that blocked the
 * leave to protect the attendance figure would be a system nobody tells the truth to.
 *
 * The threshold is a parameter because the two regimes differ and a hospital may set its own.
 */
export async function attendanceProjection(
  exec: Db | Tx, userId: string, termStart: Date, termEnd: Date, thresholdFraction = 0.8,
): Promise<AttendanceProjection> {
  if (termEnd <= termStart) {
    throw new RosterError("invalid_window", "a term cannot end before it begins", {
      termStart: termStart.toISOString(), termEnd: termEnd.toISOString(),
    });
  }
  const rows = await (exec as Db).select().from(staffAbsences).where(and(
    eq(staffAbsences.userId, userId),
    eq(staffAbsences.status, "approved"),
    lt(staffAbsences.startsAt, termEnd),
    gt(staffAbsences.endsAt, termStart),
  ));

  const termHours = (termEnd.getTime() - termStart.getTime()) / HOUR_MS;
  // Clipped to the term, so a leave that straddles its start does not count the part outside it.
  const absentHours = rows.reduce((n, r) => {
    const from = Math.max(r.startsAt.getTime(), termStart.getTime());
    const to = Math.min(r.endsAt.getTime(), termEnd.getTime());
    return n + Math.max(0, to - from) / HOUR_MS;
  }, 0);

  const projectedFraction = (termHours - absentHours) / termHours;
  return {
    termHours, absentHours, projectedFraction,
    belowThreshold: projectedFraction < thresholdFraction,
    thresholdFraction,
  };
}
