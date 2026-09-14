import { parseDays } from "../scripts/backfill-facts";

/**
 * PHASE STAFF-REPORTS T2 — THE ONLY PART OF THE BACKFILL THAT IS THIS SCRIPT'S OWN CODE.
 *
 * The work is `rollupAll`, whose properties are pinned in `rollup.test.ts` (A2 idempotence, A3 that
 * today is never written, A5 the re-roll, and T2's two: a large window writes the whole range and
 * reaches past `LOOKBACK_DAYS`). What is left here is argument handling — and it matters more than
 * it looks, because the failure mode is an operator running a tens-of-thousands-of-rollups job by
 * pressing enter on a script whose name sounds harmless.
 */
describe("staff-reports T2 — backfill:facts argument handling", () => {
  it("reads --days", () => {
    expect(parseDays(["--days=365"])).toBe(365);
    expect(parseDays(["--days=1"])).toBe(1);
  });

  /**
   * NO DEFAULT, AND THE ABSENCE IS THE FEATURE. A default of 365 would make the expensive run the
   * one you get for typing nothing. The operator states the number.
   */
  it("REFUSES to run with no --days, and the message says what to pass", () => {
    expect(() => parseDays([])).toThrow(/--days=N/);
    expect(() => parseDays([])).toThrow(/365/); // it names the usual answer rather than making them guess
  });

  it("refuses anything that is not a positive whole number of days", () => {
    for (const bad of ["--days=0", "--days=-5", "--days=1.5", "--days=abc", "--days="]) {
      expect(() => parseDays([bad])).toThrow(/positive whole number|--days=N/);
    }
  });

  it("finds --days among other arguments rather than only in first position", () => {
    expect(parseDays(["--verbose", "--days=90"])).toBe(90);
  });
});
