import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  attDays, attHolidays, attLeaves, attOnDuty, attPunches, attRoster, attShifts, attStaff, attSyncState,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { appendEvent } from "../../kernel/events/append";
import { BioattendError, MAX_RANGE_DAYS, PUNCH_PAGE, createBioattendClient } from "./client";
import { attendanceSyncRefused, attendanceSynced } from "./events";
import { addDays, chunkRange, istDate, istTime, monthStart, previousMonth } from "./ist";
import { linkPeople } from "./linking";
import { closeCorrected } from "./requests";
import { apiKeyOf } from "./secrets";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { BioDay, BioPunch, BioattendClient, FetchLike } from "./client";
import type { AttendanceConfig } from "./secrets";

/**
 * ═══ `syncAttendance` — THE ONE JOB THAT KEEPS HMIS'S COPY OF BIOATTEND CURRENT ═══
 *
 * Every two minutes (`kernel/worker/jobs.ts`). ONE job, staged inside by cadence, because a job is a
 * name in a seven-site census and a pool client; each stage FAILS SOFT and writes its own row of
 * `att_sync_state`, so a broken `/roster` never stops punches.
 *
 *   punches    every run   `after_id` paging from the stored cursor until `more` is false
 *   today      every run   today's `/attendance`, and `/on-duty`
 *   reference  30 minutes  `/staff` (then linking), `/leaves` `/roster` `/holidays` for
 *                          yesterday … today+14, `/shifts`
 *   months     nightly     01:30–02:00 IST: `/attendance` for the open month, and the previous one
 *                          while any of its days is not locked. Also on the first run ever.
 *
 * OFF MEANS ZERO CALLS. No readable API key, or `ATTENDANCE_SYNC_ENABLED` not "true", and this
 * returns before a client exists. BOTH must be there.
 *
 * A REFUSAL (401/403) IS NOT RETRIED AND ENDS THE RUN — the next stage would be refused the same
 * way, and bioattend logs every one. It raises `attendance.sync_refused` at most once an hour and
 * the job stays away for `REFUSED_BACKOFF_MS` before it asks again.
 */
export const SYNC_ACTOR: Actor = { type: "system", id: "attendance-sync" };
export const SYNC_STAGES = ["punches", "today", "reference", "months"] as const;
export type SyncStage = (typeof SYNC_STAGES)[number];

/** Pages of 1 000 punches one run may pull: the first-ever history load is spread over runs, not one burst. */
export const PUNCH_PAGES_PER_RUN = 20;
export const REFERENCE_EVERY_MS = 30 * 60_000;
export const NIGHTLY_WINDOW_IST = { from: "01:30", to: "02:00" } as const;
export const REFUSED_BACKOFF_MS = 10 * 60_000;
export const REFUSED_EVENT_EVERY_MS = 60 * 60_000;
const REFERENCE_DAYS_BACK = 1;
const REFERENCE_DAYS_AHEAD = 14;

export type SyncCounts = { punches: number; days: number; onDuty: number; staff: number; leaves: number; roster: number; holidays: number; shifts: number; linked: number };
export type SyncSummary =
  | { ran: false; why: "not_configured" | "switched_off" | "backing_off" }
  | { ran: true; counts: SyncCounts; stages: Partial<Record<SyncStage, "ok" | "skipped" | string>>; refused: boolean; calls: number };

export type SyncDeps = { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; pagesPerRun?: number; backoffMs?: number };

const zero = (): SyncCounts => ({ punches: 0, days: 0, onDuty: 0, staff: 0, leaves: 0, roster: 0, holidays: 0, shifts: 0, linked: 0 });

async function stateOf(db: Db | Tx, stage: string): Promise<typeof attSyncState.$inferSelect | undefined> {
  return (await db.select().from(attSyncState).where(eq(attSyncState.stage, stage)))[0];
}

async function writeState(db: Db | Tx, stage: string, set: Partial<typeof attSyncState.$inferInsert>): Promise<void> {
  await db.insert(attSyncState).values({ stage, ...set }).onConflictDoUpdate({ target: attSyncState.stage, set });
}

/** What a failure is CALLED in `att_sync_state` — an outcome and a status, never a message that could carry a URL. */
function errorClass(e: unknown): string {
  if (e instanceof BioattendError) return e.status === null ? e.outcome : `${e.outcome} (HTTP ${e.status})`;
  return "internal_error";
}

