import { screen } from "@testing-library/react";
import { QuotePanel } from "./registration-counter";
import { renderWithProviders } from "../test-utils";
import type { WireAdjustmentCandidate, WireFeeQuote } from "../lib/billing-api";

/**
 * RC-3 T1 — THE QUOTE PANEL: BENEFITS, THE CONTEST, THE PAYER, AND THE ₹0 REASON.
 *
 * ═══ WHY THESE ASSERTIONS AND NOT A SNAPSHOT ═══
 *
 * Every rail rendered here shipped SERVER-SIDE IN A PREVIOUS PHASE AND HAD NO CONSUMER — this file
 * is the first thing in the repository that reads `candidates`, `winner`, `freeReason` or
 * `intendedPayer` on a quote. A snapshot would pin the markup and prove nothing about the
 * SEMANTICS, and it is the semantics that were never exercised.
 *
 * ═══ THE FIXTURE'S MONEY, HAND-DERIVED ═══
 *
 * One consult, gross 50 000 paise. A membership at 20% (10 000) and a referral at 10% (5 000) both
 * propose; the membership wins. BEST SINGLE BENEFIT means net 40 000 — never 35 000.
 */
const MEMBER: WireAdjustmentCandidate = {
  sourceKey: "membership", ruleKey: "INV-MEMBER-20", kind: "percent_bps", discountCategory: null,
  amountPaise: 10_000, reason: "Invented member consultation benefit", requiresApproval: false, rejected: null,
};
const REFERRAL: WireAdjustmentCandidate = {
  sourceKey: "referral", ruleKey: "INV-SLIP-1", kind: "percent_bps", discountCategory: null,
  amountPaise: 5_000, reason: "Invented partner referral", requiresApproval: false, rejected: null,
};

function quoteWith(over: Partial<WireFeeQuote> = {}): WireFeeQuote {
  return {
    encounterId: "E1", visitType: "new", free: false, feeServiceId: "SVC-CONSULT",
    freeReason: null, intendedPayer: "self",
    draft: {
      tariffVersionId: "TV1", intendedPayer: "self",
      lines: [{
        lineId: "fee", serviceId: "SVC-CONSULT", serviceName: "Consultation", category: "consultation",
        qty: 1, unitPaise: 50_000, grossPaise: 50_000, regulatedClamp: null,
        candidates: [MEMBER, REFERRAL], winner: MEMBER,
        discountPaise: 10_000, taxableBasePaise: 40_000,
        gst: { sacCode: "999312", rateBps: 0, exempt: true, exemptReason: "category_exempt", cgstPaise: 0, sgstPaise: 0 },
        netPaise: 40_000,
      }],
      totals: {
        grossPaise: 50_000, taxableBasePaise: 40_000, cgstPaise: 0, sgstPaise: 0,
        rawTotalPaise: 40_000, netPayablePaise: 40_000, roundingPaise: 0,
      },
    },
    ...over,
  } as WireFeeQuote;
}

describe("RC-3 T1 — the quote panel renders the contest, not a total", () => {
  it("shows the WINNER as applied and every loser as not-applied, with its reason", () => {
    renderWithProviders(<QuotePanel quote={quoteWith()} />);

    const applied = screen.getAllByTestId("benefit-applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.textContent).toContain("Invented member consultation benefit");
    expect(applied[0]!.textContent).toContain("100"); // ₹100 off — the winner alone

    const lost = screen.getAllByTestId("benefit-lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.textContent).toContain("Invented partner referral");
    expect(lost[0]!.textContent).toContain("a bigger benefit won");
  });

  /**
   * THE MUTANT THE ASSERTION BOOK NAMES, as an executed comparison rather than a scratch component:
   * a panel that SUMS the candidates. The owner's ruling is one winner per line and no stacking, so
   * a summing panel would display ₹350 payable while the server charges ₹400 — the counter promising
   * money it cannot honour, which is the same disagreement class RC-1 T1 and RC-2 T1/T2 both fixed.
   */
  it("MUTANT — summing the candidates would show ₹350 where the server charges ₹400", () => {
    const q = quoteWith();
    const line = q.draft!.lines[0]!;
    const summed = line.candidates.reduce((n, c) => n + c.amountPaise, 0);
    expect(summed).toBe(15_000);                       // what a stacking panel would take off
    expect(line.winner!.amountPaise).toBe(10_000);     // what the contest actually took off
    expect(q.draft!.totals.netPayablePaise).toBe(40_000);
    expect(50_000 - summed).toBe(35_000);              // the number the mutant would print

    renderWithProviders(<QuotePanel quote={q} />);
    // The panel prints the SERVER's number, never its own arithmetic over the candidates.
    expect(screen.getByTestId("payable").textContent).toContain("400");
    expect(screen.getByTestId("payable").textContent).not.toContain("350");
  });

  it("names the review-window reason on a free visit, and shows no priced branch at all", () => {
    renderWithProviders(<QuotePanel quote={quoteWith({
      free: true, draft: null, feeServiceId: null,
      freeReason: { kind: "review_window", doctorName: "Dr Anand Rao", seenOn: "2026-08-20", windowEndsOn: "2026-09-03" },
    })} />);

    const reason = screen.getByTestId("free-reason").textContent ?? "";
    expect(reason).toContain("Dr Anand Rao");
    expect(reason).toContain("2026-09-03");
    expect(screen.queryByTestId("priced-branch")).toBeNull();
  });

  it("a free visit whose reason the server could not name still says so, rather than showing ₹0 bare", () => {
    renderWithProviders(<QuotePanel quote={quoteWith({ free: true, draft: null, feeServiceId: null, freeReason: null })} />);
    expect(screen.getByTestId("free-reason").textContent).toContain("No charge");
  });

  it.each(["tpa", "pmjay", "corporate"])(
    "on a %s bill it says bill-to-panel — the answer to why no chips are shown (RC-2 T3)",
    (payer) => {
      renderWithProviders(<QuotePanel quote={quoteWith({
        intendedPayer: payer,
        draft: { ...quoteWith().draft!, lines: [{ ...quoteWith().draft!.lines[0]!, candidates: [], winner: null }] },
      })} />);

      expect(screen.getByTestId("payer-note").textContent).toContain(payer);
      // NOT rendered as losing chips: RC-2 T3 emits no candidate, because they were never contested.
      expect(screen.queryAllByTestId("benefit-lost")).toHaveLength(0);
      expect(screen.queryAllByTestId("benefit-applied")).toHaveLength(0);
    },
  );

  it("a self-pay bill shows no panel note", () => {
    renderWithProviders(<QuotePanel quote={quoteWith()} />);
    expect(screen.queryByTestId("payer-note")).toBeNull();
  });
});
