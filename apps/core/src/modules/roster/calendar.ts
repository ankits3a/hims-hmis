import { and, asc, eq, gt, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  ROSTER_ACTIVITIES, ROSTER_HOLIDAY_KINDS, ROSTER_HOLIDAY_PATTERNS,
  rosterCycleEntries, rosterCycleOverlays, rosterCycles, rosterDutyWindows, rosterHolidays,
} from "../../kernel/db/schema/roster";
import { orgDepartments } from "../../kernel/db/schema/org";
import { RosterError } from "./errors";
import { requireRosterAct } from "./access";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type {
  RosterActivity, RosterHolidayKind, RosterHolidayPattern,
} from "../../kernel/db/schema/roster";

/**
 * PHASE R (R7) — **THE CALENDAR A DEPARTMENT ACTUALLY RUNS ON.**
 *
 * Read `kernel/db/schema/roster.ts`'s R7 header first: why a week is a cycle, why Sunday has its own
 * sequence, and why a declared holiday must not advance it.
 *
 * ═══ `expandCycle` IS PURE AND IS THE ONLY GENERATOR (V15) ═══
 *
 * Materialised windows and the answer a resolver would compute on the fly must agree on every
 * instant, or the hospital has two calendars. The only way to guarantee that is for there to be one
 * function — and for it to take no database, no clock and no configuration, so that a test can
 * compare ninety days of both without a fixture.
 *
 * ═══ EVERY MINUTE IS IST, AND NO INSTANT IS EVER A LOCAL TIME ═══
 *
 * A cycle entry says `start_minute: 480`, which is 08:00 **in the hospital**. It becomes an instant
 * exactly once, here, by adding it to that IST day's midnight. The database session is `Etc/UTC`
 * (ground truth G6), and if it were not, every window in this file would silently move by five and
 * a half hours — which is why V12 asserts the take handover at **07:59 and 08:00** rather than
 * trusting that.
 */

const IST_OFFSET_MINUTES = 330;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The UTC instant of IST midnight on a calendar day. The one place a date becomes an instant. */
export function istMidnightUtc(istDate: string): Date {
  assertIstDate(istDate);
  return new Date(Date.parse(`${istDate}T00:00:00Z`) - IST_OFFSET_MINUTES * MINUTE_MS);
}

function assertIstDate(d: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new RosterError("invalid_window", `"${d}" is not a calendar day`, { date: d });
  }
}

export const addIstDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** 0 = Sunday. The string IS the IST calendar day, so its weekday is the calendar's. */
export const istWeekday = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();

/** A short OPD on a restricted holiday: the clinic opens and closes at lunch. */
export const SHORT_OPD_MINUTES = 180;

/* ═══════════════════════════════ the pure generator ═══════════════════════════════ */

export interface CycleEntrySpec {
  dayIndex: number;
  teamId: string;
  activity: RosterActivity;
  startMinute: number;
  durationMinutes: number;
}

export interface OverlayEntrySpec {
  sequencePosition: number;
  teamId: string;
  activity: RosterActivity;
  startMinute: number;
  durationMinutes: number;
}

export interface CycleSpec {
  cycleDays: number;
  anchorIstDate: string;
  entries: readonly CycleEntrySpec[];
  /** The Sunday sequence. Empty means Sundays run the ordinary cycle. */
  overlays?: readonly OverlayEntrySpec[];
  overlayAnchorIstDate?: string;
}

export interface HolidaySpec {
  istDate: string;
  kind: RosterHolidayKind;
  pattern: RosterHolidayPattern;
}

export interface PlannedWindow {
  istDate: string;
  teamId: string;
  activity: RosterActivity;
  startsAt: Date;
  endsAt: Date;
  source: "cycle" | "overlay";
  overlayIndex: number | null;
}

