import { DeskError } from "./types";
import {
  RANGE_DIMENSIONS, assertRange, daysInRange, dropEmptyBuckets, keyOf, mergeBuckets, projectKey,
  totalsOf,
} from "./range";
import type { RangeBucket, RangeDimension } from "./range";

/**
 * PHASE STAFF-REPORTS T3 — THE MERGE, tested without a database.
 *
 * This file is about the seam where two modules' numbers meet on a key neither of them knows the
 * other computed. The queries that produce the buckets are each module's own and are tested against
 * real rows; what cannot be tested there is whether OPD's bucket and billing's bucket LAND ON THE
 * SAME KEY — by construction, a test that exercises one module can never see that.
 */
const G = (...d: RangeDimension[]): RangeDimension[] => d;

describe("staff-reports T3 — the key", () => {
  /**
   * ═══ THE BUG THIS EXISTS TO PREVENT ═══
   *
   * A key built from `Object.keys` inherits INSERTION ORDER. Two modules writing the same logical
   * key with their fields assigned in a different sequence would produce two different strings and
   * fail to merge — and the symptom is not an error, it is one column double-counted, visible only
   * when both modules happen to contribute to the same report.
   */
  it("is order-independent: the same key written two ways merges", () => {
    const a = { userId: "u1", departmentId: "d1" };
    const b = { departmentId: "d1", userId: "u1" };
    expect(keyOf(a, G("userId", "departmentId"))).toBe(keyOf(b, G("userId", "departmentId")));
  });

  it("distinguishes keys that differ in any grouped dimension", () => {
    const g = G("userId", "departmentId");
    expect(keyOf({ userId: "u1", departmentId: "d1" }, g))
      .not.toBe(keyOf({ userId: "u1", departmentId: "d2" }, g));
  });

  /**
   * A DIMENSION NOT GROUPED BY IS NOT PART OF THE KEY. Two buckets differing only in department
   * must merge when the request is grouped by user alone — otherwise "by user" would silently
   * return one row per user per department and the user column would repeat.
   */
  it("ignores dimensions the request is not grouped by", () => {
    const g = G("userId");
    expect(keyOf({ userId: "u1", departmentId: "d1" }, g))
      .toBe(keyOf({ userId: "u1", departmentId: "d2" }, g));
  });

  /**
   * THE SEPARATOR HAS TO BE A CHARACTER AN ID CANNOT CONTAIN. With a printable separator, a single
   * department literally named to contain it collides with a two-field key — the classic
   * delimiter-injection shape, arriving here as two departments' numbers silently added together.
   */
  it("a value containing a printable delimiter cannot forge another key", () => {
    const g = G("userId", "departmentId");
    expect(keyOf({ userId: "a|b", departmentId: "c" }, g))
      .not.toBe(keyOf({ userId: "a", departmentId: "b|c" }, g));
  });

  it("projectKey keeps exactly the grouped dimensions", () => {
    const k = { userId: "u1", departmentId: "d1", doctorId: "dr1", visitType: "new", day: "2026-09-14" };
    expect(projectKey(k, G("userId", "visitType"))).toEqual({ userId: "u1", visitType: "new" });
  });

  /**
   * EVERY DIMENSION MUST SURVIVE `projectKey`, and this went red the moment T5 added `payer` and
   * `serviceCategory` — which is the point of it. A dimension added to `RANGE_DIMENSIONS` but
   * forgotten in `projectKey` would be silently dropped from every key, and the symptom would be
   * rows merging that should not have: two payers' money added together under one heading.
   *
   * The fixture below must name every dimension. Adding one to the enum and not to this line is
   * how the test stops testing anything.
   */
  it("every dimension is projectable — none is silently dropped", () => {
    const k = {
      userId: "u", departmentId: "d", doctorId: "r", visitType: "new",
      payer: "tpa", serviceCategory: "consultation", day: "2026-09-14",
    };
    expect(Object.keys(projectKey(k, RANGE_DIMENSIONS)).sort()).toEqual([...RANGE_DIMENSIONS].sort());
  });
});

