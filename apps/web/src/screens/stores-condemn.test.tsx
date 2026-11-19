import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresAssetPassport, StoresCondemnSign } from "./stores-assets";
import { StoresReceive } from "./stores-tickets";
import type { WireCondemnation, WireTicket } from "@hmis/contracts";

/** STORES S4b (#1114) — the committee's phone, a refusal that names who to ask, and a tagged line received by scan. */
type Call = { method: string; path: string; body: unknown };

function mock(routes: Record<string, unknown | { status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [path] = raw.replace(/^.*\/api/, "").split("?") as [string];
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: { d1: ["stores.shelf.work", "stores.assets.condemn"] }, floor: {} } } }), { status: 200 });
    }
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response("{}", { status: 404 });
    if (typeof hit === "object" && hit !== null && "status" in hit && "body" in hit) {
      const h = hit as { status: number; body: unknown };
      return new Response(JSON.stringify(h.body), { status: h.status, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const seat = (s: "hod" | "accounts" | "materials" | "biomedical", by: string | null): WireCondemnation["seats"][number] => ({
  seat: s, holders: ["X"], signed: by === null ? null : { by, at: "2026-11-18T06:00:00.000Z", kind: "sign", reason: null },
});
const COND: WireCondemnation = {
  id: "c1", condNo: "CDN26110003", kind: "condemn", reason: "beyond_repair", note: null,
  unit: { id: "u1", tagNo: "AST2611000417", last4: "0417", name: "Patient monitor", place: "ICU shelf", department: "ICU" },
  status: "pending", costPaise: 48_500_000, ageYears: 7, repairs12m: 4, holdsData: false, regulatedBy: null, regulatorPaper: false,
  seats: [seat("hod", null), seat("accounts", "Priya"), seat("materials", null), seat("biomedical", null)], needsOwner: false,
  approvals: { ms: null, owner: null }, writeOffId: null, disposal: null, proposedBy: { id: "b", name: "Ravi" }, proposedAt: "2026-11-17T06:00:00.000Z",
  can: { sign: true, object: true, dispose: false, writeOff: false },
};

beforeEach(() => { setToken("t"); window.innerWidth = 390; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Stores S4b screens (spec #1114)", () => {
  it("the signer sees unit, reason, cost, age, repairs and each seat in words; Sign posts once and says Signed", async () => {
    const calls = mock({
      "GET /stores/assets/condemnations/to-sign": { rows: [COND] },
      "POST /stores/assets/condemnations/c1/sign": { ...COND, seats: [seat("hod", "Dr HOD"), ...COND.seats.slice(1)], can: { ...COND.can, sign: false, object: false } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresCondemnSign />);
    const card = await screen.findByTestId("sign-c1");
    for (const w of ["Beyond repair", "₹4,85,000", "7 years", "Repairs (12 months)", "HOD", "Accounts", "Materials head", "Biomedical"]) expect(within(card).getByText(w)).toBeInTheDocument();
    expect(within(card).getAllByText("Pending").length).toBeGreaterThan(1);
    await user.click(within(card).getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Signed"));
    expect(calls.filter((c) => c.method === "POST" && c.path === "/stores/assets/condemnations/c1/sign")).toHaveLength(1);
  });

  it("a second signature is refused in words (Already signed); an objection asks one line of why", async () => {
    const calls = mock({
      "GET /stores/assets/condemnations/to-sign": { rows: [COND] },
      "POST /stores/assets/condemnations/c1/sign": { status: 409, body: { statusCode: 409, code: "already_signed", message: "Already signed" } },
      "POST /stores/assets/condemnations/c1/object": { ...COND, status: "objected" },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresCondemnSign />);
    const card = await screen.findByTestId("sign-c1");
    await user.click(within(card).getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Already signed"));
    await user.click(within(card).getByRole("button", { name: "Object" }));
    await user.type(within(card).getByLabelText("Why"), "still repairable");
    await user.click(within(card).getByRole("button", { name: "Object" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Objected"));
    expect(calls.find((c) => c.path.endsWith("/object"))?.body).toEqual({ reason: "still repairable" });
  });

  it("a refused passport names who to ask", async () => {
    mock({
      "GET /stores/assets/mine": { rows: [] },
      "GET /stores/assets/lookup": { status: 403, body: { statusCode: 403, code: "not_permitted", message: "not your department", detail: { ask: ["Sister Rekha"] } } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresAssetPassport />);
    await user.type(await screen.findByLabelText("Type last 4"), "0509");
    expect(await screen.findByTestId("asset-refused")).toHaveTextContent("Not your department: ask Sister Rekha");
  });

  it("a tagged line is received by scanning the units that arrived: the rest is the short, and the scanned units go with the line", async () => {
    const ticket = {
      id: "t1", indentNo: "MIN2611100001", status: "issued", stage: "to_receive", priority: "routine", channel: "phone", neededBy: null, deliverTo: null, emergencyReason: null,
      night: false, department: { id: "d1", code: "ICU", name: "ICU" }, shelf: { id: "s1", code: "ICU-F1", name: "ICU shelf" },
      source: { id: "g1", code: "GEN-MAIN", name: "Central store", kind: "central" }, requestedBy: { id: "u2", name: "Sister" }, requestedAt: "2026-11-10T06:00:00.000Z",
      clockFrom: "2026-11-10T06:00:00.000Z", origin: null, approval: { state: "approved", by: null, at: null, forHod: false, reason: null }, review: null, claim: null,
      transfer: { id: "tr1", status: "in_transit" }, custody: null, delivery: null, shorts: [],
      lines: [{ lineIdx: 0, itemId: "i1", itemCode: "ME", itemName: "Patient monitor", baseUom: "piece", qtyBase: 2, qtyApproved: 2, qtyIssued: 2,
        units: [{ id: "u1", tagNo: "AST2611000417" }, { id: "u2", tagNo: "AST2611000418" }] }],
    } as unknown as WireTicket;
    const calls = mock({ "GET /stores/tickets/to-receive": { tickets: [ticket] }, "POST /stores/tickets/t1/deliver": { ticket, flag: null } });
    const user = userEvent.setup();
    renderWithRouter(<StoresReceive />);
    await user.click(await screen.findByRole("button", { name: "Scan unit · Patient monitor" }));
    await user.type(screen.getByLabelText("Type last 4"), "0418");
    expect(await screen.findByText("1 of 2 scanned")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/stores/tickets/t1/deliver")).toBeDefined());
    expect((calls.find((c) => c.path === "/stores/tickets/t1/deliver")!.body as { lines: unknown[] }).lines).toEqual([{ lineIdx: 0, accepted: 1, unitIds: ["u2"], short: 1 }]);
  });
});
