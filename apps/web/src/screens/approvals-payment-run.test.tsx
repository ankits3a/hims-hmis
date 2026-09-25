import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ApprovalsInbox } from "./approvals-inbox";

/**
 * PARITY P3 — the OWNER authorises a supplier payment run on sight of the run itself. From the
 * approval card, "Open the run" shows the grid read-only (vendor groups, MSME, overdue, pay now,
 * the total) from `/materials/payment-runs/:id/for-approval`; Approve / Reject go back through the
 * inbox's own decision dialog, so the decision is the kernel's (`POST /approvals/:id/...`).
 * The owner here holds ONLY the approvals grants — no stock, no payables.
 */
const RUN_APPROVAL = {
  id: "ap-9", typeKey: "materials_payment_run_approval", instanceId: "wi-9", requesterId: "u-head", requesterName: "Sanjay Prasad",
  approverRole: "owner", urgencyClass: "routine", actedFirst: false, subjectType: "supplier_payment_run", subjectId: "r-1",
  patientId: null, encounterId: null, payeeId: "r-1", patient: null, amountPaise: 1_236_550, cumulativePatientPaise: null,
  cumulativePayeePaise: 1_236_550, requestNote: "MPR2609250001 · 2 vendor(s) · 3 bill(s) · ₹12365.50", status: "pending",
  decisionNote: null, decidedBy: null, decidedByName: null, decidedAt: null, requestedAt: new Date().toISOString(),
};

const RUN = {
  id: "r-1", runNo: "MPR2609250001", status: "pending_authorisation", source: "agent", totalPaise: 1_236_550, vendorCount: 2, billCount: 3,
  approvalId: "ap-9", rejectionNote: null, createdBy: "u-head", createdAt: "2026-09-25T06:00:00Z", submittedAt: "2026-09-25T06:05:00Z",
  authorisedBy: null, authorisedAt: null, completedAt: null, note: null, cancelReason: null, names: { "u-head": "Sanjay Prasad" }, approval: null,
  vendors: [
    { vendorId: "v-2", vendorCode: "BIHARMED", vendorName: "Bihar Surgicals", msme: true, coolingOffUntil: null, payPaise: 364_000, payment: null, lines: [
      { id: "rl-1", billId: "b-7", billNo: "MSB2608020001", vendorBillNo: "BS-0412", billDate: "2026-08-02", dueDate: "2026-09-16", msme: true, totalPaise: 246_000, prevPaidPaise: 0, creditPaise: 0, payPaise: 246_000, remainingPaise: 0, overdueDays: 9, paid: false },
      { id: "rl-2", billId: "b-10", billNo: "MSB2609010001", vendorBillNo: "BS-0467", billDate: "2026-09-01", dueDate: "2026-10-01", msme: true, totalPaise: 118_000, prevPaidPaise: 0, creditPaise: 0, payPaise: 118_000, remainingPaise: 0, overdueDays: 0, paid: false },
    ] },
    { vendorId: "v-3", vendorCode: "PATLIPUTRA", vendorName: "Patliputra Pharma", msme: false, coolingOffUntil: null, payPaise: 872_550, payment: null, lines: [
      { id: "rl-3", billId: "b-8", billNo: "MSB2607150003", vendorBillNo: "PPD/2398", billDate: "2026-07-15", dueDate: "2026-08-14", msme: false, totalPaise: 1_872_550, prevPaidPaise: 1_000_000, creditPaise: 0, payPaise: 872_550, remainingPaise: 0, overdueDays: 42, paid: false },
    ] },
  ],
};

type Seen = { method: string; url: string; body: string };
function mount(): Seen[] {
  const seen: Seen[] = [];
  let pending: unknown[] = [RUN_APPROVAL];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    seen.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
    const path = url.split("?")[0]!;
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/auth/me") return json(200, { actor: { type: "user", id: "u-owner" }, permissions: { hospital: ["approvals.requests.read", "approvals.requests.decide"], scoped: { department: {}, floor: {} } } });
    if (method === "GET" && path === "/api/approvals") return json(200, { items: pending, total: pending.length });
    if (method === "GET" && path === "/api/materials/payment-runs/r-1/for-approval") return json(200, { run: RUN });
    if (method === "POST" && path === "/api/approvals/ap-9/approve") { pending = []; return json(201, { status: "granted" }); }
    return json(404, {});
  }));
  setToken("t-1");
  renderWithRouter(<ApprovalsInbox />);
  return seen;
}

afterEach(() => { setToken(null); localStorage.clear(); vi.unstubAllGlobals(); });

describe("the owner reads a payment run before authorising it (parity P3)", () => {
  it("opens the run's grid read-only from the card, and Approve goes through the kernel's decision", async () => {
    const user = userEvent.setup();
    const seen = mount();
    await user.click(await screen.findByTestId("open-payment-run"));
    const sheet = await screen.findByTestId("run-approval-sheet");
    const msme = await within(sheet).findByTestId("run-approval-vendor-BIHARMED");
    expect(msme).toHaveTextContent("MSME");
    expect(within(msme).getByTestId("run-approval-line-MSB2608020001")).toHaveTextContent("9 days overdue");
    expect(within(sheet).getByTestId("run-approval-line-MSB2607150003")).toHaveTextContent("₹8,725.50");
    expect(within(sheet).getByTestId("run-approval-total")).toHaveTextContent("₹12,365.50");
    // Read-only: no inputs, no ticks.
    expect(within(sheet).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(sheet).queryAllByRole("checkbox")).toHaveLength(0);
    expect(seen.some((c) => c.url.startsWith("/api/materials/payment-runs/r-1/for-approval"))).toBe(true);

    await user.click(within(sheet).getByRole("button", { name: /Approve/ }));
    const dialog = await screen.findByRole("dialog", { name: "Approve this request?" });
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(seen.some((c) => c.method === "POST" && c.url === "/api/approvals/ap-9/approve")).toBe(true));
    expect(seen.some((c) => c.method === "POST" && c.url.includes("/materials/"))).toBe(false);
  });
});
