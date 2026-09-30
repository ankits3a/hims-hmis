import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { previewLine } from "../../lib/trays-api";
import { renderWithRouter } from "../../test-utils";
import { TrayChecksView } from "./trays";
import type { WireTray, WireTrayCheck } from "../../lib/trays-api";

/**
 * PHARMACY STAGE D4 — the emergency trays as an office page: each tray with today's seal check and this month's
 * full check, the check sheet pre-filled at par (it previews short and expiring; the server decides), "Restock from
 * pharmacy" on a deficient tray, "Receive restock" while it is on its way, and the list editor for the in-charge only.
 */
type Call = { method: string; path: string; body: unknown };
function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const TRAY: WireTray = {
  id: "t-1", code: "TRAY-OT-1", name: "OT-1 crash tray", location: "OT-1", custodianRoles: ["ot_nurse"],
  template: [
    { id: "l1", itemId: "i-adr", itemCode: "ADR1", itemName: "Adrenaline 1 mg/mL", baseUom: "ampoule", parQty: 5, minExpiryDays: null, active: true },
    { id: "l2", itemId: "i-atr", itemCode: "ATR06", itemName: "Atropine 0.6 mg", baseUom: "ampoule", parQty: 4, minExpiryDays: null, active: true },
  ],
  daily: "missed", monthly: "done",
  lastCheck: { id: "c-9", no: "TC-000009", kind: "monthly_full", result: "deficient", findings: ["short"], checkedAt: "2026-09-27T05:00:00.000Z", restock: null },
  needsRestock: true, expectedSeal: "S-100", expiring: [],
};
const HISTORY: WireTrayCheck[] = [{
  ...TRAY.lastCheck!, trayId: "t-1", sealSeen: "S-99", sealNew: "S-100", note: null, event: null, patientId: null,
  checkedByName: "Sister Rao", restockedByName: null,
  lines: [{ itemId: "i-adr", itemName: "Adrenaline 1 mg/mL", parQty: 5, qtyPresent: 3, earliestExpiry: "2027-01-31", batchNo: null, qtyExpiring: 0, qtyUsed: 0, qtyRestock: 2 }],
}];
const ROUTES = {
  "GET /pharmacy/trays": { items: [TRAY] },
  "GET /pharmacy/trays/t-1/checks": { items: HISTORY },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the emergency trays (pharmacy stage D4)", () => {
  it("previews short and expiring the way the server decides them", () => {
    const line = { parQty: 5, minExpiryDays: null };
    expect(previewLine(line, 4, "", "2026-09-28")).toEqual({ short: true, expiring: false });
    expect(previewLine(line, 5, "2026-10-28", "2026-09-28")).toEqual({ short: false, expiring: true });
    expect(previewLine(line, 5, "2026-10-29", "2026-09-28")).toEqual({ short: false, expiring: false });
    expect(previewLine(line, 0, "2026-10-01", "2026-09-28")).toEqual({ short: true, expiring: false });
    expect(previewLine({ parQty: 5, minExpiryDays: 90 }, 5, "2026-12-01", "2026-09-28")).toEqual({ short: false, expiring: true });
  });

  it("a checker sees the tray's state, records a full check pre-filled at par, restocks the deficient tray and cannot edit its list", async () => {
    const calls = mock({
      ...ROUTES,
      "POST /pharmacy/trays/checks": { checkId: "c-10", no: "TC-000010", result: "deficient", findings: ["short"], consumed: 0, deficit: 1 },
      "POST /pharmacy/trays/checks/c-9/restock": { transferId: "tr-1", units: 2 },
    }, ["pharmacy.trays.check"]);
    renderWithRouter(<TrayChecksView />);
    expect(await screen.findByTestId("tray-daily-TRAY-OT-1")).toHaveTextContent("missed");
    expect(screen.getByTestId("tray-deficient-TRAY-OT-1")).toHaveTextContent("TC-000009 deficient");
    expect(await screen.findByTestId("tray-history-TC-000009")).toHaveTextContent("Adrenaline 1 mg/mL 3/5");
    expect(screen.queryByTestId("tray-edit-TRAY-OT-1")).toBeNull();
    expect(screen.queryByTestId("tray-add")).toBeNull();

    await userEvent.click(screen.getByTestId("tray-restock-TRAY-OT-1"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/pharmacy/trays/checks/c-9/restock")).toBe(true));
    expect(await screen.findByTestId("tray-notice")).toHaveTextContent("2 units");

    await userEvent.click(screen.getByTestId("tray-check-TRAY-OT-1-monthly_full"));
    expect(screen.getByTestId("tray-present-ADR1")).toHaveValue("5");
    await userEvent.clear(screen.getByTestId("tray-present-ATR06"));
    await userEvent.type(screen.getByTestId("tray-present-ATR06"), "3");
    expect(screen.getByTestId("tray-short-ATR06")).toBeInTheDocument();
    expect(screen.queryByTestId("tray-short-ADR1")).toBeNull();
    await userEvent.type(screen.getByTestId("tray-seal-new"), "S-101");
    await userEvent.click(screen.getByTestId("tray-check-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/pharmacy/trays/checks")).toBe(true));
    const body = calls.find((c) => c.method === "POST" && c.path === "/pharmacy/trays/checks")?.body as Record<string, unknown>;
    expect(body).toEqual({
      trayId: "t-1", kind: "monthly_full", sealSeen: null, sealNew: "S-101",
      lines: [{ itemId: "i-adr", qtyPresent: 5, earliestExpiry: null }, { itemId: "i-atr", qtyPresent: 3, earliestExpiry: null }],
      note: null,
    });
    // The client never sends a result: the server decides it.
    expect(body).not.toHaveProperty("result");
  });

  it("a daily check warns when the seal differs; a restock on its way offers the keeper the receipt", async () => {
    const calls = mock({
      "GET /pharmacy/trays": { items: [{ ...TRAY, needsRestock: false, lastCheck: { ...TRAY.lastCheck!, restock: { transferId: "tr-1", status: "in_transit", restockedAt: "2026-09-27T06:00:00.000Z" } } }] },
      "GET /pharmacy/trays/t-1/checks": { items: [] },
      "POST /pharmacy/trays/checks/c-9/receive": { status: "received" },
    }, ["pharmacy.trays.check"]);
    renderWithRouter(<TrayChecksView />);
    expect(await screen.findByTestId("tray-transit-TRAY-OT-1")).toBeInTheDocument();
    expect(screen.queryByTestId("tray-restock-TRAY-OT-1")).toBeNull();
    await userEvent.click(screen.getByTestId("tray-receive-TRAY-OT-1"));
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/trays/checks/c-9/receive")).toBe(true));

    await userEvent.click(screen.getByTestId("tray-check-TRAY-OT-1-daily_seal"));
    expect(screen.getByTestId("tray-check-save")).toBeDisabled();
    await userEvent.type(screen.getByTestId("tray-seal-seen"), "S-107");
    expect(screen.getByTestId("tray-seal-warn")).toBeInTheDocument();
    expect(screen.queryByTestId("tray-present-ADR1")).toBeNull();
  });

  it("the in-charge sets up a tray with its keepers and adds to its list", async () => {
    const calls = mock({
      ...ROUTES,
      "POST /pharmacy/trays": { trayId: "t-2", code: "TRAY-CT" },
      "GET /pharmacy/trays/items": { items: [{ id: "i-hyd", code: "HYD100", name: "Hydrocortisone 100 mg", baseUom: "vial" }] },
      "POST /pharmacy/trays/t-1/template": { templateId: "l3" },
    }, ["pharmacy.trays.manage"]);
    renderWithRouter(<TrayChecksView />);
    await userEvent.click(await screen.findByTestId("tray-add"));
    await userEvent.type(screen.getByTestId("tray-name"), "CT tray");
    await userEvent.type(screen.getByTestId("tray-location"), "CT room");
    expect(screen.getByTestId("tray-new-save")).toBeDisabled(); // no keeper yet
    await userEvent.click(screen.getByTestId("tray-keeper-radiographer"));
    await userEvent.click(screen.getByTestId("tray-new-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/pharmacy/trays")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.path === "/pharmacy/trays")?.body).toEqual({ name: "CT tray", location: "CT room", custodianRoles: ["radiographer"] });

    expect(screen.queryByTestId("tray-check-TRAY-OT-1-daily_seal")).toBeNull(); // manage alone does not check
    await userEvent.click(await screen.findByTestId("tray-edit-TRAY-OT-1"));
    await userEvent.type(screen.getByTestId("tray-item-search"), "hydro");
    await userEvent.click(await screen.findByText("Hydrocortisone 100 mg"));
    await userEvent.type(screen.getByTestId("tray-item-par"), "2");
    await userEvent.click(screen.getByTestId("tray-item-add"));
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/trays/t-1/template")).toBe(true));
    expect(calls.find((c) => c.path === "/pharmacy/trays/t-1/template")?.body).toEqual({ itemId: "i-hyd", parQty: 2 });
  });
});
