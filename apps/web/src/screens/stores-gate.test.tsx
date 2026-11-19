import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresGate, StoresPasses } from "./stores-gate";
import type { WireGatePass } from "@hmis/contracts";

/** STORES S2c (#1119) — the Gate's refusals and partial return, and the store's Passes tab and New pass sheet. */
type Call = { method: string; path: string; body: unknown };

const PASS: WireGatePass = {
  id: "gp1", passNo: "MGP2611100007", kind: "returnable", purpose: "repair", party: "Sharma Electricals", dueBack: "2026-11-12", status: "out",
  store: { id: "g1", code: "GEN-MAIN", name: "Central store" }, ref: null, note: null,
  lines: [{ itemId: "i1", itemCode: "EL-DRL-0001", itemName: "Electric drill", baseUom: "piece", qty: 2, out: 2, back: 0 }],
  raisedBy: { id: "u9", name: "Keeper" }, raisedAt: "2026-11-10T06:30:00.000Z", scans: [],
};

function mock(routes: Record<string, (body: unknown) => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["stores.gatepass.scan", "stores.gatepass.raise"], scoped: { department: {}, floor: {} } } });
    const r = routes[`${method} ${path}`];
    return r === undefined ? new Response("{}", { status: 404 }) : r(body);
  }));
  return calls;
}
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => { setToken("t"); window.innerWidth = 390; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Gate (the guard)", () => {
  it("with no camera it offers the typed fallback; a refusal reads as the spec's words", async () => {
    mock({ "GET /stores/gate-passes/lookup": () => json({ statusCode: 403, code: "own_pass", message: "x" }, 403) });
    const user = userEvent.setup();
    renderWithRouter(<StoresGate />);
    await user.type(await screen.findByLabelText("Type last 4"), "0007");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You raised this pass"));
    expect(screen.getByLabelText("Type last 4")).toHaveValue("");
  });

  it("Let in brings back what the guard counts: one of two sends one line", async () => {
    const calls = mock({
      "GET /stores/gate-passes/lookup": () => json({ pass: PASS, act: "entry" }),
      "POST /stores/gate-passes/scan": () => json({ pass: { ...PASS, lines: [{ ...PASS.lines[0]!, out: 1, back: 1 }] }, duplicate: false, flag: null }),
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresGate />);
    await user.type(await screen.findByLabelText("Type last 4"), "0007");
    const card = await screen.findByTestId("gate-pass");
    expect(within(card).getByText("Out")).toBeInTheDocument();
    const qty = within(card).getByRole("spinbutton");
    expect(qty).toHaveValue(2);
    await user.clear(qty);
    await user.type(qty, "1");
    await user.click(within(card).getByRole("button", { name: "Let in" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Recorded"));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ code: "MGP2611100007", act: "entry", lines: [{ itemId: "i1", qty: 1 }] });
  });
});

describe("Passes (the store)", () => {
  it("empty: 'No passes'; rows carry a status word; Overdue reads as a word", async () => {
    mock({ "GET /stores/gate-passes": () => json({ passes: [] }) });
    const { unmount } = renderWithRouter(<StoresPasses />);
    expect(await screen.findByText("No passes")).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    mock({ "GET /stores/gate-passes": () => json({ passes: [{ ...PASS, status: "overdue" }] }) });
    renderWithRouter(<StoresPasses />);
    const row = await screen.findByTestId("pass-gp1");
    expect(within(row).getByText("Overdue")).toBeInTheDocument();
    expect(within(row).getByText("0007")).toBeInTheDocument();
  });

  it("New pass, non-returnable with nothing behind it: 'No return or write-off ready', and Raise says 'Return or write-off needed'", async () => {
    mock({
      "GET /stores/gate-passes": () => json({ passes: [] }),
      "GET /stores/gate-passes/form": () => json({ stores: [{ id: "g1", code: "GEN-MAIN", name: "Central store" }], sources: [] }),
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPasses />);
    await user.click(await screen.findByRole("button", { name: "New pass" }));
    await user.click(await screen.findByRole("radio", { name: "Non-returnable" }));
    expect(await screen.findByText("No return or write-off ready")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Raise pass" }));
    expect(await screen.findByText("Return or write-off needed")).toBeInTheDocument();
  });

  it("New pass, returnable: to whom, an item, Raise pass, then Print pass", async () => {
    const calls = mock({
      "GET /stores/gate-passes": () => json({ passes: [] }),
      "GET /stores/gate-passes/form": () => json({ stores: [{ id: "g1", code: "GEN-MAIN", name: "Central store" }], sources: [] }),
      "GET /stores/search": () => json({ items: [{ id: "i1", code: "EL-DRL-0001", name: "Electric drill", baseUom: "piece", trackMode: "durable" }] }),
      "POST /stores/gate-passes": () => json({ ...PASS, status: "raised" }),
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresPasses />);
    await user.click(await screen.findByRole("button", { name: "New pass" }));
    await user.type(await screen.findByLabelText("To whom"), "Sharma Electricals");
    await user.type(screen.getByRole("searchbox"), "dri");
    await user.click(await screen.findByRole("button", { name: "Electric drill" }));
    await user.click(screen.getByRole("button", { name: "Raise pass" }));
    expect(await screen.findByText("Pass raised")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print pass" })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ kind: "returnable", storeId: "g1", purpose: "repair", party: "Sharma Electricals", lines: [{ itemId: "i1", qty: 1 }] });
  });
});
