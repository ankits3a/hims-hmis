import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { PharmacyOffice } from "../pharmacy-office/pharmacy-office";

/**
 * ACCEPTANCE — issue #1063, spec docs/specs/1063-expiry-action-list.md (owner APPROVED 2026-11-14): the web half.
 * The office page "Expiring: act now" (`/pharmacy/office?view=returns&page=expiring`): D3's tap on Move and D5's
 * run strip (last run, next run, batches checked, Run now). The server half, every D:
 * apps/core/src/modules/pharmacy/acceptance/expiry-action-list-1063.test.ts.
 *
 * The page reads no clock; the instants below are the server's, shown in IST.
 */
type Run = { lastRunAt: string | null; lastTrigger: "schedule" | "run_now" | null; batchesChecked: number | null; returnsCreated: number | null; returnsExtended: number | null; linesAdded: number | null; nextRunAt: string };

const MOVE_ROW = {
  key: "st-retail|bt-walkin", storeResourceId: "st-retail", storeCode: "PHARM-RETAIL", storeName: "Walk-in counter", counter: "retail", tray: null,
  itemId: "it-calpol", itemCode: "CALP500", itemName: "Calpol 500 tablet", baseUom: "tablet", pack: { uom: "strip", multiplier: 10 },
  batchId: "bt-walkin", batchNo: "CA-WALKIN", expiryDate: "2027-06-30", daysToExpiry: 177, expired: false,
  qtyBase: 200, actionQtyBase: 200, costPerBasePaise: 500, valuePaise: 100_000, estimated: false,
  vendorId: "v-acme", supplierName: "ACME Pharma Distributors", supplierKind: "supplier",
  action: "move", why: "other_counter_sells", returnableUntil: null,
  moveTo: { storeResourceId: "st-opd", storeCode: "PHARM-OPD", storeName: "OPD pharmacy counter" }, document: null, salesPerDay: 0,
};

function listOf(run: Run, moveRows: unknown[]): unknown {
  const empty = { count: 0, valuePaise: 0, estimated: false, rows: [] };
  return {
    asOf: "2027-01-04", horizonDays: 180, salesWindowDays: 90, batchesChecked: run.batchesChecked ?? 0,
    groups: {
      return: empty, at_risk: empty, write_off: empty,
      move: { count: moveRows.length, valuePaise: moveRows.length * 100_000, estimated: false, rows: moveRows },
    },
    ndps: empty, run,
  };
}

const MONDAY: Run = {
  lastRunAt: "2027-01-04T01:30:00.000Z", lastTrigger: "schedule", batchesChecked: 12, returnsCreated: 1, returnsExtended: 0, linesAdded: 3,
  nextRunAt: "2027-01-11T01:30:00.000Z",
};
const RERUN: Run = { ...MONDAY, lastRunAt: "2027-01-06T05:00:00.000Z", lastTrigger: "run_now", batchesChecked: 15, returnsCreated: 0 };

type Call = { path: string; method: string; body: unknown };

function mock(state: { list: unknown; after?: unknown }, calls: Call[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    calls.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (path === "/auth/me") {
      return json({
        actor: { type: "user", id: "u-head" },
        permissions: { hospital: ["materials.returns.manage", "materials.stock.issue", "materials.stock.read", "materials.writeoffs.manage"], scoped: { department: {}, floor: {} } },
      });
    }
    if (path === "/pharmacy/office/needs") return json({ rows: [], sides: [], money: null, copilot: { po: null, pay: null, returns: null } });
    if (path === "/pharmacy/office/expiry-actions" && method === "GET") return json(state.list);
    if (path === "/pharmacy/office/expiry-actions/run" && method === "POST") {
      state.list = state.after ?? state.list;
      return json({ run: { ran: true }, list: state.list });
    }
    if (path === "/pharmacy/office/expiry-actions/move" && method === "POST") {
      state.list = state.after ?? state.list;
      return json({ transferId: "tr-1" });
    }
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("#1063 — expiring: act now (web)", () => {
  it("spec #1063 D5: the page shows last run, next run and batches checked; Run now reruns and updates them", async () => {
    const calls: Call[] = [];
    mock({ list: listOf(MONDAY, []), after: listOf(RERUN, []) }, calls);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=returns&page=expiring");

    expect(await screen.findByTestId("expiring-last-run")).toHaveTextContent("4 Jan");
    expect(screen.getByTestId("expiring-next-run")).toHaveTextContent("11 Jan");
    expect(screen.getByTestId("expiring-checked")).toHaveTextContent("12");

    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(screen.getByTestId("expiring-last-run")).toHaveTextContent("6 Jan"));
    expect(screen.getByTestId("expiring-checked")).toHaveTextContent("15");
    expect(calls.filter((c) => c.path === "/pharmacy/office/expiry-actions/run" && c.method === "POST")).toHaveLength(1);
  });

  it("spec #1063 D3: a batch listed under Move has a Move button, and tapping it drafts the transfer to the other counter", async () => {
    const calls: Call[] = [];
    mock({ list: listOf(MONDAY, [MOVE_ROW]), after: listOf(MONDAY, []) }, calls);
    renderWithRouter(<PharmacyOffice />, "/pharmacy/office?view=returns&page=expiring");

    const row = await screen.findByTestId(`expiring-row-${MOVE_ROW.key}`);
    expect(row).toHaveTextContent("Calpol 500 tablet");
    expect(row).toHaveTextContent("CA-WALKIN");
    await userEvent.click(within(row).getByTestId(`expiring-move-${MOVE_ROW.batchId}`));
    await waitFor(() => expect(calls.some((c) => c.path === "/pharmacy/office/expiry-actions/move")).toBe(true));
    const post = calls.find((c) => c.path === "/pharmacy/office/expiry-actions/move")!;
    expect(post.method).toBe("POST");
    expect(post.body).toEqual({ storeResourceId: "st-retail", batchId: "bt-walkin" });
    await waitFor(() => expect(screen.queryByTestId(`expiring-row-${MOVE_ROW.key}`)).toBeNull());
  });
});
