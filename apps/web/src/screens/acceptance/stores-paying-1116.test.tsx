import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresPaying } from "../stores-paying";
import type { WirePayingDesk, WireRunToAuthorise } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #1116, spec docs/specs/1116-stores-paying-desk.md (owner APPROVED 2026-11-19, decision 0101): the
 * web half of S6a, D9 and D10. The paying desk at 1366 × 768 shows To book, Holds, Due, Runs, Payments and Exports; MSME
 * bills due in ≤ 5 days sit on top with the word "Due soon"; every status is a word. At 390 px the owner authorises a run
 * from its notice in two taps (the notice, then Authorise), seeing "₹ total · n bills · m MSME · k held out", with no
 * sideways scroll. A real-browser walk measures both (the PR's screenshots). The server half:
 * apps/core/src/modules/stores/acceptance/stores-s6a-1116.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const DESK: WirePayingDesk = {
  can: { book: true, release: true, prepare: true, record: true, owner: false, export: false },
  toBook: [{ kind: "ses", id: "s1", no: "SES2611100001", vendorId: "v1", vendorName: "Laundry Co", at: "2026-11-01T06:30:00.000Z", poNo: "MPO2610010001" }],
  holds: [],
  due: [
    { billId: "b1", billNo: "MSB2611010001", vendorBillNo: "A/1", vendorName: "Big Supplier", msme: false, dueDate: "2026-11-12", daysLeft: 2, outstandingPaise: 500_000, status: "accepted", dueWord: null },
    { billId: "b2", billNo: "MSB2611010002", vendorBillNo: "B/7", vendorName: "Small Maker", msme: true, dueDate: "2026-11-14", daysLeft: 4, outstandingPaise: 120_000, status: "on_hold", dueWord: "due_soon" },
    { billId: "b3", billNo: "MSB2610010003", vendorBillNo: "C/2", vendorName: "Old Supplier", msme: false, dueDate: "2026-11-01", daysLeft: -9, outstandingPaise: 90_000, status: "in_run", dueWord: "overdue" },
  ],
  runs: [], payments: [],
  settings: { version: 0, holdsCoverPharmacy: false, msmeRule: "as_today", outOfPatternMultipleBps: 20_000, firstBillLimitPaise: 10_000_000, setAt: null, setBy: null },
};
const RUN: WireRunToAuthorise = { runId: "r1", runNo: "MPR2611100001", status: "pending_authorisation", totalPaise: 28_000_000, bills: 3, msme: 1, heldOut: 2, canDecide: true };

function mock(perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/stores/pay/desk") return json(DESK);
    if (path === "/stores/pay/runs/r1" && method === "GET") return json(RUN);
    if (path === "/stores/pay/runs/r1/decide") return json({ ...RUN, status: "authorised", canDecide: false });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the paying desk (spec #1116)", () => {
  it("spec #1116 D9: at 1366 × 768 the desk shows To book, Holds, Due, Runs, Payments and Exports; MSME bills due in ≤ 5 days sit on top with \"Due soon\"; every status is a word", async () => {
    window.innerWidth = 1366;
    window.innerHeight = 768;
    mock(["materials.bills.manage", "materials.payments.prepare", "materials.payments.record", "stores.holds.release"]);
    const user = userEvent.setup();
    renderWithRouter(<StoresPaying />, "/stores/pay");
    const tabs = await screen.findByRole("tablist");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["To book", "Holds", "Due", "Runs", "Payments", "Exports"]);
    expect(await screen.findByText("SES2611100001")).toBeInTheDocument();

    await user.click(within(tabs).getByRole("tab", { name: "Due" }));
    const rows = await screen.findAllByTestId(/^due-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["due-row-b2", "due-row-b1", "due-row-b3"]);
    expect(within(rows[0]!).getByText("Due soon")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("MSME")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("On hold")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Accepted")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Overdue")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("In run")).toBeInTheDocument();
    const root = screen.getByTestId("stores-paying");
    expect(root.style.overflowX).toBe("hidden");
  });

  it("spec #1116 D10: at 390 px the owner authorises a run from its notice in two taps, seeing total, bills, MSME count and held out, with no sideways scroll", async () => {
    window.innerWidth = 390;
    window.innerHeight = 844;
    const calls = mock([]);
    const user = userEvent.setup();
    renderWithRouter(<StoresPaying />, "/stores/pay?run=r1");
    const sheet = await screen.findByTestId("authorise-sheet");
    expect(sheet.style.overflowX).toBe("hidden");
    expect(sheet.style.maxWidth).toBe("100%");
    expect(within(sheet).getByText("₹2,80,000 · 3 bills · 1 MSME · 2 held out")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Authorise" }));
    expect(await within(sheet).findByText("Authorised")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/stores/pay/runs/r1/decide", { approve: true }]]);
  });
});
