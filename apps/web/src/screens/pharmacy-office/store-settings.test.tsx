import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import i18next from "../../lib/i18n";
import { renderWithProviders, renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import { StoreSettingsView } from "./store-settings";

/**
 * OWNER RULING 2026-09-30 — "the system should recommend to enforce two different people later via
 * settings screen but currently admin login can do both." The Stores settings page carries the switch,
 * OFF by default, with the recommendation beside it; it is a page of the office's Stock menu for a
 * holder of `materials.stores.manage` and for nobody else.
 */
type Settings = { grnQcNeedsSecondPerson: boolean; updatedBy: string | null; updatedAt: string | null };

function mock(perms: string[], initial = false): { puts: unknown[] } {
  let current: Settings = { grnQcNeedsSecondPerson: initial, updatedBy: null, updatedAt: null };
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-head" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/pharmacy/office/needs") return json({ rows: [], sides: [], money: null, copilot: { po: null, pay: null, returns: null } });
    if (path === "/materials/settings" && (init?.method ?? "GET") === "GET") return json({ settings: current });
    if (path === "/materials/settings" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { grnQcNeedsSecondPerson: boolean };
      puts.push(body);
      current = { grnQcNeedsSecondPerson: body.grnQcNeedsSecondPerson, updatedBy: "u-head", updatedAt: "2026-09-30T06:00:00Z" };
      return json({ settings: current });
    }
    return new Response("{}", { status: 404 });
  }));
  return { puts };
}

describe("Stores settings — the two-person GRN switch (owner ruling 2026-09-30)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("is OFF by default, carries the recommendation, and one tap turns it on and says what is now true", async () => {
    const { puts } = mock(["materials.stores.manage"]);
    renderWithProviders(<StoreSettingsView />);
    const sw = await screen.findByRole("switch", { name: "Require a different person to QC a goods receipt than the one who captured it" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("setting-grn-two-person-recommend")).toHaveTextContent(
      "Recommended: turn this on once a second trained person (pharmacist or storekeeper) is on every shift.",
    );

    await userEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(puts).toEqual([{ grnQcNeedsSecondPerson: true }]);
    expect(screen.getByRole("status")).toHaveTextContent("a different person must now check each goods receipt");
  });

  it("is a page of the office's Stock menu for a holder of materials.stores.manage, and absent for a storekeeper", async () => {
    mock(["materials.stores.manage", "materials.stock.read"]);
    const { unmount } = renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=stock&page=settings");
    const frame = await screen.findByTestId("office-page-stock");
    expect(await within(frame).findByRole("heading", { level: 1, name: i18next.t("storeSettings.title") })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("office-view-stock"));
    expect(within(await screen.findByTestId("office-drop-stock")).getByTestId("office-entry-settings")).toHaveTextContent("Stores settings");
    unmount();
    vi.unstubAllGlobals();

    mock(["materials.stock.read", "materials.grn.capture"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("office-view-stock"));
    const drop = await screen.findByTestId("office-drop-stock");
    expect(within(drop).queryByTestId("office-entry-settings")).toBeNull();
    expect(within(drop).getByTestId("office-entry-grn")).toBeInTheDocument();
  });
});
