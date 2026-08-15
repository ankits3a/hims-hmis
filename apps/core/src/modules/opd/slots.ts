import { istDateTimeToUtc, istWeekday } from "./time";

export type ScheduleTemplate = {
  id: string; weekday: number; startTime: string; endTime: string; roomId: string;
  slotMinutes: number | null; validFrom: string; validTo: string | null; active: boolean;
};
export type LeaveRange = { fromDate: string; toDate: string; status: string };
export type Slot = { start: Date; end: Date; roomId: string; scheduleId: string; booked: boolean; past: boolean };

/** Slots of one IST date: active templates for that weekday inside their validity, minus scheduled leaves. Pure. */
export function slotsForDate(input: {
  date: string; templates: ScheduleTemplate[]; leaves: LeaveRange[]; bookedStarts: number[]; defaultSlotMinutes: number; now: Date;
}): Slot[] {
  const { date } = input;
  if (input.leaves.some((l) => l.status === "scheduled" && l.fromDate <= date && date <= l.toDate)) return [];
  const weekday = istWeekday(date);
  const booked = new Set(input.bookedStarts);
  const out: Slot[] = [];
  for (const t of input.templates) {
    if (!t.active || t.weekday !== weekday) continue;
    if (t.validFrom > date || (t.validTo !== null && t.validTo < date)) continue;
    const step = (t.slotMinutes ?? input.defaultSlotMinutes) * 60_000;
    const endMs = istDateTimeToUtc(date, t.endTime).getTime();
    for (let s = istDateTimeToUtc(date, t.startTime).getTime(); s + step <= endMs; s += step) {
      out.push({ start: new Date(s), end: new Date(s + step), roomId: t.roomId, scheduleId: t.id, booked: booked.has(s), past: s < input.now.getTime() });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
