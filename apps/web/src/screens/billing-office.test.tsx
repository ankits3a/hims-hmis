import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../test-utils";
import { todayIst } from "../lib/opd-api";
import { BillingOffice } from "./billing-office";

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init: RequestInit | undefined, callIndex: number) => Reply);

/**
 * `stubFetch` answers 200 to everything, so it cannot produce the 400 the pay lane is half about
 * or the 403 the permission case IS. The billing-counter / billing-dues / billing-session
 * precedent for a direct stub is used instead.
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
    return {
      url,
      path: url.split("?")[0]!,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodiesOf(method: string, path: string): unknown[] {
  return callsTo(method, path).map((c) => JSON.parse(c.body === "" ? "null" : c.body) as unknown);
}

// ——— the clock ————————————————————————————————————————————————————————————————————————————————

/**
 * THE CLOCK IS FROZEN, NOT INJECTED (the §3.41 dated-suite tripwire).
 *
 * This screen derives "today" itself — the day book's day field defaults to `todayIst()` — so a
 * suite that did not pin the clock would be green only on the day it was authored. `vi.setSystemTime`
 * in `beforeEach` pins `Date` for the whole file WITHOUT fake timers (Plan 07 §9: `setSystemTime`
 * alone mocks `Date`; `useFakeTimers` is only needed to drive timers, and this file drives none),
 * so every test runs on real timers and can use `userEvent.setup()`.
 *
 * There is no helper chain for the pinned value to fall out of: the screen calls the SAME
 * `todayIst()` this file imports, and the assertions below check the request URL against both that
 * call and the literal '2026-08-20'.
 *
 * The instant is chosen so the UTC calendar date and the IST calendar date DISAGREE — 19:30Z on
 * the 19th is 01:00 IST on the 20th. A screen that derived the day from `toISOString()` instead of
 * `todayIst()` would ask for '2026-08-19' and the default-day test would fail on it.
 */
const NOW_ISO = "2026-08-19T19:30:00.000Z"; // 2026-08-20 01:00 IST
const TODAY_IST = "2026-08-20";

// ——— refund fixtures ——————————————————————————————————————————————————————————————————————————

/**
 * THE WORKLIST ROW carries `payeeIdRef` HERE ON PURPOSE, even though `GET /billing/refunds` stopped
 * sending it in `30a272d`. The absence assertion is only worth something if the fixture carries the
 * field that would have made it appear (AGENT-RULES §2.6): a screen that spread the raw row would
 * render 'XXXX-1234-5678' and the assertion below would fail. The server-side projection is the
 * real fix; this screen's own projection is the second belt, and the fixture proves the belt exists.
 */
const FLAGGED_VOUCHER = {
  id: "rv-1",
  voucherNo: "RV/26-27/000004",
  patientId: "p-1",
  kind: "advance_refund",
  creditNoteId: null,
  invoiceId: null,
  amountPaise: 250_000, // ₹2,500.00
  method: "cash",
  payeeName: "Ramesh Kumar",
  payeeIdType: "aadhaar",
  payeeIdRef: "XXXX-1234-5678", // never sent by the route, never rendered by the screen
  reasonClass: "genuine",
  reason: "patient discharged, advance unused",
  guardFlags: ["terminal_encounter", "delivered_line"],
  approvalId: "apr-11",
  status: "issued",
  requestedBy: "u-1",
  issuedAt: "2026-08-19T20:05:00.000Z",
  paidBy: null,
  paidAt: null,
  cashierSessionId: null,
  // UX-AUDIT 2026-09-28 — the alias-safe summary the route now batches server-side.
  uhid: "HMS-00000001-7",
  name: "Sunil Sharma",
  alias: null,
  restricted: false,
};

const PAID_VOUCHER = {
  ...FLAGGED_VOUCHER,
  id: "rv-2",
  voucherNo: "RV/26-27/000003",
  patientId: "p-2",
  kind: "invoice_refund",
  creditNoteId: "cn-9",
  invoiceId: "inv-9",
  amountPaise: 84_000, // ₹840.00
  method: "bank_transfer",
  guardFlags: [],
  approvalId: "apr-10",
  status: "paid",
  paidBy: "u-2",
  paidAt: "2026-08-19T14:00:00.000Z",
  // A SEALED record: the server sends the alias and no name, and the row must render the alias.
  uhid: "HMS-00000002-5",
  name: null,
  alias: "Patient S-9",
  restricted: true,
};

const VOUCHERS = { items: [FLAGGED_VOUCHER, PAID_VOUCHER] };

// ——— picker + receipt fixtures (UX-AUDIT 2026-09-28) ————————————————————————————————————————————

const SEARCH_HIT = {
  id: "p-1", uhid: "HMS-00000001-7", name: "Sunil Sharma", phone: "9876500001",
  administrativeGender: "male", dob: "1980-02-02", isConfidential: false, hasPhoto: false,
};

