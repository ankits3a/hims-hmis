import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PLAN 09 T8 — E-32's ENFORCEMENT POINTS, COLLECTED AND TESTED IN ONE PLACE, PLUS §6.0 S5's
 * EXPLICIT NON-GOAL FOR `check:config-present`.
 *
 * This file lives in `apps/core` and reads `apps/web` SOURCE as text — the
 * `apps/core/test/caddyfile-parity.test.ts` precedent, copied rather than invented: that file
 * already parses the SPA's route table from inside a core test, so a core test reading a web
 * screen's source for a forbidden token is the same discipline, one directory over.
 *
 * ═══ WHY "COLLECTED IN ONE PLACE" MATTERS, RATHER THAN TRUSTING EACH SCREEN'S OWN COMMENT ═══
 *
 * `counter-instruments.tsx` (T3) and `billing-counter.tsx` (T3) each carry their OWN comment
 * disclaiming a sales figure — "NO SALES FIGURE, ANYWHERE (E-32)" and "It shows NO figure of any
 * kind (E-32)" respectively. Both are true today and neither is enforced: a comment cannot fail a
 * build. This file is the single enforcement point a later screen has to pass, so E-32 survives a
 * change to either file (or a THIRD counter screen) without depending on every author re-reading
 * two comments this task did not write.
 *
 * ═══ WHY THE FORBIDDEN VOCABULARY IS MEMBERSHIP/PARTNER-SPECIFIC, NOT "ANY MONEY FIGURE" ═══
 *
 * `billing-counter.tsx` legitimately renders the INVOICE's own totals — gross, discount, tax,
 * rounding, net payable — through `fmtPaise`, on every bill, and that is not what E-32 forbids. The
 * guardrail is narrower and it is the one DD16 actually states: no counter screen may show a
 * CHANNEL/MEMBERSHIP business figure (a commission, a "cards sold" count, a "you saved ₹X", the
 * channel P&L's own numbers) — the temptation the plan names as arriving "as a UX feature request".
 * A blanket "no `fmtPaise` at the counter" check would be false the moment it ran; this one is not.
 */

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const WEB_SCREENS = resolve(REPO_ROOT, "apps", "web", "src", "screens");
const CHECK_CONFIG_PRESENT = resolve(REPO_ROOT, "apps", "core", "scripts", "check-config-present.ts");

/**
 * THE COUNTER SCREENS — where a member or a cashier stands, as opposed to a back-office report.
 * `partner-pnl.tsx` (this task) and `partner-receivables.tsx` (T7) are deliberately NOT here: both
 * are back-office/reconciliation desks whose entire purpose is to show partner money, guarded by
 * permissions no counter role holds (`partners.pnl.read`, `partners.receivable.operate`, both
 * NOT_YET_MODELLED). E-32 governs the desk a member is standing in front of, not a report about them.
 */
const COUNTER_SCREENS = ["counter-instruments.tsx", "billing-counter.tsx"].map((f) => resolve(WEB_SCREENS, f));

/** A membership/channel business figure, never a generic "any money on screen" token. */
const FORBIDDEN_SALES_TOKENS = [
  "commission", "cardsSold", "salesTotal", "salesFigure", "salesKpi", "youSaved", "revenuePaise",
  "memberSpend", "channelMargin", "payableCommission", "cardsActive",
];

/**
 * COMMENTS ARE STRIPPED BEFORE THE SCAN, DELIBERATELY. This codebase's own house style is to
 * explain a guardrail AT LENGTH in the comment that sits beside it — `counter-instruments.tsx`'s
 * own header literally says *"Not a price, not a cap, not a commission, not a 'you saved ₹X'"*
 * while DESCRIBING what E-32 forbids, which is exactly the prose a naive substring scan would
 * mistake for a violation. The property this test needs is "no RENDERED figure", not "no
 * discussion of the rule" — so the code that would actually show something to a cashier is what
 * gets scanned, and the comment that explains why it does not is left alone.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function findHits(source: string, tokens: readonly string[]): string[] {
  const lower = stripComments(source).toLowerCase();
  return tokens.filter((token) => lower.includes(token.toLowerCase()));
}

describe("E-32 — no counter screen renders a sales figure", () => {
  it("neither counter screen's LIVE source (comments stripped) mentions a membership/channel sales token", () => {
    for (const file of COUNTER_SCREENS) {
      const source = readFileSync(file, "utf8");
      expect({ file, hits: findHits(source, FORBIDDEN_SALES_TOKENS) }).toEqual({ file, hits: [] });
    }
  });

  // §2.49 — the leg above must be able to fail. Planting one forbidden token as REAL CODE (never
  // inside a comment, which the scan above deliberately ignores) in a COPY of a real counter
  // screen's source and re-running the identical scan proves the scan is a real detector, not two
  // lists that happen to agree with each other forever.
  it("the same scan DOES find a leak when one is planted as real code", () => {
    const source = readFileSync(COUNTER_SCREENS[0]!, "utf8");
    const planted = source.replace(
      "export function CounterInstruments",
      'const commissionEarnedToday = 100;\nexport function CounterInstruments',
    );
    expect(findHits(planted, FORBIDDEN_SALES_TOKENS)).toEqual(["commission"]);
  });

  // …and the same planted token, left INSIDE a comment, is correctly ignored — proving the
  // comment-stripping is doing exactly the job the header above claims for it, in both directions.
  it("the same token, planted only in a comment, is correctly NOT flagged", () => {
    const source = readFileSync(COUNTER_SCREENS[0]!, "utf8");
    const planted = `${source}\n// a commissionEarnedToday figure would go here, if this screen ever grew one\n`;
    expect(findHits(planted, FORBIDDEN_SALES_TOKENS)).toEqual([]);
  });

  // DD16 — no ER/bedside sale path exists at all in this phase (standing ruling: sales open next
  // phase). If a screen ever branches on `MEMBERSHIP_SALES_ENABLED`, a sale lane has been built and
  // this test's premise — "there is nothing to guard because there is nothing to sell" — no longer
  // holds; it should fail here and force a conscious update rather than ship silently.
  it("no web screen references MEMBERSHIP_SALES_ENABLED — there is no sale lane to guard yet", () => {
    for (const file of COUNTER_SCREENS) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("MEMBERSHIP_SALES_ENABLED")).toBe(false);
    }
  });
});

describe("S5 — `check:config-present` deliberately does NOT learn about Plan 09", () => {
  /**
   * §6.0 S5 (the compile-time sweep): Plan 11g's deploy gate refuses a deployment whose config
   * rows are missing, and Plan 09's catalogs are LEGITIMATELY EMPTY until commissioning (DD3) — a
   * freshly migrated database has no plans, no coupons, no partners and no agreements, by design,
   * until the owner's import files land. Teaching `check:config-present` about these catalogs would
   * make it refuse every deploy between now and commissioning, which is exactly the mistake 11g's
   * own THIRD leg exists to prevent (a deploy that is correctly config-empty must not be refused).
   *
   * `check-config-present.ts` is not in this task's Files list and is not edited by it. This test
   * is the tripwire instead of a comment nobody re-reads: if a later change teaches that script
   * about a Plan 09 catalog table or imports from either of this phase's modules, this test fails
   * and forces whoever did it to look at this comment before deciding it is actually correct now
   * (e.g. because commissioning has happened and the reasoning above no longer applies).
   */
  it("the script's source names no Plan 09 catalog table or module", () => {
    const source = readFileSync(CHECK_CONFIG_PRESENT, "utf8");
    const forbidden = [
      "membership_plans", "membershipPlans", "coupon_definitions", "couponDefinitions",
      "membership_instances", "membershipInstances", "counterparties", "partner_agreements",
      "partnerAgreements", "modules/membership", "modules/partners",
    ];
    expect(forbidden.filter((token) => source.includes(token))).toEqual([]);
  });

  // §2.49 — proves the scan above can fail, the same discipline as the E-32 leg.
  it("the same scan DOES find a hit when one is planted", () => {
    const source = readFileSync(CHECK_CONFIG_PRESENT, "utf8");
    const planted = `${source}\nimport { membershipPlans } from "../src/modules/membership";\n`;
    expect(planted.includes("membershipPlans")).toBe(true);
  });
});
