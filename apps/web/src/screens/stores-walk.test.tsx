import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../lib/auth";
import { setToken } from "../lib/api";
import { router } from "../router";
import { renderWithRouter } from "../test-utils";
import { StoresApprove, StoresPick, StoresPorter, StoresReceive, StoresTicketTimeline } from "./stores-tickets";
import { StoresShelf } from "./stores-shelf";
import { StoresDesk } from "./stores-desk";
import type { WireTicket, WireTimelineStep } from "@hmis/contracts";

/**
 * STORES UX pass from the real-browser walk (Refs #1111 #1112 #1119): every MUST and behavioural SHOULD the walker
 * found, one test each. The owner's bar: "user experience is something I cannot compromise with. The flow of the
 * whole module is important." Each test names its finding number.
 */
type Call = { method: string; path: string; query: string; body: unknown };
type Perms = { hospital: string[]; scoped: { department: Record<string, string[]>; floor: Record<string, string[]> } };
const NONE: Perms = { hospital: [], scoped: { department: {}, floor: {} } };
const INCHARGE: Perms = { hospital: [], scoped: { department: { d1: ["stores.shelf.read", "stores.shelf.work"] }, floor: {} } };

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

const ticket = (over: Partial<WireTicket> = {}): WireTicket => ({
  id: "t1", indentNo: "MIN2611100001", status: "requested", stage: "to_approve", priority: "routine", channel: "phone",
  neededBy: null, deliverTo: null, emergencyReason: null, night: false,
  department: { id: "d1", code: "HSK", name: "Housekeeping" }, shelf: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" },
  source: { id: "g1", code: "GEN-MAIN", name: "Central store", kind: "central" },
  requestedBy: { id: "u2", name: "Sunita Kumari" }, requestedAt: ago(42), clockFrom: ago(42), origin: null,
  approval: { state: "pending", by: null, at: null, forHod: false, reason: null }, review: null, claim: null, transfer: null,
  lines: [
    { lineIdx: 0, itemId: "i1", itemCode: "MOP", itemName: "Wet mop refill", baseUom: "piece", qtyBase: 20, qtyApproved: null, qtyIssued: null },
    { lineIdx: 1, itemId: "i2", itemCode: "GLV", itemName: "Household gloves", baseUom: "pair", qtyBase: 12, qtyApproved: null, qtyIssued: null },
  ],
  ...over,
});
const approved = (over: Partial<WireTicket> = {}): WireTicket => ticket({
  stage: "to_pick", approval: { state: "approved", by: { id: "h", name: "Dr HOD" }, at: ago(30), forHod: false, reason: null },
  lines: [
    { lineIdx: 0, itemId: "i1", itemCode: "MOP", itemName: "Wet mop refill", baseUom: "piece", qtyBase: 20, qtyApproved: 18, qtyIssued: null },
    { lineIdx: 1, itemId: "i2", itemCode: "GLV", itemName: "Household gloves", baseUom: "pair", qtyBase: 12, qtyApproved: 12, qtyIssued: null },
  ],
  ...over,
});
const inTransit = (over: Partial<WireTicket> = {}): WireTicket => ticket({
  status: "issued", stage: "to_receive", transfer: { id: "tr9", status: "in_transit" },
  approval: { state: "approved", by: null, at: null, forHod: false, reason: null },
  lines: [
    { lineIdx: 0, itemId: "i1", itemCode: "MOP", itemName: "Wet mop refill", baseUom: "piece", qtyBase: 20, qtyApproved: 20, qtyIssued: 20 },
    { lineIdx: 1, itemId: "i2", itemCode: "GLV", itemName: "Household gloves", baseUom: "pair", qtyBase: 12, qtyApproved: 12, qtyIssued: 12 },
  ],
  custody: { holder: { id: "p1", name: "Mohan Paswan" }, legs: 1, lastCustodian: { id: "p1", name: "Mohan Paswan" } },
  ...over,
});

