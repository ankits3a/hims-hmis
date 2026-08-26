import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureSchema, viewFromFixture } from "./fixture-schema";
import { accrualBasis } from "../accrual";

/**
 * Plan 09 T6 — DD12's golden fixtures. Each one is HAND-COMPUTED: its `workings` shows the
 * arithmetic that produced every number in its expectation, and `fixture-schema.ts` refuses to
 * parse a fixture whose workings are under twenty characters.
 *
 * ONE FIXTURE PER MONEY PATH, and the list is the acceptance criterion:
 *   p01 no credit note and no reversal — the invariant DD12's rewrite had to preserve
 *   p02 a part payment of a mixed invoice — the base is COLLECTED, not invoiced (F3)
 *   p03 §3 Q4's OWN counter-example — 45 000 correct against the refuted version's 63 543 (F3b)
 *   p04 an allocation reversal — the negative delta that a two-name consumer never sees (F3c)
 *   p05 a partial refund — proportional, never a full reversal (F8)
 *   p06 an entered-in-error invoice — target 0 by branch
 *   p07 a clearance-discount note — moves the receivable and no line's base (DD19's asymmetry)
 *   p08 an ineligible category — a paid invoice that earns nothing
 *   p09 settleable 0 — the branch that stops `divHalfUp` being handed a zero divisor
 */
const dir = join(__dirname, "fixtures");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

test("the fixture set is complete and NAMED — a renamed or duplicated fixture cannot pass, an empty dir never passes vacuously", () => {
  expect(files).toEqual([
    "p01-no-credit-reduces-to-eligible-base.json",
    "p02-part-payment-of-a-mixed-invoice.json",
    "p03-credit-note-counter-example.json",
    "p04-allocation-reversed-gives-it-back.json",
    "p05-partial-refund-is-proportional.json",
    "p06-entered-in-error-reverses-everything.json",
    "p07-clearance-discount-moves-the-receivable-only.json",
    "p08-ineligible-category-earns-nothing.json",
    "p09-settleable-zero-never-divides.json",
    "p10-collected-exceeds-settleable-on-a-mixed-invoice.json",
  ]);
});

test("the fixtures directory contains NOTHING but the manifest — a .JSON straggler or stray file cannot hide", () => {
  // `files` filters `.endsWith(".json")` case-sensitively, so a p99-rogue.JSON would ship in the
  // tree while being invisible to every fixture test (Plan 06's audit m10, copied deliberately).
  expect([...readdirSync(dir)].sort()).toEqual(files);
});

test("no fixture is vacuous: every fixture prices at least one line, and its stated delta IS target − prior", () => {
  for (const file of files) {
    const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    expect(fixture.view.lines.length).toBeGreaterThan(0);
    // The fixture states `deltaPaise` rather than deriving it, so that a fixture can be READ on
    // its own — and this leg is what stops the two halves drifting apart.
    expect(fixture.expected.deltaPaise).toBe(fixture.expected.targetPaise - fixture.priorPaise);
  }
});

test("the fixture set covers both signs and the zero — a set of nine additions would prove nothing about reversal", () => {
  const deltas = files.map(
    (f) => fixtureSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))).expected.deltaPaise,
  );
  expect(deltas.some((d) => d > 0)).toBe(true);
  expect(deltas.some((d) => d < 0)).toBe(true);
  expect(deltas.some((d) => d === 0)).toBe(true);
});

for (const file of files) {
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
  test(`golden ${file}: ${fixture.name}`, () => {
    const basis = accrualBasis(viewFromFixture(fixture.view), fixture.terms);
    // FULL deep-equal of every number the base produces, never a partial match on the one the
    // author happened to be thinking about.
    expect(basis).toEqual({
      eligibleBasePaise: fixture.expected.eligibleBasePaise,
      settleablePaise: fixture.expected.settleablePaise,
      collectedPaise: fixture.expected.collectedPaise,
      targetBasePaise: fixture.expected.targetBasePaise,
      targetPaise: fixture.expected.targetPaise,
    });
    expect(basis.targetPaise - fixture.priorPaise).toBe(fixture.expected.deltaPaise);
  });
}
