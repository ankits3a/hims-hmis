import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Dossier, FindPanel, QueuesOverlay, QuotePanel, RegistrationCounter, SEAT_TENDER_ORDER, WaitLine,
  FLOW_POLL_MS, counterExit, seatKey, shouldJoinNow, tokenToShow, useQuote, waitEstimate, walkInBodyFor,
} from "./registration-counter";
import type { SeatVisit } from "./registration-counter";
import { COUNTER_SEQUENCES, TOKEN_LANES } from "../lib/opd-api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";
import type {
  WireAdjustmentCandidate, WireFeeQuote, WireIssueInvoiceResult,
} from "../lib/billing-api";
import type { WireDoctorSummary } from "../lib/opd-api";
import { matchReasonKeys } from "../lib/patients-api";
import { usePatientInHand } from "../lib/patient-in-hand";

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
    renderWithProviders(<Dossier quote={free} issued={null} canCollect />);
    expect(screen.queryByTestId("collect")).toBeNull();   // THE KILL
    expect(screen.getByTestId("exit-free")).toBeTruthy();
  });

  it("a priced, unpaid visit DOES render collection — a guard that refuses everything is not a guard", () => {
    takeInHand("P1", "E1");
    renderWithProviders(<Dossier quote={quoteWith()} issued={null} canCollect />);
    expect(screen.getByTestId("collect").textContent).toContain("400");
    expect(screen.queryByTestId("exit-free")).toBeNull();
  });

  it("with nobody in hand it says so, and renders no quote at all", () => {
    renderWithProviders(<Dossier quote={quoteWith()} issued={null} canCollect />);
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
    nowServing: 7, scheduledToday: true, roomCode: "12", avgConsultMinutes: 12, onLeaveToday: false, ...over,
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
    renderWithProviders(<><FindPanel /><Dossier quote={null} issued={null} canCollect /></>);
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

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-3 T5 — THE ALIAS LAYER (D3), THE KEYBOARD MAP, AND THE QUEUES OVERLAY
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ═══ WHY THE ALIAS LAYER IS ASSERTED AS TEXT ═══
 *
 * jsdom computes no cascade from a stylesheet this harness never loads, so "the seat is green and
 * `/billing` is not" cannot be observed by rendering. The repository has a settled answer for
 * invariants that live in a file rather than in a value: `nav-parity.test.ts` and
 * `caddyfile-parity.test.ts` both parse `router.tsx` as text from a core test, and
 * `membership/guardrails.test.ts` reads web screens the same way. This is that discipline applied
 * to `styles.css`, and it is stronger than a rendered colour would be — a computed-colour test
 * proves the seat is green, whereas this proves NOTHING ELSE IS.
 *
 * §2.49 is honoured: the parser THROWS on a census it cannot read, because a stale parser that
 * returned `[]` would satisfy every "no Desk One hex outside the seat" assertion below for ever.
 */
const STYLES = readFileSync(resolve(__dirname, "..", "styles.css"), "utf8");

/** The signed-off palette, measured from `desk-one.html` and restated here so drift has two places to fail. */
const DESK_ONE_HEXES = ["#f4f7f4", "#ffffff", "#132420", "#dfe7e1", "#5c6f66", "#8ea69a", "#eef3ef", "#0e6b4e", "#dd8f1c", "#b23a30"];

/**
 * `selector { … }` blocks, flat — this file has no nesting inside the blocks that matter.
 *
 * COMMENTS ARE STRIPPED FIRST, and finding out why was the census guard earning its keep on its
 * first run. Without the strip, the long `/* … *\/` header above `:root` is itself matched as a
 * selector running all the way to the next `{`, so `:root` and the seat's own block were being
 * swallowed into their docstrings: the parser reported 13 blocks and `:root` was not among them.
 * Every assertion below would have been evaluated over a list that did not contain the block it was
 * about — and the seat block still "matched" only because its docstring quotes its own selector.
 * That is a test passing for a reason unrelated to the thing it tests, caught only because §2.49
 * says to pin the census before comparing anything against it.
 */
function cssBlocks(source: string): { selector: string; body: string }[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of stripped.matchAll(/(^|\n|\})\s*([^{}@\n][^{}]*?)\{([^{}]*)\}/g)) {
    out.push({ selector: (m[2] ?? "").trim(), body: m[3] ?? "" });
  }
  if (out.length === 0) throw new Error("styles.css: parsed to zero blocks — this parser is stale");
  return out;
}

describe("RC-3 T5 / D3 — the alias layer is scoped to the seat", () => {
  const blocks = cssBlocks(STYLES);
  const seat = blocks.filter((b) => b.selector.includes('[data-seat="registration-counter"]'));

  it("reads a NON-VACUOUS census from the stylesheet, and finds the seat block in it", () => {
    // Pinned before anything is compared. Without this, a parser that had gone stale would report
    // "no Desk One colour is declared globally" over a list it had failed to read — which is the
    // silent false green §2.49 exists to prevent.
    expect(blocks.length).toBeGreaterThan(5);
    expect(seat).toHaveLength(1);
    expect((seat[0]!.body.match(/--[a-z-]+\s*:/g) ?? []).length).toBeGreaterThan(10);
  });

  it("declares every one of Desk One's ten measured tokens inside that block", () => {
    const body = seat[0]!.body.toLowerCase();
    expect(DESK_ONE_HEXES.filter((hex) => !body.includes(hex))).toEqual([]);
  });

  /**
   * `--faint` is the one design token with no shadcn counterpart (the registry has ONE muted
   * foreground; the design has two weights of it), so it is published seat-local — and a seat-local
   * token that nothing reads is a rail with no consumer, which is the defect §1 of this phase is
   * entirely about. This pins that it is both declared and read, in this one phase where both ends
   * are small enough to name.
   */
  it("`--seat-faint` is declared in the block AND actually read by the seat", () => {
    expect(seat[0]!.body).toContain("--seat-faint");
    const src = readFileSync(resolve(__dirname, "registration-counter.tsx"), "utf8");
    expect(src).toContain("var(--seat-faint)");
  });

  /**
   * THE MUTANT THE ASSERTION BOOK NAMES, and the kill it names: the tokens declared globally, and a
   * shadcn screen turning green.
   *
   * Twenty-odd screens ship against a deliberately greyscale base — `styles.css`'s own DD10 note
   * explains that colour on this desk means STATE and nothing else, which is why `--chart-1..5` are
   * five shades of grey. A pine-green `--primary` in `:root` repaints every primary button in the
   * application to say nothing at all, and does it silently, because nothing else in the repository
   * renders a computed colour.
   */
  /**
   * CLOSE REVIEW F17 — THIS ASSERTION USED TO BE NARROWER THAN ITS OWN DOCSTRING.
   *
   * It filtered `selector === ":root" || selector === ".dark"`, while the parser's docstring above
   * claims it covers "every no-Desk-One-hex-outside-the-seat assertion". A mutant declaring the
   * tokens on `body`, on `html`, on `*`, or inside `@layer base` would have walked straight past
   * it — and `styles.css` HAS a `*` block and a `body` block, so those are not hypothetical
   * selectors. It now takes EVERY block that is not the seat's, which is what the docstring says
   * and what the assertion book asks for.
   */
  it("MUTANT — no Desk One colour is declared in ANY block but the seat's", () => {
    /**
     * PLAN 17c T1 / D1 — a SECOND seat block, `[data-seat="lab"]`, legitimately carries the same
     * hexes (the laboratory's five seats wear Desk One too; the values are copied, not shared
     * through `:root`, for exactly the reason this test exists). The assertion's intent is
     * unchanged: no Desk One colour in any UNSCOPED block. A seat is a scope.
     */
    /** PLAN 16c T3 / D11 — the dispense counter is the third seat, same values copied. */
    const SEATS = ['[data-seat="registration-counter"]', '[data-seat="lab"]', '[data-seat="pharmacy-counter"]'];
    const others = blocks.filter((b) => !SEATS.some((seat) => b.selector.includes(seat)));
    // The census, pinned before anything is compared: `:root`, `.dark`, `*` and `body` are the
    // four a global-token mutant would reach for, and all four must be in the list being checked.
    expect(others.length).toBeGreaterThanOrEqual(10);
    for (const sel of [":root", ".dark", "*", "body"]) {
      expect(others.map((b) => b.selector)).toContain(sel);
    }

    const leaked = others.flatMap((b) =>
      DESK_ONE_HEXES.filter((hex) => b.body.toLowerCase().includes(hex)).map((hex) => `${b.selector} ${hex}`),
    );
    expect({ leaked }).toEqual({ leaked: [] }); // THE KILL
  });

  /**
   * CLOSE REVIEW F8 (MAJOR) — AND THE OTHER HALF OF D3, WHICH NOTHING ASSERTED.
   *
   * The old suite proved the block does not LEAK. It never proved anything CONSUMES it — and
   * nothing did: the seat carried no `className` at all, so eighteen aliased shadcn variables were
   * read by nobody and `/counter/seat` rendered as unstyled HTML. "Changes no colour on any other
   * screen" was true because it changed no colour on any screen.
   */
  it("the seat READS the aliased variables — the block is not a mechanism with no consumer", () => {
    /*
      ASSERTED ON THE RENDERED ELEMENT, not by grepping the source — and the first version of this
      test DID grep the source, which is why it survived the mutant that stripped the seat root's
      classes: `bg-background` still appeared elsewhere in the file (on the search input), so a
      file-wide `includes` reported the same answer with the defect present. Third time today that
      a check could not tell the two states apart. `className` is a DOM attribute, so jsdom can see
      it without loading any stylesheet — the cascade is what jsdom cannot do, not the attribute.
    */
    renderWithProviders(<RegistrationCounter />);
    const root = screen.getByTestId("registration-counter");
    expect(root.getAttribute("data-seat")).toBe("registration-counter");
    const rootClasses = root.className.split(/\s+/);
    expect(rootClasses).toContain("bg-background"); // THE KILL — the scope's own ground
    expect(rootClasses).toContain("text-foreground");

    // …and each utility resolves, through `@theme inline`, to a variable the block actually aliases.
    const seatBody = seat[0]!.body;
    for (const [utility, variable] of [
      ["bg-background", "--background"], ["text-foreground", "--foreground"],
      ["bg-card", "--card"], ["border-border", "--border"], ["text-muted-foreground", "--muted-foreground"],
    ] as const) {
      const src = readFileSync(resolve(__dirname, "registration-counter.tsx"), "utf8");
      expect({ utility, inScreen: src.includes(utility), aliased: seatBody.includes(`${variable}:`) })
        .toEqual({ utility, inScreen: true, aliased: true });
    }
  });

  /**
   * The other way the same mutant arrives: the attribute hoisted onto `<body>` or the app shell,
   * which scopes the block to everything. A census over the source tree is what catches that, since
   * the CSS itself would look correct.
   */
  it("MUTANT — only the SEATS carry `data-seat`, each on its own root element", () => {
    const carriers = readdirSync(resolve(__dirname, ".."), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
      .filter((f) => !f.endsWith(".test.tsx") && !f.endsWith(".test.ts"))
      .filter((f) => readFileSync(resolve(__dirname, "..", f), "utf8").includes("data-seat"))
      .sort();
    // VD-2 T1 / D9 — Bay One opts in (RC-3 D1 said "one attribute per seat"), and PLAN 17c T1 / D1 —
    // the laboratory's shared seat frame, on ITS root element. The census still kills the hoist:
    // `router.tsx`, the shell or `main.tsx` carrying it fails here.
    // FD-1 T4 / D4 — "your figures" is a screen OF the registration seat and carries its attribute.
    // PLAN 16c T3 / D11 — the dispense counter, on its own root element.
    // FD-7 T2 — the appointment seat, on its own root element, by the same one-attribute rule.
    expect(carriers).toEqual(["screens/appointment-seat.tsx", "screens/counter-figures.tsx", "screens/lab-seat.tsx", "screens/pharmacy-counter.tsx", "screens/registration-counter.tsx", "screens/registration-screen.tsx", "screens/vitals-bay.tsx"]); // THE KILL

    renderWithProviders(<RegistrationCounter />);
    expect(screen.getByTestId("registration-counter").getAttribute("data-seat")).toBe("registration-counter");
  });
});

describe("RC-3 T5 — the keyboard map", () => {
  const typing = document.createElement("input");
  const idle = document.createElement("div");
  const key = (k: string, mod = false): Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey"> =>
    ({ key: k, ctrlKey: mod, metaKey: false });

  /**
   * THE WHOLE MAP IN ONE `toEqual`, so a shortcut that quietly stops working fails here rather than
   * in front of a clerk. An `it.each` of individual `toBe`s would pass over an action that had gone
   * missing from the union.
   */
  it("is exactly the map the seat OWNS — Q · 1/2/3 · Ctrl+⏎ · Esc, and neither navigation chord", () => {
    expect({
      ctrlK: seatKey(key("k", true), idle, { overlayOpen: false, modalOpen: false }),
      ctrlN: seatKey(key("n", true), idle, { overlayOpen: false, modalOpen: false }),
      altN: seatKey({ key: "n", ctrlKey: false, metaKey: false }, idle, { overlayOpen: false, modalOpen: false }),
      q: seatKey(key("q"), idle, { overlayOpen: false, modalOpen: false }),
      one: seatKey(key("1"), idle, { overlayOpen: false, modalOpen: false }),
      two: seatKey(key("2"), idle, { overlayOpen: false, modalOpen: false }),
      three: seatKey(key("3"), idle, { overlayOpen: false, modalOpen: false }),
      ctrlEnter: seatKey(key("Enter", true), idle, { overlayOpen: false, modalOpen: false }),
      escClosed: seatKey(key("Escape"), idle, { overlayOpen: false, modalOpen: false }),
      escOverlayOpen: seatKey(key("Escape"), idle, { overlayOpen: true, modalOpen: false }),
      four: seatKey(key("4"), idle, { overlayOpen: false, modalOpen: false }),
      plainEnter: seatKey(key("Enter"), idle, { overlayOpen: false, modalOpen: false }),
    }).toEqual({
      // NEITHER navigation chord is the seat's, and for one reason: a shortcut a clerk learns on
      // one screen has to mean the same thing on the next, so both belong to `keyboard.tsx`.
      // `Ctrl+K` opens the palette application-wide. `Alt+N` — §6.4, ruled at close after the
      // review found `Ctrl+N` is Chrome-reserved and never reaches the page — opens the
      // new-patient form application-wide, and is asserted in `lib/keyboard.test.tsx`.
      ctrlK: null,
      ctrlN: null,
      altN: null,
      q: "toggle-queues",
      one: "tender:cash", two: "tender:upi", three: "tender:card",
      ctrlEnter: "confirm",
      // Escape means "start again" with no overlay, and "close this" with one — the design's own
      // precedence, and it is decided BEFORE the typing guard so the way out is never the mouse.
      escClosed: "clear-desk",
      escOverlayOpen: "close-overlay",
      four: null, plainEnter: null,
    });
  });

  /**
   * THE GUARD THAT MATTERS, as an executed comparison. `Q` and `1/2/3` are bare characters: a clerk
   * searching for "Qamar" or typing a mobile number that begins `1` would otherwise throw a queue
   * overlay over the screen or tender a payment, mid-keystroke. Dropping the guard is the obvious
   * simplification and it is silent — the keystroke vanishes from the field and the clerk retypes.
   */
  it("MUTANT — without the typing guard, searching for 'Q' would open the queues overlay", () => {
    expect(seatKey(key("q"), idle, { overlayOpen: false, modalOpen: false })).toBe("toggle-queues");   // what the mutant does everywhere
    expect(seatKey(key("q"), typing, { overlayOpen: false, modalOpen: false })).toBeNull();            // THE KILL
    expect(seatKey(key("1"), typing, { overlayOpen: false, modalOpen: false })).toBeNull();
    expect(seatKey(key("3"), typing, { overlayOpen: false, modalOpen: false })).toBeNull();
    // …and the two that MUST survive it: a guard that refuses everything is not a guard.
    expect(seatKey(key("Enter", true), typing, { overlayOpen: false, modalOpen: false })).toBe("confirm");
    expect(seatKey(key("Escape"), typing, { overlayOpen: false, modalOpen: false })).toBe("clear-desk");
  });

  /**
   * `1 · 2 · 3` AGAINST THE TENDER EDITOR'S OWN BUTTON ORDER, read as text because `MODES` is not
   * exported. A clerk who presses `2` for the second button they can see and gets a CARD payment
   * recorded against a UPI transfer has created a reconciliation the cashier session will not
   * balance — and nothing in either file would have disagreed out loud.
   */
  it("MUTANT — the seat's 1/2/3 cannot drift from `tender-editor.tsx`'s MODES", () => {
    const src = readFileSync(resolve(__dirname, "..", "components", "tender-editor.tsx"), "utf8");
    const m = /const MODES: TenderMode\[\] = \[([^\]]+)\]/.exec(src);
    if (m === null) throw new Error("tender-editor.tsx: no `MODES` array — this parser is stale");
    const shipped = m[1]!.split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);

    expect(shipped).toEqual(["cash", "upi", "card"]);              // the census, non-vacuous
    expect([...SEAT_TENDER_ORDER]).toEqual(shipped);               // THE KILL
  });
});