/** Two receipts for the patient; the filter must narrow by the PRINTED number, the body must carry the id. */
const PATIENT_RECEIPTS = {
  items: [
    { id: "rcp-7", receiptNo: "RCP/26-27/000071", receivedAt: "2026-08-19T10:00:00.000Z", totalPaise: 50_000, patientId: "p-1", panCaptured: false },
    { id: "rcp-8", receiptNo: "RCP/26-27/000088", receivedAt: "2026-08-19T11:00:00.000Z", totalPaise: 20_000, patientId: "p-1", panCaptured: false },
  ],
};

async function pickPatient(user: ReturnType<typeof userEvent.setup>, within_: HTMLElement): Promise<void> {
  await user.type(within(within_).getByLabelText("Search"), "Sunil");
  await user.click(await within(within_).findByRole("button", { name: /Sunil Sharma/ }));
}

// ——— recon fixtures ———————————————————————————————————————————————————————————————————————————

const CSV = "ref,settledPaise,settledOn\nUPI-77,49250,2026-08-19\nUPI-99,10000,2026-08-19";

const UPLOAD_RESULT = {
  batchId: "rb-1",
  rowsTotal: 3,
  rowsMatched: 1,
  rowsMismatched: 1,
  rowsUnmatched: 1,
  unmatchedRefs: ["UPI-404"],
};

const MISMATCHES = {
  items: [
    {
      tenderId: "tn-1",
      receiptId: "rcp-1",
      receiptNo: "RCP/26-27/000012",
      patientId: "p-3",
      uhid: "UH-3",
      name: "Sunita Devi",
      alias: null,
      restricted: false,
      mode: "card",
      amountPaise: 50_000, // ₹500.00
      expectedNetPaise: 49_250, // ₹492.50 — the card fee stamped at capture
      settledPaise: 48_000, // ₹480.00 — what the statement actually paid
      mismatchNote: "settled 48000p vs expected 49250p (tolerance 100p)",
      reconciledAt: null,
    },
  ],
};

// ——— day-book fixtures ————————————————————————————————————————————————————————————————————————

/**
 * K46 — THE FIXTURE IS DELIBERATELY INCONSISTENT, AND THAT IS THE WHOLE POINT OF THE ROW.
 *
 * `receipts.totalPaise` is ₹12,500.00 while the three mode figures add to ₹12,000.00. **Do not
 * "fix" this.** A consistent fixture renders identically whether the screen prints the API's own
 * total or folds the modes itself, so it could not tell the two apart and W-10 (the client-side
 * recompute) would survive with the assertion still green. The gap of ₹500.00 is what makes the
 * verbatim claim testable at all, and `expect(sumOfModes).not.toBe(totalPaise)` below fails loudly
 * if a later reader tidies the numbers.
 *
 * IT IS ALSO A STATE THE SERVER CAN REALLY PRODUCE, which is why this shape and not an arbitrary
 * one. `dayBook` (apps/core/src/modules/billing/daily-close.ts) computes `receipts.totalPaise` as a
 * fold over the `receipts.total_paise` COLUMN, and `byMode` as a separate fold over
 * `receipt_tenders.amount_paise` guarded by `if (mode === 'cash' || 'upi' || 'card')`. Two tables,
 * two folds, and a mode filter that silently drops anything outside those three: total ≥ Σ byMode
 * is reachable, not hypothetical. The screen's job is to print what the day book says, so the
 * hospital's own report is what the cashier reconciles against.
 */
const DAY_BOOK_INCONSISTENT = {
  day: TODAY_IST,
  receipts: {
    count: 4,
    totalPaise: 1_250_000, // ₹12,500.00 — VERBATIM; a client-side Σ of the modes gives ₹12,000.00
    byMode: { cash: 500_000, upi: 400_000, card: 300_000 },
  },
  degraded: { count: 1, totalPaise: 300_000 }, // ₹3,000.00 — the E-24 breakout
  invoices: { count: 5, netPayablePaise: 1_400_000 }, // ₹14,000.00
  creditNotes: { count: 2, netPaise: 120_000 }, // ₹1,200.00
  vouchersPaid: { count: 1, amountPaise: 84_000 }, // ₹840.00
};

/** The ordinary day, where the modes DO add up — the §3.44 not-over-broad companion. */
const DAY_BOOK_CONSISTENT = {
  day: "2026-08-18",
  receipts: {
    count: 2,
    totalPaise: 900_000, // ₹9,000.00 = 400000 + 300000 + 200000
    byMode: { cash: 400_000, upi: 300_000, card: 200_000 },
  },
  degraded: { count: 0, totalPaise: 0 },
  invoices: { count: 2, netPayablePaise: 900_000 },
  creditNotes: { count: 0, netPaise: 0 },
  vouchersPaid: { count: 0, amountPaise: 0 },
};

// ——— GSTR-1 fixtures ——————————————————————————————————————————————————————————————————————————

