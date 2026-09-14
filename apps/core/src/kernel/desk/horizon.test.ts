import { DeskError } from "./types";
import { deskHttpStatus } from "./http";
import {
  FLOOR_DAYS, YEAR_DAYS, assertWithinHorizon, capDaysFor, horizonFrom,
} from "./horizon";
import { oldestDayRead } from "./brief";

/**
 * PHASE STAFF-REPORTS T0 — THE HISTORY HORIZON, owner ruling 2026-09-14.
 *
 * The pure half, tested without a database: the lattice, the day arithmetic, and the refusal. The
 * WIRING — that each of the six doors actually calls it — is `horizon-census.test.ts`'s job, because
 * a helper that is correct and uncalled is the failure mode a unit test cannot see.
 */
const TODAY = "2026-09-14";

describe("staff-reports T0 — the tiers are a lattice", () => {
  it("holding neither string is the floor, and the floor is three months", () => {
    expect(capDaysFor({ year: false, full: false })).toBe(FLOOR_DAYS);
    expect(FLOOR_DAYS).toBe(91); // the span `quarter` means, so a capped caller keeps that period whole
  });

  it("the year string lifts the floor to a year", () => {
    expect(capDaysFor({ year: true, full: false })).toBe(YEAR_DAYS);
  });

  /**
   * THE PROPERTY A ROLE-TO-HORIZON MAP WOULD HAVE GOT WRONG. Somebody holding both strings — two
   * roles, which `types.ts` says is the normal case — must get the WIDER answer, not the first one
   * matched or the last one written.
   */
  it("full wins over year, in either combination, because roles combine", () => {
    expect(capDaysFor({ year: false, full: true })).toBeNull();
    expect(capDaysFor({ year: true, full: true })).toBeNull();
  });

  it("a cap becomes an inclusive oldest day; unbounded stays null", () => {
    expect(horizonFrom(FLOOR_DAYS, TODAY).oldestDay).toBe("2026-06-16");
    expect(horizonFrom(YEAR_DAYS, TODAY).oldestDay).toBe("2025-09-15");
    expect(horizonFrom(null, TODAY)).toEqual({ oldestDay: null, capDays: null });
  });
});

describe("staff-reports T0 — over-horizon REFUSES", () => {
  const floor = horizonFrom(FLOOR_DAYS, TODAY);

  it("lets through a day exactly ON the horizon — the cap is inclusive", () => {
    expect(() => assertWithinHorizon(floor.oldestDay!, floor)).not.toThrow();
  });

  it("refuses the day before it, and the refusal names the cap rather than just saying no", () => {
    let caught: unknown;
    try {
      assertWithinHorizon("2026-06-15", floor);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DeskError);
    expect((caught as DeskError).code).toBe("history_horizon_exceeded");
    // A person who is refused must be able to tell WHICH cap refused them without opening a ticket.
    expect((caught as DeskError).message).toContain("2026-06-16");
    expect((caught as DeskError).message).toContain("91");
  });

  /**
   * 400 AND NOT 403. The caller MAY read this report — `staff.reports.read` already decided that.
   * They may not read this far back, which is a property of the request, and `deskHttpStatus` sends
   * "the caller asked for something the system will not do" as a 400.
   */
  it("is a 400, not a 403 and not a 500", () => {
    expect(deskHttpStatus("history_horizon_exceeded")).toBe(400);
  });

  it("an unbounded horizon refuses nothing, however far back", () => {
    expect(() => assertWithinHorizon("2019-01-01", horizonFrom(null, TODAY))).not.toThrow();
  });
});

/**
 * THE TWO HALVES MEETING. `oldestDayRead` knows how far a period reaches; the horizon knows how far
 * the caller may. These are the combinations the ruling is actually about, and they are asserted
 * against the real functions rather than against a restatement of them.
 */
describe("staff-reports T0 — what each tier can actually ask for", () => {
  const floor = horizonFrom(FLOOR_DAYS, TODAY);
  const year = horizonFrom(YEAR_DAYS, TODAY);
  const full = horizonFrom(null, TODAY);
  const ask = (period: Parameters<typeof oldestDayRead>[0], h: ReturnType<typeof horizonFrom>) =>
    () => assertWithinHorizon(oldestDayRead(period, TODAY), h);

  it("the floor reaches a quarter and no further", () => {
    expect(ask("day", floor)).not.toThrow();
    expect(ask("week", floor)).not.toThrow();
    expect(ask("month", floor)).not.toThrow();
    expect(ask("quarter", floor)).not.toThrow();
    expect(ask("half", floor)).toThrow(DeskError);
    expect(ask("year", floor)).toThrow(DeskError);
  });

  it("the year tier reaches half and year", () => {
    expect(ask("half", year)).not.toThrow();
    expect(ask("year", year)).not.toThrow();
  });

  it("the full tier reaches everything", () => {
    expect(ask("year", full)).not.toThrow();
  });

  /**
   * THE DAY PERIOD'S BASELINE REACHES 56 DAYS BACK — further than the day itself. It must still fit
   * the floor, or the shortest-horizon caller loses the comparison the fix in `brief.ts` just
   * restored to them.
   */
  it("the day period's 56-day baseline fits inside the floor", () => {
    expect(oldestDayRead("day", TODAY) >= floor.oldestDay!).toBe(true);
  });
});
