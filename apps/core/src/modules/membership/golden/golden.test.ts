import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contextFromFixture, fixtureSchema, instrumentsFromFixture } from "./fixture-schema";
import { priceInvoiceLines } from "../../tariff";

/**
 * Plan 09 T2 — the golden fixtures. Each one is HAND-COMPUTED: its `workings` shows the arithmetic
 * that produced every number in its expectation, and `fixture-schema.ts` refuses to parse a
 * fixture whose workings are under twenty characters.
 *
 * The nine cases are the ones the plan's §6 T2 acceptance names, one fixture each — the off-peak
 * boundary taking two, because a boundary that is only tested on the inside is not a boundary.
 */
const dir = join(__dirname, "fixtures");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

test("the fixture set is complete and NAMED — a renamed or duplicated fixture cannot pass, an empty dir never passes vacuously", () => {
  expect(files).toEqual([
    "m01-member-coupon-contest.json",
    "m02-coupon-on-exempt-line.json",
    "m03-percentage-cap-exact-hit.json",
    "m04-offpeak-boundary-inside.json",
    "m05-offpeak-boundary-outside.json",
    "m06-ist-midnight-expiry.json",
    "m07-min-bill-before-discount.json",
    "m08-zero-amount-line.json",
    "m09-three-instrument-contest.json",
  ]);
});

test("the fixtures directory contains NOTHING but the manifest — a .JSON straggler or stray file cannot hide", () => {
  // `files` filters `.endsWith(".json")` case-sensitively, so an m99-rogue.JSON would ship in the
  // tree while being invisible to every fixture test (Plan 06's audit m10, copied deliberately).
  expect([...readdirSync(dir)].sort()).toEqual(files);
});

test("no fixture is vacuous: every fixture prices at least one line and expects one result per line", () => {
  for (const file of files) {
    const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    expect(fixture.lines.length).toBeGreaterThan(0);
    expect(fixture.expected.length).toBe(fixture.lines.length);
  }
});

for (const file of files) {
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
  test(`golden ${file}: ${fixture.name}`, () => {
    const resolved = instrumentsFromFixture(fixture.resolved);
    const ctx = contextFromFixture(fixture.config, resolved);
    const priced = priceInvoiceLines(ctx, fixture.lines);
    expect(priced.length).toBe(fixture.expected.length);
    priced.forEach((line, i) => expect(line).toEqual(fixture.expected[i]?.line)); // FULL deep-equal
  });
}
