import { ROLE_MODEL } from "../scripts/seed-roles";

/**
 * THE §13 WALK FINDING (2026-09-28) — A HELD REPORT COULD BE RELEASED BY NOBODY.
 *
 * Releasing a held report is ONE act that needs TWO permissions: the route
 * (`POST /lab/reports/:id/release`) requires `lab.reports.release_unpaid`, and `releaseUnpaid` is
 * `printReport`, which requires `lab.reports.print`. The seeds gave the first to `billing_manager`
 * and the second to `lab_reception`, so the owner's granted approval could not be used by anyone:
 * the counter got 403 on the route, and the billing manager could not open the counter at all.
 * `reports.test.ts` never saw it because it grants both strings to one test role.
 *
 * So this reads the SEEDED model, the thing production runs: some role must hold both halves.
 */
describe("the held-report release seam", () => {
  const holders = (permission: string): string[] =>
    ROLE_MODEL.filter((r) => r.permissions.includes(permission)).map((r) => r.roleKey);

  it("a seeded role holds BOTH halves of the release — the route's grant and the print it performs", () => {
    const both = holders("lab.reports.release_unpaid").filter((r) => holders("lab.reports.print").includes(r));
    expect(both).toContain("lab_reception");
  });

  it("that role can also raise the request the owner decides — ask, then act, at one counter", () => {
    expect(holders("approvals.requests.create")).toContain("lab_reception");
  });
});
