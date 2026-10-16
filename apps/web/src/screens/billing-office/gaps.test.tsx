import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../../test-utils";
import { BillingOffice } from "../billing-office";

/**
 * #655 — the billing back office's gaps from the UX audit (HANDOFF 2026-10-04 §5.4, board
 * docs/design/2026-09-28-ux-audit/billing-back-office.html): the printed voucher after paying,
 * "someone else collects — name the relation", the day book's bank charges, the GSTR-1 GSTIN count,
 * and the refund form's credit-note picker.
 */
type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(h.body), { status: h.status, headers: { "Content-Type": "application/json" } });
  }));
}
const callsOf = (method: string, path: string): unknown[] =>
  vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0] === path)
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown);

const P = (name: string, uhid: string) => ({ patientId: `p-${uhid}`, uhid, name, alias: null, restricted: false });
const PAY = {
  id: "pay:rv-4", kind: "pay_voucher", source: "PAY", state: "open", tier: 1, since: "2026-09-26T07:10:00.000Z", ageMinutes: 90, daysLeft: null, tone: "gd",
  patient: P("Sunita Verma", "SH-2026-004812"),
  params: { voucherId: "rv-4", voucherNo: "RFV/26-27/000004", amountPaise: 240_000, method: "cash", refundKind: "invoice_refund", reasonClass: "genuine",
    reason: "MRI brain cancelled", guardFlags: [], invoiceNo: "INV/26-27/003918", creditNoteNo: "CN/26-27/000061",
    requestedAt: "2026-09-26T04:42:00.000Z", requestedBy: "Arjun Mehta", approvedAt: "2026-09-26T07:10:00.000Z", approvedBy: "Neha Kulkarni",
    issuedAt: "2026-09-26T07:10:00.000Z", issuedBy: "Arjun Mehta", bankAbovePaise: 1_000_000 },
};
const GSTR1 = {
  id: "gstr1:2026-09", kind: "gstr1_due", source: "GSTR-1", state: "open", tier: 6, since: null, ageMinutes: null, daysLeft: 13, tone: "no", patient: null,
  params: { month: "2026-09", due: "2026-10-11", gstinCount: 4 },
};
const NEEDS = {
  asOf: "2026-09-28T06:10:00.000Z", day: "2026-09-28", rows: [PAY, GSTR1],
  money: { toPayPaise: 240_000, toPayCount: 1, shortPaise: 0 },
  limits: { reconChargeManagerMaxPaise: 5_000, refundOwnerAbovePaise: 2_500_000, reconTolerancePaise: 100 },
};
const PAID = { voucherId: "rv-4", voucherNo: "RFV/26-27/000004", patientId: "p-1", amountPaise: 240_000, method: "cash", cashierSessionId: "cs-2", paidAt: "2026-09-28T06:11:00.000Z", status: "paid", printJobId: "pj-1" };

