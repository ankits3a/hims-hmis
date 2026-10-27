import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LinenSetup } from "./linen-setup";
import type { LinenSetupView } from "@hmis/contracts";

/** LD-2 setup (#1014) — vendors with rates and turnaround, item cost, the two plant licences, uniform roles; no API needed. */
const view: LinenSetupView = {
  serverNow: new Date().toISOString(),
  vendors: [{ id: "v1", name: "Clean Wash", turnaroundHours: 24, rushTurnaroundHours: 12, gstRateBps: 1800, rates: [{ itemCode: "bedsheet", ratePaise: 1200, effectiveFrom: "2026-10-01" }] }],
  items: [{ code: "bedsheet", name: "Bedsheet", stream: "ward", pricePaise: null, materialsItemId: null }, { code: "towel", name: "Towel", stream: "ward", pricePaise: 25_000, materialsItemId: "m1" }],
  licences: [{ id: "l1", kind: "boiler", licenceNo: "IBR/77", authority: "Boilers", validTo: "2026-12-01", daysLeft: 35, state: "red" }],
  uniformRoles: ["nurse", "ward_nurse"],
};

describe("LinenSetup (LD-2, #1014)", () => {
  let posts: { url: string; body: unknown }[];
  let perms: string[];
  beforeEach(() => {
    setToken("t");
    posts = [];
    perms = ["linen.vendor", "linen.manage"];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posts.push({ url: raw, body: JSON.parse(String(init.body)) });
      const body = raw.endsWith("/linen/setup") ? view
        : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }
          : { id: "x" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a vendor shows its terms and rates; a new rate posts paise from a date; terms post hours and GST in basis points", async () => {
    renderWithProviders(<LinenSetup />);
    const box = await screen.findByTestId("setup-vendor-v1");
    expect(box).toHaveTextContent("24 h · rush 12 h · GST 18%");
    expect(screen.getByTestId("rates-v1")).toHaveTextContent("₹12");
    fireEvent.change(screen.getByTestId("rate-rupees-v1"), { target: { value: "15.5" } });
    fireEvent.change(screen.getByTestId("rate-from-v1"), { target: { value: "2026-11-01" } });
    fireEvent.click(screen.getByTestId("rate-save-v1"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toMatch(/\/linen\/vendors\/v1\/rates$/);
    expect(posts[0]!.body).toEqual({ itemCode: "bedsheet", ratePaise: 1550, effectiveFrom: "2026-11-01" });
    fireEvent.change(screen.getByTestId("routine-v1"), { target: { value: "48" } });
    fireEvent.click(screen.getByTestId("terms-save-v1"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.url).toMatch(/\/linen\/vendors\/v1$/);
    expect(posts[1]!.body).toEqual({ turnaroundHours: 48, rushTurnaroundHours: 12, gstRateBps: 1800 });
  });

  it("adds a vendor, sets an item's cost, files a licence and adds a uniform role", async () => {
    renderWithProviders(<LinenSetup />);
    fireEvent.change(await screen.findByTestId("vendor-name"), { target: { value: "Second Laundry" } });
    fireEvent.click(screen.getByTestId("vendor-add"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ name: "Second Laundry", turnaroundHours: 24, rushTurnaroundHours: 12, gstRateBps: 1800 });
    expect(screen.getByTestId("cost-bedsheet")).toHaveTextContent("Bedsheet");
    expect(screen.getByTestId("cost-towel")).toHaveTextContent("from stores receipt");
    fireEvent.change(screen.getByTestId("cost-in-bedsheet"), { target: { value: "400" } });
    fireEvent.click(screen.getByTestId("cost-save-bedsheet"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ url: expect.stringMatching(/\/linen\/items\/bedsheet\/cost$/), body: { pricePaise: 40_000 } });
    expect(screen.getByTestId("setup-licence-boiler")).toHaveTextContent("35 days left");
    expect(screen.getByTestId("setup-licence-etp_consent")).toHaveTextContent("Not filed");
    const save = screen.getByTestId("licence-save");
    fireEvent.change(screen.getByTestId("licence-no"), { target: { value: "SPCB/ETP/1" } });
    fireEvent.change(screen.getByTestId("licence-authority"), { target: { value: "State Pollution Control Board" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("licence-to"), { target: { value: "2030-03-31" } });
    fireEvent.click(save);
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]!.body).toMatchObject({ kind: "etp_consent", licenceNo: "SPCB/ETP/1", validTo: "2030-03-31" });
    fireEvent.change(screen.getByTestId("role-key"), { target: { value: "lab_technician" } });
    fireEvent.click(screen.getByTestId("role-add"));
    await waitFor(() => expect(posts).toHaveLength(4));
    expect(posts[3]!.body).toEqual({ roleKey: "lab_technician", entitled: true });
  });

  it("uniform roles are shown only to linen.manage holders (the door's permission)", async () => {
    perms = ["linen.vendor"];
    renderWithProviders(<LinenSetup />);
    await screen.findByTestId("setup-vendor-v1");
    expect(screen.queryByTestId("setup-roles")).toBeNull();
  });
});