describe("staff-reports T3 — the merge", () => {
  it("adds measures from different modules that share a key", () => {
    const buckets: RangeBucket[] = [
      { key: { userId: "u1" }, measures: { "opd.visitsOpened": 4 } },
      { key: { userId: "u1" }, measures: { "billing.collectedPaise": 25_000 } },
    ];
    const rows = mergeBuckets(buckets, G("userId"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.measures).toEqual({ "opd.visitsOpened": 4, "billing.collectedPaise": 25_000 });
  });

  it("adds the same measure contributed twice for one key", () => {
    const rows = mergeBuckets([
      { key: { userId: "u1" }, measures: { n: 3 } },
      { key: { userId: "u1" }, measures: { n: 4 } },
    ], G("userId"));
    expect(rows[0]!.measures["n"]).toBe(7);
  });

  it("keeps distinct keys apart", () => {
    const rows = mergeBuckets([
      { key: { userId: "u1" }, measures: { n: 3 } },
      { key: { userId: "u2" }, measures: { n: 4 } },
    ], G("userId"));
    expect(rows).toHaveLength(2);
    expect(totalsOf(rows)["n"]).toBe(7);
  });

  /**
   * A MEASURE ONLY ONE MODULE CONTRIBUTES IS ABSENT ELSEWHERE, not zero. Same distinction
   * `rollup.ts` draws between a missing key and a zero: absent means "this module said nothing
   * about that key", and rendering it as 0 would assert something nobody measured.
   */
  it("a measure only one module contributes is absent from the other keys", () => {
    const rows = mergeBuckets([
      { key: { userId: "u1" }, measures: { "opd.visitsOpened": 4, "billing.collectedPaise": 100 } },
      { key: { userId: "u2" }, measures: { "opd.visitsOpened": 2 } },
    ], G("userId"));
    const u2 = rows.find((r) => r.key.userId === "u2")!;
    expect(u2.measures["billing.collectedPaise"]).toBeUndefined();
  });

  /** The same contract `rollupUserDay` enforces, for the same reason: this sums across a year. */
  it.each([
    ["a float", 1.5],
    ["a negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("REFUSES %s rather than storing it", (_label, value) => {
    expect(() => mergeBuckets([{ key: { userId: "u" }, measures: { n: value } }], G("userId")))
      .toThrow(DeskError);
  });

  it("an empty contribution is an empty table, not an error", () => {
    expect(mergeBuckets([], G("userId"))).toEqual([]);
    expect(totalsOf([])).toEqual({});
  });
});

describe("staff-reports T3 — a bucket that measured nothing is dropped", () => {
  /**
   * ═══ THE SQL FACT BEHIND THIS, FOUND BY THE PARITY TEST AND NOT BY A UNIT TEST ═══
   *
   * An aggregate with NO `GROUP BY` returns ONE ROW even when nothing matched: `count()` over an
   * empty set is `0`, not no rows. A module keying by a dimension it does not carry — a booking has
   * no visit type — correctly falls back to grouping by nothing, and on a quiet day that emits a
   * bucket asserting `opd.appointmentsBooked: 0`.
   *
   * The zero is a claim nobody measured, and it made the report's SHAPE depend on how it was
   * grouped: the measure appeared as a column under one grouping and was absent under another.
   * `range-parity.test.ts`'s dimension-invariance assertion is what caught it.
   */
  it("drops a bucket whose every measure is zero", () => {
    expect(dropEmptyBuckets([{ key: {}, measures: { "opd.appointmentsBooked": 0 } }])).toEqual([]);
  });

  it("KEEPS a bucket where any measure is non-zero, zeros and all", () => {
    const b = [{ key: { userId: "u" }, measures: { a: 0, b: 3 } }];
    expect(dropEmptyBuckets(b)).toEqual(b);
  });

  /** A bucket with no measures at all measured nothing, by the same reasoning. */
  it("drops a bucket with no measures", () => {
    expect(dropEmptyBuckets([{ key: { userId: "u" }, measures: {} }])).toEqual([]);
  });

  /** Dropping must not change any total — it removes zeros, which is why it is safe. */
  it("changes no total", () => {
    const buckets = [
      { key: { userId: "u1" }, measures: { a: 4 } },
      { key: { userId: "u2" }, measures: { a: 0 } },
    ];
    expect(totalsOf(mergeBuckets(dropEmptyBuckets(buckets), ["userId"])))
      .toEqual(totalsOf(mergeBuckets(buckets, ["userId"])));
  });
});

describe("staff-reports T3 — totals", () => {
  /**
   * THE FOOTER IS SUMMED FROM THE ROWS, so it cannot disagree with the table above it. This is the
   * in-table half of the same property `range-parity.test.ts` asserts between the two instruments.
   */
  it("the totals row is exactly the sum of the rows shown", () => {
    const rows = mergeBuckets([
      { key: { userId: "u1" }, measures: { a: 3, b: 10 } },
      { key: { userId: "u2" }, measures: { a: 4 } },
      { key: { userId: "u3" }, measures: { b: 5 } },
    ], G("userId"));
    expect(totalsOf(rows)).toEqual({ a: 7, b: 15 });
  });
});

describe("staff-reports T3 — the range itself", () => {
  it("counts days inclusively at both ends", () => {
    expect(daysInRange("2026-09-14", "2026-09-14")).toBe(1);
    expect(daysInRange("2026-09-01", "2026-09-30")).toBe(30);
    expect(daysInRange("2026-02-27", "2026-03-01")).toBe(3); // 2026 is not a leap year
  });

  /** An inverted range returns nothing, and nothing reads as a quiet year. So it refuses. */
  it("REFUSES an inverted range instead of returning an empty report", () => {
    expect(() => assertRange({ from: "2026-09-14", to: "2026-09-01" })).toThrow(DeskError);
    expect(() => assertRange({ from: "2026-09-14", to: "2026-09-14" })).not.toThrow();
  });
});
