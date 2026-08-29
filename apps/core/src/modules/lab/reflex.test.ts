import { matchReflex } from "./reflex";
import type { ReflexRule } from "./reflex";

/**
 * PLAN 17a T3 — THE REFLEX MATCHER. Assertion Book row **A7**.
 *
 * Fail-first is discharged by the mutant (see `ranges.test.ts`'s header — §2.5).
 */
function rule(over: Partial<ReflexRule> = {}): ReflexRule {
  return {
    id: "rr-tsh", analyteId: "an-tsh", comparator: "gt", threshold: "6.0000",
    addsServiceId: "svc-ft4", active: false, version: 1,
    createdBy: "t", createdAt: new Date(), updatedBy: "t", updatedAt: new Date(),
    ...over,
  } as ReflexRule;
}

describe("the reflex matcher (17a T3)", () => {
  /**
   * ═══ A7 — ONLY ACTIVE RULES MATCH ═══
   *
   * The catalogue ships three rules and all three are INACTIVE: a reflex is an order the system
   * places and the patient pays for, so it is switched on by a human decision per hospital, never
   * by shipping. The mutant drops the `active` check — with the TSH rule off, it fires anyway and
   * bills a patient for an FT4 nobody enabled.
   *
   * **The consent half of DD8 is NOT here** and its absence is deliberate: `reflex_consented_at` is
   * a fact about the ORDER ITEM, which this pure function cannot see. 17b's caller checks it, and
   * 17a §6.3 says so, so the two halves cannot both assume the other did it.
   */
  it("A7: an INACTIVE rule never matches, however far past the threshold the value is", () => {
    const inactive = rule({ active: false });
    expect(matchReflex([inactive], { analyteId: "an-tsh", valueNumeric: "9.0" })).toEqual([]);
    // The same value against the same rule, switched on, DOES match — so the test discriminates the
    // flag and not the comparison.
    const active = rule({ active: true });
    const hits = matchReflex([active], { analyteId: "an-tsh", valueNumeric: "9.0" });
    expect(hits).toHaveLength(1);
    expect([hits[0]!.ruleId, hits[0]!.addsServiceId, hits[0]!.because]).toEqual(["rr-tsh", "svc-ft4", "9.0 > 6.0000"]);
  });

  it("matches only its own analyte, and compares with the comparator it names", () => {
    const active = rule({ active: true });
    expect(matchReflex([active], { analyteId: "an-ft4", valueNumeric: "9.0" })).toEqual([]);
    expect(matchReflex([active], { analyteId: "an-tsh", valueNumeric: "6.0" })).toEqual([]); // gt, not gte
    expect(matchReflex([rule({ active: true, comparator: "gte" })], { analyteId: "an-tsh", valueNumeric: "6.0" }))
      .toHaveLength(1);
    expect(matchReflex([rule({ active: true, comparator: "lt", threshold: "0.1000" })],
      { analyteId: "an-tsh", valueNumeric: "0.05" })).toHaveLength(1);
  });

  /**
   * TWO RULES ON ONE ANALYTE IS LEGITIMATE — a TSH of 12 might add both FT4 and anti-TPO — so the
   * matcher returns an ARRAY. One that returned the first match would silently drop the second,
   * and no reader of the result could tell which of the two had been dropped.
   */
  it("returns EVERY active rule the value satisfies, not the first", () => {
    const hits = matchReflex([
      rule({ id: "r1", active: true, addsServiceId: "svc-ft4" }),
      rule({ id: "r2", active: true, addsServiceId: "svc-tpo", threshold: "8.0000" }),
      rule({ id: "r3", active: true, addsServiceId: "svc-never", threshold: "50.0000" }),
    ], { analyteId: "an-tsh", valueNumeric: "9.0" });
    expect(hits.map((h) => h.addsServiceId)).toEqual(["svc-ft4", "svc-tpo"]);
  });

  /** A reflex compares a magnitude; a text or coded result has none and matches nothing. */
  it("a non-numeric result matches nothing", () => {
    const active = rule({ active: true });
    expect(matchReflex([active], { analyteId: "an-tsh", valueNumeric: null })).toEqual([]);
    expect(matchReflex([active], { analyteId: "an-tsh", valueNumeric: "Reactive" })).toEqual([]);
  });
});
