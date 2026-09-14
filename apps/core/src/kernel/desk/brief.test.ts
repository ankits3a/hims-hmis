import {
  MIN_BASELINE_DAYS, PERIODS, baselineWindowFor, buildBrief, medianOf, needsBaseline,
  oldestDayRead, windowFor,
} from "./brief";
import { addDays, sumWindow } from "./rollup";
import type { DayFacts } from "./rollup";

/**
 * PLAN 07c T8 / DD12 + DD8 — THE BRIEF IS GENERATED, AND THE HARD PART IS WHAT IT REFUSES TO SAY.
 *
 * Every clause is a pure function of numbers, which is the property DD12 is really asking for when
 * it says the sentence is generated rather than authored: the same facts give the same words,
 * forever, so a figure can be traced and a clause can be argued with.
 *
 * DD8 is the assertion that earns its keep. "0% vs median" on somebody's second day is not a
 * neutral placeholder — it is a FABRICATED comparison that reads exactly like a real one, and a
 * supervisor cannot tell them apart. A4's mutant is precisely that line.
 */
const TODAY = "2026-08-17"; // a Monday

/** How many IST days a `{from,to}` window covers, inclusive at both ends. */
function spanOf(w: { from: string; to: string }): number {
  return Math.round(
    (Date.parse(`${w.to}T00:00:00.000Z`) - Date.parse(`${w.from}T00:00:00.000Z`)) / 86_400_000,
  ) + 1;
}

/** `n` days ending at `end`, each carrying the same bag. */
function run(end: string, n: number, facts: Record<string, number>): DayFacts[] {
  return Array.from({ length: n }, (_, i) => ({
    day: addDays(end, -(n - 1 - i)), facts, provisional: false,
  }));
}

