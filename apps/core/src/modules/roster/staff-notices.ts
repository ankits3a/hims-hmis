import { and, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { orgDepartments } from "../../kernel/db/schema/org";
import { rosterAssignments, rosterCoverRequests } from "../../kernel/db/schema/roster";
import { users } from "../../kernel/db/schema/auth";
import { raiseNotice } from "../../kernel/alerts/notices";
import { istDateOfInstant, istMinutesOfInstant } from "./calendar";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ MOBILE §3i (owner 2026-10-07) — WHAT THE BELL SAYS ABOUT A PERSON'S OWN DUTIES ═══
 *
 * M6b put the bell on the phone and found the roster raised only ONE kind of row (a "this is wrong"
 * flag, to the duty manager). A cover asked of me, the answer to mine, a duty that moved and the
 * duty that starts in an hour reached nobody. This file is the roster's half of fixing that: the
 * READS the alerts consumer needs to word a row, and the one sweep the clock drives.
 *
 * STAFF NAMES, DUTY INSTANTS, A DEPARTMENT. A duty concerns no patient, so GC6 has nothing to strip
 * — and the PHONE is told none of it anyway (`kernel/push/phone-push.ts` picks a fixed sentence).
 * The requester's NOTE is not read here: it is the free text V9 keeps off every surface but the row.
 */

const HHMM = (at: Date): string => {
  const m = istMinutesOfInstant(at);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "07 Oct" of an instant's IST day — built from the calendar's own reading, no second copy of the offset. */
const DAY = (at: Date): string => {
  const d = istDateOfInstant(at);
  return `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
};
/** "07 Oct, 20:00–08:00 IST". */
export const dutyWindowLabel = (startsAt: Date, endsAt: Date): string => `${DAY(startsAt)}, ${HHMM(startsAt)}–${HHMM(endsAt)} IST`;

export type CoverForAlert = {
  requestId: string; kind: string; status: string;
  ownerId: string; ownerName: string; counterpartId: string; counterpartName: string;
  requestedBy: string; lastActorId: string | null;
  /** The duty asked about, and (a swap) the one offered back. */
  duty: string; give: string | null; departmentName: string | null;
};

/** One cover or swap, worded for a bell row. Null for an unknown id. */
export async function coverForAlert(exec: Db | Tx, requestId: string): Promise<CoverForAlert | null> {
  const r = (await (exec as Db).select().from(rosterCoverRequests).where(eq(rosterCoverRequests.id, requestId)))[0];
  if (r === undefined) return null;
  const names = new Map((await (exec as Db).select({ id: users.id, fullName: users.fullName }).from(users)
    .where(inArray(users.id, [r.ownerId, r.counterpartId]))).map((u) => [u.id, u.fullName]));
  const slotIds = [r.assignmentId, ...(r.counterpartAssignmentId === null ? [] : [r.counterpartAssignmentId])];
  const slots = new Map((await (exec as Db).select({ id: rosterAssignments.id, startsAt: rosterAssignments.startsAt, endsAt: rosterAssignments.endsAt })
    .from(rosterAssignments).where(inArray(rosterAssignments.id, slotIds))).map((a) => [a.id, a]));
  const label = (id: string | null): string | null => {
    const a = id === null ? undefined : slots.get(id);
    return a === undefined ? null : dutyWindowLabel(a.startsAt, a.endsAt);
  };
  const dept = (await (exec as Db).select({ name: orgDepartments.name }).from(orgDepartments).where(eq(orgDepartments.id, r.departmentId)))[0]?.name ?? null;
  return {
    requestId: r.id, kind: r.kind, status: r.status,
    ownerId: r.ownerId, ownerName: names.get(r.ownerId) ?? r.ownerId,
    counterpartId: r.counterpartId, counterpartName: names.get(r.counterpartId) ?? r.counterpartId,
    requestedBy: r.requestedBy, lastActorId: r.updatedBy ?? null,
    duty: label(r.assignmentId) ?? "a duty", give: label(r.counterpartAssignmentId), departmentName: dept,
  };
}

/**
 * Was this amendment applied BY an approved cover or swap? Then `roster.cover_decided` already tells
 * both people, in better words, and "your duties changed" would be the same fact twice on one phone.
 */
export async function amendmentIsOfCover(exec: Db | Tx, amendmentId: string): Promise<boolean> {
  const rows = await (exec as Db).select({ id: rosterCoverRequests.id }).from(rosterCoverRequests)
    .where(sql`${rosterCoverRequests.amendmentIds} @> ${JSON.stringify([amendmentId])}::jsonb`).limit(1);
  return rows.length > 0;
}

/** The windows of a set of assignment ids, soonest first — what "your duties changed" lists. */
export async function dutyWindowsForAlert(exec: Db | Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await (exec as Db).select({ startsAt: rosterAssignments.startsAt, endsAt: rosterAssignments.endsAt, kind: rosterAssignments.kind })
    .from(rosterAssignments).where(inArray(rosterAssignments.id, [...ids]));
  return rows.filter((r) => r.kind !== "off").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map((r) => dutyWindowLabel(r.startsAt, r.endsAt));
}

/* ═══════════════════════════════ the duty reminders ═══════════════════════════════ */

export const ROSTER_DUTY_REMINDER_KIND = "roster_duty_reminder";
export const ROSTER_DUTY_REF_TYPE = "roster_duty";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** DECIDED (owner's delegation, 2026-10-07): one reminder an hour before ANY duty… */
export const REMINDER_SHORT_MS = HOUR;
/** …and one twelve hours before a NIGHT or a 24-hour duty — the evening-before "you are on tonight / tomorrow". */
export const REMINDER_LONG_MS = 12 * HOUR;
/** A tick this late still sends; later than this the moment has passed and a stale reminder is noise. */
export const REMINDER_WINDOW_MS = 30 * MIN;
/** The long reminder never lands between 22:00 and 06:00 IST: it is moved EARLIER, to 21:00 that evening. */
const QUIET_FROM_MIN = 22 * 60;
const QUIET_TO_MIN = 6 * 60;
const QUIET_LANDING_MIN = 21 * 60;

type Slot = { id: string; userId: string; startsAt: Date; endsAt: Date; departmentId: string };

/** A duty that begins in the evening or the small hours, or runs twelve hours or more (a take). */
export function wantsLongReminder(s: { startsAt: Date; endsAt: Date }): boolean {
  const m = istMinutesOfInstant(s.startsAt);
  return m >= 18 * 60 || m < 6 * 60 || s.endsAt.getTime() - s.startsAt.getTime() >= 12 * HOUR;
}

/**
 * WHEN the long reminder is due: twelve hours before the duty — unless that instant is in the quiet
 * hours, in which case 21:00 IST of the evening before it. Always EARLIER, never later: a reminder
 * moved to 06:00 for an 08:00 take is two hours' notice dressed as twelve.
 */
export function longReminderAt(startsAt: Date): Date {
  const at = new Date(startsAt.getTime() - REMINDER_LONG_MS);
  const m = istMinutesOfInstant(at);
  if (m >= QUIET_FROM_MIN) return new Date(at.getTime() - (m - QUIET_LANDING_MIN) * MIN);
  if (m < QUIET_TO_MIN) return new Date(at.getTime() - (m + 24 * 60 - QUIET_LANDING_MIN) * MIN);
  return at;
}

export type DutyReminder = { lead: "1h" | "12h"; assignmentId: string; userId: string; startsAt: Date; endsAt: Date; departmentId: string };

/**
 * The reminders due at `now`, from the PUBLISHED roster only (`effective` rows — what My duties
 * shows). A person already on a duty that runs into this one is not reminded of it an hour ahead:
 * they are in the building, and the handover is the reminder.
 */
export async function dueDutyReminders(exec: Db | Tx, now: Date): Promise<DutyReminder[]> {
  const horizon = new Date(now.getTime() + REMINDER_LONG_MS + 9 * HOUR + REMINDER_WINDOW_MS);
  const rows: Slot[] = (await (exec as Db).select({
    id: rosterAssignments.id, userId: rosterAssignments.userId, startsAt: rosterAssignments.startsAt,
    endsAt: rosterAssignments.endsAt, departmentId: rosterAssignments.departmentId,
  }).from(rosterAssignments).where(and(
    eq(rosterAssignments.effective, true), eq(rosterAssignments.kind, "duty"), isNotNull(rosterAssignments.userId),
    gt(rosterAssignments.endsAt, now), lt(rosterAssignments.startsAt, horizon),
  ))).flatMap((r) => (r.userId === null ? [] : [{ ...r, userId: r.userId }]));

  const due: DutyReminder[] = [];
  const within = (at: Date): boolean => at.getTime() <= now.getTime() && now.getTime() < at.getTime() + REMINDER_WINDOW_MS;
  for (const s of rows) {
    if (s.startsAt.getTime() <= now.getTime()) continue; // already begun
    const onDutyInto = rows.some((o) => o.userId === s.userId && o.id !== s.id && o.startsAt.getTime() < s.startsAt.getTime() && o.endsAt.getTime() >= s.startsAt.getTime());
    const base = { assignmentId: s.id, userId: s.userId, startsAt: s.startsAt, endsAt: s.endsAt, departmentId: s.departmentId };
    if (!onDutyInto && within(new Date(s.startsAt.getTime() - REMINDER_SHORT_MS))) due.push({ lead: "1h", ...base });
    if (!onDutyInto && wantsLongReminder(s) && within(longReminderAt(s.startsAt))) due.push({ lead: "12h", ...base });
  }
  return due;
}

/** The clock's half: raise each due reminder once (the key is the duty and the lead). Returns how many were new. */
export async function sweepDutyReminders(db: Db, now: Date = new Date()): Promise<number> {
  const due = await dueDutyReminders(db, now);
  if (due.length === 0) return 0;
  const depts = new Map((await db.select({ id: orgDepartments.id, name: orgDepartments.name }).from(orgDepartments)
    .where(inArray(orgDepartments.id, [...new Set(due.map((d) => d.departmentId))]))).map((d) => [d.id, d.name]));
  let raised = 0;
  for (const d of due) {
    const where = depts.get(d.departmentId) ?? "your department";
    const won = await raiseNotice(db, {
      userId: d.userId, kind: ROSTER_DUTY_REMINDER_KIND,
      title: d.lead === "1h" ? `Your duty starts at ${HHMM(d.startsAt)} IST` : `You are on duty: ${dutyWindowLabel(d.startsAt, d.endsAt)}`,
      body: `${where} · ${dutyWindowLabel(d.startsAt, d.endsAt)}. Open My duties — if you cannot do it, ask for cover there.`,
      refType: ROSTER_DUTY_REF_TYPE, refId: d.assignmentId,
      sourceKey: `roster-duty-reminder:${d.lead}:${d.assignmentId}`, at: now,
    });
    if (won) raised += 1;
  }
  return raised;
}