/**
 * THE SAME FIXTURE DISCIPLINE ONE LAYER UP (K35's `b09` numbers, re-used here at the screen).
 *
 * The B2C row is two invoice lines of `taxableBasePaise` 18875 that merged into one GSTR-1 group.
 * Each line stored `taxHead(18875, 1200) = 1133`, so the group's stored head sum is **2266**. A
 * screen that re-derived the head from the merged base would compute
 * `taxHead(37750, 1200) = divHalfUp(45,300,000, 20,000) = ⌊2265.5⌋ = 2265` — ONE PAISE LOWER, and
 * wrong, because §15.1's rule is that heads are summed and never recomputed.
 *
 * The first B2B row is deliberately CONSISTENT (18875 → 1133 either way): it is the not-over-broad
 * companion inside the same table, and it is why the recompute mutant must be caught by the B2C
 * row specifically rather than by "some number changed".
 */
const GSTR1 = {
  rows: [
    {
      buyerGstin: null, // the B2C bucket
      sacCode: "999312", rateBps: 1200, exempt: false,
      taxableBasePaise: 37_750, cgstPaise: 2_266, sgstPaise: 2_266, // ₹22.66 — NOT ₹22.65
    },
    {
      buyerGstin: "27AABCU9603R1ZM",
      sacCode: "999312", rateBps: 1200, exempt: false,
      taxableBasePaise: 18_875, cgstPaise: 1_133, sgstPaise: 1_133, // consistent by construction
    },
    {
      buyerGstin: "27AABCU9603R1ZM",
      sacCode: "999311", rateBps: 0, exempt: true,
      taxableBasePaise: 50_000, cgstPaise: 0, sgstPaise: 0,
    },
  ],
};

/**
 * `taxHead` (apps/core/src/modules/tariff/money.ts), TRANSCRIBED — never imported: `apps/core` is a
 * different workspace and this suite runs in jsdom. It exists here for ONE purpose: to show, in the
 * assertion itself, that the recompute a mutant would perform lands on a DIFFERENT number.
 */
function taxHead(basePaise: number, rateBps: number): number {
  const n = basePaise * rateBps;
  const d = 20_000;
  return Math.floor((2 * n + d) / (2 * d));
}

// ——— helpers ——————————————————————————————————————————————————————————————————————————————————

/**
 * UX-AUDIT 2026-09-28 · BOARD — the five tabs became pages of a header menu, each at its own URL, so a
 * test opens the office ON its page (`/billing/office?view=&page=`) the way a bookmark or the menu does.
 */
function renderAt(query: string): void {
  renderWithRouter(<BillingOffice />, `/billing/office?${query}`);
}

/** A needs feed carrying one voucher to pay — the flow a voucher row's Pay opens on Today. */
function needsWithVoucher(v: typeof FLAGGED_VOUCHER): unknown {
  return {
    asOf: NOW_ISO, day: TODAY_IST,
    rows: [{
      id: `pay:${v.id}`, kind: "pay_voucher", source: "PAY", state: "open", tier: 1, since: v.issuedAt, ageMinutes: 30, daysLeft: null, tone: "no",
      patient: { patientId: v.patientId, uhid: v.uhid, name: v.name, alias: v.alias, restricted: v.restricted },
      params: {
        voucherId: v.id, voucherNo: v.voucherNo, amountPaise: v.amountPaise, method: v.method, refundKind: v.kind, reasonClass: v.reasonClass,
        reason: v.reason, guardFlags: v.guardFlags, invoiceNo: null, creditNoteNo: null, requestedAt: v.issuedAt, requestedBy: "Arjun Mehta",
        approvedAt: v.issuedAt, approvedBy: "Neha Kulkarni", issuedAt: v.issuedAt, issuedBy: "Arjun Mehta", bankAbovePaise: 1_000_000,
      },
    }],
    money: { toPayPaise: v.amountPaise, toPayCount: 1, shortPaise: 0 },
    limits: { reconChargeManagerMaxPaise: 5_000, refundOwnerAbovePaise: 2_500_000, reconTolerancePaise: 100 },
  };
}

