import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders, renderWithRouter } from "../../test-utils";
import { PharmacyDesk } from "../pharmacy-desk/pharmacy-desk";
import { resetDeskLog } from "../pharmacy-desk/log";
import { resetPaperNotice } from "../pharmacy-desk/paper";
import { PharmacyRetail } from "../pharmacy-retail";
import { PharmacyOfficeReports } from "../pharmacy-office/pharmacy-office";
import type { WireDispense, WireDispenseLine, WireRetailShelfEntry, WireRetailState } from "../../lib/pharmacy-api";

/**
 * ACCEPTANCE — issue #1064, spec docs/specs/1064-lost-demand.md (owner APPROVED 2026-11-14): the screens' half.
 * The desk's decline has a short reason list and "Not in stock" is the one that records demand (the server's half is
 * apps/core/src/modules/pharmacy/acceptance/lost-demand-1064.test.ts); the walk-in counter notes a medicine asked for
 * in one tap; the office's reports carry Missed sales.
 */
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<typeof import("@tanstack/react-router")>()), useNavigate: () => navigate }));

type Reply = { status: number; body: unknown };
type Handler = Reply | ((url: URL, init?: RequestInit) => Reply);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://localhost");
    const handler = handlers[`${init?.method ?? "GET"} ${url.pathname}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(url, init) : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function bodies(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}
function gets(path: string): string[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === "GET" && String(input).split("?")[0]!.endsWith(path))
    .map(([input]) => String(input));
}

// ── the OPD desk ──
const ME = "u-anita";
const lineOf = (lineIdx: number, drug: string, itemId: string): WireDispenseLine => ({
  lineIdx, rxLine: { drug, medicineId: `m-${itemId}`, dose: "1 tab", route: "oral", frequency: "1-0-0", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: null,
  orderedMedicine: { id: `m-${itemId}`, brandName: drug, strengthLabel: null, form: "tablet" }, dispensedMedicine: { id: `m-${itemId}`, brandName: drug, strengthLabel: null, form: "tablet", scheduleFlag: null },
  item: { id: itemId, code: itemId.toUpperCase(), name: `${drug} tablet`, baseUom: "tablet", uoms: [] }, saleable: true, available: 0, batchId: null,
  reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false,
  pickNote: null, partlyChecked: false, batches: [], pickedBatch: null,
});
function dispense(lines: WireDispenseLine[]): WireDispense {
  return {
    id: "d1", status: "claimed", dispenseNo: "P2611140004", orderId: "o1", prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: null, billedAt: null, handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U004", name: "Kamla Bai", alias: null, restricted: false }, allergies: [], lines,
  };
}
const desk = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/print": { status: 200, body: { jobs: [] } },
  ...extra,
});
/** The decline answered as the server would: the line declined with the words sent. */
function declining(get: () => WireDispense, set: (d: WireDispense) => void, lineIdx: number): Handler {
  return (_url, init) => {
    const { reason } = JSON.parse(String(init?.body)) as { reason: string };
    const d = get();
    set({ ...d, lines: d.lines.map((l) => (l.lineIdx === lineIdx ? { ...l, status: "declined", declinedReason: reason } : l)) });
    return { status: 201, body: get() };
  };
}

describe("#1064 — the desk's decline", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); resetPaperNotice(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("spec #1064 D1: the decline sheet's 'Not in stock' sends the reason code that records the demand, and no separate short-book note", async () => {
    let current = dispense([lineOf(0, "Pan 40", "it-pan")]);
    mockRoutes(desk(() => current, { "POST /api/pharmacy/dispenses/d1/lines/0/decline": declining(() => current, (d) => { current = d; }, 0) }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Pan 40/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Decline this line" }));
    await userEvent.click(await screen.findByTestId("desk-line-0-why-notStocked"));
    await userEvent.click(screen.getByRole("button", { name: /^Decline/ }));
    await waitFor(() => expect(bodies("POST", "/lines/0/decline")).toEqual([{ reason: "not in stock", reasonCode: "not_in_stock" }]));
    expect(bodies("POST", "/pharmacy/short-book")).toEqual([]);
  });

  it("spec #1064 D2: the other reasons — patient declined, cost, other (typed) — send their own code, never not in stock", async () => {
    let current = dispense([lineOf(0, "Pan 40", "it-pan"), lineOf(1, "Cetzine 10", "it-cz"), lineOf(2, "Shelcal 500", "it-sh")]);
    mockRoutes(desk(() => current, {
      "POST /api/pharmacy/dispenses/d1/lines/0/decline": declining(() => current, (d) => { current = d; }, 0),
      "POST /api/pharmacy/dispenses/d1/lines/1/decline": declining(() => current, (d) => { current = d; }, 1),
      "POST /api/pharmacy/dispenses/d1/lines/2/decline": declining(() => current, (d) => { current = d; }, 2),
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);

    const first = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(first).getByRole("button", { name: /What else for Pan 40/ }));
    await userEvent.click(within(first).getByRole("button", { name: "Decline this line" }));
    await userEvent.click(await screen.findByTestId("desk-line-0-why-patientDeclined"));
    await userEvent.click(screen.getByRole("button", { name: /^Decline/ }));
    await waitFor(() => expect(bodies("POST", "/lines/0/decline")).toEqual([{ reason: "patient declined", reasonCode: "patient_declined" }]));

    const second = screen.getByTestId("desk-line-1");
    await userEvent.click(within(second).getByRole("button", { name: /What else for Cetzine 10/ }));
    await userEvent.click(within(second).getByRole("button", { name: "Decline this line" }));
    await userEvent.click(await screen.findByTestId("desk-line-1-why-cost"));
    await userEvent.click(screen.getByRole("button", { name: /^Decline/ }));
    await waitFor(() => expect(bodies("POST", "/lines/1/decline")).toEqual([{ reason: "cost too high", reasonCode: "cost" }]));

    const third = screen.getByTestId("desk-line-2");
    await userEvent.click(within(third).getByRole("button", { name: /What else for Shelcal 500/ }));
    await userEvent.click(within(third).getByRole("button", { name: "Decline this line" }));
    await userEvent.click(await screen.findByTestId("desk-line-2-why-other"));
    await userEvent.type(screen.getByRole("textbox", { name: /Why is Shelcal 500/ }), "doctor will change it");
    await userEvent.click(screen.getByRole("button", { name: /^Decline/ }));
    await waitFor(() => expect(bodies("POST", "/lines/2/decline")).toEqual([{ reason: "doctor will change it", reasonCode: "other" }]));
    expect(bodies("POST", "/pharmacy/short-book")).toEqual([]);
  });
});

// ── the walk-in counter ──
const CURRENT: WireRetailState = {
  storeCode: "PHARM-RETAIL", storePresent: true, state: "current", daysLeft: 400,
  licence: { id: "l1", form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni", note: null, recordedBy: "u", recordedAt: "2026-01-01T00:00:00.000Z" },
};
const CALPOL_NONE: WireRetailShelfEntry = {
  medicineId: "m-calp", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC",
  itemId: "i-calp", itemCode: "CALP500", itemName: "Calpol 500 tablet", baseUom: "tablet", available: 0, scannedBatchId: null,
};

describe("#1064 — the walk-in counter", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("spec #1064 D3: 'Note as asked for' is one tap from a search with no stock, with its quantity; a name not on the shelf is noted as typed", async () => {
    mockRoutes({
      "GET /api/pharmacy/retail/state": { status: 200, body: CURRENT },
      "GET /api/pharmacy/retail/sales": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/retail/shelf": (url) => ({ status: 200, body: { items: (url.searchParams.get("q") ?? "").toLowerCase().startsWith("calp") ? [CALPOL_NONE] : [] } }),
      "POST /api/pharmacy/retail/asked-for": (_url, init) => {
        const b = JSON.parse(String(init?.body)) as { itemId?: string; typedName?: string; qtyBase: number };
        return { status: 201, body: {
          demand: { id: "dm1", itemId: b.itemId ?? null, typedName: b.typedName ?? null, qtyAskedBase: b.qtyBase, source: "counter_search" },
          shortBook: b.itemId === undefined ? null : { created: true, entry: { id: "sb1", itemId: b.itemId, drugName: "Calpol 500 tablet", askedCount: 1 } },
        } };
      },
    });
    renderWithProviders(<PharmacyRetail />);
    const search = await screen.findByRole("combobox", { name: "Medicine name, item code, or scan the pack" });

    // A stocked medicine with none on this shelf: its row says so, and the note is one tap, at quantity 1 unless changed.
    await userEvent.type(search, "Calpol");
    const list = await screen.findByRole("listbox", { name: "On the walk-in shelf" });
    await within(list).findByRole("option", { name: /Calpol 500 tablet/ });
    const qty = within(list).getByRole("textbox", { name: "Quantity asked for" });
    expect(qty).toHaveValue("1");
    await userEvent.clear(qty);
    await userEvent.type(qty, "20");
    await userEvent.click(within(list).getByRole("button", { name: "Note as asked for" }));
    await waitFor(() => expect(bodies("POST", "/pharmacy/retail/asked-for")).toEqual([{ source: "counter_search", itemId: "i-calp", medicineId: "m-calp", qtyBase: 20 }]));
    expect(await screen.findByTestId("retail-asked-noted")).toHaveTextContent("Calpol 500 tablet noted as asked for");

    // A name the shelf does not know: noted as typed, in one tap.
    await userEvent.clear(search);
    await userEvent.type(search, "Ascoril LS");
    const empty = await screen.findByRole("listbox", { name: "On the walk-in shelf" });
    await within(empty).findByText("Not on the walk-in shelf.");
    await userEvent.click(within(empty).getByRole("button", { name: "Note as asked for" }));
    await waitFor(() => expect(bodies("POST", "/pharmacy/retail/asked-for")[1]).toEqual({ source: "counter_search", typedName: "Ascoril LS", qtyBase: 1 }));
  });
});

// ── the office's reports ──
const MISSED = {
  from: "2026-11-01", to: "2026-11-14", preset: "month",
  rows: [
    { itemId: "i-calp", itemCode: "CALP500", itemName: "Calpol 500 tablet", baseUom: "tablet", timesAsked: 2, qtyBase: 25, mrpUnitPaise: 900, estimatedValuePaise: 22_500, stockNow: 0, openPoBase: 20, lastAskedAt: "2026-11-14T05:00:00.000Z" },
    { itemId: "i-croc", itemCode: "CROC500", itemName: "Crocin 500 tablet", baseUom: "tablet", timesAsked: 1, qtyBase: 10, mrpUnitPaise: null, estimatedValuePaise: null, stockNow: 90, openPoBase: 0, lastAskedAt: "2026-11-13T05:00:00.000Z" },
  ],
  typed: [{ name: "Ascoril LS syrup", medicineId: null, timesAsked: 2, qtyBase: 3, lastAskedAt: "2026-11-14T06:00:00.000Z" }],
  totals: { timesAsked: 5, qtyBase: 38, estimatedValuePaise: 22_500 },
};
const meWith = (perms: string[]): Reply => ({ status: 200, body: { actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } } });
const STORES = { stores: [{ code: "PHARM-OPD", name: "OPD pharmacy" }, { code: "PHARM-RETAIL", name: "Walk-in retail pharmacy" }] };

describe("#1064 — Missed sales in the office's reports", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("spec #1064 D6: Missed sales lists each medicine with times asked, quantity, estimated value, stock now and open PO quantity, and the typed names apart", async () => {
    mockRoutes({
      "GET /api/auth/me": meWith(["pharmacy.reports.read", "pharmacy.reports.margin", "pharmacy.tally.export"]),
      "GET /api/pharmacy/office/reports/stores": { status: 200, body: STORES },
      "GET /api/pharmacy/office/reports/missed-sales": { status: 200, body: MISSED },
    });
    const first = renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    const list = await screen.findByTestId("reports-view");
    // The twenty-first report, on the next free letter.
    expect(within(list).getAllByRole("button")).toHaveLength(21);
    expect(within(within(list).getByTestId("report-missedSales")).getByText("V")).toBeTruthy();
    expect(within(list).getByTestId("report-missedSales")).toHaveTextContent("Missed sales");
    list.focus();
    await userEvent.keyboard("v");

    const table = await screen.findByTestId("missed-sales-table");
    await waitFor(() => expect(gets("/pharmacy/office/reports/missed-sales").some((u) => u.includes("preset=month"))).toBe(true));
    const calpol = within(table).getByTestId("missed-sales-table-row-i-calp");
    for (const s of ["Calpol 500 tablet", "225.00", "20"]) expect(calpol).toHaveTextContent(s);
    expect(within(calpol).getAllByRole("cell").map((c) => c.textContent)).toEqual(expect.arrayContaining(["2", "25", "0"]));
    const crocin = within(table).getByTestId("missed-sales-table-row-i-croc");
    expect(crocin).toHaveTextContent("Crocin 500 tablet");
    expect(within(crocin).getAllByRole("cell").map((c) => c.textContent)).toEqual(expect.arrayContaining(["1", "10", "—", "90"]));
    for (const h of ["Times asked", "Estimated value", "Stock now", "On order"]) expect(within(table).getByText(h)).toBeTruthy();

    const typed = screen.getByTestId("missed-sales-typed");
    expect(within(typed).getByTestId("missed-sales-typed-row-ascoril ls syrup")).toHaveTextContent("Ascoril LS syrup");
    expect(within(table).queryByText("Ascoril LS syrup")).toBeNull();
    first.unmount();

    // The sales report's right is enough: a reader without the margin right is offered it too.
    mockRoutes({ "GET /api/auth/me": meWith(["pharmacy.reports.read"]), "GET /api/pharmacy/office/reports/stores": { status: 200, body: STORES } });
    renderWithRouter(<PharmacyOfficeReports />, "/pharmacy/office/reports");
    expect(await screen.findByTestId("report-missedSales")).toBeTruthy();
  });
});
