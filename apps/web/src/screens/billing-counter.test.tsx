import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { parseRupees } from "../components/money-input";
import { BillingCounter } from "./billing-counter";

/**
 * `useSearch({ strict: false })` is the one TanStack Router hook this screen calls (flag ⑧ — the
 * `/billing?encounterId=` deep link from the OPD desk). Everything else in the module stays REAL:
 * `PatientPicker` pulls in router hooks of its own, and a factory that dropped them would fail at
 * access time rather than tell us anything. (FD-7 T3: it used to reach them by importing the whole
 * registration SCREEN for one `<img>`; `PatientPhoto` now lives in `components/patient-photo.tsx`,
 * so that particular edge is gone — the mock stays because `useSearch` is still called here.)
 */
const searchState = vi.hoisted(() => ({ current: {} as { encounterId?: string } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useSearch: () => searchState.current,
}));

/**
 * ═══ THE PALETTE'S CONTEXT, SUPPLIED — the one clause of the digit guard no test could reach ═══
 *
 * `usePaletteOptional` returns `null` outside a `PaletteProvider` and this harness mounts none, so
 * `palette?.isOpen === true` in the lane-key guard was dead in every row of this file: deleting the
 * clause left the whole suite green while the behaviour it protects — an open palette owns the
 * keyboard, and its result rows are `<button>`s that `isTypingTarget` does not cover — is real.
 *
 * Mounting the REAL provider is not the answer: opening it mounts `CommandPalette`, which wants a
 * router, the search API and the ops mode. What the clause actually reads is the CONTEXT VALUE, so
 * that is what is supplied here. `null` by default — the production shape for a screen mounted
 * outside a provider — so every other test in this file runs exactly as it did.
 */
const paletteState = vi.hoisted(() => ({ current: null as { isOpen: boolean } | null }));
vi.mock("../components/command-palette", () => ({
  usePaletteOptional: () => paletteState.current,
}));

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init: RequestInit | undefined, callIndex: number) => Reply);

/**
 * `stubFetch` answers 200 to everything, so it cannot produce the 400/409 refusals half this
 * screen is about (the opd-admin / opd-display precedent for a direct stub).
 */
