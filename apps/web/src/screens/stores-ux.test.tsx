import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresPick, StoresPorter } from "./stores-tickets";
import type { WireTicket } from "@hmis/contracts";

/**
 * STORES S2b UX pass (#1112, spec "## Screens" and "## Budgets"): the porter never types an id — a scan (or the
 * label's last four) names the ticket, the server names whose hands it is in, and one more tap takes it; the
 * keeper's To pick screen also holds what comes back (department returns, tickets returning undelivered) and
 * the late scans to confirm, each one tap.
 */
type Call = { method: string; path: string; query: string; body: unknown };

const ticket = (over: Partial<WireTicket> = {}): WireTicket => ({
  id: "t1", indentNo: "MIN2611100001", status: "issued", stage: "to_receive", priority: "routine", channel: "phone",
  neededBy: null, deliverTo: null, emergencyReason: null, night: false,
  department: { id: "d1", code: "HSK", name: "Housekeeping" }, shelf: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" },
  source: { id: "g1", code: "GEN-MAIN", name: "Central store", kind: "central" },
  requestedBy: { id: "u2", name: "In-charge" }, requestedAt: "2026-11-10T06:30:00.000Z", clockFrom: "2026-11-10T06:30:00.000Z", origin: null,
  approval: { state: "approved", by: null, at: null, forHod: false, reason: null }, review: null, claim: null, transfer: { id: "tr9", status: "in_transit" },
  lines: [{ lineIdx: 0, itemId: "i1", itemCode: "MOP", itemName: "Wet mop refill", baseUom: "piece", qtyBase: 20, qtyApproved: 20, qtyIssued: 20 }],
  ...over,
});

function mock(routes: Record<string, { status?: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [path, query = ""] = raw.replace(/^.*\/api/, "").split("?") as [string, string?];
    const method = init?.method ?? "GET";
    calls.push({ method, path, query, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    if (path === "/auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

/** A camera that reads the label's QR on the first frame. */
function camera(rawValue: string): void {
  class FakeDetector { detect(): Promise<{ rawValue: string }[]> { return Promise.resolve([{ rawValue }]); } }
  vi.stubGlobal("BarcodeDetector", FakeDetector);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => undefined }] }) },
  });
}

beforeEach(() => { setToken("t"); });
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

const lookup = (holder: { id: string; name: string }, act: "take" | "hand_over") => ({ ticket: ticket(), act, holder });