describe("#655 — billing back office gaps", () => {
  beforeEach(() => { vi.setSystemTime(new Date("2026-09-28T06:10:00.000Z")); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("the GSTR-1 row says how many hospital GSTINs were billed", async () => {
    mockRoutes({ "GET /api/billing/office/needs": { status: 200, body: NEEDS } });
    renderWithRouter(<BillingOffice />, "/billing/office");
    expect(await screen.findByTestId("need-gstr1:2026-09")).toHaveTextContent("4 hospital GSTINs billed · B2C in one line");
  });

  it("someone else collects for the patient: the relation is asked and sent; paying prints the voucher here", async () => {
    mockRoutes({
      "GET /api/billing/office/needs": { status: 200, body: NEEDS },
      "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs-2", status: "open", openedAt: "2026-09-28T02:32:00.000Z" } } },
      "POST /api/billing/refunds/rv-4/pay": { status: 201, body: PAID },
      "GET /api/print/jobs/pj-1/document": { status: 200, body: null },
    });
    renderWithRouter(<BillingOffice />, "/billing/office");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("need-pay:rv-4"));
    const steps = await screen.findByTestId("hand-steps");
    // Nobody else yet: no relation box.
    expect(screen.queryByTestId("payee-relation")).toBeNull();
    await user.click(within(steps).getByRole("checkbox", { name: "Someone else collects for the patient" }));
    expect(screen.getByTestId("payee-name")).toHaveValue("");
    await user.type(screen.getByTestId("payee-name"), "Ramesh Verma");
    await user.type(screen.getByTestId("payee-relation"), "son");
    await user.selectOptions(screen.getByTestId("payee-id-type"), "pan");
    await user.click(screen.getByTestId("hand-act"));
    await waitFor(() => expect(callsOf("POST", "/api/billing/refunds/rv-4/pay")).toHaveLength(1));
    expect(callsOf("POST", "/api/billing/refunds/rv-4/pay")[0]).toEqual({ payeeName: "Ramesh Verma", payeeIdType: "pan", payeeRelation: "son" });
    // The voucher the server queued is printed on this computer (decision 0045's browser road).
    await waitFor(() => expect(callsOf("GET", "/api/print/jobs/pj-1/document")).toHaveLength(1));
  });

  it("someone else ticked but no relation named: asks for it and sends nothing", async () => {
    mockRoutes({
      "GET /api/billing/office/needs": { status: 200, body: NEEDS },
      "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs-2", status: "open", openedAt: "2026-09-28T02:32:00.000Z" } } },
      "POST /api/billing/refunds/rv-4/pay": { status: 201, body: PAID },
    });
    renderWithRouter(<BillingOffice />, "/billing/office");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("need-pay:rv-4"));
    const steps = await screen.findByTestId("hand-steps");
    await user.click(within(steps).getByRole("checkbox", { name: "Someone else collects for the patient" }));
    await user.type(screen.getByTestId("payee-name"), "Ramesh Verma");
    await user.selectOptions(screen.getByTestId("payee-id-type"), "pan");
    await user.click(screen.getByTestId("hand-act"));
    expect(await screen.findByTestId("hand-error")).toBeInTheDocument();
    expect(callsOf("POST", "/api/billing/refunds/rv-4/pay")).toHaveLength(0);
  });

  it("the day book shows the bank charges the office accepted", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/billing/day-book": { status: 200, body: {
        day: "2026-09-28", receipts: { count: 0, totalPaise: 0, byMode: { cash: 0, upi: 0, card: 0 } }, degraded: { count: 0, totalPaise: 0 },
        invoices: { count: 0, netPayablePaise: 0 }, creditNotes: { count: 0, netPaise: 0 }, vouchersPaid: { count: 0, amountPaise: 0 },
        bankCharges: { count: 2, amountPaise: 6_250 },
      } },
    });
    renderWithRouter(<BillingOffice />, "/billing/office?view=daybook");
    expect(await screen.findByTestId("daybook-bank-charges-count")).toHaveTextContent("2");
    expect(screen.getByTestId("daybook-bank-charges-total")).toHaveTextContent("₹62.50");
  });

  it("a refund against a bill picks the patient, then one of the patient's credit notes — no raw id box", async () => {
    mockRoutes({
      "GET /api/billing/refunds": { status: 200, body: { items: [] } },
      "GET /api/patients/search": { status: 200, body: { items: [{ id: "p-1", uhid: "HMS-00000001-7", name: "Sunil Sharma", phone: "9876500001", administrativeGender: "male", dob: "1980-02-02", isConfidential: false, hasPhoto: false }] } },
      "GET /api/billing/patients/p-1/credit-notes": { status: 200, body: { items: [
        { creditNoteId: "cn-61", creditNoteNo: "CN/26-27/000061", invoiceId: "inv-1", invoiceNo: "INV/26-27/003918", issuedAt: "2026-09-26T04:40:00.000Z", netPaise: 240_000, refundedPaise: 0, refundablePaise: 240_000 },
        { creditNoteId: "cn-55", creditNoteNo: "CN/26-27/000055", invoiceId: "inv-2", invoiceNo: "INV/26-27/003800", issuedAt: "2026-09-20T04:40:00.000Z", netPaise: 10_000, refundedPaise: 10_000, refundablePaise: 0 },
      ] } },
      "POST /api/billing/refunds/request": { status: 201, body: { approvalId: "apr-40", instanceId: "w", patientId: "p-1", invoiceId: "inv-1", creditNoteId: "cn-61", amountPaise: 240_000, guardFlags: [] } },
    });
    renderWithRouter(<BillingOffice />, "/billing/office?view=refunds&page=request");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Refund kind"), "invoice_refund");
    const box = screen.getByTestId("refund-patient");
    await user.type(within(box).getByLabelText("Search"), "Sunil");
    await user.click(await within(box).findByRole("button", { name: /Sunil Sharma/ }));
    const list = await screen.findByTestId("refund-credit-notes");
    expect(within(list).getByRole("radio", { name: /CN\/26-27\/000061/ })).toBeEnabled();
    // Nothing left to refund on this one: shown, not pickable.
    expect(within(list).getByRole("radio", { name: /CN\/26-27\/000055/ })).toBeDisabled();
    expect(list).toHaveTextContent("INV/26-27/003918");
    expect(list).toHaveTextContent("₹2,400.00");
    expect(document.getElementById("refund-subject")).toBeNull();
    await user.click(within(list).getByRole("radio", { name: /CN\/26-27\/000061/ }));
    await user.type(screen.getByLabelText("Refund amount"), "2400");
    await user.selectOptions(screen.getByLabelText("Reason class"), "genuine");
    await user.type(screen.getByLabelText("Reason"), "MRI cancelled");
    await user.click(screen.getByTestId("refund-request-submit"));
    await waitFor(() => expect(callsOf("POST", "/api/billing/refunds/request")).toHaveLength(1));
    expect(callsOf("POST", "/api/billing/refunds/request")[0]).toEqual({ kind: "invoice_refund", creditNoteId: "cn-61", amountPaise: 240_000, reasonClass: "genuine", reason: "MRI cancelled" });
  });
});