function mockRoutes(handlers: Record<string, Handler>): void {
  const counts: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      counts[key] = (counts[key] ?? 0) + 1;
      const reply = typeof handler === "function" ? handler(init, counts[key]! - 1) : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function fetchCalls(): { url: string; path: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return { url, path: url.split("?")[0]!, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodiesOf(method: string, path: string): Record<string, unknown>[] {
  return callsTo(method, path).map((c) => JSON.parse(c.body === "" ? "{}" : c.body) as Record<string, unknown>);
}

/** Every number anywhere in a posted body must be an integer — K38's property, structurally. */
function nonIntegerNumbers(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isInteger(value) ? [] : [`${path}=${String(value)}`];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonIntegerNumbers(v, `${path}[${String(i)}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => nonIntegerNumbers(v, `${path}.${k}`));
  }
  return [];
}

// ——— fixtures ————————————————————————————————————————————————————————————————————————————————

const SEARCH_HIT = {
  id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", phone: "9876500000", sex: "female",
  dob: "1990-04-02T00:00:00.000Z", isConfidential: false, hasPhoto: false,
};

function pricedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lineId: "fee", serviceId: "svc-consult", serviceName: "OPD consultation", category: "consultation",
    qty: 1, unitPaise: 50000, grossPaise: 50000, regulatedClamp: null,
    candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 50000,
    gst: { sacCode: "999312", rateBps: 1200, exempt: false, exemptReason: null, cgstPaise: 3000, sgstPaise: 3000 },
    netPaise: 56000,
    ...over,
  };
}

const FEE_TOTALS = {
  grossPaise: 50000, discountPaise: 0, taxableBasePaise: 50000,
  cgstPaise: 3000, sgstPaise: 3000,
  taxableTurnoverPaise: 50000, exemptTurnoverPaise: 0,
  taxSummary: [{ sacCode: "999312", rateBps: 1200, exempt: false, taxableBasePaise: 50000, cgstPaise: 3000, sgstPaise: 3000 }],
  rawTotalPaise: 56000, netPayablePaise: 56000, roundingPaise: 0,
};

const FEE_DRAFT = { tariffVersionId: "tv-1", intendedPayer: "self", lines: [pricedLine()], totals: FEE_TOTALS };
const QUOTE_NEW = { encounterId: "enc-1", visitType: "new", free: false, feeServiceId: "svc-consult", draft: FEE_DRAFT };
const QUOTE_REVISIT = { encounterId: "enc-2", visitType: "revisit", free: true, feeServiceId: null, draft: null };

/*
  The desk registered this visit to a panel. The server STILL PRICES IT AT FULL GROSS —
  `apps/core/src/modules/billing/benefits-payer.test.ts`: "full gross — the panel rate is the
  price" — so `intendedPayer` is a statement about WHO is billed and never about money arriving.
  `QUOTE_NEW` carries no top-level `intendedPayer` at all, which is why the PANEL branch had
  never once been rendered by this suite.
*/
const QUOTE_PANEL = { ...QUOTE_NEW, intendedPayer: "corporate" };

const SERVICES = {
  items: [
    { id: "svc-consult", code: "OPD-CONS", name: "OPD consultation", category: "consultation", regulated: false, active: true },
    { id: "svc-dressing", code: "PRC-DRESS", name: "Dressing", category: "procedure", regulated: false, active: true },
  ],
};

const DUES = {
  items: [
    {
      invoiceId: "inv-9", invoiceNo: "INV/26-27/000009", patientId: "p-1", uhid: "HMS0000001234",
      name: "Asha Devi", alias: null, restricted: false, serviceDay: "2026-08-14",
      issuedAt: "2026-08-14T05:00:00.000Z", netPayablePaise: 120000, outstandingPaise: 45000,
      creditExtended: true, seq: 9,
    },
  ],
};

const ISSUED = {
  invoiceId: "inv-1", invoiceNo: "INV/26-27/000042", totals: FEE_TOTALS,
  receiptId: "rcp-1", receiptNo: "RCP/26-27/000031",
  allocatedPaise: 56000, unallocatedPaise: 0, creditExtended: false,
  settlement: { state: "settled", outstandingPaise: 0 }, warnings: [],
};

const PRINT = {
  letterhead: { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR"] },
  invoice: {
    id: "inv-1", invoiceNo: "INV/26-27/000042", patientId: "p-1", encounterId: "enc-1",
    tariffVersionId: "tv-1", intendedPayer: "self", buyerGstin: null, buyerLegalName: null,
    grossPaise: 50000, discountPaise: 0, taxableBasePaise: 50000, cgstPaise: 3000, sgstPaise: 3000,
    rawTotalPaise: 56000, roundingPaise: 0, netPayablePaise: 56000,
    creditExtended: false, creditReason: null, creditApprovalId: null,
    issuedBy: "u-1", issuedAt: "2026-08-20T05:12:00.000Z", serviceDay: "2026-08-20", seq: 42,
  },
  lines: [
    {
      id: "il-1", invoiceId: "inv-1", lineNo: 1, serviceId: "svc-consult", serviceName: "OPD consultation",
      category: "consultation", qty: 1, unitPaise: 50000, grossPaise: 50000,
      regulatedClamp: null, candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 50000,
      sacCode: "999312", rateBps: 1200, exempt: false, exemptReason: null,
      cgstPaise: 3000, sgstPaise: 3000, netPaise: 56000,
    },
  ],
  patient: {
    requestedId: "p-1", id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", alias: null,
    restricted: false, sex: "female", dob: null,
  },
  settlement: { state: "settled", outstandingPaise: 0 },
  qrPayload: "bil1.invoice.inv-1.Zm9vYmFy",
};

async function pickPatient(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Search"), "98765");
  await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));
  /*
    "Asha Devi" is also the picker's own result row, so the selection is asserted on the counter's
    OWN rail rather than on the name alone.
    FD-25 — by TESTID now, not by the sentence "Selected patient: …". That sentence was a developer
    label the redesign removed: the rail's tag already says "Paying", so repeating "Selected
    patient:" beside the name was the screen explaining itself to nobody. A testid says the same
    thing to this test without pinning prose that a designer may legitimately change.
  */
  expect(await screen.findByTestId("paying-name")).toHaveTextContent("Asha Devi");
}

/**
 * FD-25 backlog 3 — THE SUBMIT BUTTON IS NOW A GATE, so every click on it waits for the gate.
 *
 * The counter no longer offers to issue against a price it has not got: while the debounced
 * preview is in flight (which it is, briefly, after EVERY edit to the encounter, the coupons or
 * the slip) `payablePaise` is null and the button is disabled and reads "Pricing…". A test that
 * clicked without waiting was racing a 250 ms timer, and this lane has already been bitten by
 * unasserted wall-clock margins. `toBeEnabled` also strengthens each refusal test: the request was
 * not sent even though the button was live.
 */
async function clickIssue(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => { expect(screen.getByTestId("submit-invoice")).toBeEnabled(); });
  await user.click(screen.getByTestId("submit-invoice"));
}

/** The two routes every write test needs before it can post anything. */
const BASE_ROUTES: Record<string, Handler> = {
  "GET /api/patients/search": { status: 200, body: { items: [SEARCH_HIT] } },
  "GET /api/billing/visits/enc-1/fee-quote": { status: 200, body: QUOTE_NEW },
  "POST /api/billing/invoices/preview": { status: 200, body: FEE_DRAFT },
  "GET /api/billing/patients/p-1/dues": { status: 200, body: { items: [] } },
};

describe("BillingCounter", () => {
  beforeEach(() => {
    searchState.current = {};
    paletteState.current = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("the visit context comes from GET /billing/visits/:encounterId/fee-quote — typed at the counter or deep-linked — and the branch badge shows the fee or FREE", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/billing/visits/enc-2/fee-quote": { status: 200, body: QUOTE_REVISIT },
    });
    const { unmount } = renderWithProviders(<BillingCounter />);

    // typed at the counter (fireEvent: the whole id at once, as a wedge-scanned or pasted id arrives)
    fireEvent.change(screen.getByLabelText("Encounter"), { target: { value: "enc-1" } });

    await waitFor(() => expect(callsTo("GET", "/api/billing/visits/enc-1/fee-quote")).toHaveLength(1));
    expect(await screen.findByTestId("fee-branch")).toHaveTextContent("New");
    expect(screen.getByTestId("fee-amount")).toHaveTextContent("₹560.00");
    // the quote's fee line is PRE-FILLED into the draft (step 3 item 2)
    expect(await screen.findByTestId("line-row-fee")).toHaveTextContent("OPD consultation");
    unmount();

    // deep-linked from the OPD desk — no typing at all, and a revisit is FREE (D8: the null fee
    // service is the free branch, not a missing mapping), so no fee line is seeded.
    searchState.current = { encounterId: "enc-2" };
    renderWithProviders(<BillingCounter />);

    await waitFor(() => expect(callsTo("GET", "/api/billing/visits/enc-2/fee-quote")).toHaveLength(1));
    expect(await screen.findByTestId("fee-branch")).toHaveTextContent("Revisit");
    expect(screen.getByTestId("fee-free")).toHaveTextContent("Free follow-up");
    expect(screen.queryByTestId("fee-amount")).toBeNull();
    expect(screen.queryByTestId("line-row-fee")).toBeNull();
  });

  it("the lines editor adds tariff services and manual discounts, and the SERVER-priced preview renders the totals, the contest outcome and the approval lane", async () => {
    searchState.current = { encounterId: "enc-1" };
    const twoLineDraft = {
      tariffVersionId: "tv-1",
      intendedPayer: "self",
      lines: [
        pricedLine(),
        pricedLine({
          lineId: "line-1", serviceId: "svc-dressing", serviceName: "Dressing", category: "procedure",
          qty: 1, unitPaise: 30000, grossPaise: 30000, discountPaise: 5000, taxableBasePaise: 25000,
          candidates: [
            { sourceKey: "manual", ruleKey: null, kind: "flat_paise", discountCategory: "charity", amountPaise: 5000, reason: "camp patient", requiresApproval: true, rejected: null },
          ],
          winner: { sourceKey: "manual", ruleKey: null, kind: "flat_paise", discountCategory: "charity", amountPaise: 5000, reason: "camp patient", requiresApproval: true, rejected: null },
          gst: { sacCode: "999316", rateBps: 1200, exempt: false, exemptReason: null, cgstPaise: 1500, sgstPaise: 1533 },
          netPaise: 28033,
        }),
      ],
      totals: {
        ...FEE_TOTALS,
        grossPaise: 80000, discountPaise: 5000, taxableBasePaise: 75000,
        cgstPaise: 4500, sgstPaise: 4533,
        rawTotalPaise: 84033, netPayablePaise: 84000, roundingPaise: -33,
      },
    };
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/tariff/services": { status: 200, body: SERVICES },
      "POST /api/billing/invoices/preview": (init) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { lines: unknown[] };
        return { status: 200, body: body.lines.length > 1 ? twoLineDraft : FEE_DRAFT };
      },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(bodiesOf("POST", "/api/billing/invoices/preview")[0]).toEqual({
      encounterId: "enc-1",
      lines: [{ lineId: "fee", serviceId: "svc-consult", qty: 1 }],
    }));

    // add a tariff service line from the catalogue search
    await user.type(screen.getByLabelText("Add service"), "dress");
    await user.click(await screen.findByTestId("add-service-svc-dressing"));
    expect(await screen.findByTestId("line-row-line-1")).toHaveTextContent("Dressing");

    // a manual discount on that line: category + value + reason, all three required to travel
    await user.click(screen.getByTestId("line-discount-line-1"));
    await user.selectOptions(screen.getByLabelText("Discount category"), "charity");
    await user.type(screen.getByLabelText("Discount value", { selector: "#discount-value-line-1" }), "50");
    await user.type(screen.getByLabelText("Discount reason"), "camp patient");

    await waitFor(() => {
      const bodies = bodiesOf("POST", "/api/billing/invoices/preview");
      expect(bodies[bodies.length - 1]).toEqual({
        encounterId: "enc-1",
        lines: [
          { lineId: "fee", serviceId: "svc-consult", qty: 1 },
          {
            lineId: "line-1", serviceId: "svc-dressing", qty: 1,
            manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 5000, reason: "camp patient" },
          },
        ],
      });
    });

    // the totals are the SERVER's, rendered verbatim — including the single §170 rounding line
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹840.00"));
    expect(screen.getByTestId("preview-gross")).toHaveTextContent("₹800.00");
    expect(screen.getByTestId("preview-discount")).toHaveTextContent("₹50.00");
    expect(screen.getByTestId("preview-tax")).toHaveTextContent("₹90.33");
    expect(screen.getByTestId("preview-rounding")).toHaveTextContent("-₹0.33");

    // the contest outcome, and the approval lane the `requiresApproval` candidate opens
    expect(screen.getByTestId("line-contest-line-1")).toHaveTextContent("camp patient · ₹50.00");
    expect(screen.getByTestId("line-contest-fee")).toHaveTextContent("No adjustment");
    const lane = screen.getByTestId("approval-required-line-1");
    expect(lane).toHaveTextContent("Approval required");
    expect(screen.getByLabelText("Approval id", { selector: "#discount-approval-line-1" })).toBeInTheDocument();
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-7 T6 — THE SCHEME RAIL FINALLY HAS A CASHIER
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * `couponCodes` and `attributionCode` have been on the issue body and the preview helper since
   * RC-2, and on the server since T2 — and NOTHING ON THIS SCREEN COULD SET EITHER. The whole
   * benefit engine underneath (memberships, coupon rules, entitlement counters, redemptions and
   * their reversal) was reachable only by a caller writing JSON by hand.
   *
   * THE KEY ASSERTION IS THAT BOTH TRAVEL ON THE PREVIEW *AND* THE INVOICE. RC-2's own review named
   * the failure mode: "a seat that quoted ₹450 would still have issued at ₹500". A coupon that
   * changes the preview and not the bill is worse than one that does nothing.
   */
  it("FD-7 T6: the coupon and the partner slip travel on the PREVIEW and on the INVOICE, in the same terms", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": { status: 200, body: FEE_DRAFT },
      "POST /api/billing/invoices": { status: 201, body: ISSUED },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();
    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    await user.type(screen.getByTestId("counter-coupons"), "DIWALI20, STAFF5");
    await user.type(screen.getByTestId("counter-referral"), "PTR-9911");
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");

    await waitFor(() => {
      const bodies = bodiesOf("POST", "/api/billing/invoices/preview");
      expect(bodies[bodies.length - 1]).toMatchObject({
        couponCodes: ["DIWALI20", "STAFF5"],   // split on the comma, trimmed, order kept
        attributionCode: "PTR-9911",
      });
    });

    await clickIssue(user);
    await waitFor(() => expect(bodiesOf("POST", "/api/billing/invoices")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/invoices")[0]).toMatchObject({
      couponCodes: ["DIWALI20", "STAFF5"],
      attributionCode: "PTR-9911",
    });
  });

  /** Empty fields must send NOTHING — an empty string is not a coupon, and `""` would be a lookup. */
  it("FD-7 T6: blank scheme fields send no keys at all", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({ ...BASE_ROUTES, "POST /api/billing/invoices/preview": { status: 200, body: FEE_DRAFT } });
    renderWithProviders(<BillingCounter />);
    await screen.findByTestId("line-row-fee");

    await waitFor(() => expect(bodiesOf("POST", "/api/billing/invoices/preview").length).toBeGreaterThan(0));
    const body = bodiesOf("POST", "/api/billing/invoices/preview")[0]!;
    expect(body).not.toHaveProperty("couponCodes");
    expect(body).not.toHaveProperty("attributionCode");
  });

  /**
   * ═══ R3's TWO LANES READ DIFFERENTLY, ON PURPOSE ═══
   *
   * "consult 3 of 8" and "₹4,200 of ₹10,000 left" are different promises to make to a patient, and
   * the owner ruled that a package may be either. The screen could answer neither: `balances` is a
   * new, deliberately narrow projection — key, title, unit, granted, remaining, and no card code.
   */
  it("FD-7 T6: a count package reads as visits and a value package reads as money", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": {
        status: 200,
        body: {
          ...FEE_DRAFT,
          balances: [
            { benefitKey: "consults", title: "Consultations", unit: "count", grantedQty: 8, remainingQty: 3 },
            { benefitKey: "wallet", title: "Health wallet", unit: "paise", grantedQty: 1_000_000, remainingQty: 420_000 },
          ],
        },
      },
    });
    renderWithProviders(<BillingCounter />);
    await screen.findByTestId("line-row-fee");

    const visits = await screen.findByTestId("balance-left-consults");
    expect(visits.textContent).toBe("3 of 8 left");                 // whole visits, no rupee sign
    const wallet = screen.getByTestId("balance-left-wallet");
    expect(wallet.textContent).toContain("4,200");                  // THE KILL — money, not "420000"
    expect(wallet.textContent).toContain("10,000");
    expect(wallet.textContent).not.toBe(visits.textContent);
  });

  /**
   * ═══ FD-7 T9 / R4 — THE SLIP THE DESK CAPTURED IS PRE-FILLED HERE ═══
   *
   * The quote now falls back to `opd_encounters.attribution_code`, so without the pre-fill the
   * cashier would see a price a stored slip had already discounted, in a screen whose slip field was
   * blank — and issuing from that blank field would send NO code and produce a DIFFERENT invoice.
   * That is the RC-2 quote/invoice disagreement arriving from the opposite direction.
   */
  it("FD-7 T9: the slip captured at the desk pre-fills, and travels on the invoice unedited", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/billing/visits/enc-1/fee-quote": { status: 200, body: { ...QUOTE_NEW, attributionCode: "PTR-FROM-DESK" } },
      "POST /api/billing/invoices/preview": { status: 200, body: FEE_DRAFT },
      "POST /api/billing/invoices": { status: 201, body: ISSUED },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();
    await pickPatient(user);
    await screen.findByTestId("line-row-fee");

    await waitFor(() => expect((screen.getByTestId("counter-referral") as HTMLInputElement).value).toBe("PTR-FROM-DESK"));
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");
    await clickIssue(user);

    await waitFor(() => expect(bodiesOf("POST", "/api/billing/invoices")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/invoices")[0]).toMatchObject({ attributionCode: "PTR-FROM-DESK" });
  });

  /**
   * R4 keeps it EDITABLE, and clearing must mean "no slip" rather than "unchanged". This is the case
   * the pre-fill exists to make possible: with a blank field the cashier could not tell whether a
   * stored code was about to be applied, so removing one was not something they could do at all.
   */
  it("FD-7 T9: the cashier can CLEAR the pre-filled slip, and the invoice then carries none", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/billing/visits/enc-1/fee-quote": { status: 200, body: { ...QUOTE_NEW, attributionCode: "PTR-WRONG-SLIP" } },
      "POST /api/billing/invoices/preview": { status: 200, body: FEE_DRAFT },
      "POST /api/billing/invoices": { status: 201, body: ISSUED },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();
    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect((screen.getByTestId("counter-referral") as HTMLInputElement).value).toBe("PTR-WRONG-SLIP"));

    await user.clear(screen.getByTestId("counter-referral"));
    await waitFor(() => expect((screen.getByTestId("counter-referral") as HTMLInputElement).value).toBe(""));

    /*
      THE CLEARED SLIP RE-PRICES, and the write must wait for that preview rather than race its
      250 ms debounce: once the request for the cleared body has been SENT the debounce has already
      fired, so nothing further is pending and `clickIssue`'s gate is deterministic. It is also the
      assertion this test was missing — the clearing travels on the PREVIEW as well as the invoice.
    */
    await waitFor(() =>
      expect(bodiesOf("POST", "/api/billing/invoices/preview").at(-1)).not.toHaveProperty("attributionCode"),
    );

    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");
    await clickIssue(user);
    await waitFor(() => expect(bodiesOf("POST", "/api/billing/invoices")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/invoices")[0]).not.toHaveProperty("attributionCode"); // THE KILL
  });

  /** The key is load-bearing: a DIFFERENT encounter re-seeds, or the next patient inherits the last one's slip. */
  it("FD-7 T9: switching to another visit re-seeds the slip from that visit's own quote", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/billing/visits/enc-1/fee-quote": { status: 200, body: { ...QUOTE_NEW, attributionCode: "PTR-FIRST" } },
      "GET /api/billing/visits/enc-2/fee-quote": { status: 200, body: { ...QUOTE_NEW, encounterId: "enc-2", attributionCode: "PTR-SECOND" } },
      "POST /api/billing/invoices/preview": { status: 200, body: FEE_DRAFT },
    });
    renderWithProviders(<BillingCounter />);
    await waitFor(() => expect((screen.getByTestId("counter-referral") as HTMLInputElement).value).toBe("PTR-FIRST"));

    fireEvent.change(screen.getByLabelText("Encounter"), { target: { value: "enc-2" } });

    // THE KILL for a seed keyed on anything but the encounter — the second patient would keep the first's slip.
    await waitFor(() => expect((screen.getByTestId("counter-referral") as HTMLInputElement).value).toBe("PTR-SECOND"));
  });

  /** No package, no panel — an empty dashed box beside a bill is furniture, not information. */
  it("FD-7 T6: a patient with no package gets no balances panel", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({ ...BASE_ROUTES, "POST /api/billing/invoices/preview": { status: 200, body: { ...FEE_DRAFT, balances: [] } } });
    renderWithProviders(<BillingCounter />);
    await screen.findByTestId("line-row-fee");
    expect(screen.queryByTestId("counter-balances")).toBeNull();
  });

  it("K39: the dues sidebar polls on refetchInterval 15_000 — a SECOND GET arrives after 15 s of fake time", async () => {
    vi.useFakeTimers();
    mockRoutes({
      "POST /api/patients/qr/verify": {
        status: 200,
        body: { ok: true, patient: { id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null } },
      },
      "GET /api/billing/patients/p-1/dues": { status: 200, body: DUES },
    });

    // waitFor cannot drive vitest's fake clock (it gates on a global `jest`) — hand-flush instead.
    const flush = async (ms = 5): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    renderWithProviders(<BillingCounter />);
    await flush();

    // `userEvent` needs real timers, so the patient is picked through the picker's scan lane, which
    // `fireEvent` drives cleanly (the opd-display precedent).
    fireEvent.paste(screen.getByLabelText("Scan QR"), {
      clipboardData: { getData: () => "GOOD-QR" } as unknown as DataTransfer,
    });
    await flush();
    await flush();

    expect(callsTo("GET", "/api/billing/patients/p-1/dues")).toHaveLength(1);
    expect(screen.getByTestId("dues-row-inv-9")).toHaveTextContent("₹450.00");

    // NEGATIVE CONTROL: well inside the window, nothing refetches — so the second GET below is the
    // interval firing and not a re-render, a remount or a query invalidation.
    await flush(14_000);
    expect(callsTo("GET", "/api/billing/patients/p-1/dues")).toHaveLength(1);

    await flush(1_500);
    await flush();
    expect(callsTo("GET", "/api/billing/patients/p-1/dues").length).toBeGreaterThan(1);
  });

  it("K38: the invoice POST carries INTEGER PAISE throughout, and a 400 pan_required reveals the PAN / Form 60 fields for the retry", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices": (init, callIndex) => {
        if (callIndex === 0) {
          return {
            status: 400,
            body: {
              statusCode: 400, code: "pan_required",
              message: "cash episode 5600000p exceeds the PAN threshold 5000000p — PAN or Form 60 is required",
              detail: { episodeCashPaise: 5600000, thresholdPaise: 5000000 },
            },
          };
        }
        return { status: 201, body: ISSUED };
      },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");
    await clickIssue(user);

    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(1));
    const first = bodiesOf("POST", "/api/billing/invoices")[0]!;
    const { draftId, ...rest } = first as { draftId: string };
    expect(typeof draftId).toBe("string");
    expect(draftId).not.toBe("");
    expect(rest).toEqual({
      patientId: "p-1",
      encounterId: "enc-1",
      lines: [{ lineId: "fee", serviceId: "svc-consult", qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 56000 }] },
    });
    // asserted from the POSTED BODY, not from rendered text: no float anywhere in it (W-2's kill).
    expect(nonIntegerNumbers(first)).toEqual([]);
    expect(JSON.stringify(first)).toContain('"amountPaise":56000');

    // the refusal renders inline, in the OPD-shaped body's own words, and OPENS the two fields
    // §139A needs — the counter asks for what the server said was missing, nothing more.
    expect(await screen.findByTestId("counter-error")).toHaveTextContent("PAN or Form 60 is required");
    expect(screen.getByTestId("counter-error-code")).toHaveTextContent("pan_required");

    await user.type(screen.getByLabelText("PAN"), "ABCDE1234F");
    await clickIssue(user);

    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(2));
    const second = bodiesOf("POST", "/api/billing/invoices")[1]!;
    expect(second.receipt).toEqual({ tenders: [{ mode: "cash", amountPaise: 56000 }], panNumber: "ABCDE1234F" });
    expect(nonIntegerNumbers(second)).toEqual([]);
  });

  it("a 409 cash_threshold_blocked renders inline with the server's own numbers, and offers no way around itself", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices": {
        status: 409,
        body: {
          statusCode: 409, code: "cash_threshold_blocked",
          message: "cash episode 20000000p reaches the block threshold 20000000p",
          detail: { episodeCashPaise: 20000000, thresholdPaise: 20000000 },
        },
      },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    // the SERVER's figure has to be in hand before a write is offered at all (FD-25 backlog 3)
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");
    await clickIssue(user);

    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(1));
    expect(await screen.findByTestId("counter-error")).toHaveTextContent(
      "cash episode 20000000p reaches the block threshold 20000000p",
    );
    expect(screen.getByTestId("counter-error-code")).toHaveTextContent("cash_threshold_blocked");
    // §269ST is a refusal, not a prompt: nothing on the screen offers to retry it away, and the
    // PAN lane — which IS a prompt — must NOT open for it.
    expect(screen.queryByLabelText("PAN")).toBeNull();
    expect(screen.queryByTestId("credit-approval-wait")).toBeNull();
  });

  it("the credit lane: the remainder is shown, the reason is mandatory BEFORE any request, and credit_approval_required opens the approval-id lane", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices": (init, callIndex) => {
        if (callIndex === 0) {
          return {
            status: 409,
            body: {
              statusCode: 409, code: "credit_approval_required",
              message: "36000p exceeds the per-invoice credit cap 20000p",
              detail: { remainderPaise: 36000, creditCapPaise: 20000 },
            },
          };
        }
        return { status: 201, body: { ...ISSUED, allocatedPaise: 20000, creditExtended: true, settlement: { state: "partial", outstandingPaise: 36000 } } };
      },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "200");
    expect(await screen.findByTestId("credit-remainder")).toHaveTextContent("₹360.00");

    // D2 step 3 / owner ruling 2: unsettled without a reason is refused BEFORE the request. The
    // button is not disabled, so "no request was sent" has exactly one cause.
    await clickIssue(user);
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(0);
    expect(screen.getByTestId("counter-error")).toHaveTextContent("A reason is required to extend credit");

    await user.type(screen.getByLabelText("Credit reason"), "camp patient, dues cleared Friday");
    await clickIssue(user);

    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/invoices")[0]!.credit).toEqual({ reason: "camp patient, dues cleared Friday" });

    // above the cap the server asks for a granted approval; the screen opens the lane for its id
    // (the server's body carries the CAP, never an approval id — the cashier brings that from the
    // approvals inbox) and the retry posts it.
    expect(await screen.findByTestId("credit-approval-wait")).toBeInTheDocument();
    expect(screen.getByTestId("counter-error")).toHaveTextContent("exceeds the per-invoice credit cap");

    await user.type(screen.getByLabelText("Approval id", { selector: "#counter-credit-approval" }), "ap-7");
    await clickIssue(user);

    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(2));
    expect(bodiesOf("POST", "/api/billing/invoices")[1]!.credit).toEqual({
      reason: "camp patient, dues cleared Friday",
      approvalId: "ap-7",
    });
  });

  it("on success the printed invoice REPLACES the counter, window.print() is available, and an over-tender renders the change-due banner", async () => {
    searchState.current = { encounterId: "enc-1" };
    const printSpy = vi.fn();
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices": { status: 201, body: { ...ISSUED, allocatedPaise: 56000, unallocatedPaise: 4000 } },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    const { container } = renderWithProviders(<BillingCounter />);
    vi.stubGlobal("print", printSpy);
    const user = userEvent.setup();

    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "600");
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Over by ₹40.00");
    await clickIssue(user);

    await waitFor(() => expect(callsTo("GET", "/api/billing/invoices/inv-1/print")).toHaveLength(1));

    expect(await screen.findByTestId("issued-invoice-no")).toHaveTextContent("INV/26-27/000042");
    // D2 step 5: the surplus is change due / a banked advance, never a refusal.
    expect(screen.getByTestId("unallocated-banner")).toHaveTextContent("₹40.00");

    const doc = await waitFor(() => {
      const found = container.querySelector(".print-doc");
      expect(found).not.toBeNull();
      return found;
    });
    expect(doc).not.toBeNull();
    // exactly one printable document is mounted: the counter view is GONE, not hidden beside it
    expect(container.querySelectorAll(".print-doc")).toHaveLength(1);
    expect(screen.queryByTestId("submit-invoice")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Print invoice" }));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-25 BACKLOG 3 — THE SCREEN MAY NOT STATE A MONEY FACT IT HAS NOT GOT

     Two independent defects, one sentence: `/billing` derived "nothing to collect" from
     `intendedPayer` (a registration INTENT) and rendered a FAILED preview as a ₹0 bill. Neither
     had a single test in the tree — `QUOTE_NEW` has no top-level `intendedPayer`, so the PANEL
     branch was never rendered, and `billing-counter.tsx` read no query error state at all.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("FD-25 backlog 3: a FAILED preview is STATED, never a ₹0 bill — the counter refuses to issue at a price nobody has", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": {
        status: 503,
        body: { statusCode: 503, code: "tariff_unavailable", message: "pricing is unavailable" },
      },
    });
    renderWithProviders(<BillingCounter />);

    // the fee line still seeds from the quote, so this is a real draft with a real line on it
    await screen.findByTestId("line-row-fee");

    // the failure is stated where the missing figure was, in the server's own code
    const banner = await screen.findByTestId("preview-error");
    expect(banner).toHaveTextContent("price could not be fetched");
    expect(banner).toHaveTextContent("tariff_unavailable");

    // and nothing on the screen offers to issue at a figure nobody has
    const submit = screen.getByTestId("submit-invoice");
    expect(submit).toHaveTextContent("Price unavailable");
    expect(submit).toBeDisabled();
    expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(0);

    /*
      FD-25 CLOSE REVIEW — THE REST OF THE RAIL, which this test asserted nothing about. Every
      `payablePaise === null` branch added for backlog 3 except the submit button was load-bearing
      prose: a refactor that dropped the null half of the lanes' `disabled` (leaving `=== 0`) left
      the whole file green, and re-opened the case the fix was written for.
    */
    expect(screen.getByTestId("lane-cash")).toBeDisabled();
    expect(screen.getByTestId("lane-cash")).toHaveTextContent("—");
    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹0.00");

    /*
      AND THE TENDER FOOTER, which is the one place `null` was still spent as a ₹0. Twelve lines
      under a red "the price could not be fetched" the cashier read "Payable: ₹0.00" beside a GREEN
      "Exact" pill — the settled verdict — on a bill nobody has priced.
    */
    expect(screen.getByTestId("tender-payable")).toHaveTextContent("—");
    expect(screen.queryByTestId("tender-state")).toBeNull();
  });

  it("FD-25 backlog 3: a PANEL bill is UNPAID and says WHAT IS STILL PAYABLE — the payer intent never overwrites the priced net", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/billing/visits/enc-1/fee-quote": { status: 200, body: QUOTE_PANEL },
    });
    renderWithProviders(<BillingCounter />);

    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    // TWO AXES, TWO MARKS. The payer fact rides BESIDE the money fact instead of erasing it —
    // and `stamp pd` is the PAID class, which this screen used to paint on an unpaid bill.
    const stamp = screen.getByTestId("token-stamp");
    expect(stamp).toHaveTextContent("UNPAID");
    expect(stamp).toHaveClass("stamp", "un");
    expect(screen.getByTestId("payer-stamp")).toHaveTextContent("PANEL");

    // THE AMOUNT, never an intermediate field: the panel card states the rupees the server priced.
    expect(screen.getByTestId("panel-still-payable")).toHaveTextContent("₹560.00");
    expect(screen.getByTestId("panel-card")).not.toHaveTextContent("nothing to collect");
  });

  /**
   * COMPANION, NOT A REVERT PAIR — and it is labelled as one. It passes against the unfixed code
   * on everything it asserts, and exists so the fix cannot be "delete the green line": the claim
   * is NARROWED to the priced figure, not removed.
   */
  it("FD-25 backlog 3 (companion): a panel bill the server prices at ZERO still reads 'nothing to collect'", async () => {
    searchState.current = { encounterId: "enc-1" };
    const zeroTotals = {
      ...FEE_TOTALS,
      grossPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
      taxableTurnoverPaise: 0, taxSummary: [], rawTotalPaise: 0, netPayablePaise: 0,
    };
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/billing/visits/enc-1/fee-quote": { status: 200, body: QUOTE_PANEL },
      "POST /api/billing/invoices/preview": {
        status: 200,
        body: { ...FEE_DRAFT, intendedPayer: "corporate", totals: zeroTotals },
      },
    });
    renderWithProviders(<BillingCounter />);

    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹0.00"));
    expect(screen.getByTestId("panel-card")).toHaveTextContent("nothing to collect");
    expect(screen.queryByTestId("panel-still-payable")).toBeNull();
    expect(screen.getByTestId("submit-invoice")).toHaveTextContent("Issue — nothing to collect");
  });

  /**
   * THE BRANCH THE NARROWING COULD HAVE SILENTLY DELETED. A FREE panel revisit seeds no fee line
   * (`quote.free` returns early), so the preview query never runs and `totals` is null FOREVER —
   * a gate written only on the priced figure would print nothing at all about collection on the
   * one visit where "nothing to collect" is unarguably true. `quote.free` is the server's own
   * nothing-to-collect fact and the gate reads it too.
   */
  it("FD-25 backlog 3: a FREE panel visit keeps 'nothing to collect' and is stamped ₹0, not UNPAID", async () => {
    searchState.current = { encounterId: "enc-2" };
    mockRoutes({
      ...BASE_ROUTES,
      "GET /api/billing/visits/enc-2/fee-quote": {
        status: 200,
        body: { ...QUOTE_REVISIT, intendedPayer: "corporate" },
      },
    });
    renderWithProviders(<BillingCounter />);

    await screen.findByTestId("fee-free");
    expect(screen.getByTestId("panel-card")).toHaveTextContent("nothing to collect");
    expect(screen.queryByTestId("panel-still-payable")).toBeNull();
    // the money stamp is not UNPAID on a visit the server has ruled costs nothing
    expect(screen.getByTestId("token-stamp")).toHaveTextContent("₹0.00");
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-25 BACKLOG 2 — THE DRAWER IS COUNTED ON THE POSTED TENDER

     `expectedCashPaise` at close is `openingFloat + Σ cash tenders − Σ cash vouchers`
     (`sessions.ts`), so the number this screen posts IS the number the cashier is held to. The
     lane armed the full payable into row state and the amount box showed nothing, so a ₹300
     payment could leave as ₹560 with no figure on screen to contradict it.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("FD-25 backlog 2: the counter posts exactly the amount its AMOUNT FIELD shows — ₹560 is never recorded against a ₹300 drawer", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices": { status: 201, body: ISSUED },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    // REAL timers throughout: `takeLane`'s `nonce: Date.now()` is frozen under fake ones, and a
    // frozen nonce is swallowed by `TenderEditor`'s `lastLane` guard.
    const user = userEvent.setup();
    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    const amount = (): HTMLInputElement =>
      screen.getByLabelText("Amount", { selector: "#tender-amount-0" }) as HTMLInputElement;

    // the cashier types what the patient actually handed over, THEN presses the lane to record
    // HOW the money came — which is what the screen's own hint ("1 cash, 2 UPI, 3 card") trains
    await user.type(amount(), "300");
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹300.00");

    await user.click(screen.getByTestId("lane-cash"));

    // read the box BEFORE issuing: the printed receipt REPLACES this screen, field and all
    const shown = parseRupees(amount().value);
    expect(amount()).toHaveValue("560.00");

    await clickIssue(user);
    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(1));
    const body = bodiesOf("POST", "/api/billing/invoices")[0]!;
    const posted = (body.receipt as { tenders: { mode: string; amountPaise: number }[] }).tenders;

    // THE AMOUNT, both ways. The posted body is IDENTICAL fixed and unfixed — 56000 either way —
    // so this equality against what the box showed is the only assertion here that can tell them
    // apart, and it is the one the drawer count depends on.
    expect(shown).toEqual({ ok: true, paise: posted[0]!.amountPaise });
    expect(posted).toEqual([{ mode: "cash", amountPaise: 56000 }]);
    expect(nonIntegerNumbers(body)).toEqual([]);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-25 BACKLOG 6 — A KEYCAP THAT LIES IS WORSE THAN NONE

     `/billing` drew `1` `2` `3` as `.kb` keycaps on its three lane buttons and printed "the keys
     are the lanes — 1 cash, 2 UPI, 3 card" in English AND Hindi, and bound nothing: it was the one
     screen missing from the census of window keydown listeners. Desk One answers the same trio at
     its own bill stage, so a cashier moving between the two seats learned the key works on one
     screen and is broken on the other. `shortcut-legend.test.ts` cannot see this class — it reads
     the `shortcuts.*` namespace only — which is why a green suite missed it.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  const LANES = [
    { digit: "1", testId: "lane-cash", mode: "cash" },
    { digit: "2", testId: "lane-upi", mode: "upi" },
    { digit: "3", testId: "lane-card", mode: "card" },
  ] as const;
  const modeNow = (): string =>
    (screen.getByLabelText("Mode", { selector: "#tender-mode-0" }) as HTMLSelectElement).value;

  /**
   * ONE `it` PER LANE, not one loop over three mounts: each iteration awaits a 250 ms debounced
   * preview and this suite has a shared 5 s per-test budget it has been close to before.
   *
   * HONESTLY HALF-BLIND ON LANE 1 — cash IS the editor's default mode, so that iteration cannot
   * tell a bound key from a dead one. The test below it, which reads the SUM, is what covers `1`.
   */
  it.each(LANES)(
    "FD-25 backlog 6: the bare digit a lane DRAWS is the digit that seats it — $digit → $mode",
    async (lane) => {
      searchState.current = { encounterId: "enc-1" };
      mockRoutes(BASE_ROUTES);
      renderWithProviders(<BillingCounter />);
      await screen.findByTestId("line-row-fee");
      await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

      // the keycap this button DRAWS is the promise the key has to keep — asserted in the SAME
      // iteration as the behaviour, so re-ordering EITHER the caps or the bindings goes red
      expect(screen.getByTestId(lane.testId).querySelector(".kb")?.textContent).toBe(lane.digit);

      fireEvent.keyDown(window, { key: lane.digit });

      await waitFor(() => { expect(modeNow()).toBe(lane.mode); });
    },
  );

  /** Cash needs no reference, so the seeded row is a COMPLETE tender and the arithmetic is visible. */
  it("FD-25 backlog 6: `1` seats the EXACT payable, not an empty cash row", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes(BASE_ROUTES);
    renderWithProviders(<BillingCounter />);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹0.00");

    fireEvent.keyDown(window, { key: "1" });

    await waitFor(() => expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹560.00"));
    expect(screen.getByTestId("tender-state")).toHaveTextContent("Exact");
    // and the seeded figure is IN the box, per backlog 2 — the two fixes meet here
    expect(screen.getByLabelText("Amount", { selector: "#tender-amount-0" })).toHaveValue("560.00");
  });

  it("FD-25 backlog 6: a digit is a VALUE inside a field or a select, and Ctrl+3 belongs to the browser", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes(BASE_ROUTES);
    renderWithProviders(<BillingCounter />);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    // (a) a `3` typed INTO a field is a value. The event still reaches window; the guard stops it.
    fireEvent.keyDown(screen.getByLabelText("Encounter"), { key: "3" });
    expect(modeNow()).toBe("cash");

    // (b) and a digit on the tender MODE select is the browser's option type-ahead. A lane seed
    //     REPLACES the whole row array, so a stray digit there would destroy a mixed tender under
    //     construction — ₹200 cash + ₹360 UPI with its reference typed, gone.
    fireEvent.keyDown(screen.getByLabelText("Mode", { selector: "#tender-mode-0" }), { key: "3" });
    expect(modeNow()).toBe("cash");

    // (c) Ctrl+3 switches browser tabs — `browserSafeKey`'s rule, honoured on this seat too
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(modeNow()).toBe("cash");

    /*
      (d) THE CONTROL, and the only line above that can go red if the binding is reverted.
      (a), (b) and (c) are ABSENCE assertions: they pass against code that binds nothing at all.
      Without this line the whole test is green on the unfixed screen and proves nothing. Each of
      (a)/(b)/(c) is instead proved by a MUTANT that deletes its clause from the guard.
    */
    fireEvent.keyDown(window, { key: "3" });
    await waitFor(() => { expect(modeNow()).toBe("card"); });
  });

  /**
   * THE KEY IS NEVER STRONGER THAN ITS BUTTON. On a bill the server prices at ₹0 there is nothing
   * to arm, the three lane buttons are dark — and `takeLane` would happily seed a ₹0 row, so this
   * is the guard's own case rather than one another guard already covers.
   */
  it("FD-25 backlog 6: no key seats a lane its own button refuses — a ₹0 bill has nothing to arm", async () => {
    searchState.current = { encounterId: "enc-1" };
    const zeroTotals = {
      ...FEE_TOTALS,
      grossPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
      taxableTurnoverPaise: 0, taxSummary: [], rawTotalPaise: 0, netPayablePaise: 0,
    };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": { status: 200, body: { ...FEE_DRAFT, totals: zeroTotals } },
    });
    renderWithProviders(<BillingCounter />);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹0.00"));

    expect(screen.getByTestId("lane-upi")).toBeDisabled();
    fireEvent.keyDown(window, { key: "2" });
    expect(modeNow()).toBe("cash");
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹0.00");
  });
  /* ══════════════════════════════════════════════════════════════════════════════════════════
     FD-25 CLOSE REVIEW — THE PAYABLE IS UNKNOWN UNLESS THE PREVIEW BOTH SUCCEEDED AND IS CURRENT

     Backlog 3 made the counter refuse to issue against a price it has not got, and closed exactly
     one of the three ways it can not have one: the FIRST fetch failing. Two were left open, and
     both put a live "Issue" button under a red alert:

       · a failed REFETCH — TanStack Query keeps `data` for a key when a background fetch of that
         key fails (query-core's reducer: "flag existing data as invalidated if we get a background
         error"), so `isError === true` and `data !== undefined` coexist, and the screen read them
         as two independent facts;
       · a preview that succeeded for a draft the cashier has since EDITED — `previewKey` is
         debounced by 250 ms while the request body is built from the LIVE inputs.

     Both are now one definition — `priced`, the current successful draft or nothing — so the
     figure, the lanes, the tender footer, the surplus banner and the write agree or none of them
     speaks.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("FD-25 close review: a failed REFETCH takes the figure with it — a stale ₹560 is never left under the red alert", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": (_init, callIndex) =>
        (callIndex === 0
          ? { status: 200, body: FEE_DRAFT }
          : { status: 503, body: { statusCode: 503, code: "tariff_unavailable", message: "pricing is unavailable" } }),
      "POST /api/billing/invoices": { status: 201, body: ISSUED },
    });
    renderWithProviders(<BillingCounter />);

    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    /*
      The cashier alt-tabs to the queue screen and comes back — or the desk's wifi drops and
      reconnects. React Query refetches the SAME preview key on focus (`refetchOnWindowFocus` is
      left at its default), and the pricing route is down. `visibilitychange` on window is the
      event `focusManager` actually listens to.
    */
    fireEvent(window, new Event("visibilitychange"));

    await screen.findByTestId("preview-error");

    // THE KILL: the ₹560 goes with the fetch that failed. Unfixed, it is still rendered in 22px
    // bold immediately above the alert telling the cashier not to say anything is due.
    await waitFor(() => { expect(screen.queryByTestId("preview-net")).toBeNull(); });

    const submit = screen.getByTestId("submit-invoice");
    expect(submit).toHaveTextContent("Price unavailable");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);                       // the only button on the screen, pressed
    expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(0);

    // and the rest of the rail agrees rather than staying armed at the stale figure
    expect(screen.getByTestId("lane-cash")).toBeDisabled();
    fireEvent.keyDown(window, { key: "1" });
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹0.00");
    expect(screen.getByTestId("tender-payable")).toHaveTextContent("—");
  });

  /**
   * "Price unavailable — RETRY before issuing" is what the button says, and there was no control
   * on the screen that retries: the preview query is `retry: false` and polls nothing, so the only
   * way out was to edit the bill. A promise in the copy with no control behind it is the
   * keycap-that-lies rule wearing prose.
   */
  it("FD-25 close review: the price-failure box carries the RETRY its own copy promises", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": (_init, callIndex) =>
        (callIndex === 0
          ? { status: 503, body: { statusCode: 503, code: "tariff_unavailable", message: "pricing is unavailable" } }
          : { status: 200, body: FEE_DRAFT }),
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await screen.findByTestId("line-row-fee");
    await screen.findByTestId("preview-error");
    expect(screen.getByTestId("submit-invoice")).toBeDisabled();

    await user.click(screen.getByTestId("preview-retry"));

    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));
    expect(screen.queryByTestId("preview-error")).toBeNull();
    expect(screen.getByTestId("submit-invoice")).toBeEnabled();
  });

  /**
   * ═══ THE QUOTED DRAFT AND THE POSTED DRAFT ARE ONE DRAFT ═══
   *
   * Every money figure on this screen comes from the DEBOUNCED preview; the request body is built
   * from the LIVE inputs. Inside the 250 ms trailing window they are two different bills, and the
   * button was enabled across it reading the old one's amount. A coupon typed and issued inside
   * that window posts `couponCodes` the screen never priced: the server prices ₹448, the cashier
   * has taken the ₹560 the lane armed, and the ₹112 is banked as an advance the pre-write surplus
   * banner never warned about — because it compared the tender against the STALE payable.
   */
  it("FD-25 close review: the invoice is priced on the draft the cashier is looking at — a coupon typed inside the debounce disarms the write", async () => {
    searchState.current = { encounterId: "enc-1" };
    const couponTotals = {
      ...FEE_TOTALS,
      grossPaise: 50000, discountPaise: 10000, taxableBasePaise: 40000,
      cgstPaise: 2400, sgstPaise: 2400, rawTotalPaise: 44800, netPayablePaise: 44800,
    };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": (init) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { couponCodes?: string[] };
        return body.couponCodes === undefined
          ? { status: 200, body: FEE_DRAFT }
          : { status: 200, body: { ...FEE_DRAFT, totals: couponTotals } };
      },
      "POST /api/billing/invoices": { status: 201, body: ISSUED },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    // ₹560 quoted, ₹560 armed in the cash lane, ₹560 in the cashier's hand
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹560.00"));

    /*
      The patient now produces a coupon. `fireEvent.change` is SYNCHRONOUS — no await runs between
      it and the assertions below, so the 250 ms trailing timer provably has not fired and this is
      the debounce window itself rather than a race against it.
    */
    fireEvent.change(screen.getByTestId("counter-coupons"), { target: { value: "DIWALI20" } });

    // THE KILL: unfixed, the button still reads "Take ₹560.00" and is live over a draft that is
    // no longer the one that was priced.
    const submit = screen.getByTestId("submit-invoice");
    expect(submit).toHaveTextContent("Pricing…");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(0);

    // once the SAME draft is priced, the screen states the ₹112 the cashier is still holding —
    // BEFORE the write, which is the whole point of the pre-write banner
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹448.00"));
    expect(screen.getByTestId("surplus-banner")).toHaveTextContent("₹112.00");

    await clickIssue(user);
    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(1));

    // and the terms the invoice is priced on are the terms the preview was priced on, field for field
    const quoted = bodiesOf("POST", "/api/billing/invoices/preview").at(-1)!;
    const posted = bodiesOf("POST", "/api/billing/invoices")[0]!;
    expect(posted.couponCodes).toEqual(quoted.couponCodes);
    expect(posted.lines).toEqual(quoted.lines);
    expect(posted.encounterId).toEqual(quoted.encounterId);
  });

  /**
   * ═══ A BARE DIGIT MAY NOT DESTROY WHAT THE CASHIER HAS ENTERED ═══
   *
   * A lane seed REPLACES the whole row array, and the guard excluded only INPUT / TEXTAREA /
   * SELECT / contentEditable. Chromium focuses a `<button>` when it is clicked, so the instant
   * after "Add tender" — the button you must press to build a mixed tender at all — focus sits on
   * an element the guard does not cover and every bare digit is live. The event's target is not
   * what saves it here: neither `window` (this test) nor a `<button>` (the browser) is a typing
   * target, so the two are the same case.
   */
  it("FD-25 close review: a bare digit never collapses a mixed tender under construction", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes(BASE_ROUTES);
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    // ₹200 in cash, and the second row opened for the ₹360 on UPI
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "200");
    const add = screen.getByRole("button", { name: "Add tender" });
    await user.click(add);
    expect(document.activeElement).toBe(add);           // the precondition, stated rather than assumed
    expect(screen.getByTestId("tender-row-1")).toBeInTheDocument();

    // following the hint printed above the lanes — "2 UPI" — she presses 2 for the new row's mode
    fireEvent.keyDown(window, { key: "2" });

    // THE KILL: unfixed, both rows are replaced by ONE UPI row for the full ₹560, the ₹200 of cash
    // is gone from the receipt and `expectedCashPaise` at close is ₹200 short of the notes in hand.
    expect(screen.getByTestId("tender-row-1")).toBeInTheDocument();
    // the AMOUNT, format-independently: the box still holds the ₹200 that was actually handed over
    // (`MoneyInput` keeps the typed text as typed, so "200" and "200.00" are the same money)
    const box = screen.getByLabelText("Amount", { selector: "#tender-amount-0" }) as HTMLInputElement;
    expect(parseRupees(box.value)).toEqual({ ok: true, paise: 20000 });
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹200.00");
    expect(modeNow()).toBe("cash");
  });

  /**
   * The digit stays a FAST PATH for an empty editor — refusing it once there is something to
   * destroy must not turn the three keycaps into decoration. This is the control for the test
   * above, and it is also why the guard reads "has the cashier entered anything" rather than
   * "is a lane already armed": a lane press is the editor's own doing and may be corrected by
   * another lane press.
   */
  it("FD-25 close review: the lane digits stay live over an untouched editor, and over a row a lane itself seeded", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes(BASE_ROUTES);
    renderWithProviders(<BillingCounter />);

    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹560.00"));

    // pressed 1 by mistake, corrects to UPI: the row the lane seeded is not the cashier's work
    fireEvent.keyDown(window, { key: "2" });
    await waitFor(() => { expect(modeNow()).toBe("upi"); });
  });

  /**
   * The keydown effect is declared ABOVE the `issued !== null` early return, so hooks mount it for
   * the receipt screen too — while the doc comment on it claimed the opposite ("this screen is
   * REPLACED by the printed receipt, so no lane key can survive the write") as the reason no extra
   * guard was needed. A stray digit while the slip prints re-arms a lane for a bill that is already
   * written and drops a line into the log dated after it, which then rides into the next patient's
   * dock — the log is not cleared by "Next bill".
   */
  it("FD-25 close review: no lane key survives the write — the receipt screen claims no digit", async () => {
    searchState.current = { encounterId: "enc-1" };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices": { status: 201, body: ISSUED },
      "GET /api/billing/invoices/inv-1/print": { status: 200, body: PRINT },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await pickPatient(user);
    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    // typed, not laned: the log is EMPTY at the write, so any lane line found afterwards is this
    // keypress and nothing else
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");
    await clickIssue(user);
    await screen.findByTestId("issued-invoice-no");

    // hands back on the keyboard while the slip prints
    fireEvent.keyDown(window, { key: "1" });

    await user.click(screen.getByRole("button", { name: "Next bill" }));
    expect(screen.getByTestId("agent-ticker")).not.toHaveTextContent("lane ·");
  });

  /**
   * A panel bill the server prices at ₹0 is the one case where an over-tender is PURE cashier
   * error, and it was the one case with no warning: the banner was gated on `payablePaise > 0`.
   * The lanes are dark at ₹0 but the amount box is hand-editable, `toWire` emits any positive
   * amount, and the server banks it as `unallocatedPaise` — announced only AFTER the write, on a
   * screen the cashier is already past.
   */
  it("FD-25 close review: an over-tender on a ₹0 bill warns BEFORE the write", async () => {
    searchState.current = { encounterId: "enc-1" };
    const zeroTotals = {
      ...FEE_TOTALS,
      grossPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
      taxableTurnoverPaise: 0, taxSummary: [], rawTotalPaise: 0, netPayablePaise: 0,
    };
    mockRoutes({
      ...BASE_ROUTES,
      "POST /api/billing/invoices/preview": { status: 200, body: { ...FEE_DRAFT, totals: zeroTotals } },
    });
    renderWithProviders(<BillingCounter />);
    const user = userEvent.setup();

    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹0.00"));

    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");

    expect(screen.getByTestId("surplus-banner")).toHaveTextContent("₹560.00");
  });

  /**
   * The palette clause of the digit guard, exercised at last — see `paletteState` at the top of
   * this file for why the context is supplied rather than the provider mounted. The palette's
   * result rows are `<button>`/`<li>` elements, so `isTypingTarget` does not cover them: arrowing
   * down the list and typing a `3` to filter would seat a card lane behind the open overlay and
   * destroy a mixed tender with nothing on screen naming what happened.
   */
  it("FD-25 close review: an open command palette owns the keyboard — the lane digits are not live behind it", async () => {
    searchState.current = { encounterId: "enc-1" };
    paletteState.current = { isOpen: true };
    mockRoutes(BASE_ROUTES);
    renderWithProviders(<BillingCounter />);

    await screen.findByTestId("line-row-fee");
    await waitFor(() => expect(screen.getByTestId("preview-net")).toHaveTextContent("₹560.00"));

    fireEvent.keyDown(window, { key: "3" });
    expect(modeNow()).toBe("cash");
    expect(screen.getByTestId("tender-sum")).toHaveTextContent("₹0.00");

    /*
      THE CONTROL, and it is what makes the leg above mean anything: an absence assertion passes
      against a screen that binds no digit at all. The palette closes and the SAME key is live.
      The credit-reason box is typed into only to force the re-render that lets the screen read the
      new context — it is not part of the previewed draft, so the payable does not move.
    */
    paletteState.current = null;
    fireEvent.change(document.querySelector("#counter-credit-reason")!, { target: { value: "x" } });

    fireEvent.keyDown(window, { key: "3" });
    await waitFor(() => { expect(modeNow()).toBe("card"); });
  });

});
