import type { labReflexRules } from "../../kernel/db/schema";

/**
 * PLAN 17a T3 / DD8 — THE REFLEX MATCHER. PURE, and it decides ONE thing: does this verified value
 * satisfy this rule's comparison?
 *
 * ═══ WHAT THIS FUNCTION DELIBERATELY DOES NOT DECIDE ═══
 *
 * **It does not check consent, and 17b's caller does** (T6 A4b). DD8 gates a reflex on
 * `lab_items.reflex_consented_at` — the patient agreed at the desk that extra tests may be added
 * and billed — and that is a fact about the ORDER ITEM, not about the rule or the value. Putting it
 * here would mean this pure function needed a row it cannot see, and the honest alternative is to
 * pass a boolean it would then have no way to verify. So the seam is: **this says "the rule fires",
 * the caller says "and we may act on it".** 17a §6.3 states it so 17b cannot assume otherwise.
 *
 * It also does not decide WHICH specimen the reflex rides, or whether the tube is disposed — both
 * are 17b's, over rows this file has no business reading.
 *
 * ═══ `active` IS CHECKED HERE, AND IT IS THE ONE GATE THAT COULD NOT LIVE ANYWHERE ELSE ═══
 *
 * The catalogue ships three rules and ALL THREE ARE INACTIVE (`active: false` in the fixture, and
 * `lab_reflex_rules.active` defaults false). A reflex is an order placed by the system that a
 * patient pays for, so it is switched ON by a human decision per hospital, never by shipping.
 * T3 A7's mutant ignores the flag: with the TSH rule inactive, the shipped matcher returns nothing
 * and the mutant fires — which is a test that would bill a patient for an FT4 nobody enabled.
 */
export type ReflexRule = typeof labReflexRules.$inferSelect;

export type ReflexMatch = {
  ruleId: string;
  ruleVersion: number;
  analyteId: string;
  addsServiceId: string;
  /** For the event payload and the audit trail: the comparison that fired, rendered. */
  because: string;
};

const COMPARATORS: Record<string, (v: number, t: number) => boolean> = {
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
  lt: (v, t) => v < t,
  lte: (v, t) => v <= t,
};

const SYMBOL: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

/**
 * Every ACTIVE rule this verified numeric value satisfies.
 *
 * Returns an ARRAY rather than the first match: two rules on one analyte is legitimate (a TSH of 12
 * might add both FT4 and anti-TPO), and a matcher that returned one would silently drop the second
 * with no way for a reader to tell which. The caller places one order per match.
 *
 * **A non-numeric result matches nothing.** A reflex compares a magnitude; a `text` or `coded`
 * result has none, and a rule written against one is a catalogue defect the upsert refuses rather
 * than a comparison this function should invent.
 */
export function matchReflex(
  rules: readonly ReflexRule[],
  result: { analyteId: string; valueNumeric: string | null },
): ReflexMatch[] {
  if (result.valueNumeric === null) return [];
  const value = Number(result.valueNumeric);
  if (!Number.isFinite(value)) return [];

  const matches: ReflexMatch[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    if (rule.analyteId !== result.analyteId) continue;
    const compare = COMPARATORS[rule.comparator];
    // A comparator outside the four is refused by `lab_reflex_rules_comparator_ck` at insert, so
    // this branch is unreachable through the schema. It is a `continue` rather than a throw because
    // a rule nobody can evaluate must not stop a pathologist verifying a result.
    if (compare === undefined) continue;
    const threshold = Number(rule.threshold);
    if (!Number.isFinite(threshold)) continue;
    if (!compare(value, threshold)) continue;
    matches.push({
      ruleId: rule.id,
      ruleVersion: rule.version,
      analyteId: rule.analyteId,
      addsServiceId: rule.addsServiceId,
      because: `${result.valueNumeric} ${SYMBOL[rule.comparator] ?? rule.comparator} ${rule.threshold}`,
    });
  }
  return matches;
}
