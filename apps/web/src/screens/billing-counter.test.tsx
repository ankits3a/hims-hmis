import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
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
  // "Asha Devi" is also the picker's own result row, so the selection is asserted on the
  // counter's OWN panel line rather than on the name alone.
  expect(await screen.findByText(/Selected patient: Asha Devi/)).toBeInTheDocument();
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

    await user.click(screen.getByTestId("submit-invoice"));
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
    await user.click(screen.getByTestId("submit-invoice"));

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
    await user.click(screen.getByTestId("submit-invoice"));

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
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "560");
    await user.click(screen.getByTestId("submit-invoice"));

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
    await user.click(screen.getByTestId("submit-invoice"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(0);
    expect(screen.getByTestId("counter-error")).toHaveTextContent("A reason is required to extend credit");

    await user.type(screen.getByLabelText("Credit reason"), "camp patient, dues cleared Friday");
    await user.click(screen.getByTestId("submit-invoice"));

    await waitFor(() => expect(callsTo("POST", "/api/billing/invoices")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/invoices")[0]!.credit).toEqual({ reason: "camp patient, dues cleared Friday" });

    // above the cap the server asks for a granted approval; the screen opens the lane for its id
    // (the server's body carries the CAP, never an approval id — the cashier brings that from the
    // approvals inbox) and the retry posts it.
    expect(await screen.findByTestId("credit-approval-wait")).toBeInTheDocument();
    expect(screen.getByTestId("counter-error")).toHaveTextContent("exceeds the per-invoice credit cap");

    await user.type(screen.getByLabelText("Approval id", { selector: "#counter-credit-approval" }), "ap-7");
    await user.click(screen.getByTestId("submit-invoice"));

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
    await user.click(screen.getByTestId("submit-invoice"));

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
});