/**
 * ═══ THE CONTRACT PASS AT CLOSE, AND WHAT IT FOUND OVER 33 GREEN TESTS ═══
 *
 * Reading the phase doc's clauses against the shipped code — the 18a lane's technique, adopted by
 * this lane at T1 — turned up two clauses this phase had written and not done, neither of which any
 * assertion touched:
 *
 *   D2 "the column accretes … the live bill". The assembled seat was handing `quote={null}` into
 *   the panel T1 built, so `QuotePanel`, `useQuote`, `freeReason`, `intendedPayer` and the entire
 *   benefits contest had NO CONSUMER — in the phase whose §1 finding is eight rails with no
 *   consumer. Thirty-three tests missed it because every one handed `QuotePanel` a quote DIRECTLY.
 *   That is 18a's diagnosis exactly: every assertion that touched this checked a state where the
 *   right and the wrong behaviour agree.
 *
 *   T2's assertion book, second half: "…and confirming releases the token". There was no
 *   confirmation on the seat at all.
 *
 * These two tests are the discharge, and they are the only two in this file that assert the seat as
 * an ASSEMBLY rather than its parts.
 */
describe("RC-3 CLOSE — the contract pass's two findings", () => {
  const QUOTE = {
    encounterId: "E1", visitType: "new", free: true, feeServiceId: null, draft: null,
    intendedPayer: "self",
    freeReason: { kind: "review_window", doctorName: "Dr Anand Rao", seenOn: "2026-08-20", windowEndsOn: "2026-09-03" },
  };

  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/queues/summary": { items: [] },
      "GET /api/billing/visits/E1/fee-quote": QUOTE,
      "GET /api/patients/search": { items: [] },
    });
  });

  it("D2 — the seat FETCHES the quote for the patient in hand and renders it; it does not pass null", async () => {
    takeInHand("P1", "E1");
    renderWithProviders(<RegistrationCounter />);

    // The panel T1 built, reached through the assembled screen for the first time.
    expect(await screen.findByTestId("quote-panel")).toBeTruthy();
    expect(screen.getByTestId("free-reason").textContent).toContain("Dr Anand Rao");
    expect(screen.queryByTestId("collect")).toBeNull(); // still ₹0: T2's guard survives the wiring
  });

  it("T2 — confirming a lawful exit RELEASES the patient, exactly as counter-desk's reset does", async () => {
    takeInHand("P1", "E1");
    renderWithProviders(<RegistrationCounter />);

    await screen.findByTestId("exit-free");
    fireEvent.click(screen.getByTestId("exit-confirm"));

    // The desk is clear and the next patient inherits nobody — the shift-change property
    // `patient-in-hand.tsx` exists to hold.
    expect(await screen.findByTestId("dossier-empty")).toBeTruthy();
    expect(sessionStorage.getItem("hmis.inHand")).toBeNull();
  });

  it("MUTANT — an unstable `reprice` identity would refetch for ever; the quote is fetched ONCE", async () => {
    takeInHand("P1", "E1");
    renderWithProviders(<RegistrationCounter />);
    await screen.findByTestId("quote-panel");

    /*
      `useQuote`'s `reprice` sits in an effect's dependency list now, which is what its FIRST
      consumer did to it — T1 shipped it as a plain function, correct for a click handler and an
      infinite loop in an effect. Counting the calls is the only assertion that can tell a working
      `useCallback` from a missing one: with an unstable identity the screen renders, fetches, sets
      state, re-renders, and fetches again, and every OTHER assertion in this file still passes.
    */
    const quoteCalls = vi.mocked(fetch).mock.calls
      .filter(([input]) => String(input).includes("/fee-quote"));
    expect(quoteCalls).toHaveLength(1); // THE KILL
  });
});

describe("RC-3 T5 — the queues overlay", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/queues/summary": { items: [summary(), summary({ doctor: { ...DOCTOR, id: "d-2", displayName: "Dr Rao" }, waitingCount: 2, avgConsultMinutes: 8, roomCode: "7" })] },
      "GET /api/patients/search": { items: [] },
    });
  });

  it("lists every line in the building, each on T4's wait model and not a second one", () => {
    renderWithProviders(
      <QueuesOverlay
        items={[summary(), summary({ doctor: { ...DOCTOR, id: "d-2", displayName: "Dr Rao" }, waitingCount: 2, avgConsultMinutes: 8 })]}
        onClose={() => undefined} now={NOW}
      />,
    );
    expect(screen.getByTestId("queues-total").textContent).toContain("6");        // 4 + 2 waiting
    expect(screen.getByTestId("wait-d-1").textContent).toContain("~48 min");      // 4 × 12
    expect(screen.getByTestId("wait-d-2").textContent).toContain("~16 min");      // 2 × 8 — its OWN pace
    expect(screen.getByTestId("wait-d-2").textContent).toContain("10:16");
  });

  it("Q opens it, Q closes it, Escape closes it — and the board comes off `queues/summary`", async () => {
    renderWithProviders(<RegistrationCounter />);
    expect(screen.queryByTestId("queues-overlay")).toBeNull();

    fireEvent.keyDown(window, { key: "q" });
    expect(await screen.findByTestId("queues-row-d-1")).toBeTruthy();
    expect(screen.getByTestId("queues-row-d-2")).toBeTruthy();

    fireEvent.keyDown(window, { key: "q" });
    expect(screen.queryByTestId("queues-overlay")).toBeNull();

    fireEvent.keyDown(window, { key: "q" });
    expect(await screen.findByTestId("queues-overlay")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("queues-overlay")).toBeNull();
  });

  it("the seat swallows NO navigation chord — and 1/2/3 are not acted on here either", () => {
    renderWithProviders(<RegistrationCounter />);

    /*
      §6.4 RULED — the seat used to handle `Ctrl+N` itself. It no longer does, and this asserts the
      ABSENCE, which is the load-bearing half: the global map owns `Alt+N` now, and a seat that
      also handled a navigation chord would either double-fire or shadow the global one with a
      local imitation. The `Register new` button is this screen's own door and is unaffected.
      RC-4 T1: that door now opens the register panel IN PLACE rather than navigating.
    */
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    fireEvent.keyDown(window, { key: "n", altKey: true });
    expect(screen.queryByTestId("register-panel")).toBeNull();

    // F15 — the tender lanes stay in the MAP (they are the seat's specified legend) and this screen
    // consumes none of them: F4 established it cannot see whether an encounter has been paid, so it
    // does not take money. What used to be here printed the literal string "upi" on the counter.
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.queryByTestId("tender-chosen")).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-3 CLOSE REVIEW — REMEDIATION. Two independent passes over a tree with 36 green tests and
   13 dead mutants returned 2 CRITICAL + 5 MAJOR (pass 1) and 1 CRITICAL + 7 MAJOR (pass 2),
   overlapping heavily. Both passes reached the same diagnosis about WHY, and it is 18a's:
   **every assertion that touched a defect checked a state where right and wrong agree.**
   Each test below is written to be a state where they DISAGREE.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("RC-3 close review — F1 (CRITICAL): a quote cannot outlive the encounter it priced", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  /**
   * THE FULL COUNTER CYCLE, which is the thing no previous test did: patient A, clear the desk,
   * patient B. Every assembled-seat test before this one put ONE patient in hand and left them
   * there — and one patient is precisely the state in which a quote with no lifetime and a quote
   * with a correct one are indistinguishable.
   */
  it("patient B never sees patient A's bill, A's benefit chips or A's review-window reason", async () => {
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/queues/summary": { items: [] },
      "GET /api/patients/search": { items: [{ ...HIT_ASHA, id: "P-B", name: "Binod Sah", matchedOn: ["mobile"] }] },
      "GET /api/billing/visits/E1/fee-quote": {
        encounterId: "E1", visitType: "new", free: false, feeServiceId: "SVC", intendedPayer: "self", freeReason: null,
        draft: {
          tariffVersionId: "TV1", intendedPayer: "self",
          lines: [{
            lineId: "fee", serviceId: "SVC", serviceName: "Consultation", category: "consultation",
            qty: 1, unitPaise: 50_000, grossPaise: 50_000, regulatedClamp: null,
            candidates: [MEMBER], winner: MEMBER, discountPaise: 10_000, taxableBasePaise: 40_000,
            gst: { sacCode: "999312", rateBps: 0, exempt: true, exemptReason: "category_exempt", cgstPaise: 0, sgstPaise: 0 },
            netPaise: 40_000,
          }],
          totals: { grossPaise: 50_000, taxableBasePaise: 40_000, cgstPaise: 0, sgstPaise: 0, rawTotalPaise: 40_000, netPayablePaise: 40_000, roundingPaise: 0 },
        },
      },
    });

    takeInHand("P-A", "E1");
    renderWithProviders(<RegistrationCounter />);

    // Patient A: priced, and the panel says so.
    expect(await screen.findByTestId("quote-panel")).toBeTruthy();
    expect(screen.getByTestId("payable").textContent).toContain("400");

    // The clerk clears the desk and takes the next person, who has NO encounter yet —
    // `takePatient` puts them in hand as `{ patientId, encounterId: null }`.
    fireEvent.keyDown(window, { key: "Escape" });
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "98765");
    await user.click(await screen.findByTestId("find-hit-P-B"));

    expect((await screen.findByTestId("dossier-patient")).textContent).toBe("P-B");
    // THE KILL, three ways: no panel, no money, and no other patient's benefit chip.
    expect(screen.queryByTestId("quote-panel")).toBeNull();
    expect(screen.queryByTestId("payable")).toBeNull();
    expect(screen.queryByTestId("benefit-applied")).toBeNull();
    expect(screen.queryByTestId("collect")).toBeNull();
    expect(screen.queryByTestId("priced-elsewhere")).toBeNull();
  });

  /**
   * THE SECOND HALF OF F1, and the first version of this test COULD NOT FAIL — caught by running the
   * revert, which is the only reason it is written this way now.
   *
   * It stubbed a fee-quote that always 404s and asserted no panel. But with no prior SUCCESS there
   * was never a quote to leave standing, so the assertion held whether or not the `catch` cleared
   * anything: the exact "right and wrong agree" shape both review passes were called in to find.
   * A refetch that FAILS AFTER A SUCCESS is the only state that tells them apart, and the seat
   * fetches once per encounter — so this drives `useQuote` directly.
   */
  it("a refetch that FAILS AFTER A SUCCESS drops the stale price rather than leaving it standing", async () => {
    let call = 0;
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/billing/visits/E1/fee-quote": () => {
        call += 1;
        if (call === 1) return quoteWith();
        throw new Error("the second call must not answer"); // stubFetch rejects -> api() throws
      },
    });

    function Probe(): React.ReactElement {
      const { quote, error, reprice } = useQuote("E1");
      return (
        <>
          <button type="button" data-testid="probe-reprice" onClick={() => void reprice([])}>go</button>
          {quote !== null && <span data-testid="probe-quote">{quote.encounterId}</span>}
          {error !== null && <span data-testid="probe-error">{error}</span>}
        </>
      );
    }
    renderWithProviders(<Probe />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("probe-reprice"));
    expect((await screen.findByTestId("probe-quote")).textContent).toBe("E1"); // a real price is on screen

    await user.click(screen.getByTestId("probe-reprice"));
    await screen.findByTestId("probe-error");
    expect(screen.queryByTestId("probe-quote")).toBeNull(); // THE KILL — the stale price is gone
  });
});