describe("Porter card: scan or last four, the holder named, two taps", () => {
  it("Scan → the camera reads the label → 'Taking from Porter A' → Take: a hand-on in two taps, the holder's id supplied by the server", async () => {
    camera("MIN2611100001");
    const calls = mock({
      "GET /stores/custody/mine": { body: { rows: [] } },
      "GET /stores/custody/lookup": { body: lookup({ id: "p1", name: "Porter A" }, "hand_over") },
      "POST /stores/custody/hand-over": { body: { ticket: ticket(), duplicate: false, flag: null } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPorter />);
    await user.click(await screen.findByRole("button", { name: "Scan" })); // tap 1
    expect(await screen.findByText("Taking from Porter A")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/stores/custody/lookup")?.query).toBe("code=MIN2611100001");
    await user.click(screen.getByRole("button", { name: "Take" })); // tap 2
    await waitFor(() => expect(calls.find((c) => c.path === "/stores/custody/hand-over")?.body).toMatchObject({ code: "MIN2611100001", fromUserId: "p1" }));
    expect(await screen.findByText("Taken")).toBeInTheDocument();
  });

  it("no camera: the last four typed finds the ticket by itself, 'Taking from <keeper>', one tap takes it from the store", async () => {
    const calls = mock({
      "GET /stores/custody/mine": { body: { rows: [] } },
      "GET /stores/custody/lookup": { body: lookup({ id: "k1", name: "Keeper A" }, "take") },
      "POST /stores/custody/take": { body: { ticket: ticket(), duplicate: false, flag: null } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPorter />);
    expect(await screen.findByText("Nothing in your hands")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Type last 4" }), "0001");
    expect(await screen.findByText("Taking from Keeper A")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Take" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/stores/custody/take")?.body).toMatchObject({ code: "0001" }));
  });

  it("the card asks for no person: one input, the label's last four, nothing named id, user or porter", async () => {
    camera("MIN2611100001");
    mock({
      "GET /stores/custody/mine": { body: { rows: [{ ticket: ticket(), from: { id: "g1", code: "GEN-MAIN", name: "Central store" }, to: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" }, minutes: 12 }] } },
      "GET /stores/custody/lookup": { body: lookup({ id: "p1", name: "Porter A" }, "hand_over") },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPorter />);
    await screen.findByTestId("porter-t1");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByText("Taking from Porter A");
    const card = screen.getByTestId("stores-porter");
    const inputs = card.querySelectorAll("input, textarea, select");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveAccessibleName("Type last 4");
    expect(inputs[0]).toHaveAttribute("maxlength", "4");
    for (const el of inputs) {
      const words = [el.getAttribute("name"), el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("type"), el.id].join(" ");
      expect(words).not.toMatch(/\b(id|user|porter|from)\b/i);
    }
  });

  it("a number that names nothing says so and keeps the field: no dead end", async () => {
    mock({
      "GET /stores/custody/mine": { body: { rows: [] } },
      "GET /stores/custody/lookup": { status: 404, body: { statusCode: 404, code: "unknown_ticket", message: "x" } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPorter />);
    await user.type(await screen.findByRole("textbox", { name: "Type last 4" }), "9999");
    expect(await screen.findByText("No ticket with that number")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Type last 4" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Take" })).toBeNull();
  });
});

describe("Keeper: what comes back and the late scans, one tap each", () => {
  const routes = (over: Record<string, { status?: number; body: unknown }> = {}) => ({
    "GET /stores/tickets/to-pick": { body: { tickets: [] } },
    "GET /stores/tickets/coming-back": { body: { tickets: [ticket({ id: "t2", indentNo: "MIN2611100002", stage: "returning" })] } },
    "GET /stores/returns/to-receive": { body: { returns: [{
      transferId: "tr1", status: "in_transit", shelf: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" }, to: { id: "g1", code: "GEN-MAIN", name: "Central store" },
      quarantine: false, raisedBy: { id: "u2", name: "In-charge" }, raisedAt: "2026-11-10T06:30:00.000Z", lines: [{ itemId: "i1", itemName: "Wet mop refill", qtyBase: 3 }],
    }] } },
    "GET /stores/custody/late-scans": { body: { scans: [{
      handoffId: "h1", indentId: "t1", indentNo: "MIN2611100001", kind: "take", by: { id: "p1", name: "Porter A" },
      phoneAt: "2026-11-09T06:30:00.000Z", recordedAt: "2026-11-10T06:30:00.000Z", flag: "late",
    }] } },
    "POST /stores/tickets/t2/accept-return": { body: ticket({ id: "t2", stage: "returned" }) },
    "POST /stores/returns/tr1/receive": { body: {} },
    "POST /stores/custody/late-scans/h1/confirm": { body: { ok: true } },
    ...over,
  });

  it("counts on top, each row one tap: Take back a return, Take back a ticket, Confirm a late scan", async () => {
    const calls = mock(routes());
    const user = userEvent.setup();
    renderWithRouter(<StoresPick />);
    expect(await screen.findByText("Nothing to pick")).toBeInTheDocument();
    const back = await screen.findByTestId("stores-take-back");
    expect(within(back).getByRole("heading")).toHaveTextContent("To take back · 2");
    const late = screen.getByTestId("stores-late-scans");
    expect(within(late).getByRole("heading")).toHaveTextContent("Late scan to confirm · 1");
    expect(late).toHaveTextContent("Porter A");
    await user.click(within(screen.getByTestId("back-ticket-t2")).getByRole("button", { name: "Take back" }));
    await user.click(within(screen.getByTestId("back-return-tr1")).getByRole("button", { name: "Take back" }));
    await user.click(within(screen.getByTestId("late-h1")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining([
      "POST /stores/tickets/t2/accept-return", "POST /stores/returns/tr1/receive", "POST /stores/custody/late-scans/h1/confirm",
    ])));
  });

  it("a refusal names the fix: another store's return reads 'Only the sending store's keeper'", async () => {
    mock(routes({ "POST /stores/returns/tr1/receive": { status: 403, body: { statusCode: 403, code: "not_permitted", message: "x" } } }));
    const user = userEvent.setup();
    renderWithRouter(<StoresPick />);
    await user.click(within(await screen.findByTestId("back-return-tr1")).getByRole("button", { name: "Take back" }));
    expect(await within(screen.getByTestId("back-return-tr1")).findByText("Only the sending store's keeper")).toBeInTheDocument();
  });

  it("nothing coming back and no late scan: the sections stay away", async () => {
    mock(routes({ "GET /stores/tickets/coming-back": { body: { tickets: [] } }, "GET /stores/returns/to-receive": { body: { returns: [] } }, "GET /stores/custody/late-scans": { body: { scans: [] } } }));
    renderWithRouter(<StoresPick />);
    expect(await screen.findByText("Nothing to pick")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("stores-take-back")).toBeNull());
    expect(screen.queryByTestId("stores-late-scans")).toBeNull();
  });
});
