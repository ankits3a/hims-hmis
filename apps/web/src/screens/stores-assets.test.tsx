import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresAssetPassport, StoresTagUnits } from "./stores-assets";
import type { WireAssetPassportForeign, WireTagLine } from "@hmis/contracts";

/** STORES S4a (#1114) — the passport's other faces: a foreign unit, an empty department, tagging a GRN line. */
type Call = { method: string; path: string; body: unknown };

const FOREIGN: WireAssetPassportForeign = {
  access: "foreign", tagReplaced: false, unit: { id: "u9", tagNo: "AST2611000009", name: "Infusion pump" }, belongsTo: { departmentId: "d2", departmentName: "Ward 4" },
};
const LINE: WireTagLine = { grnLineId: "gl1", grnNo: "GRN2611090001", itemId: "i1", itemName: "Patient monitor", qty: 2, tagged: 0, decision: "tagged", units: [] };

function mock(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [path] = raw.replace(/^.*\/api/, "").split("?") as [string];
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: { d1: ["stores.shelf.work"] }, floor: {} } } });
    const hit = routes[`${method} ${path}`];
    return hit === undefined ? new Response("{}", { status: 404 }) : json(hit);
  }));
  return calls;
}

beforeEach(() => { setToken("t"); window.innerWidth = 390; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the asset passport, beyond the acceptance pair (spec #1114)", () => {
  it("another department's unit shows Belongs to and Found here, and no cost or history", async () => {
    const calls = mock({
      "GET /stores/assets/mine": { rows: [] }, "GET /stores/assets/lookup": FOREIGN,
      "GET /stores/my-shelves": { shelves: [{ id: "s1", code: "ICU-F1", name: "ICU shelf", departmentId: "d1" }] },
      "POST /stores/assets/u9/found-here": { told: 1 },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresAssetPassport />);
    await user.type(await screen.findByLabelText("Type last 4"), "0009");
    const card = await screen.findByTestId("asset-foreign");
    expect(within(card).getByText("Belongs to Ward 4")).toBeInTheDocument();
    expect(within(card).queryByText("Cost")).toBeNull();
    expect(within(card).queryByText("Last events")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Found here" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ward 4 told"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ shelfId: "s1" });
  });

  it("a department with no tagged units says so", async () => {
    mock({ "GET /stores/assets/mine": { rows: [] } });
    renderWithRouter(<StoresAssetPassport />);
    expect(await screen.findByText("No tagged assets")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("Tag units: one serial box per unit owed; Tag and print sends them and says Labels printed", async () => {
    const calls = mock({
      "GET /stores/assets/grns": { lines: [LINE] },
      "POST /stores/assets/tag": { units: [{ id: "a", tagNo: "AST2611000001" }, { id: "b", tagNo: "AST2611000002" }], line: { ...LINE, tagged: 2 } },
    });
    const user = userEvent.setup();
    renderWithRouter(<StoresTagUnits />);
    await user.click(await screen.findByRole("button", { name: "Tag 2 units" }));
    await user.type(screen.getByLabelText("Serial (scan or type) 1"), "SN-1");
    await user.click(screen.getByRole("button", { name: "Tag and print" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Labels printed"));
    expect(calls.find((c) => c.method === "POST" && c.path === "/stores/assets/tag")?.body).toEqual({ grnLineId: "gl1", units: [{ serial: "SN-1" }, { serial: null }] });
  });
});