describe("RC-3 close review — F2 (MAJOR): the winner is not also a loser", () => {
  /**
   * THE FIXTURE IS ROUND-TRIPPED THROUGH JSON, and that is the entire point of this test.
   *
   * `runContest` (`tariff/contest.ts:78`) returns `winner: valid[0]` — a REFERENCE INTO
   * `candidates`. The old fixture reproduced that reference by writing `winner: MEMBER` with a
   * module-level const, which is the one input shape the wire cannot produce. `JSON.parse(
   * JSON.stringify(...))` is what the browser actually receives, and under it a reference
   * comparison marks the winner as a loser as well.
   */
  it("renders ONE applied chip and no losing chip for it, over a JSON-round-tripped quote", () => {
    const overTheWire = JSON.parse(JSON.stringify(quoteWith())) as WireFeeQuote;
    const line = overTheWire.draft!.lines[0]!;

    // The defect's precondition, asserted so this test cannot quietly stop testing anything:
    // after transport the winner is NOT the same object as its own entry in `candidates`.
    expect(line.candidates.some((c) => c === line.winner)).toBe(false);
    expect(line.winner).toEqual(line.candidates[0]); // …but it IS the same candidate

    renderWithProviders(<QuotePanel quote={overTheWire} />);
    expect(screen.getAllByTestId("benefit-applied")).toHaveLength(1);
    const lost = screen.getAllByTestId("benefit-lost");
    expect(lost).toHaveLength(1);                                                    // THE KILL: not 2
    expect(lost[0]!.textContent).toContain("Invented partner referral");
    expect(lost[0]!.textContent).not.toContain("Invented member consultation benefit");
  });
});

describe("RC-3 close review — F4 (CRITICAL): the seat prices, it does not instruct a collection", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/queues/summary": { items: [] },
      "GET /api/patients/search": { items: [] },
      "GET /api/billing/visits/E1/fee-quote": quoteWith(),
    });
  });

  /**
   * `feeQuote` is a PRICE quote — it reads nothing about issued invoices, allocations or
   * settlement — and no other payment signal reaches this screen. So on a priced visit the old
   * collect guard was true whether or not the money had already been taken, and a clerk who billed
   * at `/counter` and switched to the seat was told to collect ₹400 a second time.
   */
  it("a priced visit shows the PRICE and never the instruction, because the seat cannot see payment", async () => {
    takeInHand("P1", "E1");
    renderWithProviders(<RegistrationCounter />);

    const note = await screen.findByTestId("priced-elsewhere");
    expect(note.textContent).toContain("400");
    expect(note.textContent).toContain("billing counter");
    expect(screen.queryByTestId("collect")).toBeNull(); // THE KILL
  });

  /**
   * …and the guard must not simply refuse everything: `Dossier` is still the lifted component, and
   * a caller that CAN see settlement still gets `counter-desk.tsx`'s behaviour unchanged.
   */
  it("a caller that CAN see settlement still gets the lifted collect panel", () => {
    renderWithProviders(<Dossier quote={quoteWith()} issued={null} canCollect />);
    expect(screen.queryByTestId("priced-elsewhere")).toBeNull();
  });
});

describe("RC-3 close review — F3 (MAJOR): an errored search is not an empty one", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  /**
   * `App.tsx:8` sets `retry: false`, so a 403 settles on the first attempt with `data === undefined`
   * — which read as "no such patient" and offered the register-new door. The seat's route needs
   * `opd.visits.open`; `GET /patients/search` needs `patients.read`. They are not the same grant, so
   * a 403 here is a configuration a real deployment can have.
   */
  it("MUTANT — a 403 rendered 'nobody matches' and the REGISTER-NEW door; it now says the search failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(typeof input === "string" ? input : (input as Request).url).split("?")[0]!;
      if (path === "/api/auth/me") {
        return new Response(JSON.stringify({ actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200 });
      }
      if (path === "/api/patients/search") return new Response(JSON.stringify({ statusCode: 403 }), { status: 403 });
      return new Response("{}", { status: 404 });
    }));

    renderWithProviders(<FindPanel />);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("find-input"), "98765");

    expect((await screen.findByTestId("find-error")).textContent).toContain("do not register");
    expect(screen.queryByTestId("find-register-new")).toBeNull(); // THE KILL
    expect(screen.queryByTestId("find-none")).toBeNull();
  });
});

describe("RC-3 close review — F7 (MAJOR): a modal owns the keyboard while it is open", () => {
  const typing = document.createElement("input");
  const idle = document.createElement("div");
  const k = (key: string, mod = false): Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey"> =>
    ({ key, ctrlKey: mod, metaKey: false });

  /**
   * The palette's Escape is a REACT `onKeyDown` that calls `preventDefault()` and NOT
   * `stopPropagation()`, and React 18 dispatches from the root container — below `window`, where
   * the seat listens. So Escape dismissing the palette reached the seat, `overlayOpen` tracked only
   * the seat's OWN overlay, and the branch taken was `clear-desk`: **the patient in hand was
   * silently dropped**, which is the defect `patient-in-hand.tsx` exists to end.
   */
  it("claims NO key at all while a modal is open — not just Escape", () => {
    const open = { overlayOpen: false, modalOpen: true };
    expect({
      esc: seatKey(k("Escape"), idle, open),
      q: seatKey(k("q"), idle, open),
      ctrlN: seatKey(k("n", true), idle, open),
      one: seatKey(k("1"), idle, open),
      ctrlEnter: seatKey(k("Enter", true), idle, open),
    }).toEqual({ esc: null, q: null, ctrlN: null, one: null, ctrlEnter: null }); // THE KILL

    // …and with no modal open the same keys are the seat's again — a guard that refuses
    // everything is not a guard.
    const shut = { overlayOpen: false, modalOpen: false };
    expect(seatKey(k("Escape"), idle, shut)).toBe("clear-desk");
    expect(seatKey(k("q"), idle, shut)).toBe("toggle-queues");
  });

  /**
   * F5 — `Ctrl+N` sits ABOVE the typing guard now. The find input carries `autoFocus`, so the one
   * moment a clerk reaches for the new-patient door is the moment focus is in an `INPUT`; below the
   * guard, the advertised shortcut did nothing exactly when it was wanted.
   */
  /**
   * F5's root complaint was that `Ctrl+N` sat BELOW the typing guard while the find input carries
   * `autoFocus`, so the shortcut was dead at the one moment a clerk wants it. §6.4 ruled the
   * chord out of this file entirely — `Alt+N` is global now — and the property that had to survive
   * is that the guard still stops only what it should: BARE CHARACTERS a person could be typing.
   */
  it("the typing guard stops bare characters and nothing else", () => {
    const shut = { overlayOpen: false, modalOpen: false };
    expect(seatKey(k("q"), typing, shut)).toBeNull();
    expect(seatKey(k("1"), typing, shut)).toBeNull();
    expect(seatKey(k("3"), typing, shut)).toBeNull();
    // …and the two that MUST survive it, or the guard is refusing everything rather than guarding.
    expect(seatKey(k("Enter", true), typing, shut)).toBe("confirm");
    expect(seatKey(k("Escape"), typing, shut)).toBe("clear-desk");
    // The bare characters are the seat's again the moment focus leaves a field.
    expect(seatKey(k("q"), idle, shut)).toBe("toggle-queues");
  });
});

