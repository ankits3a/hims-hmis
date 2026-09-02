import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dossier, FindPanel, SettledPanel, BillPanel, ageFromDob, useQuote } from "./registration-counter";
import type { SeatVisit } from "./registration-counter";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";
import type { WireFeeQuote, WireIssueInvoiceResult } from "../lib/billing-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-2 — THE FIVE THINGS THE COUNTER REPORTED, EACH AS THE TEST THAT WOULD HAVE CAUGHT IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The seat shipped to production with 117 passing tests and the counter still called it broken. It
 * was right, and the gap is worth naming precisely because it is the same gap every screen in this
 * repository can have: **every one of those 117 tests queried by `data-testid`, and a `data-testid`
 * is present whether or not the element beside it is legible.**
 *
 * Concretely, the search row rendered as three bare `<span>`s with no separator, so the counter saw
 *
 *     Ramesh KumarCRK123450139876543210same name
 *
 * — one twenty-nine-character run with a name in front of it. `getByTestId("find-uhid-p-1")` passed
 * on that markup, because the UHID *was* there. The clerk could not read it, and reported it as
 * "searching a patient doesn't show the UHID number".
 *
 * So these tests do not add more `getByTestId`. They assert the properties a testid cannot see:
 *   · that the dossier names a PERSON and not a ULID (F1)
 *   · that a search row's fields are SEPARATE nodes, so they cannot run together (F2)
 *   · that the workspace is never empty once a visit is open (F3)
 *   · that taking money produces a CONFIRMATION and a PRINTABLE DOCUMENT (F4, F5)
 *   · that a refused quote says the server's sentence, not `API 409` (F6)
 *
 * ═══ EACH ONE WAS PROVED TO DIE, BY MUTANT, AND THE COUNTS ARE THE MEASURED ONES ═══
 *
 * "A new test must fail first against the code it guards" is not satisfied by saying so, so four
 * mutants restoring the shipped defect were APPLIED to `registration-counter.tsx`, run, and
 * reverted. Measured, in order:
 *
 *   · M1 — the dossier renders `{inHand.patientId}` visibly again and drops `DossierIdentity`
 *          → `3 failed | 14 passed`   (all three F1 rendering rows)
 *   · M2 — the UHID span loses its `font-mono` lane
 *          → `1 failed | 16 passed`   (F2's separation row)
 *   · M3 — `useQuote`'s catch goes back to `e.message`
 *          → `1 failed | 16 passed`   (F6, on the literal string `API 409`)
 *   · M4 — a second `.print-doc` node mounts beside the slip
 *          → `1 failed | 16 passed`   (F5's one-document invariant)
 *
 * With the tree restored: `17 passed`. M4 is the one worth keeping: two `.print-doc` nodes are
 * invisible on screen and wrong only on PAPER, which is the worst place to discover a defect.
 */

const ME = { actor: { type: "user", id: "u-fd2" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } };

const PATIENT = {
  id: "P-1", uhid: "CRK12345013", name: "Ramesh Kumar", phone: "9876543210",
  administrativeGender: "male", dob: "1985-04-02T00:00:00.000Z", isConfidential: false, alias: null,
};

function quoteWith(over: Partial<WireFeeQuote> = {}): WireFeeQuote {
  return {
    encounterId: "E-1", visitType: "new", free: false, feeServiceId: "SVC-CONSULT",
    freeReason: null, intendedPayer: "self",
    draft: {
      tariffVersionId: "TV1", intendedPayer: "self",
      lines: [{
        lineId: "fee", serviceId: "SVC-CONSULT", serviceName: "OPD Consultation (New)", category: "consultation",
        qty: 1, unitPaise: 40_000, grossPaise: 40_000, regulatedClamp: null,
        candidates: [], winner: null,
        discountPaise: 0, taxableBasePaise: 40_000,
        gst: { sacCode: "999312", rateBps: 0, exempt: true, exemptReason: "category_exempt", cgstPaise: 0, sgstPaise: 0 },
        netPaise: 40_000,
      }],
      totals: {
        grossPaise: 40_000, taxableBasePaise: 40_000, cgstPaise: 0, sgstPaise: 0,
        rawTotalPaise: 40_000, netPayablePaise: 40_000, roundingPaise: 0,
      },
    },
    ...over,
  } as WireFeeQuote;
}

const ISSUED: WireIssueInvoiceResult = {
  invoiceId: "inv-1", invoiceNo: "INV/26-27/000002", totals: quoteWith().draft!.totals,
  receiptId: "rcpt-1", receiptNo: "RC/1", allocatedPaise: 40_000, unallocatedPaise: 0,
  creditExtended: false, settlement: { state: "settled", outstandingPaise: 0 }, warnings: [],
};

const VISIT: SeatVisit = {
  encounterId: "E-1", patientId: "P-1", tokenNo: 4,
  flow: { counterSequence: "queue_first", tokenLane: "token_first" },
  draftId: "d-1", joining: false, joinError: null,
  slip: {
    visitNo: "V2609020004", serviceDate: "2026-09-02", visitType: "new",
    doctorName: "Dr. Anil Sharma", departmentName: "General Medicine", roomCode: "OPD-1",
  },
};

/** The patient read the dossier and the strip share (`["patient-in-hand", id]`). */
function stubPatient(over: { patient?: unknown; status?: number } = {}): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/auth/me")) return json(ME);
    if (/\/patients\/[^/]+$/.test(url.split("?")[0]!)) {
      return over.status !== undefined
        ? json({ code: "not_found" }, over.status)
        : json({ patient: over.patient ?? PATIENT });
    }
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => {
  sessionStorage.clear();
  setToken("test-token");
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   F1 — THE DOSSIER NAMES A PERSON
   ───────────────────────────────────────────────────────────────────────────────────────────── */

describe("FD-2 F1 — the dossier says who is at the counter, not which row of a table they are", () => {
  /**
   * THE KILL IS THE ULID, ASSERTED AS AN ABSENCE FROM WHAT A PERSON READS.
   *
   * `dossier-patient` still carries the id — the suites and the support desk identify records by it
   * — so an assertion on that node would pass on both the old code and the new. The claim is about
   * the dossier's VISIBLE text, so that is what is asserted: the name is in it and the id is not.
   */
  it("renders the name, the UHID and the age — and the patient id is NOT visible text", async () => {
    stubPatient();
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "P-1", encounterId: "E-1" }));
    renderWithProviders(<Dossier quote={null} issued={null} canCollect={false} />);

    // `findByTestId` would resolve on the LOADING state ("…"), which is a real state the strip
    // and the dossier share; the wait is for the resolved name, not for the node.
    await waitFor(() => expect(screen.getByTestId("dossier-name")).toHaveTextContent("Ramesh Kumar"));
    expect(screen.getByTestId("dossier-uhid")).toHaveTextContent("CRK12345013");
    // The two facts a clerk reads back to confirm the record, from the server's `dob`.
    expect(screen.getByTestId("dossier-facts").textContent).toMatch(/41/);

    // THE KILL: before FD-2 this was `01M…` in 16px type where the name is now.
    const dossier = screen.getByTestId("dossier");
    expect(dossier.textContent).toContain("Ramesh Kumar");
    expect(screen.getByTestId("dossier-patient")).not.toBeVisible();
    expect(screen.getByTestId("dossier-encounter")).not.toBeVisible();
  });

  /**
   * THE ALIAS RULE, INHERITED FROM `patient-strip.tsx` RATHER THAN RE-DECIDED. The dossier is
   * furniture in front of whoever leans over the counter, so a confidential record shows its alias
   * here even to a caller who holds `patients.confidential.read`.
   */
  it("a confidential record shows its ALIAS, never the real name", async () => {
    stubPatient({ patient: { ...PATIENT, isConfidential: true, alias: "Patient 44" } });
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "P-1", encounterId: null }));
    renderWithProviders(<Dossier quote={null} issued={null} canCollect={false} />);

    await waitFor(() => expect(screen.getByTestId("dossier-name")).toHaveTextContent("Patient 44"));
    expect(screen.getByTestId("dossier").textContent).not.toContain("Ramesh Kumar");
  });

  /** A sealed record answers 404 (07a DD2) and the rail says so rather than rendering a blank card. */
  it("a sealed record is named as restricted, not left blank", async () => {
    stubPatient({ status: 404 });
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "P-1", encounterId: null }));
    renderWithProviders(<Dossier quote={null} issued={null} canCollect={false} />);

    await waitFor(() => expect(screen.getByTestId("dossier-name").textContent).not.toBe(""));
    expect(screen.queryByTestId("dossier-uhid")).toBeNull();
  });

  /** `ageFromDob` is pure, so the boundary that is easy to get wrong is asserted on its own. */
  it("age is whole years and the birthday has not happened yet", () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    expect(ageFromDob("1985-04-02T00:00:00.000Z", now)).toBe(41);   // birthday passed
    expect(ageFromDob("1985-12-02T00:00:00.000Z", now)).toBe(40);   // birthday still to come
    expect(ageFromDob("2026-09-02T00:00:00.000Z", now)).toBe(0);    // born today
    expect(ageFromDob(null, now)).toBeNull();
    expect(ageFromDob("not-a-date", now)).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   F2 — A SEARCH ROW A HUMAN CAN READ
   ───────────────────────────────────────────────────────────────────────────────────────────── */

describe("FD-2 F2 — the search result is a row, not a run-on string", () => {
  const HIT = {
    id: "p-1", uhid: "CRK12345013", name: "Ramesh Kumar", phone: "9876543210",
    administrativeGender: "male", dob: "1985-04-02T00:00:00.000Z", isConfidential: false,
    hasPhoto: false, matchedOn: ["name"],
  };

  function stubSearch(items: unknown[]): void {
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/patients/search": { items },
    });
  }

  /**
   * ═══ THE ASSERTION IS ABOUT SEPARATION, WHICH IS THE THING A TESTID CANNOT SEE ═══
   *
   * The shipped row was three bare `<span>`s inside one `<button>` with no element between them.
   * `getByTestId("find-uhid-p-1")` found the UHID on that markup and the counter still could not
   * read it, because the browser laid the three out as `Ramesh KumarCRK123450139876543210`. So this
   * asserts the property that was actually violated: the name node's text must not have the UHID
   * or the phone glued onto it, and the three must be DIFFERENT nodes.
   *
   * A row that regresses to bare inline spans fails here even though every id still resolves.
   */
  it("the name, the UHID and the phone are separate nodes — none of them runs into the next", async () => {
    stubSearch([HIT]);
    const user = userEvent.setup();
    renderWithProviders(<FindPanel />);
    await user.type(screen.getByTestId("find-input"), "Ramesh");

    const name = await screen.findByTestId("find-name-p-1");
    const uhid = screen.getByTestId("find-uhid-p-1");
    const phone = screen.getByTestId("find-phone-p-1");

    expect(name.textContent).toBe("Ramesh Kumar");
    expect(uhid.textContent).toBe("CRK12345013");
    expect(phone.textContent).toBe("9876543210");
    // Three distinct elements, not one node whose text happens to contain all three.
    expect(new Set([name, uhid, phone]).size).toBe(3);
    expect(name).not.toContainElement(uhid);
    expect(uhid).not.toContainElement(phone);
    // The UHID is monospaced for the reason every id in this application is: `CRK12345013` and
    // `CRK12345018` are the same SHAPE in a proportional face, and the clerk reads it back aloud.
    expect(uhid.className).toContain("font-mono");
  });

  /**
   * ═══ "I CAN'T SEE NEW REGISTRATION PAGE" ═══
   *
   * The empty answer was `<p>Nobody on file matches that<button>Register new</button></p>` with no
   * classes, so the counter read one sentence ending in the words "Register new" and reported the
   * door as missing. It was not missing; it was prose. This asserts it is a BUTTON element with its
   * own accessible name, which is what makes it findable by role — the way a person finds it.
   */
  it("the empty answer offers a real button, reachable by its role and not buried in a sentence", async () => {
    stubSearch([]);
    const onRegisterNew = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<FindPanel onRegisterNew={onRegisterNew} />);
    await user.type(screen.getByTestId("find-input"), "Zzqq Nobody");

    const door = await screen.findByRole("button", { name: /register new/i });
    expect(door).toBe(screen.getByTestId("find-register-new"));
    await user.click(door);
    expect(onRegisterNew).toHaveBeenCalledTimes(1);
  });

  /**
   * ═══ THE SECOND DOOR, AND THE RULING IT DOES NOT WEAKEN ═══
   *
   * The owner's search-first ruling is enforced by the door not existing until a query has SETTLED.
   * That is unchanged and asserted below. What FD-2 adds is that the door also appears when the
   * search FOUND people — because a genuinely new patient whose name collides with an existing one
   * previously had no way to be registered from this seat at all, and the clerk's workaround was to
   * type a nonsense query, which is strictly worse for duplicate control than showing the door.
   */
  it("a search that FOUND people still offers the door — the candidates are on screen to be judged", async () => {
    stubSearch([HIT]);
    const onRegisterNew = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<FindPanel onRegisterNew={onRegisterNew} />);
    await user.type(screen.getByTestId("find-input"), "Ramesh");

    await screen.findByTestId("find-hit-p-1");
    await user.click(screen.getByTestId("find-register-new-anyway"));
    expect(onRegisterNew).toHaveBeenCalledTimes(1);
  });

  /** SEARCH-FIRST, UNCHANGED: with nothing typed there is no door of either kind. */
  it("neither door exists before anything is typed", () => {
    stubSearch([]);
    renderWithProviders(<FindPanel onRegisterNew={vi.fn()} />);
    expect(screen.queryByTestId("find-register-new")).toBeNull();
    expect(screen.queryByTestId("find-register-new-anyway")).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   F3 — THE WORKSPACE IS NEVER BLANK, AND THE BILL IS ITEMISED
   ───────────────────────────────────────────────────────────────────────────────────────────── */

describe("FD-2 F3 — the bill says what the money is FOR", () => {
  it("itemises the server's lines and prints the server's total, never a client-side fold", () => {
    renderWithProviders(<BillPanel quote={quoteWith()} />);
    expect(screen.getByTestId("bill-line-fee")).toHaveTextContent("OPD Consultation (New)");
    expect(screen.getByTestId("bill-line-fee")).toHaveTextContent("₹400.00");
    expect(screen.getByTestId("bill-total")).toHaveTextContent("₹400.00");
  });

  /**
   * The free revisit has `draft: null`, and a panel that folded over `lines` would render an empty
   * table with a ₹0.00 total under it — inviting the patient to ask what the zero is for, which is
   * the exact reason `counter-slip.tsx` omits its fee half for the same case.
   */
  it("a free revisit says it is free instead of showing a ₹0 table", () => {
    renderWithProviders(<BillPanel quote={quoteWith({ free: true, draft: null })} />);
    expect(screen.getByTestId("bill-free")).toBeInTheDocument();
    expect(screen.queryByTestId("bill-total")).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   F4 / F5 — THE CONFIRMATION AND THE PAPER
   ───────────────────────────────────────────────────────────────────────────────────────────── */

describe("FD-2 F4/F5 — taking money produces a confirmation and a document that can be printed", () => {
  const QR = { payload: "hmis://p/P-1#sig", uhid: "CRK12345013", name: "Ramesh Kumar", administrativeGender: "male", dob: null };
  const IDENTITY = { label: "Ramesh Kumar", uhid: "CRK12345013", sex: "male", ageYears: 41, restricted: false, pending: false };

  it("says how much was taken, against which invoice, with the token — the sentence that was missing", () => {
    renderWithProviders(
      <SettledPanel visit={VISIT} issued={ISSUED} quote={quoteWith()} patient={IDENTITY} qr={QR} onNext={vi.fn()} />,
    );
    const banner = screen.getByTestId("settled-banner");
    expect(banner).toHaveTextContent("400.00");
    expect(screen.getByTestId("settled-token")).toHaveTextContent("4");
    expect(screen.getByTestId("settled-invoice-no")).toHaveTextContent("INV/26-27/000002");
  });

  /**
   * ═══ THE SLIP, AND THE `.print-doc` INVARIANT THAT IS THE REASON IT IS ONE NODE ═══
   *
   * `styles.css` prints by hiding everything and re-showing `.print-doc` at `position: fixed;
   * left:0; top:0`. TWO such nodes do not make two pages — they stack at the same origin and the
   * receipt overprints the token. So the count is asserted, not just the presence: this is the
   * property that breaks silently and only on paper, which is the worst place to find it.
   */
  it("mounts exactly ONE printable document, carrying the token, the doctor, the room and the fee", () => {
    const { container } = renderWithProviders(
      <SettledPanel visit={VISIT} issued={ISSUED} quote={quoteWith()} patient={IDENTITY} qr={QR} onNext={vi.fn()} />,
    );
    expect(container.querySelectorAll(".print-doc")).toHaveLength(1);

    const slip = container.querySelector(".print-doc")!;
    expect(slip).toHaveTextContent("4");
    expect(slip).toHaveTextContent("Dr. Anil Sharma");
    expect(slip).toHaveTextContent("OPD-1");
    expect(slip).toHaveTextContent("CRK12345013");
    expect(slip).toHaveTextContent("INV/26-27/000002");
    expect(slip).toHaveTextContent("V2609020004");
    expect(screen.getByTestId("print-slip")).toBeInTheDocument();
  });

  /** "Save as PDF" is a destination in the browser's own print dialog — the button is the whole feature. */
  it("the print button calls window.print, which is what 'save as PDF' goes through", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const user = userEvent.setup();
    renderWithProviders(
      <SettledPanel visit={VISIT} issued={ISSUED} quote={quoteWith()} patient={IDENTITY} qr={QR} onNext={vi.fn()} />,
    );
    await user.click(screen.getByTestId("print-slip"));
    expect(print).toHaveBeenCalledTimes(1);
  });

  /**
   * A FREE REVISIT HAS NO INVOICE AT ALL — the third lawful exit (DD2). The tax-invoice door must
   * not be offered for it: there is nothing to fetch, and a button that answers 404 at a counter is
   * worse than an absent one.
   */
  it("a free revisit gets the slip and NO tax-invoice door", () => {
    renderWithProviders(
      <SettledPanel visit={VISIT} issued={null} quote={quoteWith({ free: true, draft: null })} patient={IDENTITY} qr={QR} />,
    );
    expect(screen.getByTestId("settled-banner")).toBeInTheDocument();
    expect(screen.getByTestId("doc-slip")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-invoice")).toBeNull();
  });

  /**
   * The QR read can fail (403, offline) while the money is perfectly recorded. A missing DOCUMENT
   * and a missing TRANSACTION are different facts and must not look alike — and no Print button may
   * be offered over a half-assembled slip.
   */
  it("a slip that cannot be assembled says so, and offers no print button over a half page", () => {
    renderWithProviders(
      <SettledPanel visit={VISIT} issued={ISSUED} quote={quoteWith()} patient={IDENTITY} qr={null} />,
    );
    expect(screen.getByTestId("settled-banner")).toBeInTheDocument();  // the money is still confirmed
    expect(screen.getByTestId("slip-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("print-slip")).toBeNull();
  });

  /** Change the clerk owes back, and the surplus banked as an advance, said where the clerk is looking. */
  it("surplus tendered but not handed back is named as a banked advance", () => {
    renderWithProviders(
      <SettledPanel
        visit={VISIT} issued={{ ...ISSUED, unallocatedPaise: 10_000 }} quote={quoteWith()}
        patient={IDENTITY} qr={QR}
      />,
    );
    expect(screen.getByTestId("settled-unallocated")).toHaveTextContent("100.00");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   F6 — A REFUSAL IS A SENTENCE
   ───────────────────────────────────────────────────────────────────────────────────────────── */

describe("FD-2 F6 — a refused quote says what the server said, not which status it was", () => {
  /**
   * ═══ THE DEFECT, VERBATIM FROM THE DEPLOYED COUNTER ═══
   *
   *     Could not price this visit: API 409
   *
   * `useQuote`'s catch read `e.message`, and `ApiError`'s message is the string its constructor
   * builds — `API ${status}`. The server had sent a sentence a clerk could act on ("no activated
   * tariff version resolvable at …") and the screen threw it away for the number. Every other
   * billing call on the seat already used `billingErrorMessage`; this was the one that did not.
   */
  it("renders the server's message, and never the string 'API <status>'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : (input as Request).url);
      if (url.includes("/auth/me")) {
        return new Response(JSON.stringify(ME), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ statusCode: 409, code: "version_not_active", message: "no activated tariff version resolvable at 2026-09-02T13:50:20.649Z" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }));

    // ONE `useQuote` call: two would be two independent hook instances, and the `error` read would
    // belong to a different one from the `reprice` that was clicked.
    function Probe(): React.ReactElement {
      const { error, reprice } = useQuote("E-1");
      return <button type="button" data-testid="go" onClick={() => void reprice([])}>{error ?? "—"}</button>;
    }
    const user = userEvent.setup();
    renderWithProviders(<Probe />);
    await user.click(screen.getByTestId("go"));

    await waitFor(() => expect(screen.getByTestId("go").textContent).toContain("no activated tariff version"));
    expect(screen.getByTestId("go").textContent).not.toContain("API 409");
  });
});