describe("BillingOffice", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("files a refund request with INTEGER PAISE and the guard flags the server computed, then issues the voucher against the granted approval", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/patients/search": { status: 200, body: { items: [SEARCH_HIT] } },
      "POST /api/billing/refunds/request": {
        status: 201,
        body: {
          approvalId: "apr-31", instanceId: "wfi-31", patientId: "p-1",
          invoiceId: null, creditNoteId: null, amountPaise: 250_000,
          guardFlags: ["terminal_encounter"],
        },
      },
      "POST /api/billing/refunds": {
        status: 201,
        body: {
          voucherId: "rv-31", voucherNo: "RV/26-27/000031", patientId: "p-1",
          kind: "advance_refund", invoiceId: null, creditNoteId: null,
          amountPaise: 250_000, method: "bank_transfer",
          guardFlags: ["terminal_encounter"], status: "issued",
        },
      },
    });
    renderAt("view=refunds&page=request");
    const user = userEvent.setup();

    // UX-AUDIT 2026-09-28 — the patient is PICKED by name, never typed as an internal id; the id
    // the picker yields is what the body carries.
    await pickPatient(user, await screen.findByTestId("refund-patient"));
    expect(screen.getByTestId("refund-patient-picked")).toHaveTextContent("Sunil Sharma");
    expect(screen.queryByLabelText("Patient")).toBeNull();
    await user.type(screen.getByLabelText("Refund amount"), "2500");
    await user.selectOptions(screen.getByLabelText("Reason class"), "genuine");
    await user.type(screen.getByLabelText("Reason"), "patient discharged, advance unused");
    await user.click(screen.getByTestId("refund-request-submit"));

    await waitFor(() => expect(callsTo("POST", "/api/billing/refunds/request")).toHaveLength(1));
    // §3.19 — the control types a rupee STRING; the body carries integer paise.
    expect(bodiesOf("POST", "/api/billing/refunds/request")[0]).toEqual({
      kind: "advance_refund",
      patientId: "p-1",
      amountPaise: 250_000,
      reasonClass: "genuine",
      reason: "patient discharged, advance unused",
    });
    const requestBody = bodiesOf("POST", "/api/billing/refunds/request")[0] as { amountPaise: unknown };
    expect(typeof requestBody.amountPaise).toBe("number");

    // The approval is named, and the flags the server computed ride the request — the approver is
    // told WHY this one is escalated (D6 guards 2+3).
    expect(await screen.findByTestId("refund-request-filed")).toHaveTextContent("apr-31");
    expect(screen.getByTestId("request-flag-terminal_encounter")).toBeInTheDocument();

    // …and the issue lane carries that approval id through, with the method the manager chose.
    await user.selectOptions(screen.getByLabelText("Refund method"), "bank_transfer");
    await user.click(screen.getByTestId("issue-submit"));
    await waitFor(() => expect(callsTo("POST", "/api/billing/refunds")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/refunds")[0]).toEqual({
      kind: "advance_refund",
      patientId: "p-1",
      amountPaise: 250_000,
      reasonClass: "genuine",
      reason: "patient discharged, advance unused",
      approvalId: "apr-31",
      method: "bank_transfer",
    });
    expect(screen.getByTestId("issue-done")).toHaveTextContent("RV/26-27/000031");
  });

  it("the worklist renders guard flags as WARNINGS, renders no payee identity reference even though the fixture carries one, and names each patient from the row itself — alias for a sealed record, no N+1", async () => {
    mockRoutes({ "GET /api/billing/refunds": { status: 200, body: VOUCHERS } });
    renderAt("view=refunds&page=all");

    const row = await screen.findByTestId("voucher-row-rv-1");
    expect(within(row).getByTestId("voucher-no-rv-1")).toHaveTextContent("RV/26-27/000004");
    expect(within(row).getByTestId("voucher-amount-rv-1")).toHaveTextContent("₹2,500.00");
    expect(within(row).getByTestId("voucher-status-rv-1")).toHaveTextContent("ISSUED");

    // The chips are WARNINGS. `role="status"` and the amber warning copy say escalated, not blocked
    // — D6: "Flags ride the approval payload … nothing is auto-blocked."
    const flag = within(row).getByTestId("voucher-flag-rv-1-terminal_encounter");
    expect(flag).toHaveAttribute("role", "status");
    expect(flag).toHaveTextContent("Encounter already closed");
    expect(within(row).getByTestId("voucher-flag-rv-1-delivered_line")).toHaveTextContent("Service already delivered");
    expect(screen.getByTestId("guard-flag-note")).toHaveTextContent(
      "These flags escalate the refund for the approver. Nothing is blocked by them.",
    );

    // An unflagged voucher carries no chips at all — the chip lane is not decoration on every row.
    const paidRow = screen.getByTestId("voucher-row-rv-2");
    expect(within(paidRow).queryByTestId(/^voucher-flag-rv-2-/)).toBeNull();

    // NO IDENTITY DOCUMENT REFERENCE, anywhere on the screen. The fixture carries
    // `payeeIdRef: 'XXXX-1234-5678'` precisely so this assertion can fail if the row is spread.
    expect(FLAGGED_VOUCHER.payeeIdRef).toBe("XXXX-1234-5678");
    expect(screen.queryByText(/XXXX-1234-5678/)).toBeNull();
    expect(document.body.textContent).not.toContain("XXXX-1234-5678");

    /**
     * UX-AUDIT 2026-09-28 — the row read "Patient: p-1". The name and UHID now ride the row from
     * ONE server-side batch, so there is still NO N+1: the screen makes no patient call of its own.
     * A sealed record renders its alias and never a name (§14).
     */
    const patient = within(row).getByTestId("voucher-patient-rv-1");
    expect(patient).toHaveTextContent("Sunil Sharma");
    expect(patient).toHaveTextContent("HMS-00000001-7");
    expect(patient).not.toHaveTextContent("p-1");
    const sealed = within(paidRow).getByTestId("voucher-patient-rv-2");
    expect(sealed).toHaveTextContent("Patient S-9");
    expect(sealed).not.toHaveTextContent("p-2");
    expect(fetchCalls().filter((c) => c.path.startsWith("/api/patients"))).toHaveLength(0);
    expect(fetchCalls().filter((c) => c.path.startsWith("/api/billing/patients"))).toHaveLength(0);
  });

  it("NOT OVER-BROAD: a guard-flagged voucher is still fully actionable — Pay opens its flow on Today and the payment posts", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: VOUCHERS },
      "GET /api/billing/office/needs": { status: 200, body: needsWithVoucher(FLAGGED_VOUCHER) },
      "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs-1", status: "open", openedAt: "2026-08-19T18:32:00.000Z" } } },
      "POST /api/billing/refunds/rv-1/pay": {
        status: 201,
        body: {
          voucherId: "rv-1", voucherNo: "RV/26-27/000004", patientId: "p-1",
          amountPaise: 250_000, method: "cash", cashierSessionId: "cs-1",
          paidAt: "2026-08-19T20:40:00.000Z", status: "paid",
        },
      },
    });
    renderAt("view=refunds&page=pay");
    const user = userEvent.setup();

    // The flagged row's pay control is present and ENABLED — a warning is not a block.
    const payButton = await screen.findByTestId("voucher-pay-rv-1");
    expect(payButton).toBeEnabled();
    await user.click(payButton);

    // UX-AUDIT 2026-09-28 · BOARD — the voucher is now in hand on Today, its flags still in view.
    const hand = await screen.findByTestId("in-hand");
    expect(within(hand).getByTestId("hand-flags")).toHaveTextContent("Encounter already closed");
    await user.clear(screen.getByTestId("payee-name"));
    await user.type(screen.getByTestId("payee-name"), "Ramesh Kumar");
    await user.selectOptions(screen.getByTestId("payee-id-type"), "aadhaar");
    await user.click(screen.getByTestId("hand-act"));

    await waitFor(() => expect(callsTo("POST", "/api/billing/refunds/rv-1/pay")).toHaveLength(1));
    // OWNER RULING 2026-09-28 — Aadhaar is never stored: the body carries the name and the ID TYPE, no number.
    expect(bodiesOf("POST", "/api/billing/refunds/rv-1/pay")[0]).toEqual({
      payeeName: "Ramesh Kumar",
      payeeIdType: "aadhaar",
    });
    expect(await screen.findByTestId("office-notice")).toHaveTextContent("RV/26-27/000004");
  });

  it("the pay flow mirrors the server's mandatory payee identity in the browser and renders a bank_transfer_required refusal inline", async () => {
    mockRoutes({
      "GET /api/billing/office/needs": { status: 200, body: needsWithVoucher(FLAGGED_VOUCHER) },
      "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
      "POST /api/billing/refunds/rv-1/pay": {
        status: 400,
        body: {
          statusCode: 400,
          message: "a refund of ₹2,500.00 must be paid by bank transfer",
          code: "bank_transfer_required",
          detail: { amountPaise: 250_000, thresholdPaise: 100_000 },
        },
      },
    });
    renderAt("view=today&open=pay:rv-1");
    const user = userEvent.setup();

    await screen.findByTestId("in-hand");
    await user.clear(screen.getByTestId("payee-name"));
    // An empty payee identity is refused in the browser, before anything leaves it. The server is the
    // authority (`payRefundBody` requires the name and the ID type); this is a mirror.
    await user.click(screen.getByTestId("hand-act"));
    expect(callsTo("POST", "/api/billing/refunds/rv-1/pay")).toHaveLength(0);
    expect(screen.getByTestId("hand-error")).toHaveTextContent("Type the payee’s name and choose the ID shown.");

    await user.type(screen.getByTestId("payee-name"), "Ramesh Kumar");
    await user.selectOptions(screen.getByTestId("payee-id-type"), "pan");
    await user.click(screen.getByTestId("hand-act"));

    await waitFor(() => expect(callsTo("POST", "/api/billing/refunds/rv-1/pay")).toHaveLength(1));
    const refusal = await screen.findByTestId("hand-error");
    expect(refusal).toHaveAttribute("role", "alert");
    expect(refusal).toHaveTextContent("must be paid by bank transfer");
  });

  it("K47/W-11: the recon upload posts the CSV WRAPPED as { csv, source } and renders matched / mismatched / unmatched counts plus the mismatch worklist with BOTH numbers", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/billing/recon/mismatches": { status: 200, body: MISMATCHES },
      "POST /api/billing/recon/upload": { status: 201, body: UPLOAD_RESULT },
    });
    renderAt("view=recon&page=upload");
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Settlement CSV"), CSV);
    await user.selectOptions(screen.getByLabelText("Statement source"), "card");
    await user.click(screen.getByTestId("recon-submit"));

    await waitFor(() => expect(callsTo("POST", "/api/billing/recon/upload")).toHaveLength(1));
    /**
     * THE BODY IS THE ASSERTION (W-11 posts the raw textarea string with no wrapper). `source` is
     * part of the shape because `reconUploadBody` requires it — a bare `{ csv }` is a 400 at the
     * shipped route — but the discriminating half is that the CSV is a NAMED FIELD of an object,
     * not the body itself.
     */
    const body = bodiesOf("POST", "/api/billing/recon/upload")[0];
    expect(body).toEqual({ csv: CSV, source: "card" });
    expect(typeof body).toBe("object");
    expect((body as { csv: string }).csv).toBe(CSV);

    expect(await screen.findByTestId("recon-rows-total")).toHaveTextContent("3");
    expect(screen.getByTestId("recon-rows-matched")).toHaveTextContent("1");
    expect(screen.getByTestId("recon-rows-mismatched")).toHaveTextContent("1");
    expect(screen.getByTestId("recon-rows-unmatched")).toHaveTextContent("1");
    // Unmatched refs are REPORTED, never guessed onto a tender (D7).
    expect(screen.getByTestId("recon-unmatched-refs")).toHaveTextContent("UPI-404");

    // UX-AUDIT 2026-09-28 · BOARD — the mismatches are their own page of Reconciliation.
    await user.click(screen.getByTestId("recon-to-mismatches"));
    await screen.findByTestId("mismatch-row-tn-1");

    // The worklist row carries BOTH numbers — a mismatch the operator cannot see both sides of is
    // not a worklist, it is a rumour.
    const row = screen.getByTestId("mismatch-row-tn-1");
    expect(within(row).getByTestId("mismatch-expected-tn-1")).toHaveTextContent("₹492.50");
    expect(within(row).getByTestId("mismatch-settled-tn-1")).toHaveTextContent("₹480.00");
    expect(within(row).getByTestId("mismatch-receipt-tn-1")).toHaveTextContent("RCP/26-27/000012");

    // UX-AUDIT 2026-09-28 — the stored note is rendered in rupees, never as raw "48000p".
    const note = within(row).getByTestId("mismatch-note-tn-1");
    expect(note).toHaveTextContent("₹480.00");
    expect(note).toHaveTextContent("₹492.50");
    expect(note).toHaveTextContent("₹1.00");
    expect(note.textContent).not.toMatch(/\d+p\b/);
  });

  it("K46/W-10: the day book renders the API's numbers VERBATIM — the fixture's mode figures deliberately do not add up to its total, and the total that renders is the API's", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/billing/day-book": { status: 200, body: DAY_BOOK_INCONSISTENT },
    });
    renderAt("view=daybook");
    await screen.findByTestId("daybook-receipts-total");

    /**
     * THE FIXTURE'S INCONSISTENCY, ASSERTED. If a later reader "tidies" the numbers so the modes add
     * up, this line fails and tells them why — instead of leaving a green test that proves nothing.
     */
    const modes = DAY_BOOK_INCONSISTENT.receipts.byMode;
    const sumOfModes = modes.cash + modes.upi + modes.card;
    expect(sumOfModes).toBe(1_200_000);
    expect(sumOfModes).not.toBe(DAY_BOOK_INCONSISTENT.receipts.totalPaise);

    // VERBATIM: the API said 1,250,000 paise, so ₹12,500.00 is what the day book shows. W-10 folds
    // the three modes and renders ₹12,000.00 here.
    expect(screen.getByTestId("daybook-receipts-total")).toHaveTextContent("₹12,500.00");
    expect(screen.getByTestId("daybook-receipts-total")).not.toHaveTextContent("₹12,000.00");
    expect(screen.getByTestId("daybook-receipts-count")).toHaveTextContent("4");

    // …and the mode figures are the API's own, likewise unmodified.
    expect(screen.getByTestId("daybook-mode-cash")).toHaveTextContent("₹5,000.00");
    expect(screen.getByTestId("daybook-mode-upi")).toHaveTextContent("₹4,000.00");
    expect(screen.getByTestId("daybook-mode-card")).toHaveTextContent("₹3,000.00");

    // the E-24 degraded breakout, the invoices, the credit notes and the vouchers paid
    expect(screen.getByTestId("daybook-degraded-count")).toHaveTextContent("1");
    expect(screen.getByTestId("daybook-degraded-total")).toHaveTextContent("₹3,000.00");
    expect(screen.getByTestId("daybook-invoices-count")).toHaveTextContent("5");
    expect(screen.getByTestId("daybook-invoices-total")).toHaveTextContent("₹14,000.00");
    expect(screen.getByTestId("daybook-credit-notes-count")).toHaveTextContent("2");
    expect(screen.getByTestId("daybook-credit-notes-total")).toHaveTextContent("₹1,200.00");
    expect(screen.getByTestId("daybook-vouchers-count")).toHaveTextContent("1");
    expect(screen.getByTestId("daybook-vouchers-total")).toHaveTextContent("₹840.00");
  });

  it("NOT OVER-BROAD: the ordinary day, whose mode figures DO add up, renders exactly the same way", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/billing/day-book": { status: 200, body: DAY_BOOK_CONSISTENT },
    });
    renderAt("view=daybook");
    await screen.findByTestId("daybook-receipts-total");

    const modes = DAY_BOOK_CONSISTENT.receipts.byMode;
    expect(modes.cash + modes.upi + modes.card).toBe(DAY_BOOK_CONSISTENT.receipts.totalPaise);

    // The verbatim rule must not have broken the consistent case — the total is right whether or
    // not the modes happen to agree with it, because it is never derived from them.
    expect(screen.getByTestId("daybook-receipts-total")).toHaveTextContent("₹9,000.00");
    expect(screen.getByTestId("daybook-mode-cash")).toHaveTextContent("₹4,000.00");
    expect(screen.getByTestId("daybook-mode-upi")).toHaveTextContent("₹3,000.00");
    expect(screen.getByTestId("daybook-mode-card")).toHaveTextContent("₹2,000.00");
    expect(screen.getByTestId("daybook-degraded-count")).toHaveTextContent("0");
    expect(screen.getByTestId("daybook-degraded-total")).toHaveTextContent("₹0.00");
  });

  it("the day book's day defaults to todayIst() — the IST calendar day, not the UTC one", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/billing/day-book": { status: 200, body: DAY_BOOK_INCONSISTENT },
    });
    renderAt("view=daybook");
    await waitFor(() => expect(callsTo("GET", "/api/billing/day-book").length).toBeGreaterThan(0));

    // The pinned instant is 19:30Z on the 19th — 01:00 IST on the 20th. The day asked for is the
    // IST one, checked against BOTH the shipped `todayIst()` and the literal it must produce here.
    const url = callsTo("GET", "/api/billing/day-book")[0]!.url;
    expect(url).toContain(`day=${TODAY_IST}`);
    expect(url).toContain(`day=${todayIst()}`);
    expect(todayIst()).toBe(TODAY_IST);
    expect(new Date(NOW_ISO).toISOString().slice(0, 10)).toBe("2026-08-19"); // the UTC day differs
    expect(url).not.toContain("day=2026-08-19");
    expect(screen.getByLabelText("Day")).toHaveValue(TODAY_IST);
  });

  it("GSTR-1 groups B2C and B2B by GSTIN over the typed range and renders the stored head sums VERBATIM — never re-derived from the merged base", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/billing/gstr1": { status: 200, body: GSTR1 },
    });
    renderAt("view=gstr1");
    const user = userEvent.setup();

    // `input[type=date]` is driven with `fireEvent.change` — `userEvent.type` types characters into
    // a control whose value is a whole date, and jsdom accepts only the complete 'YYYY-MM-DD'.
    fireEvent.change(await screen.findByLabelText("From"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-31" } });
    await user.click(screen.getByTestId("gstr1-run"));

    await waitFor(() =>
      expect(callsTo("GET", "/api/billing/gstr1").some((c) => c.url.includes("from=2026-08-01&to=2026-08-31"))).toBe(true),
    );

    // B2C first (a null GSTIN), then the GSTIN's own rows — the order the server sorted them into.
    expect(screen.getByTestId("gstr1-head-b2c")).toHaveTextContent("B2C");
    expect(screen.getByTestId("gstr1-head-27AABCU9603R1ZM")).toHaveTextContent("27AABCU9603R1ZM");

    /**
     * THE HEAD SUM, VERBATIM. The merged B2C base is 37,750p and its STORED head sum is 2,266p
     * (1133 + 1133, two lines). Re-deriving it — `taxHead(37750, 1200)` — gives 2,265p, one paise
     * lower. The assertion below states both numbers so the gap is visible in the file.
     */
    expect(taxHead(37_750, 1_200)).toBe(2_265);
    expect(GSTR1.rows[0]!.cgstPaise).toBe(2_266);
    expect(taxHead(37_750, 1_200)).not.toBe(GSTR1.rows[0]!.cgstPaise);
    expect(screen.getByTestId("gstr1-cgst-b2c-0")).toHaveTextContent("₹22.66");
    expect(screen.getByTestId("gstr1-cgst-b2c-0")).not.toHaveTextContent("₹22.65");
    expect(screen.getByTestId("gstr1-sgst-b2c-0")).toHaveTextContent("₹22.66");
    expect(screen.getByTestId("gstr1-base-b2c-0")).toHaveTextContent("₹377.50");

    // The consistent B2B row renders correctly too — a head that happens to agree with a recompute
    // is still rendered from the stored value.
    expect(taxHead(18_875, 1_200)).toBe(1_133);
    expect(screen.getByTestId("gstr1-cgst-27AABCU9603R1ZM-0")).toHaveTextContent("₹11.33");
    expect(screen.getByTestId("gstr1-exempt-27AABCU9603R1ZM-1")).toHaveTextContent("EXEMPT");

    // Group totals are a fold over the API's OWN heads, never a re-derivation from the group base.
    expect(screen.getByTestId("gstr1-total-cgst-b2c")).toHaveTextContent("₹22.66");
    expect(screen.getByTestId("gstr1-total-cgst-27AABCU9603R1ZM")).toHaveTextContent("₹11.33");
    expect(screen.getByTestId("gstr1-total-base-27AABCU9603R1ZM")).toHaveTextContent("₹688.75");
  });

  it("the entered-in-error lane finds the receipt by patient and PRINTED number, asks before it acts, names the cascade, and posts { receiptId, reason }", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/patients/search": { status: 200, body: { items: [SEARCH_HIT] } },
      "GET /api/billing/receipts": { status: 200, body: PATIENT_RECEIPTS },
      "POST /api/billing/eie": {
        status: 201,
        body: { markId: "eie-1", reversedAllocationIds: ["alc-1", "alc-2"] },
      },
    });
    renderAt("view=receipts&page=void");
    const user = userEvent.setup();

    // UX-AUDIT 2026-09-28 — no raw id box: patient → their receipts, narrowed by the printed number.
    expect(screen.queryByLabelText("Receipt to void")).toBeNull();
    await pickPatient(user, await screen.findByTestId("eie-patient"));
    await screen.findByTestId("eie-receipt-rcp-8");
    expect(callsTo("GET", "/api/billing/receipts")[0]!.url).toContain("patientId=p-1");
    await user.type(screen.getByLabelText("Receipt to void"), "000071");
    expect(screen.queryByTestId("eie-receipt-rcp-8")).toBeNull();
    await user.click(screen.getByTestId("eie-receipt-rcp-7"));
    await user.type(screen.getByLabelText("Reason for voiding"), "keyed against the wrong patient");
    await user.click(screen.getByTestId("eie-open"));

    // Nothing has left the browser yet: voiding a receipt reverses its allocations, and the
    // operator is told that before she confirms, not after.
    expect(callsTo("POST", "/api/billing/eie")).toHaveLength(0);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("eie-cascade")).toHaveTextContent(
      "Every allocation this receipt made will be reversed",
    );
    // The dialog names the receipt by the number on the paper, not by its internal id.
    expect(within(dialog).getByTestId("eie-cascade")).toHaveTextContent("RCP/26-27/000071");

    await user.click(within(dialog).getByTestId("eie-confirm-submit"));
    await waitFor(() => expect(callsTo("POST", "/api/billing/eie")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/eie")[0]).toEqual({
      receiptId: "rcp-7",
      reason: "keyed against the wrong patient",
    });
    expect(await screen.findByTestId("eie-done")).toHaveTextContent("2");
  });

  it("UX-AUDIT 2026-09-28: unbilled visits name the visit type in words, never the raw enum", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/billing/charge-orphans": {
        status: 200,
        body: {
          items: [
            { encounterId: "enc-1", patientId: "p-1", feeServiceId: "svc-1", visitNo: "V-1", visitType: "new", serviceDate: TODAY_IST },
            { encounterId: "enc-2", patientId: "p-2", feeServiceId: "svc-1", visitNo: "V-2", visitType: "revisit", serviceDate: TODAY_IST },
            { encounterId: "enc-3", patientId: "p-3", feeServiceId: "svc-1", visitNo: "V-3", visitType: "unknown", serviceDate: TODAY_IST },
          ],
        },
      },
    });
    renderAt("view=unbilled");
    expect(await screen.findByTestId("orphan-type-enc-1")).toHaveTextContent(/^New$/);
    expect(screen.getByTestId("orphan-type-enc-2")).toHaveTextContent(/^Revisit$/);
    expect(screen.getByTestId("orphan-type-enc-3")).toHaveTextContent(/^Not recorded$/);
    // UX-AUDIT 2026-09-28 · BOARD — a way out: the billing counter, opened on that visit.
    expect(screen.getByTestId("orphan-raise-enc-1")).toHaveAttribute("href", "/billing?encounterId=enc-1");
    // …and a date of its own, asked of the server as the IST day.
    expect(callsTo("GET", "/api/billing/charge-orphans")[0]!.url).toContain(`serviceDate=${TODAY_IST}`);
    expect(screen.getByTestId(`orphan-${"enc-1"}`)).toHaveTextContent("20-Aug-2026");
  });

  it("UX-AUDIT 2026-09-28 · BOARD: no tab strip — the header menu opens pages by URL, and the old ?tab= state redirects to its page", async () => {
    mockRoutes({ "GET /api/billing/refunds": { status: 200, body: { items: [] } } });
    renderAt("tab=orphans");
    expect(await screen.findByTestId("office-page-unbilled")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("office-view-refunds"));
    await user.click(await screen.findByTestId("office-entry-all"));
    expect(await screen.findByTestId("office-page-refunds")).toHaveAttribute("data-page", "all");
  });

  it("a 403 on any tab's read renders the SHARED error state, and the screen assumes nothing about which permission guards which route", async () => {
    mockRoutes({
      "GET /api/billing/refunds": {
        status: 403,
        body: {
          statusCode: 403,
          message: "billing.reports.read is required",
          code: "forbidden",
        },
      },
      "GET /api/billing/day-book": {
        status: 403,
        body: {
          statusCode: 403,
          message: "this account may not read billing reports",
          // a DIFFERENT code on a DIFFERENT route: the screen renders the server's own words and
          // never maps a route to a permission of its own — the server is the boundary (§3.5).
          code: "permission_denied",
        },
      },
    });
    renderAt("view=refunds&page=all");
    const user = userEvent.setup();

    const first = await screen.findByTestId("load-error");
    expect(first).toHaveAttribute("role", "alert");
    expect(first).toHaveTextContent("billing.reports.read is required");
    // The worklist is simply absent — no half-rendered table, no invented empty state.
    expect(screen.queryByTestId("voucher-row-rv-1")).toBeNull();

    await user.click(screen.getByTestId("office-view-daybook"));
    const second = await screen.findByTestId("load-error");
    expect(second).toHaveTextContent("this account may not read billing reports");
    expect(screen.queryByTestId("daybook-receipts-total")).toBeNull();
  });
});
