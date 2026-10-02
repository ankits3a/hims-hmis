import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders, renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "./pharmacy-office";
import { DeskSettingsView } from "./desk-settings";

/**
 * OWNER RULING 2026-10-02 — "add a toggle for admin to enable a quick desk mode for pharmacy desk
 * screen". The Desk mode page carries the switch, OFF by default, and says which three checks stand
 * down and what the law asks; it is a page of the office's Law menu for a holder of
 * `pharmacy.licences.manage` and for nobody else.
 */
type Settings = { quickDesk: boolean; updatedBy: string | null; updatedAt: string | null };

function mock(perms: string[]): { puts: unknown[] } {
  let current: Settings = { quickDesk: false, updatedBy: null, updatedAt: null };
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-admin" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/pharmacy/office/needs") return json({ rows: [], sides: [], money: null, copilot: { po: null, pay: null, returns: null } });
    if (path === "/pharmacy/settings" && (init?.method ?? "GET") === "GET") return json({ settings: current });
    if (path === "/pharmacy/settings" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { quickDesk: boolean };
      puts.push(body);
      current = { quickDesk: body.quickDesk, updatedBy: "u-admin", updatedAt: "2026-10-02T06:00:00Z" };
      return json({ settings: current });
    }
    return new Response("{}", { status: 404 });
  }));
  return { puts };
}

describe("Desk mode — the quick desk switch (owner ruling 2026-10-02)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("is OFF by default, names the three checks and the law, and one tap turns it on and says so", async () => {
    const { puts } = mock(["pharmacy.licences.manage"]);
    renderWithProviders(<DeskSettingsView />);
    const sw = await screen.findByRole("switch", { name: "Quick desk mode" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    const box = screen.getByTestId("setting-quick-desk");
    expect(within(box).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByTestId("setting-quick-desk-law")).toHaveTextContent("Pharmacy Act (section 42)");

    await userEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(puts).toEqual([{ quickDesk: true }]);
    expect(screen.getByRole("status")).toHaveTextContent("quick desk mode is on");
  });

  it("is a page of the office's Law menu for a holder of pharmacy.licences.manage, and absent for a pharmacist", async () => {
    mock(["pharmacy.licences.manage"]);
    const { unmount } = renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=law&page=desk");
    expect(await screen.findByTestId("desk-settings")).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();

    mock(["pharmacy.register.read", "pharmacy.pharmacists.manage"]);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office");
    await userEvent.click(await screen.findByTestId("office-view-law"));
    const drop = await screen.findByTestId("office-drop-law");
    expect(within(drop).queryByTestId("office-entry-desk")).toBeNull();
  });
});
