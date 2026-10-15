import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { attDays, attMeetingRequests, attStaff, users } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { raiseNotice } from "../../kernel/alerts/notices";
import { appendEvent } from "../../kernel/events/append";
import { usersHoldingRole } from "../../kernel/workflow/roles";
import { meetingRequestClosed, meetingRequestSeen, meetingRequested } from "./events";
import { ATTENDANCE_COMMITTEE_ROLE } from "./manifest";
import { selfWord } from "./reads";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { ConfirmReason } from "./reads";

/**
 * ═══ THE REQUEST TO MEET THE ATTENDANCE MANAGER (owner 2026-10-09) ═══
 *
 * A person may raise one about one of their OWN days that reads `confirm`, and about nothing else.
 * It goes to everyone who holds the Attendance Committee ROLE — the owner named a person, and the
 * code names nobody: whoever he assigns to the role is who is told.
 *
 * WHAT A NOTICE SAYS IS FIXED WORDING. "Meeting request · <name>" to the committee, "Attendance
 * request closed" to the requester — no date, no time, no status, no note. A notice is also a
 * phone notification, and a lock screen is not the place for somebody's attendance.
 */
export const REQUEST_STATUSES = ["open", "seen", "closed", "resolved_by_correction"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const MAX_OPEN_REQUESTS = 5;
export const NOTE_MAX = 200;
export const NOTICE_MEETING_REQUEST = "attendance_meeting_request";
export const NOTICE_REQUEST_CLOSED = "attendance_request_closed";
const ACTIVE: RequestStatus[] = ["open", "seen"];
const CORRECTION_ACTOR: Actor = { type: "system", id: "attendance-sync" };

export class RequestError extends Error {
  constructor(readonly code: "not_linked" | "not_a_confirm_day" | "too_many_open_requests" | "unknown_request" | "already_closed") { super(code); }
}

export type OwnRequestView = {
  id: string; date: string; reasonCode: string; note: string | null; status: RequestStatus; createdAt: string; closedAt: string | null; closeNote: string | null;
};
export type RequestView = OwnRequestView & { name: string; dept: string | null; post: string | null; ageHours: number; seenAt: string | null };

type Row = typeof attMeetingRequests.$inferSelect;
const own = (r: Row): OwnRequestView => ({
  id: r.id, date: r.date, reasonCode: r.reasonCode, note: r.note, status: r.status as RequestStatus, createdAt: r.createdAt.toISOString(),
  closedAt: r.closedAt?.toISOString() ?? null, closeNote: r.closeNote,
});

/**
 * Raise a request about `date`. The caller's own linked pin is looked up HERE from the caller, so
 * there is no way to raise one about somebody else's day. Asking twice returns the first.
 */
export async function requestMeeting(db: Db, userId: string, input: { date: string; note: string | null }, today: string, now: Date): Promise<{ request: OwnRequestView; created: boolean }> {
  const made = await withTx(db, async (tx) => {
    const person = (await tx.select({ pin: attStaff.pin, name: attStaff.name }).from(attStaff).where(eq(attStaff.userId, userId)))[0];
    if (person === undefined) throw new RequestError("not_linked");
    const day = (await tx.select({ status: attDays.status }).from(attDays).where(and(eq(attDays.pin, person.pin), eq(attDays.date, input.date))))[0];
    const word = day === undefined ? null : selfWord(day.status, true, input.date, today);
    if (word === null || word.status !== "confirm" || word.reason === undefined) throw new RequestError("not_a_confirm_day");
    // One at a time per person, so "is there one already" and "how many are open" cannot race each other.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`att-request:${userId}`}))`);
    const active = await tx.select().from(attMeetingRequests).where(and(eq(attMeetingRequests.userId, userId), inArray(attMeetingRequests.status, ACTIVE)));
    const had = active.find((r) => r.date === input.date);
    if (had !== undefined) return { row: had, created: false, name: person.name };
    if (active.length >= MAX_OPEN_REQUESTS) throw new RequestError("too_many_open_requests");
    const reason: ConfirmReason = word.reason;
    const row = (await tx.insert(attMeetingRequests).values({
      id: newId(), userId, pin: person.pin, date: input.date, reasonCode: reason, note: input.note, status: "open", createdAt: now,
    }).returning())[0]!;
    return { row, created: true, name: person.name };
  });
  if (!made.created) return { request: own(made.row), created: false };

  // The committee is told AFTER the request is committed: a notice about a request that rolled back
  // would point at nothing. Each notice is keyed on the request, so a retry tells nobody twice.
  const holders = await withTx(db, async (tx) => {
    const ids = [...new Set(await usersHoldingRole(tx, ATTENDANCE_COMMITTEE_ROLE))];
    if (ids.length === 0) return [];
    return (await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.active, true)))).map((u) => u.id);
  });
  let notified = 0;
  for (const holder of holders) {
    if (await raiseNotice(db, {
      userId: holder, kind: NOTICE_MEETING_REQUEST, title: "Meeting request", body: `Meeting request · ${made.name}`,
      refType: "attendance_request", refId: made.row.id, sourceKey: `attendance-request:${made.row.id}`, at: now,
    })) notified += 1;
  }
  await withTx(db, (tx) => appendEvent(tx, meetingRequested.make({
    actor: { type: "user", id: userId }, occurredAt: now,
    payload: { requestId: made.row.id, userId, date: made.row.date, reasonCode: made.row.reasonCode, notified },
  })));
  return { request: own(made.row), created: true };
}

