import { screen } from "@testing-library/react";
import { Dossier, QuotePanel, counterExit } from "./registration-counter";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";
import type {
  WireAdjustmentCandidate, WireFeeQuote, WireIssueInvoiceResult,
} from "../lib/billing-api";

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

/**
 * RC-3 T2 — THE DOSSIER AND DD2's THREE LAWFUL EXITS.
 *
 * The exits are lifted from `counter-desk.tsx` unchanged, so what needs proving is not the
 * arithmetic but that the LIFT is faithful and that the free branch cannot fall through to
 * collection — the mutant this task's assertion book names.
 */
/**
 * The provider seeds itself from `sessionStorage["hmis.inHand"]` (`patient-in-hand.tsx:47`), so a
 * test can put a patient in hand by writing the key the shipped code reads — no change to the
 * shared `renderWithProviders`, and it exercises the real hydration path rather than a stub.
 */
function takeInHand(patientId: string, encounterId: string | null): void {
  sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId, encounterId }));
}

describe("RC-3 T2 — the exits, and the guard that keeps tenders off a ₹0 bill", () => {
  /**
   * A SIGNED-IN ACTOR IS REQUIRED, and discovering that was worth the detour.
   *
   * `PatientInHandProvider` releases the patient on a RESOLVED sign-out — `ready && actor === null`
   * — because "the next person to sign in on a shared counter machine inherits the last one's
   * patient inside the same tab". With no token the provider resolves to no actor and wipes the
   * seeded value, so the dossier correctly showed "nobody". That is the shipped shift-change guard
   * working, not a test-harness quirk, and seeding through the real `sessionStorage` key is what
   * exercised it rather than stubbing past it.
   */
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
    stubFetch({
      "GET /api/auth/me": {
        actor: { type: "user", id: "u-rc3" },
        permissions: { hospital: [], scoped: { department: {}, floor: {} } },
      },
    });
  });
  const issuedSettled = { creditExtended: false } as WireIssueInvoiceResult;
  const issuedCredit = { creditExtended: true } as WireIssueInvoiceResult;

  it("names all three exits exactly as the shipped screen derives them", () => {
    expect(counterExit(quoteWith({ free: true, draft: null }), null, true)).toBe("free");
    expect(counterExit(quoteWith(), issuedSettled, true)).toBe("settled");
    expect(counterExit(quoteWith(), issuedCredit, true)).toBe("credit");
  });

  it("names NO exit before a visit is open, or before an invoice on a priced visit", () => {
    expect(counterExit(quoteWith(), null, false)).toBeNull();   // no visit yet
    expect(counterExit(quoteWith(), null, true)).toBeNull();    // priced, unpaid — not an exit
    // …but a FREE visit is an exit the moment it is open: there is no invoice coming.
    expect(counterExit(quoteWith({ free: true, draft: null }), null, true)).toBe("free");
  });

  /**
   * THE MUTANT: a collection guard that checks only `issued === null`. A free revisit carries
   * `draft: null`, so such a guard renders a tender panel over a null draft — tender buttons on a
   * ₹0 bill, and a clerk asking a patient for money the system says is not owed.
   */
  it("MUTANT — a guard without the free/draft terms would render collection on a ₹0 bill", () => {
    const free = quoteWith({ free: true, draft: null, feeServiceId: null });

    // What the mutant's condition would evaluate to on this exact input:
    expect(null === null).toBe(true);                    // `issued === null` alone: renders
    expect(free.free === false && free.draft !== null).toBe(false); // the shipped guard: refuses

      takeInHand("P1", "E1");
    renderWithProviders(<Dossier quote={free} issued={null} />);
    expect(screen.queryByTestId("collect")).toBeNull();   // THE KILL
    expect(screen.getByTestId("exit-free")).toBeTruthy();
  });

  it("a priced, unpaid visit DOES render collection — a guard that refuses everything is not a guard", () => {
    takeInHand("P1", "E1");
    renderWithProviders(<Dossier quote={quoteWith()} issued={null} />);
    expect(screen.getByTestId("collect").textContent).toContain("400");
    expect(screen.queryByTestId("exit-free")).toBeNull();
  });

  it("with nobody in hand it says so, and renders no quote at all", () => {
    renderWithProviders(<Dossier quote={quoteWith()} issued={null} />);
    expect(screen.getByTestId("dossier-empty")).toBeTruthy();
    expect(screen.queryByTestId("quote-panel")).toBeNull();
  });
});
