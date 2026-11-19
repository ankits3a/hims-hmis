import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { StoresReceive } from "../stores-tickets";
import type { WireTicket } from "@hmis/contracts";

/**
 * ACCEPTANCE — issue #1112, spec docs/specs/1112-stores-tickets-custody.md (owner APPROVED 2026-11-18): the web
 * half, D24. The Receive screen at 390 px: issued quantities prefilled, Confirm reachable in at most three taps
 * with no horizontal scroll, and every status a word. The server half:
 * apps/core/src/modules/stores/acceptance/stores-s2b-1112.test.ts.
 */
type Call = { method: string; path: string; body: unknown };

const TICKET: WireTicket = {
  id: "t1", indentNo: "MIN2611100001", status: "issued", stage: "to_receive", priority: "routine", channel: "phone",
  neededBy: null, deliverTo: "HSK pantry", emergencyReason: null, night: false,
  department: { id: "d1", code: "HSK", name: "Housekeeping" }, shelf: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" },
  source: { id: "g1", code: "GEN-MAIN", name: "Central store", kind: "central" },
  requestedBy: { id: "u2", name: "In-charge" }, requestedAt: "2026-11-10T06:30:00.000Z", clockFrom: "2026-11-10T06:30:00.000Z", origin: null,
  approval: { state: "approved", by: { id: "u3", name: "HOD" }, at: "2026-11-10T06:31:00.000Z", forHod: false, reason: null }, review: null, claim: null,
  transfer: { id: "tr1", status: "in_transit" },
  lines: [
    { lineIdx: 0, itemId: "i1", itemCode: "MOP", itemName: "Wet mop refill with a long name that must not wrap the row", baseUom: "piece", qtyBase: 20, qtyApproved: 20, qtyIssued: 20 },
    { lineIdx: 1, itemId: "i2", itemCode: "GLV", itemName: "Household gloves", baseUom: "pair", qtyBase: 10, qtyApproved: 10, qtyIssued: 10 },
  ],
  custody: { holder: { id: "p1", name: "Porter" }, legs: 1, lastCustodian: { id: "p1", name: "Porter" } }, delivery: null, shorts: [],
};

function mock(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: { d1: ["stores.shelf.work"] }, floor: {} } } });
    if (path === "/stores/tickets/to-receive" && method === "GET") return json({ tickets: [TICKET] });
    if (path === "/stores/tickets/t1/deliver" && method === "POST") return json({ ticket: { ...TICKET, stage: "delivered" }, duplicate: false, flag: null });
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); window.innerWidth = 390; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the Receive screen at 390 px (spec #1112)", () => {
  it("spec #1112 D24: issued quantities prefilled; Confirm in at most three taps with no horizontal scroll; every status shows a word", async () => {
    const calls = mock();
    const user = userEvent.setup();
    renderWithRouter(<StoresReceive />);

    const card = await screen.findByTestId("receive-t1");
    const rows = within(card).getAllByTestId(/^receive-line-/);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.style.whiteSpace).toBe("nowrap");
      expect(row.style.overflow).toBe("hidden");
    }
    // Prefilled with what was issued, and the status is a word.
    expect(within(rows[0]!).getByRole("spinbutton")).toHaveValue(20);
    expect(within(rows[1]!).getByRole("spinbutton")).toHaveValue(10);
    expect(within(rows[0]!).getByText("Accept")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Accept")).toBeInTheDocument();

    // No horizontal scroll: the screen clips sideways and never sets a width wider than the phone.
    const root = screen.getByTestId("stores-receive");
    expect(root.style.overflowX).toBe("hidden");
    expect(root.style.maxWidth).toBe("100%");

    // Two less on the first line: the remainder is "Short", one tap makes it "Wrong" — still a word.
    const qty = within(rows[0]!).getByRole("spinbutton");
    await user.clear(qty);
    await user.type(qty, "18");
    expect(within(rows[0]!).getByText("Short")).toBeInTheDocument();
    let taps = 0;
    await user.click(within(rows[0]!).getByRole("button", { name: /Short/ })); taps += 1;
    expect(within(rows[0]!).getByText("Wrong")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Confirm" })); taps += 1;
    expect(taps).toBeLessThanOrEqual(3);
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/stores/tickets/t1/deliver")?.body).toMatchObject({
      lines: [{ lineIdx: 0, accepted: 18, wrong: 2 }, { lineIdx: 1, accepted: 10 }],
    }));
  });
});