/**
 * ═══ THE OVERLAY POSITION IS THE COUNT OF SUNDAYS, AND NOTHING ELSE ═══
 *
 * A declared holiday runs the Sunday PATTERN and does not advance the SEQUENCE, so the sequence
 * position must be a function of Sundays alone. Counting them from the overlay's own anchor makes
 * that true by construction and keeps this function pure — no state carried across days, no
 * dependence on which order the caller expands in, and the same answer for one day computed alone
 * as for that day inside a ninety-day expansion.
 *
 * The alternative — a counter incremented while walking — is what makes the bug possible: expand
 * from a different start date and every unit's Sunday moves.
 */
function overlayPositionFor(istDate: string, overlayAnchor: string): number {
  const days = daysBetween(overlayAnchor, istDate);
  if (days < 0) return 0;
  // Sundays strictly after the anchor, up to and including this day.
  let sundays = 0;
  for (let i = 0; i <= days; i += 1) {
    if (istWeekday(addIstDays(overlayAnchor, i)) === 0) sundays += 1;
  }
  return Math.max(0, sundays - 1);
}

export function expandCycle(
  spec: CycleSpec, fromIstDate: string, toIstDate: string, holidays: readonly HolidaySpec[] = [],
): PlannedWindow[] {
  assertIstDate(fromIstDate);
  assertIstDate(toIstDate);
  if (spec.cycleDays < 1) {
    throw new RosterError("invalid_window", "a cycle is at least one day long", { cycleDays: spec.cycleDays });
  }
  const overlays = spec.overlays ?? [];
  const overlayAnchor = spec.overlayAnchorIstDate ?? spec.anchorIstDate;
  const overlayPositions = overlays.length === 0
    ? 0
    : Math.max(...overlays.map((o) => o.sequencePosition)) + 1;
  const byDate = new Map(holidays.map((h) => [h.istDate, h]));

  const out: PlannedWindow[] = [];
  const total = daysBetween(fromIstDate, toIstDate);
  for (let i = 0; i < total; i += 1) {
    const istDate = addIstDays(fromIstDate, i);
    const holiday = byDate.get(istDate);
    const isSunday = istWeekday(istDate) === 0;
    const runsOverlay = overlays.length > 0 && (isSunday || holiday?.pattern === "as_sunday");

    const midnight = istMidnightUtc(istDate).getTime();
    const emit = (
      e: { teamId: string; activity: RosterActivity; startMinute: number; durationMinutes: number },
      source: "cycle" | "overlay", overlayIndex: number | null,
    ): void => {
      let duration = e.durationMinutes;
      // The two patterns that do not replace the day but PRUNE it.
      if (holiday !== undefined && holiday.pattern !== "as_sunday") {
        if (holiday.pattern === "opd_off_ot_proceeds" && (e.activity === "opd" || e.activity === "elective_ot")) return;
        if (holiday.pattern === "opd_short") {
          if (e.activity === "elective_ot") return;
          if (e.activity === "opd") duration = Math.min(duration, SHORT_OPD_MINUTES);
        }
      }
      out.push({
        istDate, teamId: e.teamId, activity: e.activity,
        startsAt: new Date(midnight + e.startMinute * MINUTE_MS),
        endsAt: new Date(midnight + (e.startMinute + duration) * MINUTE_MS),
        source, overlayIndex,
      });
    };

    if (runsOverlay) {
      const position = overlayPositionFor(istDate, overlayAnchor) % overlayPositions;
      for (const o of overlays.filter((x) => x.sequencePosition === position)) emit(o, "overlay", position);
      continue;
    }

    const offset = daysBetween(spec.anchorIstDate, istDate);
    const dayIndex = ((offset % spec.cycleDays) + spec.cycleDays) % spec.cycleDays;
    for (const e of spec.entries.filter((x) => x.dayIndex === dayIndex)) emit(e, "cycle", null);
  }
  return out;
}

/* ═══════════════════════════════ materialising ═══════════════════════════════ */

