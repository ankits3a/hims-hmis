import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { StoresDesk } from "./stores-desk";

/** STORES S1 (#1111) — `/stores`: six tabs for the materials head, a dry-run import table, and "No permission" otherwise. */
type Call = { method: string; path: string; body: unknown };

function mock(hospital: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });
    if (path === "/stores/categories") return json({ categories: [{ id: "c1", code: "HSK", name: "Housekeeping and sanitation", nameHi: null, parentId: null, active: true }] });
    if (path === "/stores/items") return json({ items: [] });
    if (path === "/stores/my-shelves") return json({ shelves: [] });
    if (path === "/stores/items/import") {
      return json({ dryRun: true, created: 0, wouldCreate: 1, refusals: [{ row: 2, code: "duplicate_item", message: "looks like \"Wet mop refill\", already on the master" }] });
    }
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the Stores desk", () => {
  it("shows the six tabs and a dry-run table that names each refused row", async () => {
    const calls = mock(["stores.masters.manage"]);
    const user = userEvent.setup();
    renderWithRouter(<StoresDesk />);
    expect(await screen.findByRole("tab", { name: "Categories" })).toBeInTheDocument();
    for (const name of ["Items", "Stores", "Shelves", "Par", "New items"]) expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    expect(await screen.findByRole("cell", { name: "Housekeeping and sanitation" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Items" }));
    await user.click(await screen.findByText("Import items"));
    await user.type(screen.getByRole("textbox", { name: "Import items" }), "IMP-1,Floor wiper,consumable,piece,HSK,shelf{enter}IMP-2,Wet mop refil,consumable,piece,HSK,shelf");
    await user.click(screen.getByRole("button", { name: "Check sheet" }));
    const table = await screen.findByTestId("stores-import-result");
    expect(table).toHaveTextContent("Ready to add: 1");
    expect(table).toHaveTextContent("2");
    expect(table).toHaveTextContent("Wet mop refill");
    await waitFor(() => expect(calls.find((c) => c.path === "/stores/items/import")?.body).toMatchObject({ dryRun: true }));
  });

  it("a person with no Stores grant and no shelf reads No permission", async () => {
    mock([]);
    renderWithRouter(<StoresDesk />);
    expect(await screen.findByText("No permission")).toBeInTheDocument();
  });
});