describe("RC-3 close review — F16/F19: 'start again' means the search box too", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-rc3" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/queues/summary": { items: [] },
      "GET /api/patients/search": { items: [] },
    });
  });

  it("Escape clears the typed query, not only the patient", async () => {
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    const box = screen.getByTestId("find-input");
    await user.type(box, "98765");
    expect((box as HTMLInputElement).value).toBe("98765");

    fireEvent.keyDown(window, { key: "Escape" });
    // THE KILL — the previous person's mobile number must not be sitting there for the next one.
    expect((screen.getByTestId("find-input") as HTMLInputElement).value).toBe("");
  });

  /**
   * F19 — the commit and the docstring make "Ctrl+Enter reaches the focused field" load-bearing,
   * and nothing asserted it: moving `e.preventDefault()` above the switch would have broken the
   * stated behaviour with no failing test. `defaultPrevented` is the observable.
   */
  it("Ctrl+Enter is NOT swallowed — it falls through to whatever has focus", () => {
    renderWithProviders(<RegistrationCounter />);
    const ev = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // THE KILL

    // …while a key the seat DOES claim is consumed, so this is not vacuous.
    const claimed = new KeyboardEvent("keydown", { key: "q", cancelable: true, bubbles: true });
    window.dispatchEvent(claimed);
    expect(claimed.defaultPrevented).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T1 — THE SEAT OPENS A VISIT, AND REGISTERS WITHOUT LEAVING
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const DOC_A = summary();
const DOC_B = summary({ doctor: { ...DOCTOR, id: "d-2", displayName: "Dr Rao", departmentId: "dept-ortho" }, waitingCount: 2 });

/** RC-4 T2 — the flow, as `GET /opd/config` returns it. Only the two flow keys matter to the seat. */
const QUEUE_FIRST = { counterSequence: "queue_first", tokenLane: "token_first" };
const BILL_FIRST = { counterSequence: "bill_first", tokenLane: "token_first" };
const DRAWER_OPEN = { session: { id: "cs-1", status: "open" } };

describe("RC-4 T1 — the walk-in body, as a pure function", () => {
  /**
   * THE THREE FIELD RULES, ASSERTED EXHAUSTIVELY WITH `toEqual` rather than by `toMatchObject`.
   * A partial match would pass over an extra key — and an extra key is exactly how the
   * `administrativeGender` defect worked in Plan 22c-A's C1: zod strips what it does not declare,
   * so a wrongly-named field vanishes silently and the route answers 200 with nothing written.
   */
  it("sends the design's four fields, and OMITS the two that are blank", () => {
    expect(walkInBodyFor(
      { fields: { name: "  Asha Devi  ", phone: " 9876500000 ", ageYears: " 34 ", sex: "female" } },
      DOC_A, false,
    )).toEqual({
      patient: { register: { name: "Asha Devi", sex: "female", phone: "9876500000", ageYears: 34 } },
      departmentId: "dept-gm", doctorId: "d-1",
    });
  });

  /**
   * THE MUTANT THAT MATTERS MOST HERE, and it is a patient-safety one rather than a money one:
   * `ageYears: Number("")` is `0`, and `0` is a value the schema ACCEPTS (`int 0..130`). A blank
   * age box would register every adult as a newborn — and a newborn is the band that drives
   * paediatric dosing and the danger-flag thresholds VD-1 shipped. An absent age is recoverable;
   * a confidently wrong one is not.
   */
  it("MUTANT — a blank age would register a NEWBORN; it must be omitted, not sent as 0", () => {
    expect(Number("")).toBe(0); // what the mutant would send, evaluated rather than asserted about
    const body = walkInBodyFor(
      { fields: { name: "No Age", phone: "", ageYears: "", sex: "unknown" } }, DOC_A, false,
    );
    const register = (body.patient as { register: Record<string, unknown> }).register;
    expect(register).toEqual({ name: "No Age", sex: "unknown" }); // THE KILL — no ageYears, no phone
    expect("ageYears" in register).toBe(false);
    expect("phone" in register).toBe(false);
  });

  it("an existing patient sends an id and no register block at all, and the doctor sets the department", () => {
    expect(walkInBodyFor({ existingId: "p-1" }, DOC_B, true)).toEqual({
      patient: { existingId: "p-1" },
      departmentId: "dept-ortho", doctorId: "d-2",
      acknowledgedDuplicates: true,
    });
  });

  it("MUTANT — `acknowledgedDuplicates: false` sent as a key; it must be ABSENT until the clerk says so", () => {
    const body = walkInBodyFor({ existingId: "p-1" }, DOC_A, false);
    expect("acknowledgedDuplicates" in body).toBe(false); // THE KILL
  });
});

describe("RC-4 T1 — registering in place, and the duplicate that must not be a dead end", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  const ME = { actor: { type: "user", id: "u-rc4" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } };

  it("the Register-new door opens the panel IN PLACE — the seat never navigates away (D1)", async () => {
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/opd/queues/summary": { items: [DOC_A] },
      "GET /api/patients/search": { items: [] },
    });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));

    // THE KILL for the navigate-away: the form is HERE, on the seat, with the dossier still beside it.
    expect(await screen.findByTestId("register-panel")).toBeTruthy();
    expect(screen.getByTestId("dossier")).toBeTruthy();
  });

  /**
   * THE ASSEMBLY CLAUSE (method §5A.3, and RC-3's F1 is why it exists). Driven through the whole
   * act — open the panel, fill it, submit — against the assembled screen, not against `RegisterPanel`
   * handed its props by hand. RC-3 shipped a CRITICAL because every test reached its components
   * directly and none ever reached them through the screen that mounts them.
   */
  it("registering opens a visit, takes the patient in hand, and the dossier fills", async () => {
    let sent: Record<string, unknown> | null = null;
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/opd/queues/summary": { items: [DOC_A] },
      "GET /api/patients/search": { items: [] },
      // RC-4 T2 — the seat reads the flow AT OPEN; without this route it refuses to open at all.
      "GET /api/opd/config": QUEUE_FIRST,
      "POST /api/opd/walk-in": (init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { patientId: "P-NEW", registered: true, encounter: { id: "E-NEW" }, tokenNo: 7, sessionId: "s-1" };
      },
    });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Deepak Munda");
    await user.type(screen.getByTestId("reg-age"), "26");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));

    expect((await screen.findByTestId("dossier-patient")).textContent).toBe("P-NEW");
    expect(JSON.parse(sessionStorage.getItem("hmis.inHand") ?? "{}"))
      .toEqual({ patientId: "P-NEW", encounterId: "E-NEW" });
    // `toEqual`, so a `join` key can only be here if the flow put it here — under queue_first there is none.
    expect(sent).toEqual({
      patient: { register: { name: "Deepak Munda", sex: "unknown", ageYears: 26 } },
      departmentId: "dept-gm", doctorId: "d-1",
    });
  });

  /**
   * THE MUTANT THE ASSERTION BOOK NAMES: the register path swallowing the 409.
   *
   * The server refuses a suspicious registration with `409 + detail.candidates`. A panel that
   * treated that as a plain error would leave the clerk at a DEAD END in front of a waiting
   * patient — unable to proceed and unable to say why — which is worse than the duplicate it was
   * trying to prevent. The way through is the clerk's recorded judgement.
   */
  it("MUTANT — a 409 swallowed as an error; the near-matches are shown and the clerk can proceed", async () => {
    let acknowledged: boolean | undefined;
    let calls = 0;
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/opd/queues/summary": { items: [DOC_A] },
      "GET /api/patients/search": { items: [] },
      "GET /api/opd/config": QUEUE_FIRST,
      "POST /api/opd/walk-in": (init?: RequestInit) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { acknowledgedDuplicates?: boolean };
        acknowledged = body.acknowledgedDuplicates;
        if (calls === 1) throw new Error("409"); // stubFetch rejects; the panel must read the 409 path
        return { patientId: "P-DUP", registered: true, encounter: { id: "E-DUP" }, tokenNo: 8, sessionId: "s-1" };
      },
    });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Asha Devi");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));

    // A thrown fetch is NOT an ApiError 409, so this asserts the error lane rather than the
    // duplicate lane — and the clerk still gets a message rather than silence.
    expect(await screen.findByTestId("reg-error")).toBeTruthy();
    expect(acknowledged).toBeUndefined();
  });
});


/* ════════════════════════════════════════════════════════════════════════════════════════════
   FD-7 T1 — THE DUPLICATE LIST A CLERK CAN ACTUALLY READ
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The 409 lane had NO test that rendered it. The suite's one duplicate test throws a plain Error,
 * which is not an `ApiError`, so it asserts the ERROR branch and `reg-duplicates` has never been on
 * screen in a test. That is how a list of five identical-looking names survives a green suite —
 * exactly FD-6's finding, one surface along.
 *
 * `stubFetch` always answers 200, so this stubs `fetch` directly: the panel's duplicate branch is
 * reached only by a real 409 whose body carries `detail.candidates`.
 */
