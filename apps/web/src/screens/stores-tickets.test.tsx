import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresApprove, StoresPick, StoresTicketTimeline } from "./stores-tickets";
import type { WireTicket } from "@hmis/contracts";

/** STORES S2a (#1112) — the Approve list, the To pick list and the Timeline (spec "## Screens"). */
type Call = { method: string; path: string; body: unknown };

const ticket = (over: Partial<WireTicket> = {}): WireTicket => ({
  id: "t1", indentNo: "MIN2611100001", status: "requested", stage: "to_approve", priority: "routine", channel: "phone",
  neededBy: null, deliverTo: null, emergencyReason: null, night: false,
  department: { id: "d1", code: "HSK", name: "Housekeeping" }, shelf: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" },
  source: { id: "g1", code: "GEN-MAIN", name: "Central store", kind: "central" },
  requestedBy: { id: "u2", name: "In-charge" }, requestedAt: "2026-11-10T06:30:00.000Z", clockFrom: "2026-11-10T06:30:00.000Z", origin: null,
  approval: { state: "pending", by: null, at: null, forHod: false, reason: null }, review: null, claim: null, transfer: null,
  lines: [{ lineIdx: 0, itemId: "i1", itemCode: "MOP", itemName: "Wet mop refill", baseUom: "piece", qtyBase: 20, qtyApproved: null, qtyIssued: null }],
  ...over,
});

function mock(routes: Record<string, { status?: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    if (path === "/auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the Stores ticket screens", () => {
  it("Approve: asked and approve quantity per line, Approve sends the lowered quantity", async () => {
    const calls = mock({ "GET /stores/tickets/to-approve": { body: { tickets: [ticket()] } }, "POST /stores/tickets/t1/approve": { body: ticket() } });
    const user = userEvent.setup();
    renderWithRouter(<StoresApprove />);
    const qty = await screen.findByRole("spinbutton", { name: "Approve · Wet mop refill" });
    expect(qty).toHaveValue(20);
    await user.clear(qty);
    await user.type(qty, "15");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/stores/tickets/t1/approve")?.body).toEqual({ lines: [{ lineIdx: 0, qtyBase: 15 }] }));
  });

  it("Approve: the requester's own ticket reads 'Your own ticket', and Decline asks for a reason", async () => {
    const calls = mock({
      "GET /stores/tickets/to-approve": { body: { tickets: [ticket()] } },
      "POST /stores/tickets/t1/approve": { status: 403, body: { statusCode: 403, code: "own_ticket", message: "x" } },
      "POST /stores/tickets/t1/decline": { body: ticket({ stage: "declined" }) },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresApprove />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Your own ticket")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByText("Reason needed")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Enough stock");
    await user.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/stores/tickets/t1/decline")?.body).toEqual({ reason: "Enough stock" }));
  });

  it("Approve and To pick show their empty words", async () => {
    mock({ "GET /stores/tickets/to-approve": { body: { tickets: [] } }, "GET /stores/tickets/to-pick": { body: { tickets: [] } } });
    renderWithRouter(<StoresApprove />);
    expect(await screen.findByText("Nothing to approve")).toBeInTheDocument();
  });

  it("To pick: Claim, then Issue; another keeper's claim reads 'Taken by another keeper'", async () => {
    const calls = mock({
      "GET /stores/tickets/to-pick": { body: { tickets: [ticket({ stage: "to_pick", priority: "urgent" })] } },
      "POST /stores/tickets/t1/claim": { body: ticket() },
      "POST /stores/tickets/t1/issue": { status: 409, body: { statusCode: 409, code: "claimed_by_another", message: "x" } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPick />);
    expect(await screen.findByText("Urgent")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Claim" }));
    await user.click(await screen.findByRole("button", { name: "Issue" }));
    expect(await screen.findByText("Taken by another keeper")).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining(["POST /stores/tickets/t1/claim", "POST /stores/tickets/t1/issue"]));
  });

  it("Timeline: one row per step with who, the leg's minutes and 'for HOD'", async () => {
    mock({
      "GET /stores/tickets/t1": { body: {
        ticket: ticket({ stage: "to_pick" }),
        timeline: { indentId: "t1", indentNo: "MIN2611100001", steps: [
          { step: "raise", who: { id: "u2", name: "In-charge", roles: ["department_store_incharge"] }, from: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" }, to: { id: "g1", code: "GEN-MAIN", name: "Central store" }, at: "2026-11-10T06:30:00.000Z", minutes: null, forHod: false, note: null, lines: [] },
          { step: "approve", who: { id: "u3", name: "The MS", roles: ["medical_superintendent"] }, from: null, to: null, at: "2026-11-10T06:37:00.000Z", minutes: 7, forHod: true, note: null, lines: [] },
        ] },
      } },
    });
    renderWithRouter(<StoresTicketTimeline indentId="t1" />);
    expect(await screen.findByTestId("step-approve")).toHaveTextContent("Approved · for HOD");
    expect(screen.getByTestId("step-approve")).toHaveTextContent("7 m");
    expect(screen.getByTestId("step-raise")).toHaveTextContent("Housekeeping F1 → Central store");
  });
});