const SHELF = {
  shelf: { id: "s1", code: "HSK-F1", name: "Housekeeping F1", kind: "shelf", parentId: "f1", departmentId: "d1", suppliedBy: "g1", custodianRoles: [], departmentCode: "HSK", departmentName: "Housekeeping", floorName: "First floor" },
  items: [
    { itemId: "i1", code: "HK-MOP-0001", name: "Wet mop refill", baseUom: "piece", trackMode: "shelf", onHand: 12, status: "ok", par: null, lastCheckAt: null, usePerDay30: 1, usePerOpdVisit: null, usePerBedDay: null },
    { itemId: "i3", code: "HK-BIN-0042", name: "Dustbin 20 L", baseUom: "piece", trackMode: "durable", onHand: 6, status: "ok", par: null, lastCheckAt: null, usePerDay30: 0, usePerOpdVisit: null, usePerBedDay: null },
  ],
  arriving: [{ transferId: "tr9", fromName: "Central store", issuedAt: ago(20), lines: [{ lineId: "l1", itemId: "i1", name: "Wet mop refill", qty: 20 }] }],
  may: { work: true },
};

type Route = { status?: number; body: unknown } | ((c: Call) => { status?: number; body: unknown });
function mock(routes: Record<string, Route>, perms: Perms = NONE): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [path, query = ""] = raw.replace(/^.*\/api/, "").split("?") as [string, string?];
    const method = init?.method ?? "GET";
    const call: Call = { method, path, query, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown };
    calls.push(call);
    const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: perms });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return json(path.startsWith("/stores") ? { message: "nf" } : [], path.startsWith("/stores") ? 404 : 200);
    const r = typeof hit === "function" ? hit(call) : hit;
    return json(r.body, r.status ?? 200);
  }));
  return calls;
}

const CSS_PATH = join(__dirname, "stores.css");
const css = (): string => (existsSync(CSS_PATH) ? readFileSync(CSS_PATH, "utf8") : "");

