import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../test-utils";
import { BillingOffice } from "../billing-office";

/**
 * UX-AUDIT 2026-09-28 · BOARD — Today: one ranked "needs you today", the item in hand with its numbered
 * steps, and the one act pinned. OWNER RULINGS 2026-09-28 pinned here: no Aadhaar (or any ID number) in
 * the payee step; blind count (the drawer's expected cash never renders, though the route carries it);
 * a short-settlement above ₹50.00 goes to the owner; no credit act on this screen.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply | ((body: string) => Reply)>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    const reply = typeof h === "function" ? h(typeof init?.body === "string" ? init.body : "") : h;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
const bodiesOf = (method: string, path: string): unknown[] =>
  vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0] === path)
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown);

const LIMITS = { reconChargeManagerMaxPaise: 5_000, refundOwnerAbovePaise: 2_500_000, reconTolerancePaise: 100 };
const P = (name: string, uhid: string) => ({ patientId: `p-${uhid}`, uhid, name, alias: null, restricted: false });

const RECON = {
  id: "recon:tn-1", kind: "recon_mismatch", source: "RECON", state: "open", tier: 0, since: "2026-09-26T06:12:00.000Z", ageMinutes: 2 * 1440 + 30, daysLeft: null, tone: "rd",
  patient: P("Rakesh Yadav", "SH-2026-003377"),
  params: { tenderId: "tn-1", receiptNo: "RCP/26-27/001482", mode: "upi", amountPaise: 50_000, expectedNetPaise: 49_250, settledPaise: 48_000, shortPaise: 1_250,
    ownerApproval: null, ownerApprovalId: null, takenAt: "2026-09-26T06:12:00.000Z", uploadedAt: "2026-09-28T04:35:00.000Z", disputedAt: null },
};
const PAY = {
  id: "pay:rv-4", kind: "pay_voucher", source: "PAY", state: "open", tier: 1, since: "2026-09-26T07:10:00.000Z", ageMinutes: 2 * 1440 + 90, daysLeft: null, tone: "gd",
  patient: P("Sunita Verma", "SH-2026-004812"),
  params: { voucherId: "rv-4", voucherNo: "RFV/26-27/000004", amountPaise: 240_000, method: "cash", refundKind: "invoice_refund", reasonClass: "genuine",
    reason: "MRI brain cancelled", guardFlags: [], invoiceNo: "INV/26-27/003918", creditNoteNo: "CN/26-27/000061",
    requestedAt: "2026-09-26T04:42:00.000Z", requestedBy: "Arjun Mehta", approvedAt: "2026-09-26T07:10:00.000Z", approvedBy: "Neha Kulkarni",
    issuedAt: "2026-09-26T07:10:00.000Z", issuedBy: "Arjun Mehta", bankAbovePaise: 1_000_000 },
};
const UNBILLED = {
  id: "unbilled:enc-41", kind: "unbilled_visit", source: "UNBILLED", state: "open", tier: 3, since: "2026-09-27T18:30:00.000Z", ageMinutes: 600, daysLeft: null, tone: "no",
  patient: P("Mohd. Aslam", "SH-2026-005001"),
  params: { encounterId: "enc-41", visitNo: "V2609280041", visitType: "new", serviceDate: "2026-09-28" },
};
const GSTR1 = {
  id: "gstr1:2026-09", kind: "gstr1_due", source: "GSTR-1", state: "open", tier: 6, since: null, ageMinutes: null, daysLeft: 13, tone: "no", patient: null,
  params: { month: "2026-09", due: "2026-10-11" },
};
const OWNER_REFUND = {
  id: "approval:ap-9", kind: "refund_owner", source: "APPROVE", state: "waiting", tier: 2, since: "2026-09-28T03:00:00.000Z", ageMinutes: 180, daysLeft: null, tone: "no",
  patient: P("Imran Qureshi", "SH-2026-000777"), params: { approvalId: "ap-9", amountPaise: 3_000_000, note: "surgery cancelled", subjectId: "p-1", requestedBy: "Arjun Mehta" },
};
const NEEDS = {
  asOf: "2026-09-28T06:10:00.000Z", day: "2026-09-28",
  rows: [RECON, PAY, UNBILLED, OWNER_REFUND, GSTR1],
  money: { toPayPaise: 240_000, toPayCount: 1, shortPaise: 1_250 },
  limits: LIMITS,
};

describe("billing office — Today (UX-AUDIT 2026-09-28 · BOARD)", () => {
  beforeEach(() => { vi.setSystemTime(new Date("2026-09-28T06:10:00.000Z")); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("opens on one ranked list with source chips, the money pills, and the owner's question on the collapsed clocks", async () => {
    mockRoutes({ "GET /api/billing/office/needs": { status: 200, body: NEEDS } });
    renderWithRouter(<BillingOffice />, "/billing/office");
    const list = await screen.findByTestId("needs-list");
    const rows = await within(list).findAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["need-recon:tn-1", "need-pay:rv-4", "need-unbilled:enc-41", "need-gstr1:2026-09"]);
    expect(rows[0]).toHaveTextContent("RECON");
    expect(rows[0]).toHaveTextContent("UPI settled ₹12.50 short on RCP/26-27/001482");
    expect(rows[0]).toHaveTextContent("2 d");
    expect(rows[1]).toHaveTextContent("Pay RFV/26-27/000004 · ₹2,400.00 cash");
    expect(rows[3]).toHaveTextContent("September GSTR-1 due 11-Oct-2026");
    expect(screen.getByTestId("pill-to-pay")).toHaveTextContent("1 voucher to pay · ₹2,400.00");
    expect(screen.getByTestId("pill-short")).toHaveTextContent("₹12.50 short-settled");
    // Waiting on the owner: a clock, not a task, and collapsed until asked.
    expect(within(list).queryByText(/with the owner/)).toBeNull();
    const clocks = screen.getByTestId("office-clocks");
    expect(clocks).toHaveTextContent("Clocks running · 1");
    expect(within(clocks).queryByTestId("clock-approval:ap-9")).toBeNull();
    await userEvent.setup().click(within(clocks).getByRole("button", { name: /Clocks running/ }));
    expect(within(clocks).getByTestId("clock-approval:ap-9")).toHaveTextContent("Refund ₹30,000.00 is with the owner");
    // Credit is the owner's alone — the office has no credit act anywhere.
    expect(screen.queryByRole("button", { name: /credit/i })).toBeNull();
  });

  it("OWNER RULINGS 2026-09-28: the pay flow asks for the payee's name and the ID TYPE — no ID number — and never shows the drawer's expected cash", async () => {
    mockRoutes({
      "GET /api/billing/office/needs": { status: 200, body: NEEDS },
      // The route carries the expected figure; the office must not render it (blind count).
      "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs-2", status: "open", openedAt: "2026-09-28T02:32:00.000Z", expectedCashPaise: 1_234_567 } } },
      "POST /api/billing/refunds/rv-4/pay": { status: 201, body: { voucherId: "rv-4", voucherNo: "RFV/26-27/000004", patientId: "p-1", amountPaise: 240_000, method: "cash", cashierSessionId: "cs-2", paidAt: "2026-09-28T06:11:00.000Z", status: "paid" } },
    });
    renderWithRouter(<BillingOffice />, "/billing/office");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("need-pay:rv-4"));

    const steps = await screen.findByTestId("hand-steps");
    expect(within(steps).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Refund requested", "Approved", "Voucher issued", "Who takes the money", "From which drawer", "Take the payee’s signature",
    ]);
    expect(screen.getByTestId("in-hand-head")).toHaveTextContent("Pay a refund — Sunita Verma");
    // No ID-number field of any kind.
    expect(screen.queryByLabelText(/ID number|reference|last 4/i)).toBeNull();
    expect(within(steps).getAllByRole("textbox")).toHaveLength(1);
    expect(await screen.findByTestId("drawer-open")).toHaveTextContent("drawer open");
    expect(document.body.textContent).not.toContain("₹12,345.67");

    expect(screen.getByTestId("payee-name")).toHaveValue("Sunita Verma");
    await user.selectOptions(screen.getByTestId("payee-id-type"), "aadhaar");
    expect(screen.getByTestId("hand-act")).toHaveTextContent("Pay ₹2,400.00 in cash");
    await user.click(screen.getByTestId("hand-act"));
    await waitFor(() => expect(bodiesOf("POST", "/api/billing/refunds/rv-4/pay")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/refunds/rv-4/pay")[0]).toEqual({ payeeName: "Sunita Verma", payeeIdType: "aadhaar" });
  });

  it("a mismatch: what the bank owed and paid in rupees, three outcomes, and the act says what it will do", async () => {
    mockRoutes({
      "GET /api/billing/office/needs": { status: 200, body: NEEDS },
      "POST /api/billing/recon/mismatches/tn-1/resolve": { status: 201, body: { status: "resolved", tenderId: "tn-1", outcome: "bank_charge", shortPaise: 1_250, state: "reconciled", resolutionId: "r-1" } },
    });
    renderWithRouter(<BillingOffice />, "/billing/office?view=today&open=recon:tn-1");
    const user = userEvent.setup();
    const money = await screen.findByTestId("recon-money");
    expect(money).toHaveTextContent("₹500.00");
    expect(money).toHaveTextContent("₹492.50");
    expect(money).toHaveTextContent("₹480.00");
    expect(screen.getByTestId("recon-diff")).toHaveTextContent("₹12.50");
    expect(screen.getByTestId("hand-act")).toHaveTextContent("Raise a dispute with the bank");

    await user.click(screen.getByTestId("recon-opt-bank_charge"));
    expect(screen.getByTestId("hand-act")).toHaveTextContent("Accept ₹12.50 as a bank charge");
    await user.click(screen.getByTestId("hand-act"));
    expect(bodiesOf("POST", "/api/billing/recon/mismatches/tn-1/resolve")).toHaveLength(0);
    expect(screen.getByTestId("hand-error")).toHaveTextContent("Write the reason first.");
    await user.type(screen.getByTestId("recon-reason"), "HDFC MDR difference");
    await user.click(screen.getByTestId("hand-act"));
    await waitFor(() => expect(bodiesOf("POST", "/api/billing/recon/mismatches/tn-1/resolve")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/recon/mismatches/tn-1/resolve")[0]).toEqual({ outcome: "bank_charge", reason: "HDFC MDR difference" });
  });

  it("OWNER RULING 2026-09-28: above ₹50.00 the write-off is asked of the owner, and the act waits", async () => {
    const big = { ...RECON, params: { ...RECON.params, settledPaise: 41_750, shortPaise: 7_500 } };
    mockRoutes({
      "GET /api/billing/office/needs": { status: 200, body: { ...NEEDS, rows: [big] } },
      "POST /api/billing/recon/mismatches/tn-1/resolve": { status: 201, body: { status: "awaiting_owner", tenderId: "tn-1", outcome: "bank_charge", shortPaise: 7_500, approvalId: "ap-77" } },
    });
    renderWithRouter(<BillingOffice />, "/billing/office?view=today&open=recon:tn-1");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("recon-opt-bank_charge"));
    expect(screen.getByTestId("hand-act")).toHaveTextContent("Ask the owner to accept ₹75.00");
    await user.type(screen.getByTestId("recon-reason"), "bank kept more than its fee");
    await user.click(screen.getByTestId("hand-act"));
    expect(await screen.findByTestId("hand-owner")).toHaveTextContent("The owner has been asked to accept ₹75.00");
    expect(screen.getByTestId("hand-act")).toBeDisabled();
  });

  it("an unbilled visit opens with 'Raise the missing bill' — the billing counter on that visit", async () => {
    mockRoutes({ "GET /api/billing/office/needs": { status: 200, body: NEEDS } });
    renderWithRouter(<BillingOffice />, "/billing/office?view=today&open=unbilled:enc-41");
    const act = await screen.findByTestId("hand-act");
    expect(act).toHaveTextContent("Raise the missing bill");
    expect(act).toHaveAttribute("href", "/billing?encounterId=enc-41");
  });
});
