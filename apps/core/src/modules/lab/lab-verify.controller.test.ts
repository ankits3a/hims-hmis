import { newId } from "@hmis/contracts";
import { amendResultBody } from "./lab-verify.controller";

/**
 * ═══ 17d T1 / F1 — THE GUARD SHIPPED WITH NO DOOR, AND FOUR GREEN TESTS DID NOT SEE IT ═══
 *
 * `amendResult` has accepted `impossibleOverride` since #71 and reads it at `results.ts:1210`. The
 * wire schema did not declare it, and a non-strict `z.object` STRIPS what it does not declare — so
 * the field was discarded on every request and the refusal always computed `no_override`. A signed
 * result made impossible by a later demographic correction could not be re-keyed from any route,
 * and the refusal rendered a "check the other tube" list the user had no way to act on.
 *
 * **#71's four tests all called the SERVICE directly.** Every one of them passed `impossibleOverride`
 * as a TypeScript argument, which no wire ever had to carry. That is the gap this file closes: the
 * contract under test is what crosses the boundary, and a service-level test cannot see a boundary
 * it never crosses.
 *
 * The shape is `accession.test.ts`'s, which guards `receiveBody` the same way for the same reason —
 * a wire schema is a contract and deserves an assertion, not just a reading.
 */
describe("amendResultBody — the wire carries the second pair of hands", () => {
  const base = { resultId: newId(), value: "41.0" };

  it("CARRIES impossibleOverride, naming who vouched — stripped, the 17d T1 amendment guard has no door", () => {
    const parsed = amendResultBody.parse({ ...base, impossibleOverride: { by: newId() } });
    expect(parsed.impossibleOverride).toBeDefined();
  });

  it("preserves the ID it was given, rather than merely accepting the key", () => {
    const by = newId();
    expect(amendResultBody.parse({ ...base, impossibleOverride: { by } }).impossibleOverride?.by).toBe(by);
  });

  /**
   * A SECOND PERSON, NEVER A CHECKBOX — the same rule `receiveBody`'s header states for
   * `absurdOverride`. `{ force: true }` would make the override something the same technologist
   * ticks, which is the dialog people learn to click through.
   */
  it("refuses a boolean override", () => {
    expect(amendResultBody.safeParse({ ...base, impossibleOverride: true }).success).toBe(false);
    expect(amendResultBody.safeParse({ ...base, impossibleOverride: { by: "" } }).success).toBe(false);
  });

  it("stays OPTIONAL — the ordinary amendment names nobody", () => {
    expect(amendResultBody.parse(base).impossibleOverride).toBeUndefined();
  });
});