/** The rolling horizon: ninety days is a quarter, which is how far a department plans theatre. */
export const HORIZON_DAYS = 90;

async function loadSpec(exec: Db | Tx, cycleId: string): Promise<CycleSpec & { departmentId: string }> {
  const cycle = (await (exec as Db).select().from(rosterCycles).where(eq(rosterCycles.id, cycleId)))[0];
  if (cycle === undefined) throw new RosterError("unknown_cycle", undefined, { cycleId });
  const entries = await (exec as Db).select().from(rosterCycleEntries)
    .where(eq(rosterCycleEntries.cycleId, cycleId)).orderBy(asc(rosterCycleEntries.dayIndex));
  const overlays = await (exec as Db).select().from(rosterCycleOverlays)
    .where(eq(rosterCycleOverlays.departmentId, cycle.departmentId))
    .orderBy(asc(rosterCycleOverlays.sequencePosition));
  return {
    departmentId: cycle.departmentId,
    cycleDays: cycle.cycleDays,
    anchorIstDate: cycle.anchorIstDate,
    entries: entries.map((e) => ({
      dayIndex: e.dayIndex, teamId: e.teamId, activity: e.activity as RosterActivity,
      startMinute: e.startMinute, durationMinutes: e.durationMinutes,
    })),
    overlays: overlays.map((o) => ({
      sequencePosition: o.sequencePosition, teamId: o.teamId, activity: o.activity as RosterActivity,
      startMinute: o.startMinute, durationMinutes: o.durationMinutes,
    })),
    overlayAnchorIstDate: overlays[0]?.anchorIstDate ?? cycle.anchorIstDate,
  };
}

async function holidaysBetween(exec: Db | Tx, from: string, to: string): Promise<HolidaySpec[]> {
  const rows = await (exec as Db).select().from(rosterHolidays)
    .where(and(gte(rosterHolidays.istDate, from), lt(rosterHolidays.istDate, to)));
  return rows.map((h) => ({
    istDate: h.istDate, kind: h.kind as RosterHolidayKind, pattern: h.pattern as RosterHolidayPattern,
  }));
}

/**
 * Writes the windows for `[from, to)` and supersedes whatever this department had there before.
 * Superseded rather than deleted: a window that was live when somebody was paged is evidence, and
 * a re-materialisation must not erase what the hospital was working to.
 */
export async function materialiseWindows(
  tx: Tx, actor: Actor, cycleId: string, fromIstDate: string, toIstDate: string,
): Promise<{ written: number; superseded: number }> {
  const spec = await loadSpec(tx, cycleId);
  await requireRosterAct(tx, actor, "publish", { departmentId: spec.departmentId });

  const holidays = await holidaysBetween(tx, fromIstDate, toIstDate);
  const planned = expandCycle(spec, fromIstDate, toIstDate, holidays);
  const from = istMidnightUtc(fromIstDate);
  const to = istMidnightUtc(toIstDate);

  const gone = await tx.update(rosterDutyWindows)
    .set({ supersededAt: sql`now()` })
    .where(and(
      eq(rosterDutyWindows.departmentId, spec.departmentId),
      isNull(rosterDutyWindows.supersededAt),
      gte(rosterDutyWindows.startsAt, from),
      lt(rosterDutyWindows.startsAt, to),
    ))
    .returning({ id: rosterDutyWindows.id });

  if (planned.length > 0) {
    await tx.insert(rosterDutyWindows).values(planned.map((w) => ({
      id: newId(), departmentId: spec.departmentId, teamId: w.teamId, activity: w.activity,
      startsAt: w.startsAt, endsAt: w.endsAt, cycleId, overlayIndex: w.overlayIndex,
      source: w.source, createdBy: actor.id, updatedBy: actor.id,
    })));
  }
  return { written: planned.length, superseded: gone.length };
}

export interface PublishCycleResult {
  version: number;
  written: number;
  superseded: number;
}