export async function ownRequests(db: Db, userId: string): Promise<OwnRequestView[]> {
  return (await db.select().from(attMeetingRequests).where(eq(attMeetingRequests.userId, userId)).orderBy(desc(attMeetingRequests.createdAt), desc(attMeetingRequests.id)).limit(100)).map(own);
}

/** For the committee and the owner: who asked, about which day, why, how long ago. Oldest first — the queue's order. */
export async function listRequests(db: Db, status: "open" | "seen" | "closed", now: Date): Promise<RequestView[]> {
  const statuses: RequestStatus[] = status === "closed" ? ["closed", "resolved_by_correction"] : [status];
  const rows = await db.select({ r: attMeetingRequests, name: attStaff.name, dept: attStaff.dept, post: attStaff.post, fullName: users.fullName })
    .from(attMeetingRequests)
    .innerJoin(users, eq(users.id, attMeetingRequests.userId))
    .leftJoin(attStaff, eq(attStaff.pin, attMeetingRequests.pin))
    .where(inArray(attMeetingRequests.status, statuses))
    .orderBy(status === "closed" ? desc(attMeetingRequests.closedAt) : asc(attMeetingRequests.createdAt)).limit(200);
  return rows.map(({ r, name, dept, post, fullName }) => ({
    ...own(r), name: name ?? fullName, dept, post, seenAt: r.seenAt?.toISOString() ?? null,
    ageHours: Math.max(0, Math.floor((now.getTime() - r.createdAt.getTime()) / 3_600_000)),
  }));
}

async function locked(tx: Tx, id: string): Promise<Row> {
  const row = (await tx.select().from(attMeetingRequests).where(eq(attMeetingRequests.id, id)).for("update"))[0];
  if (row === undefined) throw new RequestError("unknown_request");
  return row;
}
const eventPayload = (r: Row): { requestId: string; userId: string; date: string; reasonCode: string } => ({ requestId: r.id, userId: r.userId, date: r.date, reasonCode: r.reasonCode });

/** "I have seen this." Open → seen, once; marking a seen one again changes nothing. */
export async function markSeen(db: Db, actor: Actor, id: string, now: Date): Promise<OwnRequestView> {
  return withTx(db, async (tx) => {
    const row = await locked(tx, id);
    if (row.status === "closed" || row.status === "resolved_by_correction") throw new RequestError("already_closed");
    if (row.status === "seen") return own(row);
    const next = (await tx.update(attMeetingRequests).set({ status: "seen", seenBy: actor.id, seenAt: now }).where(eq(attMeetingRequests.id, id)).returning())[0]!;
    await appendEvent(tx, meetingRequestSeen.make({ actor, occurredAt: now, payload: eventPayload(next) }));
    return own(next);
  });
}

/** Close it, with an optional note. The requester is told ONCE, in fixed words. */
export async function closeRequest(db: Db, actor: Actor, id: string, note: string | null, now: Date): Promise<OwnRequestView> {
  const closed = await withTx(db, async (tx) => {
    const row = await locked(tx, id);
    if (row.status === "closed" || row.status === "resolved_by_correction") return { row, changed: false };
    const next = (await tx.update(attMeetingRequests).set({ status: "closed", closedBy: actor.id, closedAt: now, closeNote: note }).where(eq(attMeetingRequests.id, id)).returning())[0]!;
    await appendEvent(tx, meetingRequestClosed.make({ actor, occurredAt: now, payload: { ...eventPayload(next), how: "closed" } }));
    return { row: next, changed: true };
  });
  if (closed.changed) {
    await raiseNotice(db, {
      userId: closed.row.userId, kind: NOTICE_REQUEST_CLOSED, title: "Attendance request closed", body: "Attendance request closed",
      refType: "attendance_request", refId: closed.row.id, sourceKey: `attendance-request-closed:${closed.row.id}`, at: now,
    });
  }
  return own(closed.row);
}

/**
 * THE SYNC'S HALF: bioattend corrected a day (an admin added the missing punch), so it is no longer
 * `single_punch`, the person's word for it turns ordinary by itself — and a request still waiting
 * about that day has nothing left to meet about. Called by `storeDays` with the rows it just changed.
 */
export async function closeCorrected(tx: Db | Tx, changed: readonly { pin: string; date: string; status: string }[], now: Date): Promise<number> {
  const fixed = changed.filter((c) => c.status !== "single_punch");
  if (fixed.length === 0) return 0;
  const pairs = sql.join(fixed.map((c) => sql`(${c.pin}, ${c.date}::date)`), sql`, `);
  const rows = await tx.update(attMeetingRequests)
    .set({ status: "resolved_by_correction", closedAt: now })
    .where(and(inArray(attMeetingRequests.status, ACTIVE), sql`(${attMeetingRequests.pin}, ${attMeetingRequests.date}) in (${pairs})`))
    .returning();
  for (const r of rows) {
    const make = meetingRequestClosed.make({ actor: CORRECTION_ACTOR, occurredAt: now, payload: { ...eventPayload(r), how: "resolved_by_correction" } });
    await appendEvent(tx as Tx, make);
  }
  return rows.length;
}