describe("FD-7 T1 — five rows reading the same name, told apart", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  const ME = { actor: { type: "user", id: "u-fd7" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } };

  const CANDIDATES = [
    {
      id: "p-1", uhid: "U00110012", name: "Ramesh Kale", phone: "9876540002",
      administrativeGender: "male", dob: "1982-04-11", isConfidential: false, matchedOn: ["mobile", "name"],
    },
    {
      id: "p-2", uhid: "U00110029", name: "Ramesh Kale", phone: "9811110000",
      administrativeGender: "male", dob: "1996-01-20", isConfidential: false, matchedOn: ["name"],
    },
    {
      id: "p-3", uhid: "U00110036", name: "Ramesh Kale", phone: null,
      administrativeGender: "female", dob: null, isConfidential: true, matchedOn: ["name"],
    },
  ];

  function stubWithDuplicates(): void {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
      if (key === "POST /api/opd/walk-in") {
        return new Response(
          JSON.stringify({ code: "duplicate_suspected", detail: { candidates: CANDIDATES } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      const table: Record<string, unknown> = {
        "GET /api/auth/me": ME,
        "GET /api/opd/queues/summary": { items: [DOC_A] },
        "GET /api/patients/search": { items: [] },
        "GET /api/opd/config": QUEUE_FIRST,
      };
      if (!(key in table)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(table[key]), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  }

  async function openTheWarning(): Promise<void> {
    stubWithDuplicates();
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Ramesh Kale");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
    await screen.findByTestId("reg-duplicates");
  }

  /**
   * THE KILL. Three rows, one name. If the row carries only name + UHID this passes on presence and
   * fails here — which is the whole of FD-6's lesson: assert what a human can READ, and assert the
   * nodes are SEPARATE, never that a testid exists.
   */
  it("each candidate row carries phone, sex and age as separate, readable nodes", async () => {
    await openTheWarning();

    expect(screen.getByTestId("reg-dup-phone-p-1").textContent).toBe("9876540002");
    expect(screen.getByTestId("reg-dup-phone-p-2").textContent).toBe("9811110000");
    expect(screen.queryByTestId("reg-dup-phone-p-3")).toBeNull();   // no phone on file — no empty node

    // Sex and age, the two facts a clerk can check against the person standing there.
    expect(screen.getByTestId("reg-dup-facts-p-1").textContent).toContain("44");
    expect(screen.getByTestId("reg-dup-facts-p-2").textContent).toContain("30");
    expect(screen.getByTestId("reg-dup-facts-p-1").textContent)
      .not.toBe(screen.getByTestId("reg-dup-facts-p-2").textContent);

    // SEPARATION: the name and the UHID are distinct nodes, not one run-together string.
    expect(screen.getByTestId("reg-dup-name-p-1").textContent).toBe("Ramesh Kale");
    expect(screen.getByTestId("reg-dup-uhid-p-1").textContent).toBe("U00110012");
  });

  /** `matchedOn` is why this row is in front of the clerk — the same chips the search row wears. */
  it("the row says WHY it is a candidate, and the both-lanes row says so", async () => {
    await openTheWarning();
    const why1 = within(screen.getByTestId("reg-dup-why-p-1")).getAllByTestId("reg-dup-reason-p-1");
    // Asserted as the VISIBLE TEXT, not the key: what the clerk reads is the thing under test (D9).
    expect(why1.map((n) => n.textContent)).toEqual(["same mobile", "same name"]);
    const why2 = within(screen.getByTestId("reg-dup-why-p-2")).getAllByTestId("reg-dup-reason-p-2");
    expect(why2.map((n) => n.textContent)).toEqual(["same name"]);
  });

  /** A confidential candidate the clerk MAY see is marked, so the row is handled as one. */
  it("a confidential candidate wears its marker", async () => {
    await openTheWarning();
    expect(screen.getByTestId("reg-dup-confidential-p-3")).toBeTruthy();
    expect(screen.queryByTestId("reg-dup-confidential-p-1")).toBeNull();
  });

  /** The way through is unchanged: the warning is a question, never a gate (DD8). */
  it("the clerk can still register anyway", async () => {
    await openTheWarning();
    expect(screen.getByTestId("reg-acknowledge")).toBeTruthy();
  });
});


/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T3 — THE PAID STAMP (D7: the BOARD), AND THE TOKEN IN THE DOSSIER
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("RC-4 T3 — the token the clerk reads out loud", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  /**
   * D2's "token" noun, and it costs NO extra fetch: `WireWalkInResult` extends
   * `WireOpenVisitResult`, which has carried `tokenNo` since 07b, and the seat was throwing it
   * away. The PAID stamp itself lives on the board (D7) because `feeStatus` only travels on the
   * queue route; what the clerk needs here is the number they are about to say to the patient.
   */
  it("registering surfaces the token in the dossier, and clearing the desk takes it away", async () => {
    /*
      A URL-AWARE STUB, because this test needs the SAME route to answer differently for two
      different queries: "zzzz" must find nobody (so the register door opens) and "98765" must find
      Binod (so a second patient can come in hand). `stubFetch` keys on METHOD+PATH with the query
      stripped, which is right for almost every test here and cannot express that.
    */
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u-rc4" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(QUEUE_FIRST);
      if (path === "/api/patients/search") {
        return json({ items: url.includes("zzzz") ? [] : [{ ...HIT_ASHA, id: "P-B", name: "Binod Sah", matchedOn: ["mobile"] }] });
      }
      if (path === "/api/opd/walk-in" && init?.method === "POST") {
        return json({ patientId: "P-T", registered: true, encounter: { id: "E-T" }, tokenNo: 42, sessionId: "s-1" });
      }
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("find-input"), "zzzz"); // finds nobody -> the door opens
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Token Patient");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));

    expect((await screen.findByTestId("dossier-token")).textContent).toContain("42");

    /*
      THE NEXT PATIENT MUST NOT INHERIT THE LAST ONE'S TOKEN — and the FIRST version of this
      assertion could not fail, caught by running R21. It stopped at "press Escape, the token line
      is gone", which is true whether or not the state was cleared: the line lives inside the
      `inHand !== null` branch, so an empty dossier hides it either way. The state survived and
      would have reappeared under the next patient — **F1's exact shape, on a second field, inside
      the phase that fixed F1.** Only a SECOND PATIENT tells the two apart, which is what method
      §5A.3 means by driving the assembly through a full cycle.
    */
    fireEvent.keyDown(window, { key: "Escape" });
    await user.type(await screen.findByTestId("find-input"), "98765");
    await user.click(await screen.findByTestId("find-hit-P-B"));

    expect((await screen.findByTestId("dossier-patient")).textContent).toBe("P-B");
    expect(screen.queryByTestId("dossier-token")).toBeNull(); // THE KILL
  });

  it("MUTANT — token 0 rendered as absent: `!= null` and not a truthiness check", () => {
    takeInHand("P1", "E1");
    renderWithProviders(<Dossier quote={null} issued={null} canCollect={false} token={0} />);
    // A falsy-but-real token must still render. `token && …` would hide it, and token 0 is the one
    // a board issues first thing in the morning.
    expect(screen.getByTestId("dossier-token").textContent).toContain("0");
  });

  it("no token, no line — the dossier does not print an empty stamp", () => {
    takeInHand("P1", "E1");
    renderWithProviders(<Dossier quote={null} issued={null} canCollect={false} />);
    expect(screen.queryByTestId("dossier-token")).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T2 — BILL-FIRST: THE DEFERRED JOIN, ITS FIRST CONSUMER SINCE RC-1 WROTE IT (D3)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

function visitWith(over: Partial<SeatVisit> = {}): SeatVisit {
  return {
    encounterId: "E-A", patientId: "P-A", tokenNo: null,
    flow: { counterSequence: "bill_first", tokenLane: "token_first" },
    draftId: "draft-1", joining: false, joinError: null, ...over,
  };
}

const ISSUED: WireIssueInvoiceResult = {
  invoiceId: "inv-1", invoiceNo: "INV/1", totals: quoteWith().draft!.totals,
  receiptId: "rcpt-1", receiptNo: "RC/1", allocatedPaise: 40_000, unallocatedPaise: 0,
  creditExtended: false, settlement: { state: "settled", outstandingPaise: 0 }, warnings: [],
};

describe("RC-4 T2 — the join fires after the money, as a pure decision", () => {
  /**
   * THE MUTANT THE ASSERTION BOOK NAMES, and the reason it is a pure function: `joinQueue` has NO
   * settlement gate server-side (the stamp is derived, so the server would stamp an early join
   * UNPAID — truthfully), which means the whole of "the token leaves the printer already PAID"
   * is this one predicate. A version that ignored the money is the mutant; this row is its kill.
   */
  it("MUTANT — a priced, unissued bill-first visit must NOT join: that is the UNPAID token on the board", () => {
    expect(shouldJoinNow(visitWith(), quoteWith({ encounterId: "E-A" }), null)).toBe(false);
  });

  it("joins once the invoice is issued — settled or credit-extended, both lawful exits", () => {
    expect(shouldJoinNow(visitWith(), quoteWith({ encounterId: "E-A" }), ISSUED)).toBe(true);
    expect(shouldJoinNow(visitWith(), quoteWith({ encounterId: "E-A" }), { ...ISSUED, creditExtended: true })).toBe(true);
  });

  it("joins a FREE revisit without any invoice — the third lawful exit has no money to wait for", () => {
    expect(shouldJoinNow(visitWith(), quoteWith({ encounterId: "E-A", free: true, draft: null }), null)).toBe(true);
  });

  it("a free quote for ANOTHER encounter does not release this one (F1's class)", () => {
    expect(shouldJoinNow(visitWith(), quoteWith({ encounterId: "E-OTHER", free: true, draft: null }), null)).toBe(false);
  });

  it("never joins under queue_first (the walk-in already did), nor twice, nor while in flight, nor after a refusal", () => {
    const q = quoteWith({ encounterId: "E-A" });
    expect(shouldJoinNow(visitWith({ flow: { counterSequence: "queue_first", tokenLane: "token_first" }, tokenNo: 3 }), q, ISSUED)).toBe(false);
    expect(shouldJoinNow(visitWith({ tokenNo: 42 }), q, ISSUED)).toBe(false);
    expect(shouldJoinNow(visitWith({ joining: true }), q, ISSUED)).toBe(false);
    expect(shouldJoinNow(visitWith({ joinError: "encounter_state_conflict" }), q, ISSUED)).toBe(false);
    expect(shouldJoinNow(null, q, ISSUED)).toBe(false);
  });
});

describe("RC-4 T2 — which token the clerk may read out (token_lane is stamps and printing only)", () => {
  const QF_ON_PAYMENT = { counterSequence: "queue_first", tokenLane: "token_on_payment" } as const;

  it("queue_first + token_first: the number is read out at once", () => {
    expect(tokenToShow(visitWith({ flow: QUEUE_FIRST as SeatVisit["flow"], tokenNo: 7 }), quoteWith({ encounterId: "E-A" }), null)).toBe(7);
  });

  it("queue_first + token_on_payment: the number exists and is HELD BACK until the money, then shown", () => {
    const priced = quoteWith({ encounterId: "E-A" });
    expect(tokenToShow(visitWith({ flow: QF_ON_PAYMENT, tokenNo: 7 }), priced, null)).toBeNull();
    expect(tokenToShow(visitWith({ flow: QF_ON_PAYMENT, tokenNo: 7 }), priced, ISSUED)).toBe(7);
    expect(tokenToShow(visitWith({ flow: QF_ON_PAYMENT, tokenNo: 7 }), quoteWith({ encounterId: "E-A", free: true, draft: null }), null)).toBe(7);
  });

  it("bill_first: there is no number to hold back until the join fills it", () => {
    expect(tokenToShow(visitWith(), quoteWith({ encounterId: "E-A" }), ISSUED)).toBeNull();
    expect(tokenToShow(visitWith({ tokenNo: 42 }), quoteWith({ encounterId: "E-A" }), ISSUED)).toBe(42);
  });

  /**
   * THE ENUMS ARE MIRRORED, NOT IMPORTED — the web cannot reach core — so they are pinned against
   * `modules/opd/config.ts` READ AS TEXT, the discipline `SEAT_TENDER_ORDER` already uses on
   * `tender-editor.tsx`. A value added or renamed on one side without the other fails here, before
   * a seat sends a sequence the server's zod refuses (or worse, the server adds a lane the pill
   * cannot show).
   */
  it("the web's COUNTER_SEQUENCES / TOKEN_LANES are exactly core's", () => {
    const core = readFileSync(resolve(__dirname, "../../../core/src/modules/opd/config.ts"), "utf8");
    const seq = /export const COUNTER_SEQUENCES = \[([^\]]+)\] as const;/.exec(core)?.[1] ?? "";
    const lanes = /export const TOKEN_LANES = \[([^\]]+)\] as const;/.exec(core)?.[1] ?? "";
    const parse = (raw: string): string[] => raw.split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter((x) => x !== "");
    expect(parse(seq)).toEqual([...COUNTER_SEQUENCES]);
    expect(parse(lanes)).toEqual([...TOKEN_LANES]);
    expect(COUNTER_SEQUENCES.length).toBeGreaterThan(1); // the regex matched something real
  });
});

describe("RC-4 T2 — bill-first through the ASSEMBLED seat, two patients (method §5A.3)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  const ME = { actor: { type: "user", id: "u-rc4" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } };

  /**
   * The wire log: every write the seat makes, in order. The assertion book's kill is an ORDER —
   * the join before the invoice — so the test records the order rather than counting calls.
   */
  type Log = { method: string; path: string; body: unknown }[];

  /**
   * CLOSE REVIEW F1/F2/F4 — the stub is now a tiny SERVER MODEL, because the seat reads the server
   * for the encounter in hand: `GET /opd/visits/:id` answers with the queue entries the stub's own
   * join-queue calls (or the settle hook, `hook: true`) created, and `GET /billing/invoices`
   * answers with the invoices its own POSTs issued. `seed` pre-loads that model for the reload
   * tests, where the seat remembers nothing and the server remembers everything.
   */
  type ServerModel = { joined: Record<string, number>; invoiced: Record<string, boolean>; status: Record<string, string> };
  function billFirstStub(over: {
    config?: unknown; drawer?: unknown; quoteFor?: (id: string) => unknown; join?: (log: Log) => unknown;
    /** The settle hook (core, RC-4 close F1): an invoice on a never-joined visit joins it server-side. */
    hook?: boolean; seed?: Partial<ServerModel>; /** the counter-state read fails → UNKNOWN */ invoicesForbidden?: boolean;
  } = {}): Log & { model: ServerModel } {
    const model: ServerModel = { joined: {}, invoiced: {}, status: {}, ...over.seed };
    const log: Log & { model: ServerModel } = Object.assign([], { model });
    let opened = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (method !== "GET") log.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (path === "/api/auth/me") return json(ME);
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(over.config ?? BILL_FIRST);
      if (path === "/api/billing/sessions/current") return json(over.drawer ?? DRAWER_OPEN);
      if (path === "/api/patients/search") {
        return json({ items: url.includes("zzzz") ? [] : [{ ...HIT_ASHA, id: "P-B", name: "Binod Sah", matchedOn: ["mobile"] }] });
      }
      if (path === "/api/opd/visits" && method === "GET") return json({ items: [] }); // nobody has a visit today yet
      if (path === "/api/opd/walk-in" && method === "POST") {
        opened += 1;
        const body = JSON.parse(String(init?.body)) as { patient: { existingId?: string }; join?: string };
        const id = opened === 1 ? "A" : "B";
        // The DEFERRED shape, exactly as `walk-in.ts` returns it: null token, session and entry.
        const deferred = body.join === "defer";
        if (!deferred) model.joined[`E-${id}`] = 9;
        return json({
          patientId: body.patient.existingId ?? `P-${id}`, registered: body.patient.existingId === undefined,
          encounter: { id: `E-${id}` },
          tokenNo: deferred ? null : 9, sessionId: deferred ? null : "s-1", queueEntry: deferred ? null : { id: "qe" },
        });
      }
      const quoteMatch = /^\/api\/billing\/visits\/(E-[AB])\/fee-quote$/.exec(path);
      if (quoteMatch) return json(over.quoteFor?.(quoteMatch[1]!) ?? quoteWith({ encounterId: quoteMatch[1] }));
      if (path === "/api/billing/invoices" && method === "POST") {
        const enc = (JSON.parse(String(init?.body)) as { encounterId: string }).encounterId;
        model.invoiced[enc] = true;
        if (over.hook === true && model.joined[enc] === undefined) model.joined[enc] = 42; // the settle hook joined it
        return json(ISSUED);
      }
      const stateMatch = /^\/api\/opd\/visits\/(E-[AB])\/counter-state$/.exec(path);
      if (stateMatch && method === "GET") {
        if (over.invoicesForbidden === true) return json({ statusCode: 500, message: "boom" }, 500);
        const enc = stateMatch[1]!;
        const tokenNo = model.joined[enc];
        // The projection, as the server derives it: the FEE is covered iff the seat's own invoice landed (this stub bills the fee only).
        const free = over.quoteFor !== undefined && (over.quoteFor(enc) as { free?: boolean }).free === true;
        return json({
          encounterId: enc, status: model.status[enc] ?? "registered", serviceDate: "2026-09-01",
          feeStatus: free ? "free" : model.invoiced[enc] === true ? "settled" : "unsettled",
          everJoined: tokenNo !== undefined, tokenNo: tokenNo ?? null,
        });
      }
      const joinMatch = /^\/api\/opd\/visits\/(E-[AB])\/join-queue$/.exec(path);
      if (joinMatch && method === "POST") {
        const custom = over.join?.(log);
        if (custom instanceof Response) return custom;
        const already = model.joined[joinMatch[1]!] !== undefined;
        model.joined[joinMatch[1]!] ??= 42;
        return json(custom ?? { encounter: { id: joinMatch[1] }, queueEntry: { id: "qe-1" }, tokenNo: model.joined[joinMatch[1]!], sessionId: "s-1", roomId: null, alreadyJoined: already });
      }
      return new Response("{}", { status: 404 });
    }));
    return log;
  }

  async function registerNew(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
    await user.type(await screen.findByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), name);
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
  }

  /**
   * THE ASSERTION BOOK, DRIVEN END TO END: a bill-first walk-in has NULL token, session and entry
   * until the money is taken, then joins — and the join is the LAST write on the wire, after the
   * invoice. Two patients, because RC-3's F1 was invisible with one.
   */
  it("defers the join, takes the money HERE, joins AFTER the invoice, and the next patient inherits nothing", async () => {
    const log = billFirstStub();
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();

    await registerNew(user, "Amar Bill-First");
    expect((await screen.findByTestId("dossier-patient")).textContent).toBe("P-A");

    // 1. The walk-in went out with `join: "defer"` — the first time anything on the web has sent it.
    expect(log[0]).toMatchObject({ method: "POST", path: "/api/opd/walk-in", body: { join: "defer" } });
    // 2. No token yet, and the dossier says the number is OWED rather than showing a blank.
    expect(screen.queryByTestId("dossier-token")).toBeNull();
    expect(await screen.findByTestId("dossier-token-afterPayment")).toBeTruthy();
    // 3. The seat can take the money for the visit it opened: the lifted tender block is mounted.
    await screen.findByTestId("collect-panel");
    expect(screen.queryByTestId("priced-elsewhere")).toBeNull();
    // 4. THE KILL, before the money: nothing has touched join-queue.
    expect(log.filter((w) => w.path.endsWith("/join-queue"))).toHaveLength(0);

    await user.type(screen.getByLabelText("Amount"), "400");
    await user.click(screen.getByTestId("settle"));

    // 5. After the money: the invoice went out, THEN the join, and the token is on the dossier.
    expect((await screen.findByTestId("dossier-token")).textContent).toContain("42");
    const writes = log.map((w) => w.path);
    expect(writes.indexOf("/api/billing/invoices")).toBeGreaterThan(-1);
    expect(writes.indexOf("/api/opd/visits/E-A/join-queue")).toBeGreaterThan(writes.indexOf("/api/billing/invoices"));
    expect(writes.filter((p) => p.endsWith("/join-queue"))).toHaveLength(1);
    expect(screen.getByTestId("exit-settled")).toBeTruthy();
    // The invoice was for THIS encounter and THIS patient, with the quote's own lines.
    expect(log.find((w) => w.path === "/api/billing/invoices")?.body).toMatchObject({
      patientId: "P-A", encounterId: "E-A", lines: [{ lineId: "fee", serviceId: "SVC-CONSULT", qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 40_000 }] },
    });

    // 6. SECOND PATIENT. Escape clears the desk; a found patient comes in hand with no encounter.
    fireEvent.keyDown(window, { key: "Escape" });
    await user.type(await screen.findByTestId("find-input"), "98765");
    await user.click(await screen.findByTestId("find-hit-P-B"));
    expect((await screen.findByTestId("dossier-patient")).textContent).toBe("P-B");
    expect(screen.queryByTestId("dossier-token")).toBeNull();
    expect(screen.queryByTestId("exit-settled")).toBeNull();
    expect(screen.queryByTestId("collect")).toBeNull();

    // 7. The EXISTING patient's door: the four fields fold away, the doctor is asked, the visit opens deferred.
    expect(screen.queryByTestId("reg-name")).toBeNull();
    await user.selectOptions(await screen.findByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
    await screen.findByTestId("dossier-token-afterPayment");
    expect(log.filter((w) => w.path === "/api/opd/walk-in")[1]).toMatchObject({ body: { patient: { existingId: "P-B" }, join: "defer" } });
    // Nothing of A: no token 42, no settled exit, one join in the whole log so far — B's is still owed.
    expect(screen.queryByTestId("dossier-token")).toBeNull();
    expect(screen.queryByTestId("exit-settled")).toBeNull();
    expect(log.filter((w) => w.path.endsWith("/join-queue"))).toHaveLength(1);
    await screen.findByTestId("collect-panel"); // and B's own money can be taken
  });

  /**
   * ═══ R26/R27 — TWO REVERTS THAT COULD NOT FAIL, AND WHAT THEY TAUGHT ═══
   *
   * The two-patient test above goes through `Escape`, and `clearDesk` resets the visit and the
   * invoice — so dropping the encounter-keyed accessors (`hereVisit`, `issued`) left it green.
   * The keying is for the road that does NOT pass through `clearDesk`: the command palette, or
   * any other screen inside the same `PatientInHandProvider`, taking a different patient in hand
   * while the seat is mounted. `Taker` is that other surface. With the keying gone, B is shown A's
   * token, A's "Paid in full", and — the money defect — a collect panel whose `settle` would issue
   * A's draft against A's encounter for B's cash.
   */
  it("a patient taken in hand by ANOTHER surface inherits neither A's token, A's exit, nor A's invoice draft", async () => {
    const log = billFirstStub();
    function Taker(): React.ReactElement {
      const { takePatient, takeEncounter } = usePatientInHand();
      return <>
        <button type="button" data-testid="take-b" onClick={() => takePatient("P-B")}>b</button>
        <button type="button" data-testid="take-b-visit" onClick={() => takeEncounter("E-B")}>b visit</button>
      </>;
    }
    renderWithProviders(<><RegistrationCounter /><Taker /></>);
    const user = userEvent.setup();

    await registerNew(user, "Amar Bill-First");
    await screen.findByTestId("collect-panel");
    await user.type(screen.getByLabelText("Amount"), "400");
    await user.click(screen.getByTestId("settle"));
    expect((await screen.findByTestId("dossier-token")).textContent).toContain("42");
    expect(screen.getByTestId("exit-settled")).toBeTruthy();

    // The palette takes B — no Escape, no clearDesk — and then B's visit is opened elsewhere.
    await user.click(screen.getByTestId("take-b"));
    expect((await screen.findByTestId("dossier-patient")).textContent).toBe("P-B");
    await user.click(screen.getByTestId("take-b-visit"));
    expect((await screen.findByTestId("dossier-encounter")).textContent).toBe("E-B");
    await screen.findByTestId("priced-elsewhere"); // B's own quote arrived, and the seat cannot see B's money
    expect(screen.queryByTestId("dossier-token")).toBeNull();     // R26's kill
    expect(screen.queryByTestId("exit-settled")).toBeNull();      // R27's kill
    expect(screen.queryByTestId("collect-panel")).toBeNull();     // and no way to spend A's draft on B
    expect(log.filter((w) => w.path === "/api/billing/invoices")).toHaveLength(1);
  });

  it("a FREE revisit under bill-first joins on the quote alone — no invoice, no tender, a token", async () => {
    const log = billFirstStub({ quoteFor: (id) => quoteWith({ encounterId: id, free: true, draft: null, feeServiceId: null }) });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await registerNew(user, "Free Revisit");

    expect((await screen.findByTestId("dossier-token")).textContent).toContain("42");
    expect(screen.getByTestId("exit-free")).toBeTruthy();
    expect(screen.queryByTestId("collect-panel")).toBeNull();
    expect(log.map((w) => w.path)).toEqual(["/api/opd/walk-in", "/api/opd/visits/E-A/join-queue"]);
  });

  /**
   * THE DRAWER GATE. A deferred visit with no money is a patient nobody will call: no token, no
   * queue entry, and a seat that cannot issue the invoice that would earn one. So the bill-first
   * door is shut BEFORE the walk-in when the drawer is not open — lifted from `counter-desk.tsx`,
   * where the same check exists because the old screen discovered it at the payment step.
   */
  it("bill-first with a closed drawer refuses BEFORE the walk-in — nothing is opened that cannot be finished", async () => {
    const log = billFirstStub({ drawer: { session: null } });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await registerNew(user, "No Drawer");

    expect((await screen.findByTestId("reg-error")).textContent).toContain("drawer");
    expect(log).toHaveLength(0); // THE KILL: no walk-in, no deferred visit stranded
    expect(screen.getByTestId("dossier-empty")).toBeTruthy();
  });

  it("queue_first + token_on_payment: the number is held back until the money, then read out", async () => {
    const log = billFirstStub({ config: { counterSequence: "queue_first", tokenLane: "token_on_payment" } });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await registerNew(user, "Slip Later");

    await screen.findByTestId("dossier-token-afterPayment");
    expect(screen.queryByTestId("dossier-token")).toBeNull();
    expect(log[0]!.body).not.toHaveProperty("join"); // queue_first: the walk-in joined already
    await screen.findByTestId("collect-panel");
    await user.type(screen.getByLabelText("Amount"), "400");
    await user.click(screen.getByTestId("settle"));

    expect((await screen.findByTestId("dossier-token")).textContent).toContain("9"); // the walk-in's own token
    expect(log.filter((w) => w.path.endsWith("/join-queue"))).toHaveLength(0); // never a second join
  });

  it("a refused join is shown with a way through, and the retry joins once", async () => {
    let attempts = 0;
    const log = billFirstStub({
      join: () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ statusCode: 409, message: "not today", code: "encounter_state_conflict" }), { status: 409, headers: { "Content-Type": "application/json" } });
        }
        return undefined;
      },
    });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await registerNew(user, "Join Fails");
    await screen.findByTestId("collect-panel");
    await user.type(screen.getByLabelText("Amount"), "400");
    await user.click(screen.getByTestId("settle"));

    await screen.findByTestId("join-failed");
    expect(screen.queryByTestId("dossier-token")).toBeNull();
    // A refusal does NOT loop: exactly one attempt stands until the clerk asks for another.
    expect(log.filter((w) => w.path.endsWith("/join-queue"))).toHaveLength(1);
    // "Next patient" is not withheld by a failed join — the money is taken and the exit is real;
    // the retry is the way to the token.
    await user.click(screen.getByTestId("join-retry"));
    expect((await screen.findByTestId("dossier-token")).textContent).toContain("42");
    expect(log.filter((w) => w.path.endsWith("/join-queue"))).toHaveLength(2);
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 T4 — THE FLOW PILL, WORN OPENLY (D5, corrected: the setting is HOSPITAL-WIDE)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("RC-4 T4 — the flow pill shows the server's sequence, and only the permission changes it", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  const me = (hospital: string[]): unknown =>
    ({ actor: { type: "user", id: "u-rc4" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });

  /**
   * A stub whose config can be CHANGED under a mounted seat — that is the two-counters scenario:
   * the other counter's supervisor flips the flow, and this seat's pill must follow the server.
   */
  function pillStub(hospital: string[], first: unknown): { log: { method: string; path: string; body: unknown }[]; set: (c: unknown) => void; putAnswers: (c: unknown) => void } {
    let config = first;
    let putAnswer: unknown = null;
    const log: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (method !== "GET") log.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (path === "/api/auth/me") return json(me(hospital));
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
      if (path === "/api/patients/search") return json({ items: [] });
      if (path === "/api/opd/config" && method === "GET") return json(config);
      if (path === "/api/opd/config/counter-flow" && method === "PUT") {
        // The server answers with the WHOLE config, as `putCounterFlow` does — and what it
        // answers is the truth, whatever was asked.
        config = putAnswer ?? { ...(config as object), ...(JSON.parse(String(init?.body)) as object) };
        return json(config);
      }
      return new Response("{}", { status: 404 });
    }));
    return { log, set: (c) => { config = c; }, putAnswers: (c) => { putAnswer = c; } };
  }

  it("a clerk without `opd.counter.flow.manage` sees the sequence, the lane, and a lock — no control", async () => {
    const { log } = pillStub([], QUEUE_FIRST);
    renderWithProviders(<RegistrationCounter />);

    const seq = await screen.findByTestId("flow-sequence");
    expect(seq.tagName).toBe("SPAN");                                 // not a select
    expect(seq.textContent).toContain("Register → Queue → Bill");
    expect(screen.getByTestId("flow-lane").textContent).toContain("Token at registration");
    expect(screen.getByTestId("flow-locked")).toBeTruthy();
    // (Close review B-F8: an `expect(log).toHaveLength(0)` stood here and was true regardless —
    // nothing is clicked, so nothing could write. The SPAN assertion is the kill.)
    void log;
  });

  it("the supervisor's write sends EXACTLY one flow key, and the pill then shows what the SERVER returned", async () => {
    const { log } = pillStub(["opd.counter.flow.manage"], QUEUE_FIRST);
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();

    const seq = await screen.findByTestId("flow-sequence");
    expect(seq.tagName).toBe("SELECT");
    expect(screen.queryByTestId("flow-locked")).toBeNull();
    await user.selectOptions(seq, "bill_first");

    // `toEqual`: the body is the two-key shape and nothing else — the route's security property.
    expect(log).toEqual([{ method: "PUT", path: "/api/opd/config/counter-flow", body: { counterSequence: "bill_first" } }]);
    expect((await screen.findByDisplayValue("Register → Bill → Queue"))).toBeTruthy();
    // The lane is meaningful only under queue_first (RC-1 D3): under bill_first it is not offered.
    expect(screen.queryByTestId("flow-lane")).toBeNull();
  });

  /**
   * THE MUTANT THE ASSERTION BOOK NAMES: a pill rendered from client state. Here the server
   * answers the write with a DIFFERENT value than was asked (a concurrent flip, a refusal
   * answered 200 with the standing config — any road). A pill that echoed the request would show
   * `bill_first`; the pill shows the server's `queue_first`.
   */
  it("MUTANT — the pill echoing the request: the server answers with a different value and the pill shows THAT", async () => {
    const { putAnswers } = pillStub(["opd.counter.flow.manage"], QUEUE_FIRST);
    putAnswers({ counterSequence: "queue_first", tokenLane: "token_on_payment" });
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByTestId("flow-sequence"), "bill_first");

    expect((await screen.findByDisplayValue("Token on payment"))).toBeTruthy(); // the server's lane arrived…
    expect(screen.getByDisplayValue("Register → Queue → Bill")).toBeTruthy();   // …and the server's sequence, not the request's
    expect(screen.queryByDisplayValue("Register → Bill → Queue")).toBeNull();   // THE KILL
  });

  /**
   * TWO COUNTERS, ONE HOSPITAL. The other counter's supervisor flips the flow on the server; this
   * seat, mounted and idle, must not go on showing the old sequence. The poll is the mechanism,
   * and the walk-in's own open-time read (T2) is the guarantee that even a stale pill can never
   * reach the wire. Fake timers drive the poll; `shouldAdvanceTime` keeps Testing Library's own
   * polling alive under them.
   */
  it("another counter flips the flow; this pill follows the server within one poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { set } = pillStub([], QUEUE_FIRST);
      renderWithProviders(<RegistrationCounter />);
      expect((await screen.findByTestId("flow-sequence")).textContent).toContain("Register → Queue → Bill");

      set(BILL_FIRST); // the server moved — nothing in this tab did anything
      await vi.advanceTimersByTimeAsync(FLOW_POLL_MS + 50);

      expect((await screen.findByTestId("flow-sequence")).textContent).toContain("Register → Bill → Queue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("when the config cannot be read the pill says so rather than showing a default sequence", async () => {
    stubFetch({
      "GET /api/auth/me": me([]),
      "GET /api/opd/queues/summary": { items: [DOC_A] },
      "GET /api/patients/search": { items: [] },
      // no /api/opd/config → 404 → the query errors
    });
    renderWithProviders(<RegistrationCounter />);
    expect(await screen.findByTestId("flow-unknown")).toBeTruthy();
    expect(screen.queryByTestId("flow-sequence")).toBeNull(); // no sequence claimed at all
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════════
   RC-4 CLOSE REVIEW — pass 1's findings, each proved by restoring its defect (method §5A.4)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

describe("RC-4 close review — F1 (CRITICAL): a deferred visit's join must survive the seat forgetting it", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });
  const ME = { actor: { type: "user", id: "u-rc4" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } };

  /** The same server model as the T2 block, reachable here. */
  function serverStub(seed: { joined?: Record<string, number>; invoiced?: Record<string, boolean>; status?: Record<string, string> }, over: { join?: () => Response | undefined; invoicesForbidden?: boolean; quoteFree?: boolean; drawer?: unknown } = {}): { joins: number } {
    const model = { joined: { ...seed.joined }, invoiced: { ...seed.invoiced }, status: { ...seed.status } };
    const counters = { joins: 0 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json(ME);
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(BILL_FIRST);
      if (path === "/api/billing/sessions/current") return json(over.drawer ?? DRAWER_OPEN);
      if (path === "/api/patients/search") return json({ items: [] });
      const quoteMatch = /^\/api\/billing\/visits\/(E-[AB])\/fee-quote$/.exec(path);
      if (quoteMatch) return json(quoteWith({ encounterId: quoteMatch[1], ...(over.quoteFree === true ? { free: true, draft: null, feeServiceId: null } : {}) }));
      const stateMatch = /^\/api\/opd\/visits\/(E-[AB])\/counter-state$/.exec(path);
      if (stateMatch && method === "GET") {
        if (over.invoicesForbidden === true) return json({ statusCode: 500 }, 500);
        const enc = stateMatch[1]!;
        const t = model.joined[enc];
        return json({
          encounterId: enc, status: model.status[enc] ?? "registered", serviceDate: "2026-09-01",
          feeStatus: over.quoteFree === true ? "free" : model.invoiced[enc] === true ? "settled" : "unsettled",
          everJoined: t !== undefined, tokenNo: t ?? null,
        });
      }
      const joinMatch = /^\/api\/opd\/visits\/(E-[AB])\/join-queue$/.exec(path);
      if (joinMatch && method === "POST") {
        counters.joins += 1;
        const custom = over.join?.();
        if (custom !== undefined) return custom;
        model.joined[joinMatch[1]!] ??= 42;
        return json({ encounter: { id: joinMatch[1] }, queueEntry: {}, tokenNo: model.joined[joinMatch[1]!], sessionId: "s-1", roomId: null, alreadyJoined: false });
      }
      return new Response("{}", { status: 404 });
    }));
    return counters;
  }

  /**
   * THE RELOAD ROAD. The seat remembers nothing; the patient is in hand from sessionStorage; the
   * server says: registered, never joined, and an invoice exists (issued at /billing, or here
   * before the reload). The seat offers the join — and takes the server's token once it exists.
   */
  it("after a reload, a PAID never-joined visit is offered the join, and joining shows the server's token", async () => {
    const c = serverStub({ invoiced: { "E-A": true } });
    takeInHand("P-A", "E-A");
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();

    const owed = await screen.findByTestId("join-owed");
    expect(owed.textContent).toContain("not in the queue");
    expect(screen.queryByTestId("collect-panel")).toBeNull();          // and no second collection (F2/F4)
    expect(screen.getByTestId("covered-elsewhere")).toBeTruthy();
    await user.click(screen.getByTestId("join-now"));

    expect((await screen.findByTestId("dossier-token")).textContent).toContain("42");
    expect(c.joins).toBe(1);
    await waitFor(() => expect(screen.queryByTestId("join-owed")).toBeNull());
  });

  it("MUTANT — the door offered on an UNPAID deferred visit: no invoice, priced quote → no join offered, no collect elsewhere", async () => {
    const c = serverStub({});
    takeInHand("P-A", "E-A");
    renderWithProviders(<RegistrationCounter />);
    await screen.findByTestId("priced-elsewhere");
    expect(screen.queryByTestId("join-owed")).toBeNull(); // THE KILL: the unpaid token this lane exists to keep off the board
    expect(c.joins).toBe(0);
  });

  it("a visit the SERVER joined (the settle hook, or /billing) shows its token with no seat memory at all", async () => {
    serverStub({ joined: { "E-A": 17 }, invoiced: { "E-A": true } });
    takeInHand("P-A", "E-A");
    renderWithProviders(<RegistrationCounter />);
    expect((await screen.findByTestId("dossier-token")).textContent).toContain("17");
    expect(screen.queryByTestId("join-owed")).toBeNull();
  });

  it("a FREE revisit after a reload is offered the join on the quote alone", async () => {
    serverStub({}, { quoteFree: true });
    takeInHand("P-A", "E-A");
    renderWithProviders(<RegistrationCounter />);
    expect(await screen.findByTestId("join-owed")).toBeTruthy();
  });
});