/**
 * E17 — a cycle version takes effect at an INSTANT, and the old version's windows stand until it.
 * A department that re-plans on the 12th does not retroactively change what it ran on the 11th.
 */
export async function publishCycle(
  tx: Tx, actor: Actor, cycleId: string, effectiveFromIstDate: string,
): Promise<PublishCycleResult> {
  const cycle = (await tx.select().from(rosterCycles).where(eq(rosterCycles.id, cycleId)).for("update"))[0];
  if (cycle === undefined) throw new RosterError("unknown_cycle", undefined, { cycleId });
  await requireRosterAct(tx, actor, "publish", { departmentId: cycle.departmentId });
  if (cycle.status !== "draft") {
    throw new RosterError("cycle_not_draft", undefined, { cycleId, status: cycle.status });
  }
  const entries = await (tx as Db).select({ id: rosterCycleEntries.id }).from(rosterCycleEntries)
    .where(eq(rosterCycleEntries.cycleId, cycleId));
  if (entries.length === 0) throw new RosterError("empty_cycle", undefined, { cycleId });

  const live = (await tx.select().from(rosterCycles).where(and(
    eq(rosterCycles.departmentId, cycle.departmentId), eq(rosterCycles.status, "published"),
  )).for("update"))[0];
  if (live !== undefined) {
    await tx.update(rosterCycles).set({ status: "superseded", updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(rosterCycles.id, live.id));
  }

  await tx.update(rosterCycles).set({
    status: "published", publishedAt: sql`now()`, publishedBy: actor.id,
    effectiveFrom: istMidnightUtc(effectiveFromIstDate),
    updatedBy: actor.id, updatedAt: new Date(),
  }).where(eq(rosterCycles.id, cycleId));

  const { written, superseded } = await materialiseWindows(
    tx, actor, cycleId, effectiveFromIstDate, addIstDays(effectiveFromIstDate, HORIZON_DAYS),
  );
  return { version: cycle.version, written, superseded };
}

/**
 * ═══ THE NIGHTLY EXTENSION — one scheduler job, and the scheduler census grows by one ═══
 *
 * The horizon is rolling, so something must roll it. Every night this pushes each published cycle's
 * windows out to `HORIZON_DAYS` from today, which is idempotent: re-materialising a stretch that is
 * already there supersedes and rewrites it identically.
 */
export async function extendWindows(
  tx: Tx, actor: Actor, todayIstDate: string,
): Promise<{ departments: number; written: number }> {
  const live = await (tx as Db).select().from(rosterCycles).where(eq(rosterCycles.status, "published"));
  let written = 0;
  for (const cycle of live) {
    const last = (await (tx as Db).select({ startsAt: rosterDutyWindows.startsAt })
      .from(rosterDutyWindows)
      .where(and(eq(rosterDutyWindows.departmentId, cycle.departmentId), isNull(rosterDutyWindows.supersededAt)))
      .orderBy(sql`${rosterDutyWindows.startsAt} desc`).limit(1))[0];
    const from = last === undefined
      ? todayIstDate
      : addIstDays(new Date(last.startsAt.getTime() + IST_OFFSET_MINUTES * MINUTE_MS).toISOString().slice(0, 10), 1);
    const to = addIstDays(todayIstDate, HORIZON_DAYS);
    if (daysBetween(from, to) <= 0) continue;
    written += (await materialiseWindows(tx, actor, cycle.id, from, to)).written;
  }
  return { departments: live.length, written };
}

/* ═══════════════════════════════ holidays ═══════════════════════════════ */

export interface DeclareHolidayInput {
  istDate: string;
  kind: RosterHolidayKind;
  pattern?: RosterHolidayPattern;
  appliesTo?: readonly string[];
  /** D3's two step: by when each HOD must confirm what their department will run. */
  confirmationDueAt?: Date | null;
}

/**
 * ═══ DECLARED AT 19:30, FOR TOMORROW ═══
 *
 * The owner's own edge case. It re-materialises **only that date**, and only for departments with a
 * published cycle — so an OPD list and an elective theatre are withdrawn and **the take unit's
 * night is untouched**, which is what `opd_off_ot_proceeds` means. Everything outside the date is
 * not read and not rewritten.
 *
 * And it does not advance the Sunday sequence: `expandCycle` derives the position from Sundays
 * alone, so a declared holiday borrows the current position without consuming it. The unit whose
 * turn Sunday was still has that turn on Sunday.
 */
export async function declareHoliday(
  tx: Tx, actor: Actor, input: DeclareHolidayInput,
): Promise<{ istDate: string; departmentsRematerialised: number }> {
  await requireRosterAct(tx, actor, "declare");
  assertIstDate(input.istDate);
  const kind = input.kind;
  const pattern = input.pattern ?? "as_sunday";
  if (!(ROSTER_HOLIDAY_KINDS as readonly string[]).includes(kind)
    || !(ROSTER_HOLIDAY_PATTERNS as readonly string[]).includes(pattern)) {
    throw new RosterError("invalid_window", "that is not a kind or pattern of holiday the roster knows", { kind, pattern });
  }

  await tx.insert(rosterHolidays).values({
    istDate: input.istDate, kind, pattern, appliesTo: [...(input.appliesTo ?? [])],
    declaredBy: actor.id, confirmationDueAt: input.confirmationDueAt ?? null,
    createdBy: actor.id, updatedBy: actor.id,
  }).onConflictDoUpdate({
    target: [rosterHolidays.siteId, rosterHolidays.istDate],
    set: { kind, pattern, declaredBy: actor.id, declaredAt: sql`now()`, updatedBy: actor.id, updatedAt: new Date() },
  });

  const live = await (tx as Db).select().from(rosterCycles).where(eq(rosterCycles.status, "published"));
  for (const cycle of live) {
    await materialiseWindows(tx, actor, cycle.id, input.istDate, addIstDays(input.istDate, 1));
  }
  return { istDate: input.istDate, departmentsRematerialised: live.length };
}

/* ═══════════════════════════════ reading the calendar ═══════════════════════════════ */

export interface OnTakeAnswer {
  teamId: string | null;
  source: "published" | "none";
  startsAt: Date | null;
  endsAt: Date | null;
}

const liveWindowAt = (departmentId: string, activity: RosterActivity, at: Date) => and(
  eq(rosterDutyWindows.departmentId, departmentId),
  eq(rosterDutyWindows.activity, activity),
  isNull(rosterDutyWindows.supersededAt),
  lte(rosterDutyWindows.startsAt, at),
  gt(rosterDutyWindows.endsAt, at),
);

/**
 * **V12 lives here.** A take runs `[08:00, 08:00)` across a day boundary, and the range is
 * half-open — so at 07:59 the outgoing unit is still on and at 08:00 exactly the incoming one is.
 * There is no instant belonging to both and none belonging to neither.
 */
export async function unitOnTake(exec: Db | Tx, departmentId: string, at: Date): Promise<OnTakeAnswer> {
  const [row] = await (exec as Db).select().from(rosterDutyWindows).where(liveWindowAt(departmentId, "take", at)).limit(1);
  return row === undefined
    ? { teamId: null, source: "none", startsAt: null, endsAt: null }
    : { teamId: row.teamId, source: "published", startsAt: row.startsAt, endsAt: row.endsAt };
}

export async function backupUnit(exec: Db | Tx, departmentId: string, at: Date): Promise<OnTakeAnswer> {
  const [row] = await (exec as Db).select().from(rosterDutyWindows).where(liveWindowAt(departmentId, "backup", at)).limit(1);
  return row === undefined
    ? { teamId: null, source: "none", startsAt: null, endsAt: null }
    : { teamId: row.teamId, source: "published", startsAt: row.startsAt, endsAt: row.endsAt };
}

export interface WindowGap { from: Date; to: Date }

/**
 * **V11** — the take must be continuous. A gap means an hour in which a department has nobody
 * admitting, and the hospital finds out when an ambulance arrives. Returned as a list rather than
 * refused, because the fix is a human's (a cycle with a missing day) and `standup:check` is where
 * it belongs.
 */
export async function takeGaps(
  exec: Db | Tx, departmentId: string, from: Date, to: Date,
): Promise<WindowGap[]> {
  const rows = await (exec as Db).select().from(rosterDutyWindows).where(and(
    eq(rosterDutyWindows.departmentId, departmentId),
    eq(rosterDutyWindows.activity, "take"),
    isNull(rosterDutyWindows.supersededAt),
    lt(rosterDutyWindows.startsAt, to),
    gt(rosterDutyWindows.endsAt, from),
  )).orderBy(asc(rosterDutyWindows.startsAt));

  const gaps: WindowGap[] = [];
  let cursor = from;
  for (const w of rows) {
    if (w.startsAt > cursor) gaps.push({ from: cursor, to: w.startsAt });
    if (w.endsAt > cursor) cursor = w.endsAt;
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

/** Every department whose take has a hole inside the horizon — the `standup:check` row. */
export async function departmentsWithTakeGaps(
  exec: Db | Tx, from: Date, to: Date,
): Promise<{ departmentId: string; code: string; gaps: WindowGap[] }[]> {
  const cycles = await (exec as Db).select().from(rosterCycles).where(eq(rosterCycles.status, "published"));
  const out: { departmentId: string; code: string; gaps: WindowGap[] }[] = [];
  for (const cycle of cycles) {
    const gaps = await takeGaps(exec, cycle.departmentId, from, to);
    if (gaps.length === 0) continue;
    const [dept] = await (exec as Db).select({ code: orgDepartments.code }).from(orgDepartments)
      .where(eq(orgDepartments.id, cycle.departmentId));
    out.push({ departmentId: cycle.departmentId, code: dept?.code ?? "?", gaps });
  }
  return out;
}

export const ROSTER_CALENDAR_ACTIVITIES = ROSTER_ACTIVITIES;

/* ═══════════════════════════════ the scheduled job ═══════════════════════════════ */

/**
 * PHASE R (R7) — **THE NIGHTLY WINDOW EXTENSION**, and it is the roster's first scheduler job.
 *
 * The horizon is rolling, so something must roll it. Registered `dailyIst("01:30")`: after IST
 * midnight, so "today" is the day it is extending from, and long before any clinic opens.
 *
 * ═══ WHAT ACTOR A SCHEDULED JOB ACTS AS, AND WHY IT IS NOT `system` ═══
 *
 * The matrix says `publish` is **`never`** for a `system` actor, and that is right: no scheduled job
 * decides who is on. But this job is not deciding anything — it is **writing down more of what a
 * human already decided**, by re-expanding a cycle that is already `published`. `extendWindows`
 * cannot publish a cycle and cannot reach a draft.
 *
 * So `MATERIALISER_ACTOR` is a `user`-typed actor with a reserved id, exactly as `TIMER_ACTOR` is in
 * `kernel/workflow/timers.ts` — this codebase's established shape for a scheduled act that continues
 * a person's decision rather than making one. It holds no grant of its own, which is why the
 * hospital-scope check in `materialiseWindows` is satisfied by the department's cycle already being
 * published and not by anything this actor carries.
 */
export const MATERIALISER_ACTOR: Actor = { type: "user", id: "roster-materialiser" };

export async function sweepRosterWindows(db: Db, now: Date): Promise<{ departments: number; written: number }> {
  const todayIst = new Date(now.getTime() + IST_OFFSET_MINUTES * MINUTE_MS).toISOString().slice(0, 10);
  return db.transaction((tx) => extendWindows(tx, MATERIALISER_ACTOR, todayIst));
}
