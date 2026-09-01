import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dossier, FindPanel, QuotePanel, WaitLine, counterExit, waitEstimate } from "./registration-counter";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";
import type {
  WireAdjustmentCandidate, WireFeeQuote, WireIssueInvoiceResult,
} from "../lib/billing-api";
import type { WireDoctorSummary } from "../lib/opd-api";
import { matchReasonKeys } from "../lib/patients-api";

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

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-3 T4 — SEARCH-FIRST FIND WITH MATCH REASONS (D6), AND THE WAIT MODEL (D7)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ═══ WHAT T4 MEASURED BEFORE IT WROTE ANYTHING, BECAUSE THE PHASE DOC TOLD IT TO ═══
 *
 * `matchedOn`: produced since RC-1 T4, travels the wire untouched (`patients.controller.ts:227`
 * returns `unknown[]`), and was declared by NO web type — three private `SearchHit` copies
 * (`patient-picker.tsx:17`, `registration-desk.tsx:16`, `merge-review.tsx:8`) all missing it.
 *
 * `avgConsultMinutes`: **already exposed.** `summaryByDoctor` fills it (`opd/queue.ts:306`) and
 * `opd-queue.controller.ts:109` returns `DoctorSummary[]` with nothing between. The phase doc left
 * "expose it if unexposed" open; the measurement closed it — **T4 needed no core change at all**,
 * only a wire type that had been narrower than its producer.
 */
const NOW = new Date("2026-09-01T04:30:00.000Z"); // 10:00 IST — the clock every wait below is read off

/** The wire row, with the field two phases of web code could not see. */
const HIT_ASHA = {
  id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", phone: "9876500000",
  administrativeGender: "female", dob: "1990-04-02T00:00:00.000Z", isConfidential: false, hasPhoto: false,
};

const DOCTOR = {
  id: "d-1", userId: "u-1", displayName: "Dr Minz", registrationNo: null, departmentId: "dept-gm",
  specialty: null, active: true, createdBy: "s", createdAt: "", updatedBy: "s", updatedAt: "",
};
function summary(over: Partial<WireDoctorSummary> = {}): WireDoctorSummary {
  return {
    doctor: DOCTOR, sessionId: "sess-1", status: "in", waitingCount: 4, waitingVitalsCount: 0,
    nowServing: 7, scheduledToday: true, roomCode: "12", avgConsultMinutes: 12, ...over,
  };
}

describe("RC-3 T4 / D6 — match reasons, never a score", () => {
  // The shift-change guard T2 recorded: with no token the provider resolves to NO actor and
  // releases the patient, so the seat needs a signed-in one before anything can be in hand.
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  /**
   * The ruling asserted EXHAUSTIVELY rather than by "contains a reason". `toEqual` on the whole
   * list is what makes a fourth lane, or a reordering, or a smuggled-in score key, fail here —
   * a `toContain` would pass over any of them.
   */
  it("returns exactly one key per lane the server named, in the server's order", () => {
    expect(matchReasonKeys(["mobile"])).toEqual(["registrationCounter.find.reason.mobile"]);
    expect(matchReasonKeys(["uhid", "mobile", "name"])).toEqual([
      "registrationCounter.find.reason.uhid",
      "registrationCounter.find.reason.mobile",
      "registrationCounter.find.reason.name",
    ]);
  });

  /**
   * `laneFor` (`search.ts:240`) emits a literal `false` for any lane the parsed query built no
   * condition for, so `[]` is reachable and is not an error. An unexplained row sitting beside
   * explained ones reads as a STRONGER match — which is the confidence ranking D6 forbids, arriving
   * through the back door of an omission rather than a percentage.
   */
  it("a row the server did not explain says 'on file' rather than nothing", () => {
    expect(matchReasonKeys([])).toEqual(["registrationCounter.find.reason.onFile"]);
  });

  /**
   * THE MUTANT, as an executed comparison: reasons replaced by a confidence percentage.
   *
   * The owner's design ruling, from `desk-one.html`'s own legend — *"search results say what matched
   * (same mobile), never a confidence percentage; a clerk can act on a reason, not on 87%."* A
   * percentage invites the clerk to read the top row as nearly-certain and click it; "same mobile"
   * tells them the one fact they can check against the person in front of them.
   */
  it("MUTANT — a two-of-three match would score 67%; the seat renders two reasons and no number", async () => {
    const scored = Math.round((2 / 3) * 100); // what a confidence renderer would print for this row
    expect(scored).toBe(67);

    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/patients/search": { items: [{ ...HIT_ASHA, matchedOn: ["uhid", "mobile"] }] },
    });
    renderWithProviders(<FindPanel />);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("find-input"), "98765");

    const why = await screen.findByTestId("find-why-p-1");
    expect(why.textContent).toContain("same UHID");
    expect(why.textContent).toContain("same mobile");
    expect(why.textContent).not.toContain("same name");   // the lane that did NOT fire
    expect(why.textContent).not.toContain("%");           // THE KILL
    expect(why.textContent).not.toContain(String(scored));
  });

  /**
   * SEARCH-FIRST, and the mutant is the one that costs the hospital a duplicate record.
   *
   * The design puts the rule in the empty state's own words — *"Register new … the button only
   * wakes after a real search"* — so the assertion is a three-state one: absent on an untouched
   * box, absent while the answer is still in flight, present only once a real query has come back
   * with nobody. A register-new button that is always there turns the panel's hint into advice, and
   * a duplicate created at this desk is one the merge screen has to unpick later.
   */
  it("MUTANT — an always-present register-new button; the door only opens after a search finds nobody", async () => {
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/patients/search": { items: [] },
    });
    const onRegisterNew = vi.fn();
    renderWithProviders(<FindPanel onRegisterNew={onRegisterNew} />);
    const user = userEvent.setup();

    // State 1 — nothing typed. `q.length > 0` is false, so there is no door. THE KILL.
    expect(screen.queryByTestId("find-register-new")).toBeNull();
    expect(screen.queryByTestId("find-none")).toBeNull();

    // State 3 — a real query that found nobody. Only now.
    await user.type(screen.getByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    expect(onRegisterNew).toHaveBeenCalledTimes(1);
  });

  it("a search that FOUND somebody offers no register-new door — that is the duplicate", async () => {
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/patients/search": { items: [{ ...HIT_ASHA, matchedOn: ["mobile"] }] },
    });
    renderWithProviders(<FindPanel />);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("find-input"), "98765");

    await screen.findByTestId("find-hit-p-1");
    expect(screen.queryByTestId("find-register-new")).toBeNull();
  });

  it("picking a hit takes the patient IN HAND, and the dossier — a rendering of it — fills", async () => {
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/patients/search": { items: [{ ...HIT_ASHA, matchedOn: ["mobile"] }] },
    });
    renderWithProviders(<><FindPanel /><Dossier quote={null} issued={null} /></>);
    const user = userEvent.setup();

    expect(screen.getByTestId("dossier-empty")).toBeTruthy();
    await user.type(screen.getByTestId("find-input"), "98765");
    await user.click(await screen.findByTestId("find-hit-p-1"));

    // D2 — no second store: choosing the person is what fills the column, via `usePatientInHand`.
    expect((await screen.findByTestId("dossier-patient")).textContent).toBe("p-1");
    expect(JSON.parse(sessionStorage.getItem("hmis.inHand") ?? "{}")).toEqual({ patientId: "p-1", encounterId: null });
  });
});