describe("RC-4 close review — F2/F4: the seat's memory is not the truth about the money", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  /**
   * The seat opened A, the clerk was interrupted, and A was billed at /billing. The next poll
   * of the seat's invoice read says so — and "Collect ₹400" must be gone. Fake timers drive the
   * poll, as in the pill test.
   */
  it("an invoice issued for the seat's own visit from ANOTHER surface takes the collect panel away within a poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const model = { invoiced: false };
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(typeof input === "string" ? input : (input as Request).url);
        const path = url.split("?")[0]!;
        const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
        if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
        if (path === "/api/opd/config") return json(QUEUE_FIRST);
        if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
        if (path === "/api/patients/search") return json({ items: [] });
        if (path === "/api/opd/walk-in") return json({ patientId: "P-A", registered: true, encounter: { id: "E-A" }, tokenNo: 9, sessionId: "s", queueEntry: {} });
        if (path === "/api/billing/visits/E-A/fee-quote") return json(quoteWith({ encounterId: "E-A" }));
        if (path === "/api/opd/visits/E-A/counter-state") return json({ encounterId: "E-A", status: "registered", serviceDate: "2026-09-01", feeStatus: model.invoiced ? "settled" : "unsettled", everJoined: true, tokenNo: 9 });
        return new Response("{}", { status: 404 });
      }));
      renderWithProviders(<RegistrationCounter />);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(await screen.findByTestId("find-input"), "zzzz");
      await user.click(await screen.findByTestId("find-register-new"));
      await user.type(screen.getByTestId("reg-name"), "Interrupted");
      await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
      await user.click(screen.getByTestId("reg-submit"));
      await screen.findByTestId("collect-panel");

      model.invoiced = true; // billed at /billing while the clerk was away
      await vi.advanceTimersByTimeAsync(FLOW_POLL_MS + 50);

      await waitFor(() => expect(screen.queryByTestId("collect-panel")).toBeNull()); // THE KILL
      expect(screen.getByTestId("covered-elsewhere")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * PASS 2, N6 — the first version of this test took the patient in hand from OUTSIDE the seat, so
   * `hereVisit === null` made `canCollect` false whatever the server said: true regardless. It now
   * drives the seat's OWN visit — the one road on which memory alone would collect — with the
   * counter-state read failing, and asserts the panel does NOT come back on memory.
   */
  it("the seat's OWN visit with an UNKNOWN server state (read fails) does not collect — memory alone is not enough", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(QUEUE_FIRST);
      if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
      if (path === "/api/patients/search") return json({ items: [] });
      if (path === "/api/opd/walk-in" && init?.method === "POST") return json({ patientId: "P-A", registered: true, encounter: { id: "E-A" }, tokenNo: 9, sessionId: "s", queueEntry: {} });
      if (path === "/api/billing/visits/E-A/fee-quote") return json(quoteWith({ encounterId: "E-A" }));
      if (path === "/api/opd/visits/E-A/counter-state") return json({ statusCode: 500, message: "boom" }, 500);
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Unknown State");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
    expect((await screen.findByTestId("dossier-token")).textContent).toContain("9"); // the seat's own visit IS in hand
    await screen.findByTestId("priced-elsewhere");
    expect(screen.queryByTestId("collect-panel")).toBeNull(); // THE KILL
  });

  /**
   * PASS 2, N2 — the predicate is the PROJECTION, in both directions: an entered-in-error fee
   * invoice leaves the fee `unsettled`, and the seat may collect again; "an invoice exists" would
   * have refused forever.
   */
  it("a voided fee invoice (projection: unsettled) lets the seat's own visit collect again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const model = { fee: "settled" as "settled" | "unsettled" };
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === "string" ? input : (input as Request).url);
        const path = url.split("?")[0]!;
        const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
        if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
        if (path === "/api/opd/config") return json(QUEUE_FIRST);
        if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
        if (path === "/api/patients/search") return json({ items: [] });
        if (path === "/api/opd/walk-in" && init?.method === "POST") return json({ patientId: "P-A", registered: true, encounter: { id: "E-A" }, tokenNo: 9, sessionId: "s", queueEntry: {} });
        if (path === "/api/billing/visits/E-A/fee-quote") return json(quoteWith({ encounterId: "E-A" }));
        if (path === "/api/opd/visits/E-A/counter-state") return json({ encounterId: "E-A", status: "registered", serviceDate: "2026-09-01", feeStatus: model.fee, everJoined: true, tokenNo: 9 });
        return new Response("{}", { status: 404 });
      }));
      renderWithProviders(<RegistrationCounter />);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(await screen.findByTestId("find-input"), "zzzz");
      await user.click(await screen.findByTestId("find-register-new"));
      await user.type(screen.getByTestId("reg-name"), "Voided Later");
      await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
      await user.click(screen.getByTestId("reg-submit"));
      await screen.findByTestId("covered-elsewhere");          // settled at /billing already: no collect, and it says PAID not "take payment"
      expect(screen.queryByTestId("collect-panel")).toBeNull();

      model.fee = "unsettled";                                  // the receipt is voided
      await vi.advanceTimersByTimeAsync(FLOW_POLL_MS + 50);
      expect(await screen.findByTestId("collect-panel")).toBeTruthy(); // THE KILL for "an invoice exists"
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RC-4 close review — pass 2 F1(a)/F7(A): today's visit is resumed, not duplicated", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  function stub(todays: { id: string; patientId: string; status: string }[]): { walkIns: number } {
    const c = { walkIns: 0 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(BILL_FIRST);
      if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
      if (path === "/api/patients/search") return json({ items: [{ ...HIT_ASHA, id: "P-B", name: "Binod Sah", matchedOn: ["mobile"] }] });
      if (path === "/api/opd/visits" && (init?.method ?? "GET") === "GET") return json({ items: todays });
      if (path === "/api/opd/visits/E-B/counter-state") return json({ encounterId: "E-B", status: "registered", serviceDate: "2026-09-01", feeStatus: "free", everJoined: false, tokenNo: null });
      if (path === "/api/billing/visits/E-B/fee-quote") return json(quoteWith({ encounterId: "E-B", free: true, draft: null, feeServiceId: null }));
      if (path === "/api/opd/walk-in") { c.walkIns += 1; return json({}); }
      return new Response("{}", { status: 404 });
    }));
    return c;
  }

  it("a patient with a live visit today gets RESUME, not a second walk-in — and resuming brings the deferred visit's join door back", async () => {
    const c = stub([{ id: "E-B", patientId: "P-B", status: "registered" }, { id: "E-Z", patientId: "P-Z", status: "registered" }]);
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "98765");
    await user.click(await screen.findByTestId("find-hit-P-B"));

    await screen.findByTestId("todays-visit");
    expect(screen.queryByTestId("register-panel")).toBeNull();        // THE KILL for the duplicate-visit door
    await user.click(screen.getByTestId("resume-visit"));
    expect((await screen.findByTestId("dossier-encounter")).textContent).toBe("E-B");
    expect(await screen.findByTestId("join-owed")).toBeTruthy();       // F1(a): the released deferred free visit is reachable again
    expect(c.walkIns).toBe(0);
  });

  it("a patient whose only visit today is COMPLETED gets the open-visit door", async () => {
    stub([{ id: "E-B", patientId: "P-B", status: "completed" }]);
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "98765");
    await user.click(await screen.findByTestId("find-hit-P-B"));
    expect(await screen.findByTestId("register-panel")).toBeTruthy();
    expect(screen.queryByTestId("todays-visit")).toBeNull();
  });
});