/** Insert-or-ignore on bioattend's id — the webhook and the pull can both deliver a punch. Returns how many were new. */
export async function storePunches(tx: Db | Tx, punches: readonly BioPunch[], via: "pull" | "webhook", now: Date): Promise<number> {
  if (punches.length === 0) return 0;
  const rows = punches.map((p) => ({
    id: p.id, pin: p.pin, ts: p.ts, day: p.ts.slice(0, 10), direction: p.direction, verify: p.verify, device: p.device, origin: p.origin,
    receivedVia: via, receivedAt: now,
  }));
  const done = await tx.insert(attPunches).values(rows).onConflictDoNothing({ target: attPunches.id }).returning({ id: attPunches.id });
  return done.length;
}

/**
 * Upsert days. A stored row that is `locked` is FINAL and is left exactly as it is; an open row is
 * rewritten only when something in it differs, so the count returned is rows that really changed.
 */
export async function storeDays(tx: Db | Tx, days: readonly BioDay[], now: Date): Promise<number> {
  let changed = 0;
  for (let i = 0; i < days.length; i += 500) {
    const rows = days.slice(i, i + 500).map((d) => ({
      pin: d.pin, date: d.date, firstIn: d.first_in, lastOut: d.last_out, hoursWorked: d.hours_worked, otMinutes: d.ot_minutes,
      shiftName: d.shift_name, status: d.status, dayType: d.day_type, locked: d.locked, fetchedAt: now,
    }));
    const done = await tx.insert(attDays).values(rows).onConflictDoUpdate({
      target: [attDays.pin, attDays.date],
      set: {
        firstIn: sql`excluded.first_in`, lastOut: sql`excluded.last_out`, hoursWorked: sql`excluded.hours_worked`,
        otMinutes: sql`excluded.ot_minutes`, shiftName: sql`excluded.shift_name`, status: sql`excluded.status`,
        dayType: sql`excluded.day_type`, locked: sql`excluded.locked`, fetchedAt: sql`excluded.fetched_at`,
      },
      setWhere: sql`${attDays.locked} = false and (${attDays.firstIn}, ${attDays.lastOut}, ${attDays.hoursWorked}, ${attDays.otMinutes}, ${attDays.shiftName}, ${attDays.status}, ${attDays.dayType}, ${attDays.locked})
        is distinct from (excluded.first_in, excluded.last_out, excluded.hours_worked, excluded.ot_minutes, excluded.shift_name, excluded.status, excluded.day_type, excluded.locked)`,
    }).returning({ pin: attDays.pin, date: attDays.date, status: attDays.status });
    changed += done.length;
    await closeCorrected(tx, done, now);
  }
  return changed;
}

async function stagePunches(db: Db, client: BioattendClient, now: Date, pagesPerRun: number): Promise<number> {
  let after = (await stateOf(db, "punches"))?.cursor ?? 0;
  let stored = 0;
  for (let page = 0; page < pagesPerRun; page++) {
    const body = await client.punches(after, PUNCH_PAGE);
    const next = Math.max(after, body.next_after_id, ...body.punches.map((p) => p.id));
    // The page and the cursor land TOGETHER: a crash between them is a crash before both, and the
    // next run asks for the same page again (insert-or-ignore makes that harmless).
    stored += await withTx(db, async (tx) => {
      const n = await storePunches(tx, body.punches, "pull", now);
      await writeState(tx, "punches", { cursor: next });
      return n;
    });
    const stuck = next === after;
    after = next;
    if (!body.more || stuck) break;
  }
  return stored;
}

async function stageToday(db: Db, client: BioattendClient, now: Date, today: string): Promise<{ days: number; onDuty: number }> {
  const days = await storeDays(db, await client.attendance(today, today), now);
  const duty = await client.onDuty();
  await withTx(db, async (tx) => {
    await tx.delete(attOnDuty);
    if (duty.on_duty.length > 0) {
      await tx.insert(attOnDuty).values(duty.on_duty.map((d) => ({ pin: d.pin, inSince: d.in_since, device: d.device, asOf: duty.as_of }))).onConflictDoNothing();
    }
    await writeState(tx, "today", { note: duty.as_of });
  });
  return { days, onDuty: duty.on_duty.length };
}

