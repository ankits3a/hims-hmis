import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
const SESSION = { id: "s1", cashierUserId: "u-anita", status: "open", openedAt: "2026-09-22T03:00:00.000Z", openingFloatPaise: 200000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null };
const base = (extra: Record<string, Reply>): Record<string, Reply> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-anita" } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  ...extra,
});

/**
 * THE DESK HEADER'S TWO PRECONDITIONS, AS THE BOARD DRAWS THEM: may this login verify (the Pharmacy
 * Act's registration), and can it take money (an open drawer — every receipt needs one). Said before
 * the first ticket, not discovered at the till.
 */
describe("the desk header (the Desk board)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a registered pharmacist with a drawer open reads both, with the number and the float", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/pharmacists/me": { status: 200, body: { registration: { council: "Maharashtra State Pharmacy Council", registrationNo: "41892", validUntil: null } } },
      "GET /api/billing/sessions/current": { status: 200, body: { session: SESSION } },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    expect(await screen.findByTestId("desk-registered")).toHaveTextContent("registered · 41892");
    expect(await screen.findByTestId("desk-drawer")).toHaveTextContent("drawer open · float ₹2,000");
  });

  it("no registration is said in red; no drawer is a button to where one is opened", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/pharmacists/me": { status: 200, body: { registration: null } },
      "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    const reg = await screen.findByTestId("desk-registered");
    expect(reg).toHaveTextContent("not registered — cannot verify");
    expect(reg).toHaveClass("rd");
    const drawer = await screen.findByTestId("desk-drawer");
    expect(drawer).toHaveTextContent("no drawer — open one to take money");
    await userEvent.click(within(drawer.parentElement!).getByRole("button", { name: /no drawer/ }));
    expect(navigate).toHaveBeenCalledWith({ to: "/billing/session" });
  });

  it("an older server that cannot say is left unsaid — never a false red", async () => {
    mockRoutes(base({ "GET /api/billing/sessions/current": { status: 200, body: { session: SESSION } } }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await screen.findByTestId("desk-drawer");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/pharmacists/me"))).toBe(true));
    expect(screen.queryByTestId("desk-registered")).toBeNull();
  });
});