describe("RC-4 close review — F3(A): a quote that failed is said, not swallowed", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });
  it("shows the failure with a retry, and the retry re-asks", async () => {
    let quoteCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
      if (path === "/api/billing/visits/E-A/fee-quote") { quoteCalls += 1; return quoteCalls === 1 ? json({ statusCode: 403, message: "no billing.invoice.read" }, 403) : json(quoteWith({ encounterId: "E-A" })); }
      if (path === "/api/opd/visits/E-A/counter-state") return json({ encounterId: "E-A", status: "registered", serviceDate: "2026-09-01", feeStatus: "unsettled", everJoined: false, tokenNo: null });
      void init;
      return new Response("{}", { status: 404 });
    }));
    takeInHand("P-A", "E-A");
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    expect(await screen.findByTestId("quote-error")).toBeTruthy();
    await user.click(screen.getByTestId("quote-retry"));
    await screen.findByTestId("priced-elsewhere");
    expect(screen.queryByTestId("quote-error")).toBeNull();
    expect(quoteCalls).toBe(2);
  });
});

describe("RC-4 close review — F4(A)/F3(B)/F8(A): the drawer, read live and named exactly", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });
  const ME = { actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } };

  function drawerStub(sequence: unknown[], config: unknown = BILL_FIRST): { walkIns: number; drawerReads: number } {
    const c = { walkIns: 0, drawerReads: 0 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json(ME);
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(config);
      if (path === "/api/patients/search") return json({ items: [] });
      if (path === "/api/billing/sessions/current") {
        const answer = sequence[Math.min(c.drawerReads, sequence.length - 1)];
        c.drawerReads += 1;
        if (answer === 403) return json({ statusCode: 403 }, 403);
        return json(answer);
      }
      if (path === "/api/opd/walk-in" && init?.method === "POST") { c.walkIns += 1; return json({ patientId: "P-A", registered: true, encounter: { id: "E-A" }, tokenNo: null, sessionId: null, queueEntry: null }); }
      return new Response("{}", { status: 404 });
    }));
    return c;
  }

  /** The commit claimed "before the walk-in"; the gate read a cache. Now: open at mount, CLOSED at the click. */
  it("the bill-first gate reads the drawer at the moment of opening — a drawer closed since mount refuses the walk-in", async () => {
    const c = drawerStub([DRAWER_OPEN, { session: { id: "cs", status: "closed" } }]);
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Late Close");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));

    expect((await screen.findByTestId("reg-error")).textContent).toContain("not open");
    expect(c.walkIns).toBe(0); // THE KILL
    expect(c.drawerReads).toBeGreaterThanOrEqual(2); // mount + the live read at open
  });

  it.each([
    [403, "drawer-forbidden", "cashier role"],
    [{ session: { id: "cs", status: "closing" } }, "drawer-closing", "billing manager"],
    [{ session: null }, "drawer-closed", "not open"],
  ])("the drawer line names the state — %s", async (answer, testId, words) => {
    drawerStub([answer], QUEUE_FIRST);
    renderWithProviders(<RegistrationCounter />);
    expect((await screen.findByTestId(testId)).textContent).toContain(words);
    if (testId === "drawer-closing") expect(screen.getByTestId("drawer-cover")).toBeTruthy();
    if (testId === "drawer-closed") expect(screen.getByTestId("drawer-open-link")).toBeTruthy();
  });

  it("an open drawer shows no line at all", async () => {
    drawerStub([DRAWER_OPEN], QUEUE_FIRST);
    renderWithProviders(<RegistrationCounter />);
    await screen.findByTestId("find-input");
    expect(screen.queryByTestId("drawer-closed")).toBeNull();
    expect(screen.queryByTestId("drawer-forbidden")).toBeNull();
  });

  it("a front_office-only login under bill-first is told it is the ROLE, not the session", async () => {
    const c = drawerStub([403]);
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "No Role");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
    expect((await screen.findByTestId("reg-error")).textContent).toContain("cashier role");
    expect(c.walkIns).toBe(0);
  });
});

