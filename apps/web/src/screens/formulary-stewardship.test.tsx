import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { FormularyStewardship } from "./formulary-stewardship";

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init?: RequestInit) => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${new URL(raw, "http://localhost").pathname}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(init) : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function patched(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "PATCH" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const HIT = { id: "m-mero", name: "Meronem 1 g", form: "injection", strength: "1 g", code: null, routeClass: "systemic", salts: ["meropenem"], prefix: true, reviewed: true };

/**
 * PHARMACY STAGE D5 — /formulary/admin's stewardship editor: find a product, read its WHO AWaRe class and restriction,
 * change them, save through the medicine PATCH (`formulary.manage`).
 */
describe("the formulary's antimicrobial stewardship editor (pharmacy stage D5)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads a product's class and restriction, and saves what the pharmacist changes", async () => {
    let stored = { id: "m-mero", brandName: "Meronem 1 g", awareCategory: "Watch", antimicrobialRestricted: true };
    mockRoutes({
      "GET /api/formulary/medicines/search": { status: 200, body: { items: [HIT] } },
      "GET /api/formulary/medicines/m-mero/stewardship": () => ({ status: 200, body: stored }),
      "PATCH /api/formulary/medicines/m-mero": (init) => {
        stored = { ...stored, ...(JSON.parse(String(init?.body)) as object) };
        return { status: 200, body: { ok: true } };
      },
    });
    renderWithProviders(<FormularyStewardship />);
    await userEvent.type(screen.getByTestId("stewardship-search"), "mero");
    await userEvent.click(await screen.findByTestId("stewardship-hit-m-mero"));
    const aware = await screen.findByTestId("stewardship-aware");
    expect(aware).toHaveValue("Watch");
    expect(screen.getByTestId("stewardship-restricted")).toBeChecked();
    await userEvent.selectOptions(aware, "Reserve");
    await userEvent.click(screen.getByTestId("stewardship-restricted"));
    await userEvent.click(screen.getByTestId("stewardship-save"));
    await waitFor(() => expect(patched("/formulary/medicines/m-mero")).toEqual([{ awareCategory: "Reserve", antimicrobialRestricted: false }]));
    expect(await screen.findByTestId("stewardship-saved")).toHaveTextContent("Saved Meronem 1 g");
  });
});
