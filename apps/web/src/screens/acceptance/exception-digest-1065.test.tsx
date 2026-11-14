import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlertsBell } from "../../components/alerts-bell";
import { setToken } from "../../lib/api";
import { resetRealtimeClientForTests } from "../../lib/realtime";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "../pharmacy-office/pharmacy-office";

/**
 * ACCEPTANCE — issue #1065, spec docs/specs/1065-pharmacy-exception-digest.md (owner APPROVED 2026-11-14, ruling
 * 0097): the web half. The office's Exceptions page shows a day's exceptions biggest first with totals by kind, each
 * row with rupees, who, when and a link, only to a holder of `pharmacy.exceptions.view`; the owner's bell row for
 * the 08:00 digest opens that day's page. The server half:
 * apps/core/src/modules/pharmacy/acceptance/exception-digest-1065.test.ts.
 *
 * The day is given in the address, so nothing here reads the clock.
 */
const DAY = "2026-11-13";
const ROWS = [
  { id: "r1", kind: "refund", paise: 30_000, who: "ph.mehta", at: "2026-11-13T05:00:00.000Z", link: "/pharmacy/desk/d1", what: "CN-0001 on bill INV-0001" },
  { id: "r2", kind: "stock_adjustment", paise: 150_000, who: "ms.approver", at: "2026-11-13T06:00:00.000Z", link: "/pharmacy/office?view=stock&page=counts", what: "CALPOL500 −3 · shrinkage · PHARM-OPD" },
  { id: "r3", kind: "refund", paise: 120_000, who: "ph.mehta", at: "2026-11-13T07:00:00.000Z", link: "/pharmacy/desk/d2", what: "CN-0002 on bill INV-0007" },
  { id: "r4", kind: "cash", paise: 4_000, who: "ph.mehta", at: "2026-11-13T13:00:00.000Z", link: "/billing/office", what: "Drawer counted ₹40 short" },
];
const DIGEST = {
  day: DAY, rows: ROWS, count: 4, totalPaise: 304_000,
  totals: [{ kind: "refund", count: 2, paise: 150_000 }, { kind: "stock_adjustment", count: 1, paise: 150_000 }, { kind: "cash", count: 1, paise: 4_000 }],
};

type Call = { method: string; path: string; query: string };
function mock(perms: readonly string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = raw.replace(/^.*\/api/, "");
    const [path, query] = [url.split("?")[0]!, url.split("?")[1] ?? ""];
    calls.push({ method: init?.method ?? "GET", path, query });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/pharmacy/office/reports/exceptions") return json(DIGEST);
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("#1065 — the pharmacy's daily exceptions (web)", () => {
  it("spec #1065 D1: each row on the Exceptions page shows its rupees, who, when and a link to the record", async () => {
    mock(["pharmacy.exceptions.view", "pharmacy.reports.read"]);
    renderWithRouter(<PharmacyOffice />, `/pharmacy/office?view=reports&page=exceptions&day=${DAY}`);
    const rows = await screen.findAllByTestId("exc-row", {}, { timeout: 3000 });
    expect(rows).toHaveLength(4);
    const refund = rows.find((r) => r.textContent?.includes("CN-0002"))!;
    expect(refund).toHaveTextContent("₹1,200.00");
    expect(refund).toHaveTextContent("ph.mehta");
    expect(within(refund).getByRole("link")).toHaveAttribute("href", "/pharmacy/desk/d2");
    expect(within(refund).getByTestId("exc-when")).not.toBeEmptyDOMElement();
  });

  it("spec #1065 D4: the page lists the day biggest first with totals by kind, and is not offered without pharmacy.exceptions.view", async () => {
    const calls = mock(["pharmacy.exceptions.view", "pharmacy.reports.read"]);
    const first = renderWithRouter(<PharmacyOffice />, `/pharmacy/office?view=reports&page=exceptions&day=${DAY}`);
    const rows = await screen.findAllByTestId("exc-row", {}, { timeout: 3000 });
    expect(rows.map((r) => within(r).getByTestId("exc-paise").textContent)).toEqual(["₹1,500.00", "₹1,200.00", "₹300.00", "₹40.00"]);
    expect(screen.getByTestId("exc-total-refund")).toHaveTextContent("₹1,500.00");
    expect(screen.getByTestId("exc-total-refund")).toHaveTextContent("2");
    expect(screen.getByTestId("exc-total-cash")).toHaveTextContent("₹40.00");
    expect(screen.getByTestId("exc-total-all")).toHaveTextContent("₹3,040.00");
    expect(calls.some((c) => c.path === "/pharmacy/office/reports/exceptions" && c.query.includes(`day=${DAY}`))).toBe(true);
    first.unmount();
    vi.unstubAllGlobals();

    // A reader of the reports without the right: no page, and the server is never asked.
    const without = mock(["pharmacy.reports.read"]);
    renderWithRouter(<PharmacyOffice />, `/pharmacy/office?view=reports&page=exceptions&day=${DAY}`);
    await waitFor(() => expect(without.some((c) => c.path === "/auth/me")).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("exc-page")).not.toBeInTheDocument();
    expect(without.some((c) => c.path === "/pharmacy/office/reports/exceptions")).toBe(false);
  });

  it("spec #1065 D5: the owner's digest row in the bell opens that day's Exceptions page", async () => {
    class FakeWebSocket {
      readonly sent: string[] = [];
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(readonly url: string) {}
      send(data: string): void { this.sent.push(data); }
      close(): void { this.readyState = 3; this.onclose?.(); }
    }
    resetRealtimeClientForTests();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setToken("tok-1");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = raw.split("?")[0]!;
      const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path.endsWith("/auth/me")) return json({ actor: { type: "user", id: "u-owner" } });
      if (path.endsWith("/alerts")) {
        return json({
          items: [{
            id: "al-1", kind: "pharmacy_exception_digest", title: "Pharmacy: 4 exceptions yesterday, ₹3,040", body: null,
            refType: "pharmacy_exceptions_day", refId: DAY, createdAt: new Date().toISOString(), readAt: null,
            ackKind: null, acknowledgedAt: null, ownedUntil: null, ackNote: null, handedToUserId: null, ackExtensions: 0,
          }],
          unreadCount: 1,
        });
      }
      return new Response("{}", { status: 404 });
    }));
    renderWithRouter(<AlertsBell />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("alerts-bell-toggle"));
    expect(await screen.findByTestId("alerts-open-al-1")).toHaveAttribute("href", `/pharmacy/office?view=reports&page=exceptions&day=${DAY}`);
  });
});
