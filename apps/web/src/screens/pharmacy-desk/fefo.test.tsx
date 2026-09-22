import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { addDays, batchRows, expiryLabel, freshTick, inPacks, istToday, packOf, qtyLabels, routeScan, scanBatchOf } from "./work";
import type { WireDispense, WireDispenseLine } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init?: RequestInit) => Reply);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(init) : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const TODAY = istToday();
const ME = "u-anita";
const STRIP = [{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 10 }];
const NEAR = { batchId: "near", batchNo: "AMC-4471", expiryDate: addDays(TODAY, 30), available: 40 };
const LATE = { batchId: "late", batchNo: "AMC-4520", expiryDate: "2028-03-02", available: 120 };
function lineOf(over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  const med = { id: "m-aug", brandName: "Augmentin 625", strengthLabel: "625 mg", form: "tablet", scheduleFlag: "H" };
  return {
    lineIdx: 0, rxLine: { drug: "Augmentin 625", medicineId: "m-aug", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "H", orderedMedicine: med, dispensedMedicine: med,
    item: { id: "it-aug", code: "AUG625", name: "Augmentin 625 tablet", baseUom: "tablet", uoms: STRIP }, saleable: true, available: 160, location: "Rack B2 · shelf 3",
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false, salt: "Amoxicillin + Clavulanic acid",
    batches: [NEAR, LATE], pickedBatch: null, ...over,
  };
}
function dispense(status: string, lines: WireDispenseLine[]): WireDispense {
  return {
    id: "d1", status, dispenseNo: null, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p1", uhid: "U001", name: "Ramkishan Yadav", alias: null, restricted: false }, allergies: [], lines,
  };
}
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "POST /api/pharmacy/dispenses/d1/verify": () => ({ status: 201, body: dispense("verified", current().lines) }),
  "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", current().lines) }),
  ...extra,
});

describe("the FEFO batch & shelf chip, pure", () => {
  it("counts in the pack when there is one — strips on top, tablets under", () => {
    const pack = packOf({ uoms: STRIP });
    expect(pack).toEqual({ uom: "strip", multiplier: 10 });
    expect(inPacks(10, pack)).toBe("1 strip");
    expect(inPacks(25, pack)).toBe("2 strips + 5");
    expect(inPacks(5, pack)).toBeNull();
    expect(qtyLabels(10, pack, "tablet")).toEqual({ main: "1 strip", sub: "10 tablets" });
    expect(qtyLabels(6, null, "tablet")).toEqual({ main: "6", sub: "tablets" });
    expect(qtyLabels(null, pack, "tablet")).toEqual({ main: "—", sub: "tablet" });
  });
  it("lists the batches nearest-expiry first: the top is FEFO, the soon one is flagged, on hand in strips", () => {
    const rows = batchRows(lineOf(), freshTick(lineOf()), TODAY);
    expect(rows.map((r) => [r.batch.batchNo, r.fefo, r.chosen, r.soon, r.onHand])).toEqual([
      ["AMC-4471", true, true, true, "4 strips"],
      ["AMC-4520", false, false, false, "12 strips"],
    ]);
    const later = batchRows(lineOf(), { ...freshTick(lineOf()), batchId: "late" }, TODAY);
    expect(later.map((r) => r.chosen)).toEqual([false, true]);
    expect(expiryLabel("2026-10-21")).toBe("21 Oct 2026");
  });
  it("a batch that outlives 90 days but dies inside a long course is still flagged", () => {
    const long = lineOf({ rxLine: { ...lineOf().rxLine, durationDays: 180 }, batches: [{ ...LATE, expiryDate: addDays(TODAY, 120) }] });
    expect(batchRows(long, undefined, TODAY)[0]!.soon).toBe(true);
    expect(batchRows(lineOf({ batches: [{ ...LATE, expiryDate: addDays(TODAY, 120) }] }), undefined, TODAY)[0]!.soon).toBe(false);
  });
  it("a scanned pack goes to the line whose batch it carries; a bare code to the line in focus, else the next open one", () => {
    expect(scanBatchOf("(01)08901234567890(17)280302(10)AMC-4520")).toBe("AMC-4520");
    expect(scanBatchOf(`0108901234567890172803021${"0"}AMC-4520`)).toBe("AMC-4520");
    expect(scanBatchOf("8901234567890")).toBeNull();
    const a = lineOf();
    const b = lineOf({ lineIdx: 1, batches: [{ batchId: "cz", batchNo: "CZ-1", expiryDate: "2028-01-01", available: 50 }] });
    const ticks = { 0: freshTick(a), 1: freshTick(b) };
    expect(routeScan("(01)08901234567890(10)CZ-1", [a, b], ticks, null)).toEqual({ lineIdx: 1, batchId: null });
    expect(routeScan("(01)08901234567890(10)AMC-4520", [a, b], ticks, null)).toEqual({ lineIdx: 0, batchId: "late" });
    expect(routeScan("8901234567890", [a, b], ticks, 1)).toEqual({ lineIdx: 1, batchId: null });
    expect(routeScan("8901234567890", [a, b], { ...ticks, 0: { ...ticks[0], ticked: true } }, null)).toEqual({ lineIdx: 1, batchId: null });
  });
});

describe("the FEFO batch & shelf chip at the window", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("names the FEFO batch and the rack under the drug; the sheet lists every batch, and a later one goes to the pick by name", async () => {
    const lines = [lineOf()];
    mockRoutes(base(() => dispense("claimed", lines)));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    const chip = within(row).getByTestId("desk-line-0-batch");
    expect(chip).toHaveTextContent("FEFO");
    expect(chip).toHaveTextContent(`AMC-4471 · exp ${expiryLabel(NEAR.expiryDate)}`);
    expect(chip).toHaveTextContent("Rack B2 · shelf 3");

    await userEvent.click(chip);
    const sheet = await screen.findByRole("dialog", { name: "FEFO batch & shelf — Augmentin 625" });
    const first = within(sheet).getByRole("button", { name: /AMC-4471/ });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(first).toHaveTextContent("FEFO · give this first — it expires soonest");
    expect(first).toHaveTextContent("4 strips");
    expect(first).toHaveTextContent("30 days left");
    const later = within(sheet).getByRole("button", { name: /AMC-4520/ });
    expect(later).toHaveTextContent("12 strips");
    await userEvent.click(later);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(row).getByTestId("desk-line-0-batch")).toHaveTextContent("later batch");
    expect(within(row).getByTestId("desk-line-0-batch")).toHaveTextContent("AMC-4520");

    await userEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() => expect(posted("/pick")).toEqual([{ lines: [{ lineIdx: 0, batchId: "late" }] }]));
  });

  it("B opens the sheet on the first open line; Esc closes it and keeps the desk", async () => {
    mockRoutes(base(() => dispense("claimed", [lineOf()])));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    await userEvent.keyboard("b");
    expect(await screen.findByRole("dialog", { name: /FEFO batch & shelf/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
});
