import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { BillingDues } from "./billing-dues";

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init: RequestInit | undefined, callIndex: number) => Reply);

/**
 * `stubFetch` answers 200 to everything, so it cannot produce the 409 refusals half this screen is
 * about (`over_cap`, `over_allocation`, `allocation_exceeds_advance`) — the billing-counter /
 * opd-admin precedent for a direct stub is used instead.
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

// ——— fixtures ————————————————————————————————————————————————————————————————————————————————

const SEARCH_HIT = {
  id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", phone: "9876500000", sex: "female",
  dob: "1990-04-02T00:00:00.000Z", isConfidential: false, hasPhoto: false,
};

/**
 * THE PARTIAL-AMOUNT FIXTURE. `outstandingPaise` is 45,000 and every clear in this file types a
 * DIFFERENT figure, because a fixture whose typed amount equals the outstanding cannot separate
 * W-5 ("always post the full outstanding") from correct code — Plan 07's T14 shipped exactly that
 * test and it discriminated nothing.
 */
const DUE_OLD = {
  invoiceId: "inv-7", invoiceNo: "INV/26-27/000007", patientId: "p-1", uhid: "HMS0000001234",
  name: "Asha Devi", alias: null, restricted: false, serviceDay: "2026-08-11",
  issuedAt: "2026-08-11T05:00:00.000Z", netPayablePaise: 120000, outstandingPaise: 45000,
  creditExtended: true, seq: 7,
};
/**
 * The restricted row carries BOTH a name and an alias. The server promises `name === null` when
 * `restricted` — this fixture deliberately VIOLATES that promise (the §3.33 discipline), so a
 * screen that rendered `name ?? alias` would leak "Meena Kumari" and the assertion below would
 * catch it. Confidential/VIP §14: a restricted row renders its alias and never its name.
 */
const DUE_NEW = {
  invoiceId: "inv-9", invoiceNo: "INV/26-27/000009", patientId: "p-1", uhid: "HMS0000001234",
  name: "Meena Kumari", alias: "Patient 9F2C", restricted: true, serviceDay: "2026-08-18",
  issuedAt: "2026-08-18T05:00:00.000Z", netPayablePaise: 80000, outstandingPaise: 80000,
  creditExtended: false, seq: 9,
};

const BALANCE = { patientId: "p-1", advancePaise: 25000, outstandingPaise: 125000, dues: [DUE_OLD, DUE_NEW] };

/**
 * `GET /billing/receipts` — the apply-advance lane's source of existing receipt rows.
 *
 * `panNumber` IS NOT A FIELD THE SHIPPED ROUTE SENDS: commit 30a272d replaced the raw row with a
 * projection carrying the derived `panCaptured` boolean. It is present here on purpose, as the
 * row a regressed (or pre-30a272d) server would send, so "no PAN reaches the screen" is an
 * executed assertion rather than a promise about the server.
 */
const RECEIPTS = {
  items: [
    {
      id: "rcp-adv", receiptNo: "RCP/26-27/000021", patientId: "p-1", cashierSessionId: "cs-1",
      receivedBy: "u-1", receivedAt: "2026-08-19T06:30:00.000Z", serviceDay: "2026-08-19",
      totalPaise: 25000, panCaptured: true, panNumber: "ABCDE1234F", form60: false,
      degraded: false, note: null, seq: 21,
    },
  ],
};

const RECEIPT_TAKEN = { receiptId: "rcp-new", receiptNo: "RCP/26-27/000044", totalPaise: 30000 };
const ALLOCATED = { allocationId: "al-1", amountPaise: 30000, settlement: { state: "partial", outstandingPaise: 15000 } };

const CREDIT_NOTE = {
  creditNoteId: "cn-1", creditNoteNo: "CN/26-27/000003", invoiceId: "inv-7", kind: "clearance_discount",
  grossPaise: 45000, discountPaise: 0, taxableBasePaise: 45000, cgstPaise: 0, sgstPaise: 0,
  rawTotalPaise: 45000, roundingPaise: 0, netPaise: 45000,
  settlement: { state: "settled", outstandingPaise: 0 },
};