beforeEach(() => { setToken("t"); window.innerWidth = 390; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("MUST", () => {
  it("#1 every Stores input wears one shared field style: a visible border and a focus ring", async () => {
    mock({ "GET /stores/tickets/to-receive": { body: { tickets: [inTransit()] } }, "GET /stores/tickets/to-approve": { body: { tickets: [ticket()] } } });
    const a = renderWithRouter(<StoresReceive />);
    expect(await screen.findByTestId("stores-receive")).toHaveClass("stores-ui");
    a.unmount();
    renderWithRouter(<StoresApprove />);
    await screen.findByTestId("approve-t1");
    expect(screen.getByTestId("stores-approve")).toHaveClass("stores-ui");
    const text = css();
    expect(text).toMatch(/\.stores-ui input[^{]*\{[^}]*border:\s*1px solid/);
    expect(text).toMatch(/\.stores-ui[^{]*:focus-visible[^{]*\{[^}]*outline:/);
  });

  it("#2 To pick shows what to pick: each line with its approved quantity, the shelf it goes to, the row opens the ticket", async () => {
    mock({ "GET /stores/tickets/to-pick": { body: { tickets: [approved()] } } });
    renderWithRouter(<StoresPick />);
    const row = await screen.findByTestId("pick-t1");
    const l0 = within(row).getByTestId("pick-line-0");
    expect(l0).toHaveTextContent("Wet mop refill");
    expect(l0).toHaveTextContent("18");
    expect(within(row).getByTestId("pick-line-1")).toHaveTextContent("12");
    expect(row).toHaveTextContent("Housekeeping F1");
    expect(within(row).getByRole("link", { name: /0001/ })).toHaveAttribute("href", "/stores/tickets/t1");
  });

  it("#3 another keeper's live claim reads 'Taken by <name>' and offers no button", async () => {
    mock({ "GET /stores/tickets/to-pick": { body: { tickets: [approved({ id: "t5", indentNo: "MIN2611100005", claim: { by: { id: "k2", name: "Ramesh Yadav" }, at: ago(5), lapsesAt: ago(-25) } }), approved({ id: "t6", indentNo: "MIN2611100006", claim: { by: { id: "u1", name: "Me" }, at: ago(5), lapsesAt: ago(-25) } })] } } });
    renderWithRouter(<StoresPick />);
    const theirs = await screen.findByTestId("pick-t5");
    await waitFor(() => expect(within(theirs).getByText("Taken by Ramesh Yadav")).toBeInTheDocument());
    expect(within(theirs).queryByRole("button")).toBeNull();
    expect(within(screen.getByTestId("pick-t6")).getByRole("button", { name: "Issue" })).toBeInTheDocument();
  });

  it("#4 a ticket shows its last four everywhere; the full number only on the timeline", async () => {
    mock({
      "GET /stores/tickets/to-approve": { body: { tickets: [ticket()] } },
      "GET /stores/tickets/to-receive": { body: { tickets: [inTransit()] } },
      "GET /stores/tickets/t1": { body: { ticket: ticket({ stage: "delivered" }), timeline: { indentId: "t1", indentNo: "MIN2611100001", steps: [] } } },
    });
    const a = renderWithRouter(<StoresApprove />);
    const card = await screen.findByTestId("approve-t1");
    expect(within(card).getByText("0001")).toBeInTheDocument();
    expect(card.textContent).not.toContain("MIN2611100001");
    a.unmount();
    const b = renderWithRouter(<StoresReceive />);
    const rc = await screen.findByTestId("receive-t1");
    expect(within(rc).getByText("0001")).toBeInTheDocument();
    expect(rc.textContent).not.toContain("MIN2611100001");
    b.unmount();
    renderWithRouter(<StoresTicketTimeline indentId="t1" />);
    expect(await screen.findByText(/MIN2611100001/)).toBeInTheDocument();
  });

  it("#5 every ticket number is a link to its timeline; the shelf has My tickets; Sent links to the new ticket", async () => {
    const calls = mock({
      "GET /stores/tickets/to-approve": { body: { tickets: [ticket()] } },
    });
    const a = renderWithRouter(<StoresApprove />);
    const card = await screen.findByTestId("approve-t1");
    expect(within(card).getByRole("link", { name: /0001/ })).toHaveAttribute("href", "/stores/tickets/t1");
    a.unmount();

    vi.unstubAllGlobals();
    const c2 = mock({
      "GET /stores/shelves/s1": { body: SHELF },
      "GET /stores/shelves/s1/tickets": { body: { tickets: [inTransit({ id: "t7", indentNo: "MIN2611100007" })] } },
      "GET /stores/shelves/s1/reorder": { body: { lines: [{ itemId: "i1", code: "M", name: "Wet mop refill", onHand: 2, proposed: 10, packUom: "piece", packSize: 1 }] } },
      "GET /stores/shelves/s1/open-ticket": { body: { ticket: null } },
      "POST /stores/shelves/s1/tickets": { body: ticket({ id: "t9", indentNo: "MIN2611100009" }) },
    }, INCHARGE);
    const user = userEvent.setup();
    renderWithRouter(<StoresShelf shelfId="s1" />);
    await user.click(await screen.findByRole("button", { name: "My tickets" }));
    const list = await screen.findByTestId("shelf-tickets");
    expect(within(list).getByRole("link", { name: /0007/ })).toHaveAttribute("href", "/stores/tickets/t7");
    expect(within(list).getByText("On the way")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(await screen.findByRole("button", { name: "Reorder" }));
    await screen.findByLabelText(/Quantity · Wet mop refill/);
    await user.click(screen.getByRole("button", { name: "Send" }));
    const status = await screen.findByTestId("shelf-sent");
    expect(within(status).getByRole("link", { name: /0009/ })).toHaveAttribute("href", "/stores/tickets/t9");
    expect(c2.some((c) => c.method === "POST" && c.path === "/stores/shelves/s1/tickets")).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("#6 a Now card's ?ticket= focuses that ticket; Approve puts emergencies first", async () => {
    const list = [ticket(), ticket({ id: "t3", indentNo: "MIN2611100003", priority: "emergency", emergencyReason: "Spill in ICU" })];
    mock({
      "GET /stores/tickets/to-approve": { body: { tickets: list } },
      "GET /stores/tickets/to-pick": { body: { tickets: [approved(), approved({ id: "t5", indentNo: "MIN2611100005" })] } },
      "GET /stores/tickets/to-receive": { body: { tickets: [inTransit({ id: "t8", indentNo: "MIN2611100008", transfer: { id: "tr8", status: "in_transit" } }), inTransit()] } },
    });
    const a = renderWithRouter(<StoresApprove />, "/stores/approve");
    await screen.findByTestId("approve-t1");
    let cards = screen.getAllByTestId(/^approve-t/);
    expect(cards[0]).toHaveAttribute("data-testid", "approve-t3");
    a.unmount();

    const b = renderWithRouter(<StoresApprove />, "/stores/approve?ticket=t1");
    await screen.findByTestId("approve-t1");
    cards = screen.getAllByTestId(/^approve-t/);
    expect(cards[0]).toHaveAttribute("data-testid", "approve-t1");
    expect(cards[0]).toHaveAttribute("data-focused", "true");
    b.unmount();

    const c = renderWithRouter(<StoresPick />, "/stores/pick?ticket=t5");
    expect(await screen.findByTestId("pick-t5")).toHaveAttribute("data-focused", "true");
    c.unmount();

    renderWithRouter(<StoresReceive />, "/stores/receive?transfer=tr9");
    expect(await screen.findByTestId("receive-t1")).toHaveAttribute("data-focused", "true");
    expect(screen.getAllByTestId(/^receive-t/)[0]).toHaveAttribute("data-testid", "receive-t1");
  });

  it("#13 a department-scoped holder gets a menu way into Stores, and /stores offers each person their own screens", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mock({ "GET /stores/my-shelves": { body: { shelves: [] } } }, INCHARGE);
    setToken("t-1");
    const r = render(
      <QueryClientProvider client={qc}>
        <AuthProvider><RouterProvider router={router} history={createMemoryHistory({ initialEntries: ["/merge"] })} /></AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole("link").some((l) => l.getAttribute("href") === "/stores")).toBe(true));
    r.unmount();

    vi.unstubAllGlobals();
    mock({ "GET /stores/my-shelves": { body: { shelves: [] } } }, { hospital: ["stores.carry"], scoped: { department: {}, floor: {} } });
    const p = renderWithRouter(<StoresDesk />);
    const porterLinks = await screen.findByTestId("stores-ticket-links");
    await waitFor(() => expect(within(porterLinks).getByRole("link", { name: "Porter" })).toHaveAttribute("href", "/stores/porter"));
    expect(within(porterLinks).queryByRole("link", { name: "Indents to approve" })).toBeNull();
    expect(screen.queryByTestId("stores-desk-denied")).toBeNull();
    p.unmount();

    vi.unstubAllGlobals();
    mock({ "GET /stores/my-shelves": { body: { shelves: [] } } }, INCHARGE);
    renderWithRouter(<StoresDesk />);
    const links = await screen.findByTestId("stores-ticket-links");
    await waitFor(() => expect(within(links).getByRole("link", { name: "To receive" })).toHaveAttribute("href", "/stores/receive"));
    expect(within(links).queryByRole("link", { name: "To pick" })).toBeNull();
  });
});

describe("SHOULD", () => {
  it("#7 Decline has a way back, and 'Reason needed' sits under the box", async () => {
    mock({ "GET /stores/tickets/to-approve": { body: { tickets: [ticket()] } } });
    const user = userEvent.setup();
    renderWithRouter(<StoresApprove />);
    const card = await screen.findByTestId("approve-t1");
    await user.click(within(card).getByRole("button", { name: "Decline" }));
    const box = within(card).getByRole("textbox", { name: "Reason" });
    await user.click(within(card).getByRole("button", { name: "Decline" }));
    expect(box.nextElementSibling).toHaveTextContent("Reason needed");
    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("textbox", { name: "Reason" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("#8 the timeline names roles in words, dates a step not from today, and lists the lines", async () => {
    const twoDays = ago(60 * 48);
    const steps: WireTimelineStep[] = [
      { step: "raise", who: { id: "u2", name: "Sunita Kumari", roles: ["ward_incharge_raw_key"] }, from: null, to: null, at: twoDays, minutes: null, forHod: false, note: null, lines: [] },
      {
        step: "approve", who: { id: "h", name: "Ramesh Yadav", roles: ["storekeeper"] }, from: null, to: null, at: ago(1), minutes: 40, forHod: false, note: null,
        lines: [{ itemId: "i1", itemName: "Wet mop refill", asked: 20, approved: 18, issued: null }],
      },
    ];
    mock({ "GET /stores/tickets/t1": { body: { ticket: ticket(), timeline: { indentId: "t1", indentNo: "MIN2611100001", steps } } } });
    renderWithRouter(<StoresTicketTimeline indentId="t1" />);
    const raise = await screen.findByTestId("step-raise");
    expect(raise.textContent).not.toContain("ward_incharge_raw_key");
    expect(raise.textContent).toContain(new Date(twoDays).toLocaleDateString([], { day: "numeric", month: "short" }));
    const appr = screen.getByTestId("step-approve");
    expect(appr).toHaveTextContent("Storekeeper");
    expect(appr.textContent).not.toContain("(storekeeper)");
    expect(within(appr).getByTestId("step-line-i1")).toHaveTextContent(/Wet mop refill.*Asked 20.*Approved 18/);
  });

  it("#9 Receive: Issued/Got headings, From <porter>, a one-tap −1, and a visible three-way choice", async () => {
    const calls = mock({
      "GET /stores/tickets/to-receive": { body: { tickets: [inTransit()] } },
      "POST /stores/tickets/t1/deliver": { body: { ticket: inTransit({ stage: "delivered" }), duplicate: false, flag: null } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresReceive />);
    const card = await screen.findByTestId("receive-t1");
    expect(within(card).getByTestId("receive-head")).toHaveTextContent(/Issued.*Got/);
    expect(card).toHaveTextContent("From Mohan Paswan");
    const row = within(card).getByTestId("receive-line-0");
    await user.click(within(row).getByRole("button", { name: "One less · Wet mop refill" }));
    expect(within(row).getByRole("spinbutton")).toHaveValue(19);
    const choice = within(card).getByRole("radiogroup", { name: /Wet mop refill/ });
    for (const k of ["Short", "Wrong", "Damaged"]) expect(within(choice).getByRole("radio", { name: k })).toBeInTheDocument();
    await user.click(within(choice).getByRole("radio", { name: "Damaged" }));
    expect(within(choice).getByRole("radio", { name: "Damaged" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(card).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ lines: [{ lineIdx: 0, accepted: 19, damaged: 1 }, { lineIdx: 1, accepted: 12 }] }));
  });

  it("#10 the shelf's Arriving opens the counted Receive for that transfer, never a blind one-tap receipt", async () => {
    const calls = mock({ "GET /stores/shelves/s1": { body: SHELF } }, INCHARGE);
    renderWithRouter(<StoresShelf shelfId="s1" />);
    const arriving = await screen.findByTestId("shelf-arriving-tr9");
    expect(within(arriving).getByRole("link", { name: "Receive" })).toHaveAttribute("href", "/stores/receive?transfer=tr9");
    expect(within(arriving).queryByRole("button", { name: "Receive" })).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("#11 porter card leads with the destination, lists the items, and Bring back asks first", async () => {
    const calls = mock({
      "GET /stores/custody/mine": { body: { rows: [{ ticket: inTransit(), from: { id: "g1", code: "GEN-MAIN", name: "Central store" }, to: { id: "s1", code: "HSK-F1", name: "Housekeeping F1" }, minutes: 12 }] } },
      "POST /stores/tickets/t1/return-undelivered": { body: { ticket: inTransit(), duplicate: false, flag: null } },
      "GET /stores/custody/lookup": { body: { ticket: inTransit(), act: "take", holder: { id: "k1", name: "Ramesh Yadav" } } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPorter />);
    const row = await screen.findByTestId("porter-t1");
    expect(within(row).getByTestId("porter-to")).toHaveTextContent("Housekeeping F1");
    expect(row.firstElementChild).toContainElement(within(row).getByTestId("porter-to"));
    expect(row).toHaveTextContent(/Wet mop refill 20/);
    expect(screen.queryByText("Hand back before leaving")).toBeNull();
    await user.click(within(row).getByRole("button", { name: "Bring back" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(row).getByRole("button", { name: "Yes, bring back" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/stores/tickets/t1/return-undelivered")).toBe(true));

    await user.type(screen.getByLabelText("Type last 4"), "0001");
    const confirm = await screen.findByTestId("porter-confirm");
    expect(confirm).toHaveTextContent(/Wet mop refill 20/);
  });

  it("#12 a disabled button looks disabled", () => {
    expect(css()).toMatch(/\.stores-ui button:disabled[^{]*\{[^}]*opacity:\s*0?\.\d/);
  });

  it("#14 a refusal names who to ask and offers Back", async () => {
    const calls = mock({
      "GET /stores/shelves/s1": { status: 403, body: { statusCode: 403, code: "not_permitted", message: "not your department" } },
      "GET /stores/who-to-ask": { body: { department: { id: "d1", name: "Housekeeping" }, ask: [{ id: "h", name: "Dr Anil Sinha" }] } },
    });
    renderWithRouter(<StoresShelf shelfId="s1" />);
    const refused = await screen.findByTestId("shelf-refused");
    await waitFor(() => expect(refused).toHaveTextContent("Ask Dr Anil Sinha"));
    expect(refused).toHaveTextContent("Housekeeping");
    expect(within(refused).getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/stores/who-to-ask")?.query).toBe("shelfId=s1");
  });

  it("#15 an open ticket reads 'Ticket 0001 waits for HOD' with Add to it as the primary", async () => {
    mock({
      "GET /stores/shelves/s1": { body: SHELF },
      "GET /stores/shelves/s1/reorder": { body: { lines: [{ itemId: "i1", code: "M", name: "Wet mop refill", onHand: 2, proposed: 10, packUom: "piece", packSize: 1 }] } },
      "GET /stores/shelves/s1/open-ticket": { body: { ticket: ticket() } },
    }, INCHARGE);
    const user = userEvent.setup();
    renderWithRouter(<StoresShelf shelfId="s1" />);
    await user.click(await screen.findByRole("button", { name: "Reorder" }));
    expect(await screen.findByText("Ticket 0001 waits for HOD")).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add to it" });
    expect(add).toHaveAttribute("data-primary", "true");
    expect(screen.getByRole("button", { name: "Send" })).not.toHaveAttribute("data-primary", "true");
  });

  it("#16 materials head: create an item from the request in place; the over-book card opens the shelf check; class names are words", async () => {
    const calls = mock({
      "GET /stores/categories": { body: { categories: [] } },
      "GET /stores/items": { body: { items: [{ id: "i1", code: "HK-MOP-0001", name: "Wet mop refill", class: "consumable_dated", baseUom: "piece", categoryId: null, categoryName: null, trackMode: "shelf", searchAliases: [], active: true, issuePack: { uom: "piece", multiplier: 1 } }] } },
      "GET /stores/requests": { body: { requests: [{ id: "r1", name: "Toilet brush long handle", note: null, status: "open", requestedBy: "u2", shelfId: "s1", departmentId: "d1", resolvedItemId: null, createdAt: ago(300), similar: [] }] } },
      "POST /stores/items": { body: { itemId: "i99" } },
      "POST /stores/requests/r1/resolve": { body: { ok: true } },
      "GET /stores/shelves": { body: { shelves: [] } },
      "GET /stores/stores": { body: { stores: [] } },
      "GET /stores/pickers": { body: { floors: [], departments: [] } },
      "GET /stores/cards": { body: { cards: [{ cardId: "k1", shelfId: "s1", shelfName: "Housekeeping F1", checkId: "c", at: ago(60), lines: [{ itemId: "i3", name: "Dustbin 20 L", book: 6, counted: 7 }] }] } },
    }, { hospital: ["stores.masters.manage"], scoped: { department: {}, floor: {} } });
    const user = userEvent.setup();
    renderWithRouter(<StoresDesk />);
    await user.click(await screen.findByRole("tab", { name: "Items" }));
    expect(await screen.findByRole("cell", { name: "Consumable, dated" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "New items" }));
    await user.click(await screen.findByRole("button", { name: "Create item" }));
    const form = await screen.findByTestId("request-create-r1");
    expect(within(form).getByRole("textbox", { name: "Name" })).toHaveValue("Toilet brush long handle");
    await user.type(within(form).getByRole("textbox", { name: "Code" }), "HK-BRS-0009");
    await user.click(within(form).getByRole("button", { name: "Add item" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/stores/requests/r1/resolve")?.body).toEqual({ outcome: "created", itemId: "i99" }));
    expect(calls.find((c) => c.method === "POST" && c.path === "/stores/items")?.body).toMatchObject({ name: "Toilet brush long handle", code: "HK-BRS-0009" });
    await user.click(screen.getByRole("tab", { name: "Shelves" }));
    const card = await screen.findByTestId("stores-over-book");
    expect(within(card).getByRole("link", { name: "Open shelf check" })).toHaveAttribute("href", "/stores/shelf/s1?check=1");
  });
});