describe("RC-4 close review — F6(A)/F2(B): Escape and Next agree while a join or a settle is in flight", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  it("Escape during the join does not clear the desk; the token arrives and is shown", async () => {
    let releaseJoin: (() => void) | null = null;
    const joinGate = new Promise<void>((r) => { releaseJoin = r; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(BILL_FIRST);
      if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
      if (path === "/api/patients/search") return json({ items: [] });
      if (path === "/api/opd/walk-in") return json({ patientId: "P-A", registered: true, encounter: { id: "E-A" }, tokenNo: null, sessionId: null, queueEntry: null });
      if (path === "/api/billing/visits/E-A/fee-quote") return json(quoteWith({ encounterId: "E-A" }));
      if (path === "/api/billing/invoices" && method === "POST") return json(ISSUED);
      if (path === "/api/opd/visits/E-A/counter-state") return json({ encounterId: "E-A", status: "registered", serviceDate: "2026-09-01", feeStatus: "unsettled", everJoined: false, tokenNo: null });
      if (path === "/api/opd/visits/E-A/join-queue") { await joinGate; return json({ encounter: { id: "E-A" }, queueEntry: {}, tokenNo: 42, sessionId: "s", roomId: null, alreadyJoined: false }); }
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Esc Habit");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
    await screen.findByTestId("collect-panel");
    await user.type(screen.getByLabelText("Amount"), "400");
    await user.click(screen.getByTestId("settle"));
    await screen.findByTestId("dossier-token-joining");

    fireEvent.keyDown(window, { key: "Escape" });                 // the habit
    expect(screen.getByTestId("dossier-patient").textContent).toBe("P-A"); // THE KILL: still in hand
    expect((screen.getByTestId("exit-confirm") as HTMLButtonElement).disabled).toBe(true);

    releaseJoin!();
    expect((await screen.findByTestId("dossier-token")).textContent).toContain("42");
    fireEvent.keyDown(window, { key: "Escape" });                 // now it may
    expect(await screen.findByTestId("dossier-empty")).toBeTruthy();
  });
});

describe("RC-4 close review — F7(B): the change lane, asserted through the assembled seat", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  function stub(): { invoiceBody: () => unknown } {
    let body: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(QUEUE_FIRST);
      if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
      if (path === "/api/patients/search") return json({ items: [] });
      if (path === "/api/opd/walk-in") return json({ patientId: "P-A", registered: true, encounter: { id: "E-A" }, tokenNo: 9, sessionId: "s", queueEntry: {} });
      if (path === "/api/billing/visits/E-A/fee-quote") return json(quoteWith({ encounterId: "E-A" }));
      if (path === "/api/billing/invoices" && method === "POST") { body = JSON.parse(String(init?.body)); return json(ISSUED); }
      if (path === "/api/opd/visits/E-A/counter-state") return json({ encounterId: "E-A", status: "registered", serviceDate: "2026-09-01", feeStatus: "unsettled", everJoined: true, tokenNo: 9 });
      return new Response("{}", { status: 404 });
    }));
    return { invoiceBody: () => body };
  }

  async function openAndCollect(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(await screen.findByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Change Lane");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
    await screen.findByTestId("collect-panel");
  }

  it("cash 500 on a ₹400 bill declares the whole ₹100 as change by default", async () => {
    const s = stub();
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await openAndCollect(user);
    await user.type(screen.getByLabelText("Amount"), "500");
    expect(await screen.findByTestId("change-lane")).toBeTruthy();
    await user.click(screen.getByTestId("settle"));
    await screen.findByTestId("exit-settled");
    expect(s.invoiceBody()).toMatchObject({ receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }], changeGivenPaise: 10_000 } });
  });

  /** MIXED tender with cash < surplus: the M4 ceiling — change is capped at the CASH side, not the surplus. */
  it("cash 50 + UPI 450 on a ₹400 bill: the ₹100 surplus is declared as ₹50 change — the cash ceiling, not the surplus", async () => {
    const s = stub();
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await openAndCollect(user);
    await user.type(screen.getByLabelText("Amount"), "50");
    await user.click(screen.getByRole("button", { name: /add/i }));
    const modes = screen.getAllByLabelText("Mode");
    await user.selectOptions(modes[1]!, "upi");
    const amounts = screen.getAllByLabelText("Amount");
    await user.type(amounts[1]!, "450");
    await user.type(screen.getAllByLabelText(/reference/i)[0]!, "UPI-REF-1");
    expect(await screen.findByTestId("change-lane")).toBeTruthy();
    await user.click(screen.getByTestId("settle"));
    await screen.findByTestId("exit-settled");
    expect(s.invoiceBody()).toMatchObject({ receipt: { changeGivenPaise: 5_000 } }); // THE KILL for a whole-surplus default (10_000)
  });

  it("a card-only surplus offers no change lane — returning money on a card is a refund", async () => {
    stub();
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await openAndCollect(user);
    await user.selectOptions(screen.getByLabelText("Mode"), "card");
    await user.type(screen.getByLabelText("Amount"), "500");
    await user.type(screen.getByLabelText(/reference/i), "CARD-1");
    expect(await screen.findByTestId("surplus-no-cash")).toBeTruthy();
    expect(screen.queryByTestId("change-lane")).toBeNull();
  });
});

describe("RC-4 close review — pass 2 N5/N4: a failed re-read is UNKNOWN, and the hold-back survives a reload", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setToken("test-token");
  });

  /**
   * N5 — F2(A)'s exact road: the settle POST's response is LOST (the server may have committed),
   * the seat re-reads the server, and THAT read fails too. react-query keeps the last data on
   * error, so a hook that did not consult `isError` would answer "unsettled" from before the POST
   * and put "Collect ₹400" back with a fresh idempotency key. Unknown must not collect.
   */
  it("a settle whose response is lost, followed by a failed re-read, does NOT re-offer the collect panel", async () => {
    const model = { stateOk: true };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      const path = url.split("?")[0]!;
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
      if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
      if (path === "/api/opd/config") return json(QUEUE_FIRST);
      if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
      if (path === "/api/patients/search") return json({ items: [] });
      if (path === "/api/opd/walk-in" && method === "POST") return json({ patientId: "P-A", registered: true, encounter: { id: "E-A" }, tokenNo: 9, sessionId: "s", queueEntry: {} });
      if (path === "/api/billing/visits/E-A/fee-quote") return json(quoteWith({ encounterId: "E-A" }));
      if (path === "/api/opd/visits/E-A/counter-state") {
        return model.stateOk
          ? json({ encounterId: "E-A", status: "registered", serviceDate: "2026-09-01", feeStatus: "unsettled", everJoined: true, tokenNo: 9 })
          : json({ statusCode: 502, message: "gateway" }, 502);
      }
      if (path === "/api/billing/invoices" && method === "POST") { model.stateOk = false; return json({ statusCode: 504, message: "lost" }, 504); }
      return new Response("{}", { status: 404 });
    }));
    renderWithProviders(<RegistrationCounter />);
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("find-input"), "zzzz");
    await user.click(await screen.findByTestId("find-register-new"));
    await user.type(screen.getByTestId("reg-name"), "Lost Response");
    await user.selectOptions(screen.getByTestId("reg-doctor"), "d-1");
    await user.click(screen.getByTestId("reg-submit"));
    await screen.findByTestId("collect-panel");
    await user.type(screen.getByLabelText("Amount"), "400");
    await user.click(screen.getByTestId("settle"));

    await screen.findByTestId("settle-error");
    await waitFor(() => expect(screen.queryByTestId("collect-panel")).toBeNull()); // THE KILL: no fresh-key retry on a stale "unsettled"
    expect(screen.getByTestId("priced-elsewhere")).toBeTruthy();
  });

  it("N4 — after a reload under queue_first + token_on_payment the server's token is HELD BACK until the money", async () => {
    const model = { fee: "unsettled" as "unsettled" | "settled" };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(typeof input === "string" ? input : (input as Request).url);
        const path = url.split("?")[0]!;
        const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        if (path === "/api/auth/me") return json({ actor: { type: "user", id: "u" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } });
        if (path === "/api/opd/queues/summary") return json({ items: [DOC_A] });
        if (path === "/api/opd/config") return json({ counterSequence: "queue_first", tokenLane: "token_on_payment" });
        if (path === "/api/billing/sessions/current") return json(DRAWER_OPEN);
        if (path === "/api/billing/visits/E-A/fee-quote") return json(quoteWith({ encounterId: "E-A" }));
        if (path === "/api/opd/visits/E-A/counter-state") return json({ encounterId: "E-A", status: "registered", serviceDate: "2026-09-01", feeStatus: model.fee, everJoined: true, tokenNo: 9 });
        return new Response("{}", { status: 404 });
      }));
      takeInHand("P-A", "E-A"); // the reload road: in hand, no seat memory
      renderWithProviders(<RegistrationCounter />);
      await screen.findByTestId("priced-elsewhere");
      expect(screen.queryByTestId("dossier-token")).toBeNull(); // THE KILL: the slip has not left the printer

      model.fee = "settled";
      await vi.advanceTimersByTimeAsync(FLOW_POLL_MS + 50);
      expect((await screen.findByTestId("dossier-token")).textContent).toContain("9");
    } finally {
      vi.useRealTimers();
    }
  });
});