const BASE_ROUTES: Record<string, Handler> = {
  "GET /patients/search": { status: 200, body: { items: [SEARCH_HIT] } },
  "GET /billing/patients/p-1/balance": { status: 200, body: BALANCE },
};

async function pickPatient(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Search"), "98765");
  await user.click(await screen.findByRole("button", { name: /Asha Devi/ }));
  expect(await screen.findByText(/Selected patient: Asha Devi/)).toBeInTheDocument();
}

/** The lane's money field: cleared of its seeded default, then typed. Rupees in, paise out. */
async function typeAmount(
  user: ReturnType<typeof userEvent.setup>, label: string, selector: string, rupees: string,
): Promise<void> {
  const field = screen.getByLabelText(label, { selector });
  await user.clear(field);
  await user.type(field, rupees);
}

describe("BillingDues", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("one ledger, one screen: the balance read renders the advance, the total outstanding and the dues OLDEST FIRST, with a restricted row shown as its alias", async () => {
    mockRoutes(BASE_ROUTES);
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await waitFor(() => expect(callsTo("GET", "/billing/patients/p-1/balance")).toHaveLength(1));

    expect(await screen.findByTestId("advance-balance")).toHaveTextContent("₹250.00");
    expect(screen.getByTestId("outstanding-total")).toHaveTextContent("₹1,250.00");

    // The server sends the worklist oldest-first (`listDues` orders by `seq`); the screen renders
    // that order VERBATIM and never re-sorts — no billing surface orders on identity (§14).
    expect(screen.getAllByTestId(/^due-row-/).map((row) => row.getAttribute("data-testid")))
      .toEqual(["due-row-inv-7", "due-row-inv-9"]);

    expect(screen.getByTestId("due-row-inv-7")).toHaveTextContent("INV/26-27/000007");
    expect(screen.getByTestId("due-day-inv-7")).toHaveTextContent("2026-08-11");
    expect(screen.getByTestId("due-payable-inv-7")).toHaveTextContent("₹1,200.00");
    expect(screen.getByTestId("due-cleared-inv-7")).toHaveTextContent("₹750.00");
    expect(screen.getByTestId("due-outstanding-inv-7")).toHaveTextContent("₹450.00");
    expect(screen.getByTestId("due-badge-inv-7")).toHaveTextContent("CREDIT");
    expect(screen.getByTestId("due-badge-inv-9")).toHaveTextContent("DUE");

    expect(screen.getByTestId("due-name-inv-7")).toHaveTextContent("Asha Devi");
    expect(screen.getByTestId("due-name-inv-9")).toHaveTextContent("Patient 9F2C");
    expect(screen.queryByText(/Meena Kumari/)).toBeNull();
  });

  it("K41: clearing a due posts the receipt and then allocates THE PARTIAL AMOUNT THE CASHIER TYPED — and the ordinary full clear still posts the full figure", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "POST /billing/receipts": { status: 201, body: RECEIPT_TAKEN },
      "POST /billing/receipts/rcp-new/allocations": { status: 201, body: ALLOCATED },
    });
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await user.click(await screen.findByTestId("due-open-clear-inv-7"));

    // The field is SEEDED with the outstanding (most clears are full) — and the cashier types over
    // it. 45,000p outstanding, 30,000p taken and allocated: partial settlement is a first-class
    // lane (D1), not a failure of the full one.
    expect(screen.getByLabelText("Amount to allocate", { selector: "#clear-amount" })).toHaveValue("450.00");
    await typeAmount(user, "Amount to allocate", "#clear-amount", "300");
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "300");
    await user.click(screen.getByTestId("clear-submit"));

    await waitFor(() => expect(callsTo("POST", "/billing/receipts/rcp-new/allocations")).toHaveLength(1));
    expect(bodiesOf("POST", "/billing/receipts")[0]).toEqual({
      patientId: "p-1",
      tenders: [{ mode: "cash", amountPaise: 30000 }],
    });
    // THE LOAD-BEARING ASSERTION — on the POSTED BODY, and on an amount that is NOT the
    // outstanding. W-5 posts `due.outstandingPaise` and dies exactly here.
    expect(bodiesOf("POST", "/billing/receipts/rcp-new/allocations")[0]).toEqual({
      invoiceId: "inv-7",
      amountPaise: 30000,
    });
    expect(DUE_OLD.outstandingPaise).toBe(45000); // …and the two figures really do differ

    // NOT OVER-BROAD (§3.44): typing the FULL outstanding must still post the full outstanding —
    // handling the partial case did not break the ordinary one.
    await user.click(screen.getByTestId("due-open-clear-inv-9"));
    await typeAmount(user, "Amount to allocate", "#clear-amount", "800");
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "800");
    await user.click(screen.getByTestId("clear-submit"));

    await waitFor(() => expect(callsTo("POST", "/billing/receipts/rcp-new/allocations")).toHaveLength(2));
    expect(bodiesOf("POST", "/billing/receipts/rcp-new/allocations")[1]).toEqual({
      invoiceId: "inv-9",
      amountPaise: 80000,
    });
  });

  it("K42: the clearance lane refuses to post without a category AND without a reason, then posts kind clearance_discount carrying both", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "POST /billing/invoices/inv-7/credit-notes": { status: 201, body: CREDIT_NOTE },
    });
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await user.click(await screen.findByTestId("due-open-clearance-inv-7"));

    // no category: refused in the browser, before anything leaves it
    await user.click(screen.getByTestId("clearance-submit"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/billing/invoices/inv-7/credit-notes")).toHaveLength(0);
    expect(screen.getByTestId("lane-error")).toHaveTextContent("Pick a discount category");

    // category but no reason: still refused (D4 — a clearance discount without a reason is an
    // unsigned write-off, and the server refuses it too)
    await user.selectOptions(screen.getByLabelText("Discount category"), "scheme");
    await user.click(screen.getByTestId("clearance-submit"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("POST", "/billing/invoices/inv-7/credit-notes")).toHaveLength(0);
    expect(screen.getByTestId("lane-error")).toHaveTextContent("A reason is required for a clearance discount");

    await user.type(screen.getByLabelText("Reason"), "written off at the outreach camp");
    await user.click(screen.getByTestId("clearance-submit"));

    await waitFor(() => expect(callsTo("POST", "/billing/invoices/inv-7/credit-notes")).toHaveLength(1));
    // W-6 drops `discountCategory` from this body and dies on the `toEqual`.
    expect(bodiesOf("POST", "/billing/invoices/inv-7/credit-notes")[0]).toEqual({
      kind: "clearance_discount",
      discountCategory: "scheme",
      askPaise: 45000,
      reason: "written off at the outreach camp",
    });
  });

  it("an over_cap refusal whose cap is ZERO is a CONFIGURATION message naming the category — and one with a real cap is still the ordinary asked-vs-cap money refusal", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "POST /billing/invoices/inv-7/credit-notes": (init, callIndex) =>
        callIndex === 0
          ? {
            status: 409,
            body: {
              statusCode: 409, code: "over_cap",
              message: '45000p exceeds the 0p clearance cap for "charity"',
              detail: { askedPaise: 45000, capPaise: 0, discountCategory: "charity", maxBps: null, rawTotalPaise: 120000 },
            },
          }
          : {
            status: 409,
            body: {
              statusCode: 409, code: "over_cap",
              message: '45000p exceeds the 25000p clearance cap for "scheme"',
              detail: { askedPaise: 45000, capPaise: 25000, discountCategory: "scheme", maxBps: 500, rawTotalPaise: 5000000 },
            },
          },
    });
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await user.click(await screen.findByTestId("due-open-clearance-inv-7"));
    await user.selectOptions(screen.getByLabelText("Discount category"), "charity");
    await user.type(screen.getByLabelText("Reason"), "camp patient");
    await user.click(screen.getByTestId("clearance-submit"));

    // A fresh environment seeds NO adjustment-rule cap rows, so `credit-notes.ts` reads an absent
    // cap as a cap of zero and refuses every ask. Telling a cashier she asked for too much when
    // the ceiling is zero is how a configuration gap becomes a bug report (carried item 2).
    const notConfigured = await screen.findByTestId("clearance-not-configured");
    expect(notConfigured).toHaveTextContent("Charity");
    expect(notConfigured).toHaveTextContent("no cap configured");
    expect(screen.queryByTestId("clearance-over-cap")).toBeNull();

    // NOT OVER-BROAD (§3.44): a category that IS configured must still refuse as MONEY, with the
    // server's asked-vs-cap numbers — the configuration message must not swallow the real refusal.
    await user.selectOptions(screen.getByLabelText("Discount category"), "scheme");
    await user.click(screen.getByTestId("clearance-submit"));

    const overCap = await screen.findByTestId("clearance-over-cap");
    expect(overCap).toHaveTextContent("₹450.00");
    expect(overCap).toHaveTextContent("₹250.00");
    expect(overCap).toHaveTextContent("Scheme");
    expect(screen.queryByTestId("clearance-not-configured")).toBeNull();
  });

  it("taking an advance posts a receipt with NO allocation, and the balance re-reads", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "GET /billing/patients/p-1/balance": (init, callIndex) =>
        callIndex === 0
          ? { status: 200, body: BALANCE }
          : { status: 200, body: { ...BALANCE, advancePaise: 75000 } },
      "POST /billing/receipts": { status: 201, body: { ...RECEIPT_TAKEN, totalPaise: 50000 } },
    });
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await user.click(await screen.findByTestId("take-advance-open"));
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "500");
    await user.click(screen.getByTestId("take-advance-submit"));

    await waitFor(() => expect(callsTo("POST", "/billing/receipts")).toHaveLength(1));
    expect(bodiesOf("POST", "/billing/receipts")[0]).toEqual({
      patientId: "p-1",
      tenders: [{ mode: "cash", amountPaise: 50000 }],
    });
    // An advance is a receipt with nothing allocated against it — the SAME row a paid bill writes
    // (D1); what makes it an advance is only the absence of the allocation.
    expect(fetchCalls().filter((c) => c.method === "POST" && c.path.endsWith("/allocations"))).toEqual([]);

    await waitFor(() => expect(screen.getByTestId("advance-balance")).toHaveTextContent("₹750.00"));
    expect(callsTo("GET", "/billing/patients/p-1/balance").length).toBeGreaterThan(1);
  });

  it("applying an advance allocates from an EXISTING receipt and posts NO receipt — proven on a fixture whose receipt route is live and does fire for the take-advance lane", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "GET /billing/receipts": { status: 200, body: RECEIPTS },
      "POST /billing/receipts": { status: 201, body: RECEIPT_TAKEN },
      "POST /billing/receipts/rcp-adv/allocations": { status: 201, body: { ...ALLOCATED, amountPaise: 20000 } },
    });
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await user.click(await screen.findByTestId("due-open-apply-inv-7"));
    await user.selectOptions(await screen.findByLabelText("From receipt"), "rcp-adv");

    // The Rule 114B capture is a COMPLIANCE CHIP, never a number. The fixture's row carries a
    // `panNumber` the shipped route does not send (see its comment) and it must reach nothing.
    expect(screen.getByTestId("receipt-pan-rcp-adv")).toHaveTextContent("PAN captured");
    expect(screen.queryByText(/ABCDE1234F/)).toBeNull();

    await typeAmount(user, "Advance to allocate", "#apply-amount", "200");
    await user.click(screen.getByTestId("apply-submit"));

    await waitFor(() => expect(callsTo("POST", "/billing/receipts/rcp-adv/allocations")).toHaveLength(1));
    expect(bodiesOf("POST", "/billing/receipts/rcp-adv/allocations")[0]).toEqual({
      invoiceId: "inv-7",
      amountPaise: 20000,
    });

    // THE ABSENCE ASSERTION: no new money changed hands, so no receipt is written. The fixture
    // field that would have made it appear is this very handler table's `POST /billing/receipts`
    // entry — it is registered, it answers 201, and the take-advance lane below proves it fires,
    // so the zero above is a real absence and not a route that could never have been hit.
    expect(callsTo("POST", "/billing/receipts")).toHaveLength(0);

    await user.click(screen.getByTestId("take-advance-open"));
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "100");
    await user.click(screen.getByTestId("take-advance-submit"));
    await waitFor(() => expect(callsTo("POST", "/billing/receipts")).toHaveLength(1));
  });

  it("allocation_exceeds_advance is a DEAD END — the reason with no remedial action — while an ordinary over_allocation leaves the lane open to correct", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "GET /billing/receipts": { status: 200, body: RECEIPTS },
      "POST /billing/receipts/rcp-adv/allocations": {
        status: 409,
        body: {
          statusCode: 409, code: "allocation_exceeds_advance",
          message: "allocating 20000p from receipt RCP/26-27/000021 would leave this patient a -5000p advance: 25000p has already gone back on advance-refund vouchers",
          detail: { askedPaise: 20000, wouldBeAdvancePaise: -5000, refundedPaise: 25000 },
        },
      },
    });
    const { unmount } = renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await user.click(await screen.findByTestId("due-open-apply-inv-7"));
    await user.selectOptions(await screen.findByLabelText("From receipt"), "rcp-adv");
    await typeAmount(user, "Advance to allocate", "#apply-amount", "200");
    await user.click(screen.getByTestId("apply-submit"));

    // A paid advance-refund voucher is cash that physically left the drawer. There is no
    // correction path by design (carried item 1), so the screen states the reason and stops: no
    // retry button, no "undo", not even the form that produced the refusal.
    const dead = await screen.findByTestId("terminal-refusal");
    expect(dead).toHaveTextContent("has already gone back on advance-refund vouchers");
    expect(within(dead).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("apply-submit")).toBeNull();
    expect(screen.queryByLabelText("Advance to allocate")).toBeNull();
    unmount();

    // NOT OVER-BROAD (§3.44): an ordinary, correctable refusal must NOT be turned into a dead end
    // — the cashier retypes a smaller figure and tries again.
    mockRoutes({
      ...BASE_ROUTES,
      "GET /billing/receipts": { status: 200, body: RECEIPTS },
      "POST /billing/receipts/rcp-adv/allocations": {
        status: 409,
        body: {
          statusCode: 409, code: "over_allocation",
          message: "20000p exceeds the 15000p still unallocated on this receipt",
          detail: { askedPaise: 20000, remainingPaise: 15000 },
        },
      },
    });
    renderWithProviders(<BillingDues />);
    const user2 = userEvent.setup();

    await pickPatient(user2);
    await user2.click(await screen.findByTestId("due-open-apply-inv-7"));
    await user2.selectOptions(await screen.findByLabelText("From receipt"), "rcp-adv");
    await typeAmount(user2, "Advance to allocate", "#apply-amount", "200");
    await user2.click(screen.getByTestId("apply-submit"));

    expect(await screen.findByTestId("lane-error")).toHaveTextContent("still unallocated on this receipt");
    expect(screen.queryByTestId("terminal-refusal")).toBeNull();
    expect(screen.getByTestId("apply-submit")).toBeInTheDocument();
  });

  it("refunding an advance LINKS to the back office's refund flow — this screen builds no second one", async () => {
    mockRoutes(BASE_ROUTES);
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);

    expect(await screen.findByTestId("refund-advance-link")).toHaveAttribute("href", "/billing/office");
    // D6's voucher is approval-gated, guard-flagged and payee-identified; a second copy of that
    // form at the dues counter is exactly the duplication pipeline B's §3.3 warns about.
    expect(screen.queryByLabelText("Payee name")).toBeNull();
    expect(screen.queryByLabelText("Reason class")).toBeNull();
    expect(fetchCalls().filter((c) => c.path.startsWith("/billing/refunds"))).toEqual([]);
  });

  it("the balance read carries refetchInterval 15_000", async () => {
    /**
     * PRESENCE ONLY, and deliberately so. T13's `billing-counter.test.tsx` OWNS the 15 s
     * convention's teeth: K39 lives there, with the 14 s negative control that separates "the
     * interval fired" from "a re-render, a remount or an invalidation refetched". W-3 — the mutant
     * that deletes `refetchInterval` — is aimed at that suite, not at this one. This test asserts
     * only that THIS screen's one polling read is wired with the interval; on its own it cannot
     * prove the second GET came from the interval, and it does not claim to.
     */
    vi.useFakeTimers();
    mockRoutes({
      "POST /patients/qr/verify": {
        status: 200,
        body: { ok: true, patient: { id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null } },
      },
      "GET /billing/patients/p-1/balance": { status: 200, body: BALANCE },
    });

    // `waitFor` cannot drive vitest's fake clock (it gates on a global `jest`) — hand-flush instead.
    const flush = async (ms = 5): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    renderWithProviders(<BillingDues />);
    await flush();

    // `userEvent` needs real timers, so the patient arrives through the picker's scan lane, which
    // `fireEvent` drives cleanly (the opd-display / billing-counter precedent).
    fireEvent.paste(screen.getByLabelText("Scan QR"), {
      clipboardData: { getData: () => "GOOD-QR" } as unknown as DataTransfer,
    });
    await flush();
    await flush();

    expect(callsTo("GET", "/billing/patients/p-1/balance")).toHaveLength(1);

    await flush(15_500);
    await flush();
    expect(callsTo("GET", "/billing/patients/p-1/balance").length).toBeGreaterThan(1);
  });

  /**
   * REGRESSION — the re-entrancy the pipeline-C discovery review reproduced against SHIPPED code
   * (finding 2 / carried item 1), on the very lane it used. Every money write on all four billing
   * screens was `<Button onClick={() => void handler()}>` with no in-flight guard, so a double
   * click posted twice. There is no idempotency key on `POST /billing/receipts`, so the duplicate
   * is a REAL SECOND RECEIPT: it inflates the patient's advance and manufactures the drawer
   * variance `44c8b86` exists to remove. One physical payment, two rows.
   *
   * The clicks are SYNCHRONOUS (`fireEvent`, no await between) because that is the shape that
   * discriminates: `userEvent.click` awaits, React re-renders, and a `disabled` attribute would
   * carry the test on its own. `submit-button.test.tsx` owns the proof that the ref latch — not
   * the attribute — is what stops the second call; THIS asserts the wiring, that this lane really
   * is guarded end to end.
   */
  it("REGRESSION: a double click on the clear lane posts ONE receipt and ONE allocation, not two — the money write is not re-entrant", async () => {
    mockRoutes({
      ...BASE_ROUTES,
      "POST /billing/receipts": { status: 201, body: RECEIPT_TAKEN },
      "POST /billing/receipts/rcp-new/allocations": { status: 201, body: ALLOCATED },
    });
    renderWithProviders(<BillingDues />);
    const user = userEvent.setup();

    await pickPatient(user);
    await user.click(await screen.findByTestId("due-open-clear-inv-7"));
    await typeAmount(user, "Amount to allocate", "#clear-amount", "300");
    await user.type(screen.getByLabelText("Amount", { selector: "#tender-amount-0" }), "300");

    const submit = screen.getByTestId("clear-submit");
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(callsTo("POST", "/billing/receipts/rcp-new/allocations")).toHaveLength(1));
    // let anything a second handler call would have issued actually land before counting
    await act(async () => {
      await Promise.resolve();
    });

    expect(callsTo("POST", "/billing/receipts")).toHaveLength(1);
    expect(callsTo("POST", "/billing/receipts/rcp-new/allocations")).toHaveLength(1);
    expect(bodiesOf("POST", "/billing/receipts")[0]).toEqual({
      patientId: "p-1",
      tenders: [{ mode: "cash", amountPaise: 30000 }],
    });
  });
});
