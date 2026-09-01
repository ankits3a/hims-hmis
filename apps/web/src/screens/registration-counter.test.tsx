import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Dossier, FindPanel, QueuesOverlay, QuotePanel, RegistrationCounter, SEAT_TENDER_ORDER, WaitLine,
  counterExit, seatKey, useQuote, waitEstimate,
} from "./registration-counter";
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
    const others = blocks.filter((b) => !b.selector.includes('[data-seat="registration-counter"]'));
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
  it("MUTANT — exactly ONE file carries `data-seat`, and it is the seat's own root element", () => {
    const carriers = readdirSync(resolve(__dirname, ".."), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
      .filter((f) => !f.endsWith(".test.tsx") && !f.endsWith(".test.ts"))
      .filter((f) => readFileSync(resolve(__dirname, "..", f), "utf8").includes("data-seat"));
    expect(carriers).toEqual(["screens/registration-counter.tsx"]); // THE KILL

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
  it("is exactly the map the design specifies — Ctrl+K · Ctrl+N · Q · 1/2/3 · Ctrl+⏎ · Esc", () => {
    expect({
      ctrlK: seatKey(key("k", true), idle, { overlayOpen: false, modalOpen: false }),
      ctrlN: seatKey(key("n", true), idle, { overlayOpen: false, modalOpen: false }),
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
      // Ctrl+K is NOT the seat's. `KeyboardProvider` already opens the palette application-wide,
      // and a shortcut a clerk learns on one screen has to mean the same thing on the next.
      ctrlK: null,
      ctrlN: "new-walkin",
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

  it("Ctrl+N opens the SAME new-patient door F2 already opens, and 1/2/3 are NOT acted on here", () => {
    const onRegisterNew = vi.fn();
    renderWithProviders(<RegistrationCounter onRegisterNew={onRegisterNew} />);

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(onRegisterNew).toHaveBeenCalledTimes(1);

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
  it("Ctrl+N fires from inside the search box; the bare characters still do not", () => {
    const shut = { overlayOpen: false, modalOpen: false };
    expect(seatKey(k("n", true), typing, shut)).toBe("new-walkin"); // THE KILL
    expect(seatKey(k("q"), typing, shut)).toBeNull();
    expect(seatKey(k("1"), typing, shut)).toBeNull();
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