describe("07c T8 — the windows", () => {
  it("each period is its own span ending today, and the baseline is the stretch before it", () => {
    expect(windowFor("day", TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(windowFor("week", TODAY)).toEqual({ from: "2026-08-11", to: TODAY });
    expect(windowFor("half", TODAY)).toEqual({ from: "2026-02-16", to: TODAY });

    // The baseline ENDS the day before the window starts — they never overlap, which is what would
    // make a period compare against a stretch that includes itself.
    const w = windowFor("week", TODAY);
    const b = baselineWindowFor("week", TODAY);
    expect(b.to).toBe(addDays(w.from, -1));
    expect(b).toEqual({ from: "2026-08-04", to: "2026-08-10" });
  });

  it("addDays is calendar arithmetic and crosses a month and a year boundary", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("07c T8 A4 — no metric without an honest baseline (DD8)", () => {
  it("a median over too few days is NULL rather than a number computed from nothing", () => {
    expect(medianOf([1, 2, 3], 14)).toBeNull();
    expect(medianOf(Array.from({ length: 14 }, () => 5), 14)).toBe(5);
  });

  it("the median of an even sample is the rounded midpoint, not a float on a printed report", () => {
    expect(medianOf([1, 2, 3, 4], 4)).toBe(3); // (2+3)/2 = 2.5 → 3
    expect(medianOf([10, 20], 2)).toBe(15);
  });

  /**
   * A4 — a new joiner's FIRST DAY. There is no history at all, so the brief still speaks (it says
   * what they did) but every comparison clause is absent. The mutant for this row emits
   * `.compared` with a zero median; the assertion below is what kills it.
   */
  it("A4: with no history the clauses are PLAIN — no comparison is invented", () => {
    const today: DayFacts[] = [{ day: TODAY, facts: { "opd.visitsOpened": 12 }, provisional: true }];
    const brief = buildBrief("day", TODAY, today, []);

    expect(brief.clauses).toEqual([{ key: "brief.visits.plain", values: { total: "12" } }]);
    expect(JSON.stringify(brief.clauses)).not.toContain("median");
  });

  it("A4: with enough SAME-WEEKDAY history the comparison appears, and names the median", () => {
    // Four Mondays of history, each with 10 visits. 2026-08-17 is a Monday.
    const baseline = [1, 2, 3, 4].map((w) => ({
      day: addDays(TODAY, -7 * w), facts: { "opd.visitsOpened": 10 }, provisional: false,
    }));
    const brief = buildBrief("day", TODAY, [{ day: TODAY, facts: { "opd.visitsOpened": 12 }, provisional: true }], baseline);

    expect(brief.clauses).toEqual([
      { key: "brief.visits.compared", values: { total: "12", median: "10" } },
    ]);
  });

  /**
   * THE WEEKDAY RULE, ASSERTED. A Saturday OPD is a different shape of day from a Tuesday one, and
   * a pooled median manufactures a collapse every weekend. Here the baseline is dense on every day
   * EXCEPT Mondays — so a pooled median would happily produce a comparison and the same-weekday
   * rule correctly refuses one.
   */
  it("A4: a day is compared against its OWN weekday, so a dense non-Monday history says nothing", () => {
    const baseline = Array.from({ length: 28 }, (_, i) => addDays(TODAY, -(i + 1)))
      .filter((d) => new Date(`${d}T00:00:00.000Z`).getUTCDay() !== 1) // every day but Mondays
      .map((day) => ({ day, facts: { "opd.visitsOpened": 10 }, provisional: false }));
    expect(baseline.length).toBeGreaterThan(20);

    const brief = buildBrief("day", TODAY, [{ day: TODAY, facts: { "opd.visitsOpened": 12 }, provisional: true }], baseline);
    expect(brief.clauses.map((c) => c.key)).toEqual(["brief.visits.plain"]);
  });
});

describe("07c T8 — long periods carry drift, short periods carry comparison", () => {
  it("a six-month brief compares its own first half against its own second half", () => {
    const first = run(addDays(TODAY, -92), 91, { "billing.collectedPaise": 100000 });
    const second = run(TODAY, 92, { "billing.collectedPaise": 150000 });
    const brief = buildBrief("half", TODAY, [...first, ...second], []);

    const drift = brief.clauses.find((c) => c.key === "brief.collected.drift");
    expect(drift).toBeDefined();
    expect(drift!.values.direction).toBe("up");
    // Money renders as rupees on a surface a person reads — the paise are in `totals`.
    expect(drift!.values.total).toMatch(/^₹[\d,]+\.\d\d$/);
    expect(brief.totals["billing.collectedPaise"]).toBe(91 * 100000 + 92 * 150000);
  });

  /**
   * ═══ THE ASSERTION THAT FOUND A REAL DEFECT, KEPT AS THE REGRESSION ═══
   *
   * Three visits a day for ninety-one days is the flattest input there is, and the first
   * implementation reported "up" for it — because a quarter is an ODD number of days and the naive
   * split gave the second half 46 days against the first half's 45. Both long periods are odd (91
   * and 183), so EVERY quarterly and six-monthly brief would have flattered its reader, silently
   * and in the same direction. `buildBrief` now drops the middle day so the halves match.
   */
  it("drift compares EQUAL halves — a perfectly flat quarter reads flat, not rising", () => {
    const brief = buildBrief("quarter", TODAY, run(TODAY, 91, { "opd.visitsOpened": 3 }), []);
    expect(brief.clauses.map((c) => c.key)).toEqual(["brief.visits.drift"]);
    expect(brief.clauses[0]!.values.direction).toBe("flat");
  });

  it("and a flat SIX-MONTH window reads flat too — 183 days is odd for the same reason", () => {
    const brief = buildBrief("half", TODAY, run(TODAY, 183, { "opd.visitsOpened": 5 }), []);
    expect(brief.clauses[0]!.values.direction).toBe("flat");
  });

  it("a fact no module contributed produces no clause at all — silence, not a zero", () => {
    const brief = buildBrief("week", TODAY, run(TODAY, 7, { "opd.visitsOpened": 4 }), []);
    expect(JSON.stringify(brief.clauses)).not.toContain("collected");
    expect(brief.totals["billing.collectedPaise"]).toBeUndefined();
  });

  it("counts the days that carried any activity — the brief's own evidence count", () => {
    const days: DayFacts[] = [
      { day: "2026-08-15", facts: { "opd.visitsOpened": 0 }, provisional: false },
      { day: "2026-08-16", facts: { "opd.visitsOpened": 7 }, provisional: false },
      { day: TODAY, facts: { "opd.visitsOpened": 2 }, provisional: true },
    ];
    expect(buildBrief("week", TODAY, days, []).daysWithActivity).toBe(2);
  });
});

describe("07c T8 — summing a window", () => {
  it("adds every key across days, and a key absent everywhere stays absent", () => {
    expect(sumWindow([
      { day: "a", facts: { x: 1, y: 2 }, provisional: false },
      { day: "b", facts: { x: 3 }, provisional: false },
    ])).toEqual({ x: 4, y: 2 });
  });

  it("MIN_BASELINE_DAYS is a fortnight — stated once, so a clause cannot quietly use its own", () => {
    expect(MIN_BASELINE_DAYS).toBe(14);
  });
});

/**
 * PHASE STAFF-REPORTS T0 — THE YEAR PERIOD, AND THE DAY BASELINE THAT COULD NEVER FIRE.
 *
 * ═══ THE DEFECT THESE TESTS WERE WRITTEN AGAINST ═══
 *
 * `baselineWindowFor("day")` returned a ONE-DAY window — yesterday. `sameWeekdayBaseline` then
 * filters that window to the days sharing today's weekday, and yesterday never does, so the sample
 * was ALWAYS empty and `medianOf(sample, 4)` always returned null. The same-weekday comparison that
 * this file's header spends a paragraph justifying — "a Tuesday counter and a Saturday counter are
 * different jobs at an Indian hospital" — could not fire in production, ever.
 *
 * It survived because `baselineWindowFor` was exercised for `"week"` only, and the day-period tests
 * hand `buildBrief` a baseline array they built themselves. Calling the function with an input the
 * real caller would never produce cannot detect that the real caller produces a different one: the
 * seam between "which days the controller FETCHES" and "which days `buildBrief` NEEDS" had no test
 * standing on it. So the tests below go through `baselineWindowFor` rather than around it.
 */
describe("staff-reports T0 — the year period and the day baseline", () => {
  it("a year is a period, spanning 365 days ending today", () => {
    expect(PERIODS).toContain("year");
    expect(windowFor("year", TODAY)).toEqual({ from: "2025-08-18", to: TODAY });
  });

  /**
   * THE REGRESSION TEST FOR THE DEFECT, and it is built the way the controller builds it: take the
   * window `baselineWindowFor` actually returns, fill it, and ask whether the brief can speak.
   */
  it("the day baseline carries enough same-weekday candidates for a comparison to be possible", () => {
    const b = baselineWindowFor("day", TODAY);
    const days = run(b.to, spanOf(b), { "opd.visitsOpened": 10 });
    const sameWeekday = days.filter(
      (d) => new Date(`${d.day}T00:00:00.000Z`).getUTCDay()
        === new Date(`${TODAY}T00:00:00.000Z`).getUTCDay(),
    );
    // Four is `medianOf`'s floor for a day. A window that cannot hold four same-weekdays makes the
    // comparison unreachable no matter how diligently the person worked.
    expect(sameWeekday.length).toBeGreaterThanOrEqual(4);
  });

  it("a day IS compared against the same weekday, end to end through the real baseline window", () => {
    const b = baselineWindowFor("day", TODAY);
    const baseline = run(b.to, spanOf(b), { "opd.visitsOpened": 10 });
    const brief = buildBrief(
      "day", TODAY, [{ day: TODAY, facts: { "opd.visitsOpened": 12 }, provisional: true }], baseline,
    );
    const visits = brief.clauses.find((c) => c.key.startsWith("brief.visits"));
    expect(visits?.key).toBe("brief.visits.compared");
    expect(visits?.values.median).toBe("10");
  });

  /**
   * `needsBaseline` is the single fact both controllers and `buildBrief` must agree on. The long
   * periods carry DRIFT computed from the window itself and never read the baseline — fetching it
   * for them read 91 extra days for a quarter and threw every one away.
   */
  it("only the short periods need a baseline; the long ones drift within their own window", () => {
    expect(needsBaseline("day")).toBe(true);
    expect(needsBaseline("week")).toBe(true);
    expect(needsBaseline("month")).toBe(false);
    expect(needsBaseline("quarter")).toBe(false);
    expect(needsBaseline("half")).toBe(false);
    expect(needsBaseline("year")).toBe(false);
  });

  /**
   * What the horizon is enforced against. For a long period it is the window's own first day; for a
   * short one the baseline reaches further back and IT is the oldest day the request will read.
   */
  it("oldestDayRead is the furthest back a period actually reaches", () => {
    expect(oldestDayRead("quarter", TODAY)).toBe(windowFor("quarter", TODAY).from);
    expect(oldestDayRead("year", TODAY)).toBe(windowFor("year", TODAY).from);
    expect(oldestDayRead("day", TODAY)).toBe(baselineWindowFor("day", TODAY).from);
    expect(oldestDayRead("week", TODAY)).toBe(baselineWindowFor("week", TODAY).from);
  });
});
