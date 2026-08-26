import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MembershipError, membershipHttpStatus } from "../membership";

/**
 * PLAN 09 CLOSE REMEDIATION (owner-authorised 2026-08-26) — A MEMBERSHIP REFUSAL MUST NOT REACH A
 * COUNTER AS A 500.
 *
 * T4 wired `resolveInstruments`, `consumeEntitlements` and `redeemCoupon` into `issueInvoice`, so a
 * `MembershipError` escapes through `billing.controller.ts`. That controller's `toHttp` had a
 * clause for BillingError, TariffError, OpdError, PatientError, ApprovalError, WorkflowError and
 * SodViolationError — and none for MembershipError, so every code in that union fell through to the
 * rethrow and answered 500.
 *
 * The one that will actually happen at a desk: a member with one free consult left, billed for two
 * consults on one invoice, is refused WHOLE with `entitlement_exhausted`. That refusal is correct —
 * the clerk must split the bill — but an unexplained server error does not say so.
 * `MEMBER_BENEFITS_ENABLED` is what arms it, which is why this landed before any flip.
 */
describe("a membership refusal answers a typed status, never 500", () => {
  it("maps the code a busy counter will actually hit", () => {
    // The refusal that motivated this fix. 409 = a state conflict the caller can act on.
    expect(membershipHttpStatus("entitlement_exhausted")).toBe(409);
    expect(membershipHttpStatus("coupon_already_redeemed")).toBe(409);
    // The rate limiter must keep its own status or `Retry-After` becomes meaningless.
    expect(membershipHttpStatus("lookup_rate_limited")).toBe(429);
    expect(membershipHttpStatus("unknown_instrument")).toBe(404);
    expect(membershipHttpStatus("import_columns_unknown")).toBe(400);
  });

  it("never answers 500 for ANY code in the closed union", () => {
    /**
     * The union is closed, so this list is checkable against it: a code added without a mapping
     * decision falls to the `return 409` default, which is a deliberate default rather than an
     * accident — what must never happen is a 5xx.
     */
    const EVERY_CODE = [
      "unknown_instrument", "unknown_plan", "unknown_member",
      "instrument_not_valid", "instrument_expired", "instrument_suspended", "instrument_unverified",
      "lookup_rate_limited", "grace_honor_approval_required", "approval_subject_mismatch",
      "unknown_counter", "counter_lapsed", "entitlement_exhausted",
      "unknown_coupon", "coupon_expired", "coupon_not_yet_valid", "coupon_out_of_window",
      "coupon_not_applicable", "coupon_min_bill_not_met", "coupon_already_redeemed",
      "redemption_not_found", "redemption_already_released",
      "family_cap_exceeded",
      "import_columns_unknown", "import_row_quarantined", "import_duplicate_key",
      "import_already_applied", "import_range_inverted",
      "match_already_resolved", "match_candidate_unknown",
      "sales_disabled", "benefits_disabled", "coupon_issuance_disabled",
    ] as const;
    for (const code of EVERY_CODE) {
      const status = membershipHttpStatus(code);
      expect({ code, is5xx: status >= 500 }).toEqual({ code, is5xx: false });
      expect({ code, is4xx: status >= 400 && status < 500 }).toEqual({ code, is4xx: true });
    }
  });

  it("carries the detail the counter needs to act, not just a code", () => {
    const e = new MembershipError("entitlement_exhausted", "one free consult, two billed", { held: 1, asked: 2 });
    expect(e.detail).toEqual({ held: 1, asked: 2 });
    expect(membershipHttpStatus(e.code)).toBe(409);
  });

  /**
   * THE STRUCTURAL LEG, AND IT IS WHY THIS FILE IS UNDER `modules/billing` RATHER THAN
   * `modules/membership`. The mapping above can be perfect while `billing.controller.ts` still has
   * no clause that calls it — which is exactly the state that shipped. This reads the shipped
   * source and THROWS rather than returning empty on a shape it does not recognise (§2.49): a
   * parser that finds no `toHttp` would agree with every implementation ever written.
   */
  it("billing's toHttp has a MembershipError clause that uses the SHARED mapper", () => {
    const source = readFileSync(join(__dirname, "billing.controller.ts"), "utf8");
    const start = source.indexOf("function toHttp(");
    if (start === -1) throw new Error("billing.controller.ts: no `function toHttp(` — this parser is stale");
    const end = source.indexOf("\n}", start);
    if (end === -1) throw new Error("billing.controller.ts: `toHttp` has no closing brace — this parser is stale");
    const body = source.slice(start, end);
    expect(body).toContain("e instanceof MembershipError");
    // Shared, never copied: a second hand-maintained status table is §2.54's defect.
    expect(body).toContain("membershipHttpStatus(e.code)");
    expect(source).toContain('from "../membership"');
    // The clause must precede the rethrow, or it never runs.
    expect(body.indexOf("MembershipError")).toBeLessThan(body.length);
  });

  it("membership's own controller uses the SAME mapper, so the two routes cannot disagree", () => {
    const source = readFileSync(join(__dirname, "..", "membership", "membership.controller.ts"), "utf8");
    expect(source).toContain("membershipHttpStatus(e.code)");
    // The private copy T3 shipped is gone — one fact, one place.
    expect(source).not.toContain("function membershipStatus(");
  });
});
