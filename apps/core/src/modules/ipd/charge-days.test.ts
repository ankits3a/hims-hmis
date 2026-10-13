import { ipdChargeableDays } from "./charge-days";
import type { ChargeStay } from "./charge-days";
import type { IpdBedClass } from "@hmis/contracts";

/** E2.1 — the day rule's edges, as a pure function. Instants are inputs (IST, `+05:30`); no clock is read. */
const ist = (s: string): Date => new Date(`${s}+05:30`);
const stay = (cls: IpdBedClass, from: string, to: string | null, billed?: IpdBedClass): ChargeStay => ({
  bedClass: cls, billedClass: billed ?? cls, startedAt: ist(from), endedAt: to === null ? null : ist(to),
});
const days = (stays: ChargeStay[], admitted: string, discharged: string | null, upTo: string): string[] =>
  ipdChargeableDays(stays, ist(admitted), discharged === null ? null : ist(discharged), upTo).map((d) => `${d.date}:${d.billedClass}`);

describe("ipdChargeableDays", () => {
  it("bills the admission day whatever the hour, and nothing after the last day asked for", () => {
    expect(days([stay("general", "2026-03-10T23:55:00", null)], "2026-03-10T23:55:00", null, "2026-03-11"))
      .toEqual(["2026-03-10:general", "2026-03-11:general"]);
    expect(days([stay("general", "2026-03-10T10:00:00", null)], "2026-03-10T10:00:00", null, "2026-03-09")).toEqual([]);
  });

  it("frees the discharge day up to 14:00 inclusive and bills it after; a same-day stay bills its one day", () => {
    const s = [stay("general", "2026-03-10T10:00:00", "2026-03-11T14:00:00")];
    expect(days(s, "2026-03-10T10:00:00", "2026-03-11T14:00:00", "2026-03-31")).toEqual(["2026-03-10:general"]);
    const late = [stay("general", "2026-03-10T10:00:00", "2026-03-11T14:01:00")];
    expect(days(late, "2026-03-10T10:00:00", "2026-03-11T14:01:00", "2026-03-31")).toEqual(["2026-03-10:general", "2026-03-11:general"]);
    const sameDay = [stay("general", "2026-03-10T08:00:00", "2026-03-10T12:00:00")];
    expect(days(sameDay, "2026-03-10T08:00:00", "2026-03-10T12:00:00", "2026-03-31")).toEqual(["2026-03-10:general"]);
  });

  it("bills the protected (booked) class over the bed's own, overflow as general, and critical care over any ward room", () => {
    expect(days([stay("general", "2026-03-10T10:00:00", null, "private")], "2026-03-10T10:00:00", null, "2026-03-10")).toEqual(["2026-03-10:private"]);
    expect(days([stay("overflow", "2026-03-10T10:00:00", null)], "2026-03-10T10:00:00", null, "2026-03-10")).toEqual(["2026-03-10:general"]);
    const s = [stay("suite", "2026-03-10T08:00:00", "2026-03-10T15:00:00"), stay("icu", "2026-03-10T15:00:00", null)];
    expect(days(s, "2026-03-10T08:00:00", null, "2026-03-10")).toEqual(["2026-03-10:icu"]);
  });

  it("posts no rent for a day spent only in a bed without class rates; home leave (an open stay) keeps billing", () => {
    const s = [stay("emergency", "2026-03-10T08:00:00", "2026-03-11T09:00:00"), stay("general", "2026-03-11T09:00:00", null)];
    expect(days(s, "2026-03-10T08:00:00", null, "2026-03-12")).toEqual(["2026-03-11:general", "2026-03-12:general"]);
  });

  it("a short admission day bills the class held longest, ignoring a transit bed under an hour", () => {
    const s = [
      stay("general", "2026-03-10T23:00:00", "2026-03-10T23:10:00"),
      stay("icu", "2026-03-10T23:10:00", "2026-03-10T23:50:00"),
      stay("general", "2026-03-10T23:50:00", null),
    ];
    expect(days(s, "2026-03-10T23:00:00", null, "2026-03-11")).toEqual(["2026-03-10:general", "2026-03-11:general"]);
  });
});
