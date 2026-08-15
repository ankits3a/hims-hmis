import { slotsForDate } from "./slots";

const tpl = { id: "T1", weekday: 1, startTime: "09:00", endTime: "10:00", roomId: "R1", slotMinutes: null, validFrom: "2026-01-01", validTo: null, active: true };
const base = { date: "2026-08-17", templates: [tpl], leaves: [], bookedStarts: [] as number[], defaultSlotMinutes: 10, now: new Date("2026-08-17T00:00:00.000Z") };

describe("slotsForDate (pure)", () => {
  it("Mon 09:00–10:00 IST at 10 min = six slots from 03:30Z, ten minutes apart, in room R1", () => {
    const slots = slotsForDate(base);
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-08-17T03:30:00.000Z", "2026-08-17T03:40:00.000Z", "2026-08-17T03:50:00.000Z",
      "2026-08-17T04:00:00.000Z", "2026-08-17T04:10:00.000Z", "2026-08-17T04:20:00.000Z",
    ]);
    expect(slots.every((s) => s.end.getTime() - s.start.getTime() === 600_000 && s.roomId === "R1" && s.scheduleId === "T1")).toBe(true);
    expect(slots.every((s) => !s.booked && !s.past)).toBe(true);
  });
  it("a booked start is flagged; starts before now are past", () => {
    const slots = slotsForDate({ ...base, bookedStarts: [Date.parse("2026-08-17T03:40:00.000Z")], now: new Date("2026-08-17T03:45:00.000Z") });
    expect(slots.map((s) => s.booked)).toEqual([false, true, false, false, false, false]);
    expect(slots.map((s) => s.past)).toEqual([true, true, false, false, false, false]);
  });
  it("a scheduled leave covering the date empties the day; a cancelled one does not", () => {
    expect(slotsForDate({ ...base, leaves: [{ fromDate: "2026-08-15", toDate: "2026-08-17", status: "scheduled" }] })).toEqual([]);
    expect(slotsForDate({ ...base, leaves: [{ fromDate: "2026-08-15", toDate: "2026-08-17", status: "cancelled" }] })).toHaveLength(6);
    expect(slotsForDate({ ...base, leaves: [{ fromDate: "2026-08-18", toDate: "2026-08-19", status: "scheduled" }] })).toHaveLength(6);
  });
  it("weekday and validity windows gate the template", () => {
    expect(slotsForDate({ ...base, date: "2026-08-18" })).toEqual([]); // Tuesday
    expect(slotsForDate({ ...base, templates: [{ ...tpl, validTo: "2026-08-16" }] })).toEqual([]);
    expect(slotsForDate({ ...base, templates: [{ ...tpl, validFrom: "2026-08-18" }] })).toEqual([]);
    expect(slotsForDate({ ...base, templates: [{ ...tpl, active: false }] })).toEqual([]);
  });
  it("a template slot override wins over the default; a partial trailing slot is dropped", () => {
    // 09:00–09:35 at 15 min → 09:00, 09:15 (09:30+15 > 09:35 is dropped)
    const slots = slotsForDate({ ...base, templates: [{ ...tpl, endTime: "09:35", slotMinutes: 15 }] });
    expect(slots.map((s) => s.start.toISOString())).toEqual(["2026-08-17T03:30:00.000Z", "2026-08-17T03:45:00.000Z"]);
  });
  it("two templates on the same weekday merge sorted by start", () => {
    const evening = { ...tpl, id: "T2", startTime: "17:00", endTime: "17:20", roomId: "R2" };
    const slots = slotsForDate({ ...base, templates: [evening, tpl] });
    expect(slots).toHaveLength(8);
    expect(slots[6]!.roomId).toBe("R2");
    expect(slots[6]!.start.toISOString()).toBe("2026-08-17T11:30:00.000Z");
  });
});
