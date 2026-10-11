import { and, asc, count, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  REMINDER_MAX_ACTIVE, REMINDER_MAX_AHEAD_DAYS, REMINDER_MIN_LEAD_MS, REMINDER_REPEATS, REMINDER_TEXT_MAX,
  firstDue, newId, nextOccurrence,
} from "@hmis/contracts";
import { withTx } from "../db/client";
import { userReminders } from "../db/schema";
import { raiseNotice } from "../alerts/notices";
import type { Actor, ReminderRepeat, ReminderRow } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══ E1.2 — PERSONAL REMINDERS (decision 0064; spec /opt/hmis-context/SPEC-reminders-2026-10-11.md) ═══
 *
 * "Remind me at 4 pm to see bed 12." A person's own reminder: set from the phone's Reminders screen
 * today and, from E2.3, by a copilot act after one confirm — which calls `createReminder` below,
 * the same function the route calls, so the two cannot disagree about a limit.
 *
 * WHAT THE PERSON TYPED STAYS INSIDE THE APP. It is stored here and written as the BODY of their own
 * bell row (`alerts`, addressed to them alone). The phone is told the fixed sentence of the
 * `personal` category and nothing else (`push/phone-push.ts`); `alert.raised` carries no title or body.
 *
 * NO EVENTS. A personal reminder is a note to oneself, not a record of care or money; nothing reads a
 * history of them, and the bell row is the trace of each firing.
 */

export const PERSONAL_REMINDER_KIND = "personal_reminder";
export const REMINDER_REF_TYPE = "user_reminder";
/** The bell row's title, in the hospital's working language; the person's own words are its body. */
const BELL_TITLE = "Reminder";
const DAY_MS = 24 * 60 * 60 * 1000;
/** One tick fires at most this many; the rest wait twenty seconds for the next. */
const FIRE_BATCH = 200;

export type RemindersErrorCode = "user_actor_required" | "invalid_reminder" | "reminder_limit" | "unknown_reminder";
export class RemindersError extends Error {
  constructor(readonly code: RemindersErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RemindersError";
  }
}

export const createReminderBody = z.object({
  text: z.string().trim().min(1).max(REMINDER_TEXT_MAX),
  /** The instant, ISO-8601 with an offset (the phone sends IST's +05:30 or Z). */
  at: z.string().datetime({ offset: true }),
  repeat: z.enum(REMINDER_REPEATS),
});
export type CreateReminderInput = z.input<typeof createReminderBody>;

function requireUser(actor: Actor): string {
  if (actor.type !== "user") throw new RemindersError("user_actor_required");
  return actor.id;
}

function rowOut(r: typeof userReminders.$inferSelect): ReminderRow {
  return { id: r.id, text: r.text, dueAt: r.dueAt.toISOString(), repeat: r.repeat as ReminderRepeat, createdAt: r.createdAt.toISOString() };
}

const active = (userId: string) => and(eq(userReminders.userId, userId), isNull(userReminders.firedAt), isNull(userReminders.cancelledAt));

/**
 * Sets a reminder for the actor. A minute to a year ahead; at most `REMINDER_MAX_ACTIVE` active,
 * counted under a per-person transaction lock so two taps at once cannot make the 21st.
 */
export async function createReminder(db: Db, actor: Actor, input: unknown, now: Date = new Date()): Promise<ReminderRow> {
  const userId = requireUser(actor);
  const parsed = createReminderBody.safeParse(input);
  if (!parsed.success) throw new RemindersError("invalid_reminder", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { text, repeat } = parsed.data;
  const due = firstDue(repeat, new Date(parsed.data.at));
  if (due.getTime() < now.getTime() + REMINDER_MIN_LEAD_MS) throw new RemindersError("invalid_reminder", "at: must be at least a minute ahead");
  if (due.getTime() > now.getTime() + REMINDER_MAX_AHEAD_DAYS * DAY_MS) throw new RemindersError("invalid_reminder", "at: at most a year ahead");

  return withTx(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`user_reminders:${userId}`}))`);
    const [held] = await tx.select({ n: count() }).from(userReminders).where(active(userId));
    if ((held?.n ?? 0) >= REMINDER_MAX_ACTIVE) throw new RemindersError("reminder_limit");
    const [row] = await tx.insert(userReminders).values({ id: newId(), userId, text, dueAt: due, repeat, createdAt: now }).returning();
    return rowOut(row!);
  });
}

/** The actor's active reminders, soonest first. */
export async function listReminders(db: Db, actor: Actor): Promise<ReminderRow[]> {
  const userId = requireUser(actor);
  const rows = await db.select().from(userReminders).where(active(userId)).orderBy(asc(userReminders.dueAt));
  return rows.map(rowOut);
}

/**
 * Cancels one of the actor's own reminders. Another person's id answers exactly as an unknown id
 * does — whether it exists is not theirs to learn. Cancelling a spent or cancelled one is a no-op.
 */
export async function cancelReminder(db: Db, actor: Actor, id: string, now: Date = new Date()): Promise<{ id: string; cancelled: boolean }> {
  const userId = requireUser(actor);
  const mine = await db.select({ id: userReminders.id }).from(userReminders).where(and(eq(userReminders.id, id), eq(userReminders.userId, userId)));
  if (mine.length === 0) throw new RemindersError("unknown_reminder");
  const done = await db.update(userReminders).set({ cancelledAt: now })
    .where(and(eq(userReminders.id, id), active(userId))).returning({ id: userReminders.id });
  return { id, cancelled: done.length > 0 };
}

/** The bell row's key for ONE firing — the same reminder at the same time raises nothing twice. */
export function reminderKey(id: string, dueAt: Date): string {
  return `reminder:${id}:${dueAt.toISOString()}`;
}

/**
 * Fires every due reminder. Runs on the `runDueTimers` tick (20 s), so a reminder fires within
 * 60 s of its time with room to spare.
 *
 * RAISE, THEN CLAIM. The bell row is raised first under `reminderKey` — `(source_event_id, user_id)`
 * is unique, so a second raise of the same firing writes and announces nothing — and only then is
 * the reminder claimed by a conditional UPDATE on its OLD `due_at`. A process that dies between the
 * two leaves the reminder due; the next tick re-raises (absorbed by the key) and claims it. Two
 * workers at once: both raises collapse into one row, one claim wins. Exactly one bell row, one
 * `alert.raised`, one phone notification — whatever crashed. Returns how many it claimed.
 */
export async function runDueReminders(db: Db, now: Date = new Date()): Promise<number> {
  const due = await db.select().from(userReminders)
    .where(and(lte(userReminders.dueAt, now), isNull(userReminders.firedAt), isNull(userReminders.cancelledAt)))
    .orderBy(asc(userReminders.dueAt)).limit(FIRE_BATCH);
  let fired = 0;
  for (const r of due) {
    await raiseNotice(db, {
      userId: r.userId, kind: PERSONAL_REMINDER_KIND, title: BELL_TITLE, body: r.text,
      refType: REMINDER_REF_TYPE, refId: r.id, sourceKey: reminderKey(r.id, r.dueAt), at: now,
    });
    const next = nextOccurrence(r.repeat as ReminderRepeat, r.dueAt, now);
    const claimed = await db.update(userReminders)
      .set(next === null ? { firedAt: now } : { dueAt: next })
      .where(and(eq(userReminders.id, r.id), eq(userReminders.dueAt, r.dueAt), isNull(userReminders.firedAt), isNull(userReminders.cancelledAt)))
      .returning({ id: userReminders.id });
    if (claimed.length > 0) fired += 1;
  }
  return fired;
}