async function stageReference(db: Db, client: BioattendClient, now: Date, today: string): Promise<Pick<SyncCounts, "staff" | "leaves" | "roster" | "holidays" | "shifts" | "linked">> {
  const from = addDays(today, -REFERENCE_DAYS_BACK);
  const to = addDays(today, REFERENCE_DAYS_AHEAD);
  const [staff, leaves, roster, holidays, shifts] = [await client.staff(), await client.leaves(from, to), await client.roster(from, to), await client.holidays(from, to), await client.shifts()];
  return withTx(db, async (tx) => {
    let staffChanged = 0;
    for (let i = 0; i < staff.length; i += 500) {
      const rows = staff.slice(i, i + 500).map((s) => ({
        pin: s.pin, name: s.name, dept: s.dept, post: s.post, gender: s.gender, mobile: s.mobile, status: s.status,
        joiningDate: s.joining_date, dateOfLeaving: s.date_of_leaving, workDays: s.work_days, aadhaarHash: s.aadhaar_hash,
        firstSeenAt: now, updatedAt: now,
      }));
      // The link (`user_id`, `link_source`, `linked_at`) is HMIS's own and is not in the SET: a staff
      // refresh can never unlink or re-point anybody.
      const done = await tx.insert(attStaff).values(rows).onConflictDoUpdate({
        target: attStaff.pin,
        set: {
          name: sql`excluded.name`, dept: sql`excluded.dept`, post: sql`excluded.post`, gender: sql`excluded.gender`, mobile: sql`excluded.mobile`,
          status: sql`excluded.status`, joiningDate: sql`excluded.joining_date`, dateOfLeaving: sql`excluded.date_of_leaving`,
          workDays: sql`excluded.work_days`, aadhaarHash: sql`excluded.aadhaar_hash`, updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`(${attStaff.name}, ${attStaff.dept}, ${attStaff.post}, ${attStaff.gender}, ${attStaff.mobile}, ${attStaff.status}, ${attStaff.joiningDate}, ${attStaff.dateOfLeaving}, ${attStaff.workDays}, ${attStaff.aadhaarHash})
          is distinct from (excluded.name, excluded.dept, excluded.post, excluded.gender, excluded.mobile, excluded.status, excluded.joining_date, excluded.date_of_leaving, excluded.work_days, excluded.aadhaar_hash)`,
      }).returning({ pin: attStaff.pin });
      staffChanged += done.length;
    }
    // Leaves, roster and holidays are REPLACED for the window read: a leave cancelled upstream must
    // disappear here, and an upsert alone would keep it for ever.
    await tx.delete(attLeaves).where(and(gte(attLeaves.date, from), lte(attLeaves.date, to)));
    for (let i = 0; i < leaves.length; i += 1000) {
      await tx.insert(attLeaves).values(leaves.slice(i, i + 1000).map((l) => ({ pin: l.pin, date: l.date, reason: l.reason, fetchedAt: now }))).onConflictDoNothing();
    }
    await tx.delete(attRoster).where(and(gte(attRoster.date, from), lte(attRoster.date, to)));
    for (let i = 0; i < roster.length; i += 1000) {
      await tx.insert(attRoster).values(roster.slice(i, i + 1000).map((r) => ({
        pin: r.pin, date: r.date, shiftName: r.shift_name, startTime: r.start, endTime: r.end, off: r.off, holiday: r.holiday, leave: r.leave, fetchedAt: now,
      }))).onConflictDoNothing();
    }
    await tx.delete(attHolidays).where(and(gte(attHolidays.date, from), lte(attHolidays.date, to)));
    if (holidays.length > 0) await tx.insert(attHolidays).values(holidays.map((h) => ({ date: h.date, name: h.name, dept: h.dept, cancelled: h.cancelled, fetchedAt: now })));
    await tx.delete(attShifts);
    if (shifts.length > 0) {
      await tx.insert(attShifts).values(shifts.map((s) => ({
        id: s.id, name: s.name, dept: s.dept, checkinTime: s.checkin_time, checkoutTime: s.checkout_time, crossesMidnight: s.crosses_midnight,
        graceMinutes: s.grace_minutes, kind: s.kind, weeklyOffDays: s.weekly_off_days, fetchedAt: now,
      }))).onConflictDoNothing();
    }
    const { linked } = await linkPeople(tx, now);
    return { staff: staffChanged, leaves: leaves.length, roster: roster.length, holidays: holidays.length, shifts: shifts.length, linked };
  });
}

/** The open month to today, and the previous month while any stored day of it is not locked (or none is stored). */
async function stageMonths(db: Db, client: BioattendClient, now: Date, today: string): Promise<number> {
  const ranges = [{ from: monthStart(today), to: today }];
  const prev = previousMonth(today);
  const held = (await db.select({ n: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${attDays.locked} = false)::int` })
    .from(attDays).where(and(gte(attDays.date, prev.from), lte(attDays.date, prev.to))))[0]!;
  if (held.n === 0 || held.open > 0) ranges.push(prev);
  let changed = 0;
  for (const r of ranges) for (const c of chunkRange(r.from, r.to, MAX_RANGE_DAYS)) changed += await storeDays(db, await client.attendance(c.from, c.to), now);
  return changed;
}

export async function syncAttendance(db: Db, cfg: AttendanceConfig | undefined, now: Date = new Date(), deps: SyncDeps = {}): Promise<SyncSummary> {
  if (cfg === undefined || apiKeyOf(cfg, now.getTime()) === null) return { ran: false, why: "not_configured" };
  if (!cfg.syncEnabled) return { ran: false, why: "switched_off" };
  const refusedRow = await stateOf(db, "refused");
  if (refusedRow?.lastAttemptAt !== undefined && refusedRow.lastAttemptAt !== null && now.getTime() - refusedRow.lastAttemptAt.getTime() < REFUSED_BACKOFF_MS) {
    return { ran: false, why: "backing_off" };
  }

  const client = createBioattendClient({
    baseUrl: cfg.baseUrl, key: () => apiKeyOf(cfg), fetch: deps.fetch, sleep: deps.sleep,
    ...(deps.backoffMs === undefined ? {} : { backoffMs: deps.backoffMs }),
  });
  const today = istDate(now);
  const clock = istTime(now);
  const counts = zero();
  const stages: Partial<Record<SyncStage, string>> = {};
  // A holder, not a `let`: it is written inside `run`'s closure and read after it.
  const seen: { refused: BioattendError | null } = { refused: null };

  const run = async (stage: SyncStage, due: boolean, body: () => Promise<void>, okNote?: string): Promise<void> => {
    if (seen.refused !== null) return;
    if (!due) { stages[stage] = "skipped"; return; }
    await writeState(db, stage, { lastAttemptAt: now });
    try {
      await body();
      await writeState(db, stage, { lastOkAt: now, lastOutcome: "ok", lastError: null, ...(okNote === undefined ? {} : { note: okNote }) });
      stages[stage] = "ok";
    } catch (e) {
      const cls = errorClass(e);
      await writeState(db, stage, { lastOutcome: e instanceof BioattendError ? e.outcome : "internal_error", lastError: cls });
      stages[stage] = cls;
      if (e instanceof BioattendError && e.refused) seen.refused = e;
      // Anything that is not bioattend answering badly is a defect here: say so in the worker's log,
      // by class only — a message could carry a row.
      else if (!(e instanceof BioattendError)) console.error(`attendance sync: stage ${stage} failed (${e instanceof Error ? e.name : "error"})`);
    }
  };

  await run("punches", true, async () => { counts.punches = await stagePunches(db, client, now, deps.pagesPerRun ?? PUNCH_PAGES_PER_RUN); });
  await run("today", true, async () => { Object.assign(counts, await stageToday(db, client, now, today)); });

  const ref = await stateOf(db, "reference");
  const refDue = ref?.lastOkAt === undefined || ref.lastOkAt === null || now.getTime() - ref.lastOkAt.getTime() >= REFERENCE_EVERY_MS;
  await run("reference", refDue, async () => { Object.assign(counts, await stageReference(db, client, now, today)); });

  const months = await stateOf(db, "months");
  const never = months?.lastOkAt === undefined || months.lastOkAt === null;
  const inWindow = clock >= NIGHTLY_WINDOW_IST.from && clock < NIGHTLY_WINDOW_IST.to && months?.note !== today;
  await run("months", never || inWindow, async () => { counts.days += await stageMonths(db, client, now, today); }, today);

  // The `refused` row: `last_attempt_at` is the last refusal (the back-off reads it), `last_ok_at`
  // the last time somebody was TOLD (the once-an-hour rule reads it).
  if (seen.refused !== null) {
    const r = seen.refused;
    const lastTold = refusedRow?.lastOkAt ?? null;
    const tell = lastTold === null || now.getTime() - lastTold.getTime() >= REFUSED_EVENT_EVERY_MS;
    await withTx(db, async (tx) => {
      await writeState(tx, "refused", { lastAttemptAt: now, lastOutcome: r.outcome, lastError: errorClass(r), ...(tell ? { lastOkAt: now } : {}) });
      if (tell) await appendEvent(tx, attendanceSyncRefused.make({ actor: SYNC_ACTOR, occurredAt: now, payload: { status: r.status ?? 0, outcome: r.outcome } }));
    });
  }
  if (Object.values(counts).some((n) => n > 0)) {
    await withTx(db, (tx) => appendEvent(tx, attendanceSynced.make({ actor: SYNC_ACTOR, occurredAt: now, payload: counts })));
  }
  return { ran: true, counts, stages, refused: seen.refused !== null, calls: client.callCount() };
}
