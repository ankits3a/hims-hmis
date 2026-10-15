import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import {
  PACE_GROUP_ITEMS_FLOOR, PACE_GROUP_PEOPLE_FLOOR, PACE_MAX_MINUTES, PACE_MIN_MINUTES, PACE_OWN_FLOOR, PACE_PERIOD_DAYS,
} from "@hmis/contracts";
import type { Actor, MyPace, PaceBlock, PaceGroup, PaceOwn, PacePeriod } from "@hmis/contracts";
import { opdDoctors, opdEncounters } from "../../kernel/db/schema";
import { addDays, istDate } from "./time";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ MY PACE ═══ (owner, 2026-10-09: "I also want each doctor to see their performance compared to
 * other doctor's average. Let the doctor see average time per consultation compared to average of the
 * department and average to the hospital. Same goes to Vitals staff as well.")
 *
 * ═══ THE DOCTOR'S MEASURE ═══ minutes from `opd_encounters.consult_started_at` to
 * `opd_encounters.consult_completed_at`, for visits of the period (`service_date`, IST) that the
 * doctor COMPLETED ON A SCREEN: `status = 'completed'` and `completed_via` null. Left out:
 *
 *   · closed on paper (`completed_via = 'paper'`) — the desk stamped both instants when it filed the
 *     slip; they say when the paper was typed, not how long the patient was in the room;
 *   · abandoned (`status = 'abandoned'`) — nobody was consulted;
 *   · a duration under `PACE_MIN_MINUTES` or over `PACE_MAX_MINUTES` — a data-entry artefact.
 *
 * Each is COUNTED for the caller's own block. A parked consultation is one duration, start to
 * completion, with the minutes the patient was outside still in it: the parked span lives only in the
 * event ledger, and a measure that read two stores could disagree with itself.
 *
 * ═══ THE VITALS BAY'S MEASURE IS NOT BUILT, BECAUSE ITS START IS NOT STORED ═══ `opd_vitals` holds
 * the save (`recorded_at`, `recorded_by`) and nothing before it: taking a patient in hand at the bay is
 * screen state on the phone and the web (`setTaken`), no route is called and no event is written.
 * `bench.state_set` records resting/away, not "in hand". The gap between one save and the next is the
 * bay's idle time plus the walk, not time with a patient, so it is not used. `vitals` is always null.
 *
 * ═══ THE FLOORS ARE HERE, NOT ON THE PHONE ═══ a figure the server withholds cannot be shown by a
 * later screen that forgot the rule. A group row carries a mean, a median and `enough` — no headcount
 * and no item count, because own + group mean + group count solves for the colleague in a group of two.
 */

/** One qualifying duration: who (an opaque key that never leaves this file), their group, the minutes. */
export type PaceItem = { person: string; group: string | null; minutes: number };

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function meanOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : round1(values.reduce((a, b) => a + b, 0) / values.length);
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return round1(s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

/** A duration that is a consultation rather than an artefact. Both bounds are inclusive. */
export function withinBounds(minutes: number): boolean {
  return minutes >= PACE_MIN_MINUTES && minutes <= PACE_MAX_MINUTES;
}

export function ownFigure(minutes: readonly number[]): PaceOwn {
  const enough = minutes.length >= PACE_OWN_FLOOR;
  return { enough, meanMin: enough ? meanOf(minutes) : null, medianMin: enough ? medianOf(minutes) : null, n: minutes.length };
}

/** The group's average, or nothing at all when it could be read back into one colleague. */
export function groupFigure(items: readonly PaceItem[]): PaceGroup {
  const people = new Set(items.map((i) => i.person)).size;
  const enough = people >= PACE_GROUP_PEOPLE_FLOOR && items.length >= PACE_GROUP_ITEMS_FLOOR;
  const minutes = items.map((i) => i.minutes);
  return { enough, meanMin: enough ? meanOf(minutes) : null, medianMin: enough ? medianOf(minutes) : null };
}

/** `[from, to]` IST days of a period ending today. */
export function paceWindow(period: PacePeriod, now: Date): { from: string; to: string } {
  const to = istDate(now);
  return { from: addDays(to, -(PACE_PERIOD_DAYS[period] - 1)), to };
}

export async function loadMyPace(db: Db, actor: Actor, period: PacePeriod, now: Date = new Date()): Promise<MyPace> {
  const { from, to } = paceWindow(period, now);
  const none: MyPace = { period, from, to, consultation: null, vitals: null };
  if (actor.type !== "user") return none;

  const me = (await db.select({ id: opdDoctors.id, departmentId: opdDoctors.departmentId }).from(opdDoctors).where(eq(opdDoctors.userId, actor.id)))[0];
  if (me === undefined) return none;

  const rows = await db.select({
    doctorId: opdEncounters.doctorId, departmentId: opdDoctors.departmentId, status: opdEncounters.status,
    completedVia: opdEncounters.completedVia, startedAt: opdEncounters.consultStartedAt, completedAt: opdEncounters.consultCompletedAt,
  }).from(opdEncounters).innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId)).where(and(
    eq(opdEncounters.type, "opd"), isNotNull(opdEncounters.doctorId),
    gte(opdEncounters.serviceDate, from), lte(opdEncounters.serviceDate, to),
  ));

  const items: PaceItem[] = [];
  const excluded = { paper: 0, abandoned: 0, outOfBounds: 0 };
  for (const r of rows) {
    const mine = r.doctorId === me.id;
    if (r.status === "abandoned") { if (mine) excluded.abandoned += 1; continue; }
    if (r.status !== "completed") continue;
    if (r.completedVia === "paper") { if (mine) excluded.paper += 1; continue; }
    if (r.completedVia !== null || r.startedAt === null || r.completedAt === null) continue;
    const minutes = (r.completedAt.getTime() - r.startedAt.getTime()) / 60_000;
    if (!withinBounds(minutes)) { if (mine) excluded.outOfBounds += 1; continue; }
    items.push({ person: r.doctorId!, group: r.departmentId, minutes });
  }

  const consultation: PaceBlock = {
    own: ownFigure(items.filter((i) => i.person === me.id).map((i) => i.minutes)),
    department: groupFigure(items.filter((i) => i.group === me.departmentId)),
    all: groupFigure(items),
    excluded,
  };
  return { ...none, consultation };
}