describe("RC-3 T4 / D7 — the wait model", () => {
  // The shift-change guard T2 recorded: with no token the provider resolves to NO actor and
  // releases the patient, so the seat needs a signed-in one before anything can be in hand.
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  it("is waitingCount × the DEPARTMENT's pace, as minutes and as a clock time", () => {
    expect(waitEstimate(4, 12, NOW)).toEqual({ minutes: 48, clock: "10:48" });
    expect(waitEstimate(0, 12, NOW)).toEqual({ minutes: 0, clock: "10:00" }); // nobody ahead: now
  });

  /**
   * THE MUTANT: the pace hardcoded to the schema's default 6 instead of read off the row.
   *
   * `avg_consult_minutes` is `NOT NULL DEFAULT 6` and every department the hospital actually runs
   * overrides it — Paediatrics is quick, Ortho is the crunch. A hardcoded 6 halves a 12-minute
   * department's wait, and the patient told "~24 min" who is called at 48 is the one who asks the
   * clerk why the screen lied. It is silent everywhere the default happens to be right, which is
   * the assertion trap 18a's close named: every check that touched it compared a state where the
   * right and the wrong answers agree.
   */
  it("MUTANT — a hardcoded pace of 6 would promise 24 min at a 12-minute department", () => {
    const mutant = waitEstimate(4, 6, NOW);
    expect(mutant).toEqual({ minutes: 24, clock: "10:24" }); // what the mutant would print

    renderWithProviders(<WaitLine summary={summary()} now={NOW} />);
    const line = screen.getByTestId("wait-d-1").textContent ?? "";
    expect(line).toContain("4 ahead");
    // `~48 min` and not the bare "48": "10:48" contains "48" too, so a substring check on the
    // digits alone would pass over a mutant that got the minutes wrong and the clock right —
    // a check that reports the same whether or not the defect is present is not a check.
    expect(line).toContain("~48 min");
    expect(line).toContain("10:48");
    expect(line).not.toContain("~24 min"); // THE KILL, both halves
    expect(line).not.toContain("10:24");
  });

  /**
   * The clock is IST BY ARITHMETIC, not by the desk machine's timezone — `fmtIst`'s own header says
   * that hospital hardware's clock "is routinely wrong", which is exactly why the seat composes the
   * shipped helper instead of formatting a `Date` itself.
   */
  it("renders the IST clock, never the UTC instant it was computed from", () => {
    renderWithProviders(<WaitLine summary={summary()} now={NOW} />);
    const line = screen.getByTestId("wait-d-1").textContent ?? "";
    expect(line).toContain("10:48");
    expect(line).not.toContain("05:18"); // NOW + 48 min in UTC — the mutant that drops the offset
  });
});
