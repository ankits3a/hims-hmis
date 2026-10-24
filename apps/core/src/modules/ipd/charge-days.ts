import { IPD_BED_CLASS_INFO } from "@hmis/contracts";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import type { IpdBedClass } from "@hmis/contracts";

/**
 * E2.1 (#725) — THE DAY RULE (spec SPEC-ipd-core §4.3), a pure function: stays + the admission's two instants → the
 * IST calendar days the stay is billed for and the class each day bills at. No clock is read: the caller names the
 * last day it wants (`upToIstDate`, inclusive).
 *
 * The rules, each DECIDED as the standard Indian corporate-hospital practice (decision 0072 lets them stand):
 * - One room-rent day per IST calendar day (midnight to midnight). The ADMISSION day is billed whatever the hour.
 * - The DISCHARGE day is free when the patient leaves by 14:00 IST (12 noon + 2 hours grace), billed after it. A stay
 *   that begins and ends on one day bills that one day (it is the admission day).
 * - A day bills at the HIGHEST class held for MORE THAN ONE HOUR that day. A bed held under one hour in all (an ended
 *   stay shorter than 60 minutes) is TRANSIT and is not billed at all. When no class was held for more than an hour
 *   on a billable day (an admission at 23:30, a discharge at 14:30), the day bills at the class held longest that day
 *   (ties to the higher class); a day that saw only transit beds bills at the class the patient settled into next
 *   (else the one before).
 * - The class of a stay is its BILLED class (`ipd_bed_stays.billed_class`): a protected or booked class overrides the
 *   bed's own. `overflow` bills as `general` (`billsAs`). `daycare`, `emergency` and `ldr` are not rent-bearing (no
 *   daily rates; their care is billed by package or service) — a day that held only those posts no rent.
 * - Ranking: general < semi_private < private < deluxe < suite < hdu < icu = nicu = picu (critical care outranks any
 *   ward room; a tie between critical classes goes to the longer hold).
 * - Home leave keeps billing: the stay stays open, so the days keep coming.
 * - Review #756: overlapping stays are clipped to the previous stay's end before summing; a stay that is all there is
 *   is never transit — a stay entirely under an hour still bills the admission day (minimum one day).
 */

export type ChargeStay = {
  bedClass: IpdBedClass;
  billedClass: IpdBedClass;
  startedAt: Date;
  endedAt: Date | null;
};

export type ChargeableDay = {
  /** IST calendar date, `YYYY-MM-DD`. */
  date: string;
  /** The rated class the day bills at (after `billsAs`). */
  billedClass: IpdBedClass;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Noon + 2 hours' grace, from IST midnight. */
export const DISCHARGE_FREE_UNTIL_MS = 14 * HOUR_MS;
export const TRANSIT_UNDER_MS = HOUR_MS;

const RANK: Partial<Record<IpdBedClass, number>> = {
  general: 1, semi_private: 2, private: 3, deluxe: 4, suite: 5, hdu: 6, icu: 7, nicu: 7, picu: 7,
};

/** The class a stay's day is rated at, or null when the class carries no daily rent. */
export function rentClassOf(cls: IpdBedClass): IpdBedClass | null {
  const rated = IPD_BED_CLASS_INFO[cls].billsAs ?? cls;
  return RANK[rated] === undefined ? null : rated;
}

export function classRank(cls: IpdBedClass): number {
  return RANK[cls] ?? 0;
}

/** Next IST date after `date` (`YYYY-MM-DD`). */
export function nextIstDate(date: string): string {
  return istDayString(new Date(istStartOf(date).getTime() + DAY_MS));
}

/** The instant an IST date begins. */
export function istStartOf(date: string): Date {
  // Noon UTC of the same calendar date is inside that IST day for any offset under 12 hours.
  return istDayWindow(new Date(`${date}T12:00:00.000Z`)).start;
}

export function ipdChargeableDays(
  stays: readonly ChargeStay[],
  admittedAt: Date,
  dischargedAt: Date | null,
  upToIstDate: string,
): ChargeableDay[] {
  const firstDay = istDayString(admittedAt);
  const dischargeDay = dischargedAt === null ? null : istDayString(dischargedAt);
  const lastDay = dischargeDay !== null && dischargeDay < upToIstDate ? dischargeDay : upToIstDate;
  if (lastDay < firstDay) return [];

  const endOf = (s: ChargeStay): number => {
    const end = s.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return dischargedAt === null ? end : Math.min(end, dischargedAt.getTime());
  };
  // Overlap (review #756 item 8): stays sorted by start, each clipped to begin no earlier than the previous one ended,
  // so no hour is counted twice; a stay wholly inside an earlier one disappears.
  const clipped: ChargeStay[] = [];
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const s of [...stays].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) {
    const start = Math.max(s.startedAt.getTime(), prevEnd);
    const end = s.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (end > start) clipped.push({ ...s, startedAt: new Date(start) });
    prevEnd = Math.max(prevEnd, end);
  }
  // Transit: an ended stay shorter than an hour is dropped whole. An open stay is never transit. RED 1 (review #756,
  // DECIDED: minimum one day): when EVERY stay was that short, none is dropped — the admission day bills at its class.
  const nonTransit = clipped.filter((s) => s.endedAt === null || s.endedAt.getTime() - s.startedAt.getTime() >= TRANSIT_UNDER_MS);
  const kept = nonTransit.length > 0 ? nonTransit : clipped;

  const out: ChargeableDay[] = [];
  for (let day = firstDay; day <= lastDay; day = nextIstDate(day)) {
    const dayStart = istStartOf(day).getTime();
    const dayEnd = dayStart + DAY_MS;
    if (day === dischargeDay && day !== firstDay && dischargedAt!.getTime() <= dayStart + DISCHARGE_FREE_UNTIL_MS) continue;

    const held = new Map<IpdBedClass, number>();
    let overlapped = false;
    for (const s of kept) {
      const from = Math.max(s.startedAt.getTime(), dayStart, admittedAt.getTime());
      const to = Math.min(endOf(s), dayEnd);
      if (to <= from) continue;
      overlapped = true;
      const cls = rentClassOf(s.billedClass);
      if (cls !== null) held.set(cls, (held.get(cls) ?? 0) + (to - from));
    }
    // A day spent only in beds that carry no rent (emergency, day care, LDR) posts none; a day that saw only transit
    // beds (nothing kept overlaps it) bills at the class the patient settled into.
    const billed = overlapped ? pickClass(held) : settledClass(kept, dayStart, dayEnd);
    if (billed !== null) out.push({ date: day, billedClass: billed });
  }
  return out;
}

function pickClass(held: Map<IpdBedClass, number>): IpdBedClass | null {
  const entries = [...held.entries()];
  if (entries.length === 0) return null;
  const overHour = entries.filter(([, ms]) => ms > HOUR_MS);
  const pool = overHour.length > 0 ? overHour : entries;
  pool.sort((a, b) => {
    if (overHour.length > 0) return classRank(b[0]) - classRank(a[0]) || b[1] - a[1];
    return b[1] - a[1] || classRank(b[0]) - classRank(a[0]);
  });
  return pool[0]![0];
}

/** A day with only transit beds bills at the class of the next kept stay, else the one before (null: no rent). */
function settledClass(kept: readonly ChargeStay[], dayStart: number, dayEnd: number): IpdBedClass | null {
  const after = kept.find((s) => s.startedAt.getTime() >= dayEnd);
  if (after !== undefined) return rentClassOf(after.billedClass);
  const before = [...kept].reverse().find((s) => s.startedAt.getTime() < dayStart);
  return before === undefined ? null : rentClassOf(before.billedClass);
}
