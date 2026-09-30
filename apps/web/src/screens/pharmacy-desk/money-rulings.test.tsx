import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { payableFor } from "./bill";
import { percentToBps } from "./discount";
import type { WireDispense, WireDispenseLine, WirePricedDraft } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

/**
 * OWNER RULINGS 2026-09-30 (money), at the desk: the payable follows the tender being chosen (cash rounds
 * DOWN, UPI/card to the paisa), and a discount lives behind the bill's ⋯ — the pharmacist's own up to 10%,
 * above it the bill waits for the in-charge (or the owner) and carries the approval when it goes.
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | ((url: URL, init?: RequestInit) => Reply);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://desk");
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

const ME = "u-anita";
const LINE: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Crocin 500", medicineId: "m", dose: "1 tab", route: "oral", frequency: "1-1-1", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 15, scheduleFlag: "OTC",
  orderedMedicine: { id: "m", brandName: "Crocin 500", strengthLabel: null, form: "tablet" }, dispensedMedicine: { id: "m", brandName: "Crocin 500", strengthLabel: null, form: "tablet", scheduleFlag: "OTC" },
  item: { id: "it", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 185, batchId: "b1",
  reservationId: "r1", ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false,
  pickNote: null, partlyChecked: false, batches: [], pickedBatch: { batchNo: "CR-1", expiryDate: "2028-09-19" },
};
function dispense(status: string): WireDispense {
  return {
    id: "d1", status, dispenseNo: "P2609300004", orderId: "o1", prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: false, invoiceId: status === "picked" ? null : "inv1", identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: "2026-09-30T06:14:00.000Z", billedAt: null, handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U004", name: "Mohammed Salim", alias: null, restricted: false }, allergies: [], lines: [LINE],
  };
}
/** The go-live day's bill: 15 Crocin at ₹22.40 a strip — ₹33.60 of MRP. */
const PLAIN: WirePricedDraft = {
  lines: [{ lineId: "l", serviceId: "s", serviceName: "Crocin 500 tablet", qty: 15, unitPaise: 224, grossPaise: 3360, discountPaise: 0, netPaise: 3360, gst: { rateBps: 1200, exempt: false } }],
  totals: { grossPaise: 3360, discountPaise: 0, cgstPaise: 180, sgstPaise: 180, rawTotalPaise: 3360, netPayablePaise: 3300, roundingPaise: -60 },
  byTender: { cash: { netPayablePaise: 3300, roundingPaise: -60 }, digital: { netPayablePaise: 3360, roundingPaise: 0 } },
  discount: null,
};
/** 15% off: ₹5.04, ₹28.56 left — the in-charge's to approve. */
const FIFTEEN: WirePricedDraft = {
  lines: [{ ...PLAIN.lines[0]!, discountPaise: 504, netPaise: 2856 }],
  totals: { grossPaise: 3360, discountPaise: 504, cgstPaise: 153, sgstPaise: 153, rawTotalPaise: 2856, netPayablePaise: 2800, roundingPaise: -56 },
  byTender: { cash: { netPayablePaise: 2800, roundingPaise: -56 }, digital: { netPayablePaise: 2856, roundingPaise: 0 } },
  discount: { kind: "percent_bps", value: 1500, amountPaise: 504, tier: "pharmacy_incharge", approverRole: "pharmacy_incharge" },
};
const EIGHT: WirePricedDraft = {
  lines: [{ ...PLAIN.lines[0]!, discountPaise: 269, netPaise: 3091 }],
  totals: { grossPaise: 3360, discountPaise: 269, cgstPaise: 166, sgstPaise: 166, rawTotalPaise: 3091, netPayablePaise: 3000, roundingPaise: -91 },
  byTender: { cash: { netPayablePaise: 3000, roundingPaise: -91 }, digital: { netPayablePaise: 3091, roundingPaise: 0 } },
  discount: { kind: "percent_bps", value: 800, amountPaise: 269, tier: "pharmacist", approverRole: null },
};

const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs", cashierUserId: ME, status: "open", openedAt: "2026-09-30T03:00:00.000Z", openingFloatPaise: 200000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } },
  "GET /api/pharmacy/dispenses/d1/bill/preview": (url) => {
    const v = url.searchParams.get("discountValue");
    return { status: 200, body: v === "1500" ? FIFTEEN : v === "800" ? EIGHT : PLAIN };
  },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  ...extra,
});

describe("ruling 1 — the payable follows the tender (pure)", () => {
  it("cash and a split take the rounded-down figure; UPI and card the exact one; an older server's totals stand", () => {
    expect(payableFor("cash", PLAIN)).toEqual({ netPayablePaise: 3300, roundingPaise: -60 });
    expect(payableFor("split", PLAIN)).toEqual({ netPayablePaise: 3300, roundingPaise: -60 });
    expect(payableFor("upi", PLAIN)).toEqual({ netPayablePaise: 3360, roundingPaise: 0 });
    expect(payableFor("card", PLAIN)).toEqual({ netPayablePaise: 3360, roundingPaise: 0 });
    expect(payableFor("upi", { totals: PLAIN.totals })).toEqual({ netPayablePaise: 3300, roundingPaise: -60 });
  });
  it("a percentage is read to basis points, at most 100% and two decimals", () => {
    expect(percentToBps("8")).toBe(800);
    expect(percentToBps("10.5")).toBe(1050);
    expect(percentToBps("100")).toBe(10000);
    expect(percentToBps("100.01")).toBeNull();
    expect(percentToBps("0")).toBeNull();
    expect(percentToBps("8.125")).toBeNull();
  });
});

describe("the desk's bill under the 2026-09-30 money rulings", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("₹33.60 reads ₹33.60 on UPI and ₹33.00 on Cash, with the −₹0.60 rounding line — and UPI posts the exact amount", async () => {
    let current = dispense("picked");
    mockRoutes(base(() => current, { "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("billed"); return { status: 201, body: current }; } }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    expect(await within(rail).findByTestId("desk-payable")).toHaveTextContent("₹33.60");
    expect(within(rail).queryByTestId("desk-rounding")).toBeNull();
    await userEvent.click(within(rail).getByRole("radio", { name: /Cash/ }));
    expect(within(rail).getByTestId("desk-payable")).toHaveTextContent("₹33.00");
    expect(within(rail).getByTestId("desk-rounding")).toHaveTextContent("−₹0.60");
    expect(rail).not.toHaveTextContent("₹34.00");
    await userEvent.click(within(rail).getByRole("radio", { name: /UPI/ }));
    await userEvent.type(within(rail).getByRole("textbox", { name: /UTR/i }), "425512345678");
    await userEvent.click(within(rail).getByRole("button", { name: /Received ₹33.60/ }));
    await waitFor(() => expect(bodies("POST", "/d1/bill")).toEqual([{ tenders: [{ mode: "upi", amountPaise: 3360, refText: "425512345678" }] }]));
  });

  it("8% is the pharmacist's own: the sheet behind ⋯ says so, applies it, and the bill carries it with no approval", async () => {
    let current = dispense("picked");
    mockRoutes(base(() => current, { "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("billed"); return { status: 201, body: current }; } }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    await within(rail).findByTestId("desk-payable");
    await userEvent.click(within(rail).getByTestId("desk-bill-menu"));
    await userEvent.click(within(rail).getByTestId("desk-discount-open"));
    const sheet = await screen.findByTestId("discount-sheet");
    await userEvent.type(within(sheet).getByTestId("discount-value"), "8");
    expect(await within(sheet).findByTestId("discount-tier")).toHaveTextContent("Up to 10% — you can give this yourself.");
    expect(within(sheet).getByTestId("discount-preview")).toHaveTextContent("To collect in cash₹30.00");
    expect(within(sheet).getByTestId("discount-preview")).toHaveTextContent("To collect by UPI or card₹30.91");
    expect(within(sheet).getByTestId("discount-apply")).toBeDisabled(); // a reason first
    await userEvent.type(within(sheet).getByTestId("discount-reason"), "senior citizen");
    await userEvent.click(within(sheet).getByTestId("discount-apply"));
    expect(await within(rail).findByTestId("desk-discount-row")).toHaveTextContent("discount 8% · senior citizen−₹2.69");
    expect(within(rail).getByTestId("desk-payable")).toHaveTextContent("₹30.91");
    await userEvent.click(within(rail).getByRole("radio", { name: /Cash/ }));
    expect(within(rail).getByTestId("desk-payable")).toHaveTextContent("₹30.00");
    await userEvent.type(within(rail).getByRole("textbox", { name: /tendered/ }), "30");
    await userEvent.click(within(rail).getByRole("button", { name: /Received ₹30.00/ }));
    await waitFor(() => expect(bodies("POST", "/d1/bill")).toEqual([{
      tenders: [{ mode: "cash", amountPaise: 3000 }], discount: { kind: "percent_bps", value: 800, reason: "senior citizen" },
    }]));
  });

  it("15% asks the pharmacy in-charge; the bill waits while it is pending and goes with the approval once granted", async () => {
    let current = dispense("picked");
    let status = "pending";
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/discount-requests": { status: 201, body: { approvalId: "ap-7", tier: "pharmacy_incharge", amountPaise: 504 } },
      "GET /api/pharmacy/discount-requests/ap-7": () => ({ status: 200, body: { approvalId: "ap-7", status, amountPaise: 504, tier: "pharmacy_incharge", decisionNote: null } }),
      "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("billed"); return { status: 201, body: current }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    await within(rail).findByTestId("desk-payable");
    await userEvent.click(within(rail).getByTestId("desk-bill-menu"));
    await userEvent.click(within(rail).getByTestId("desk-discount-open"));
    const sheet = await screen.findByTestId("discount-sheet");
    await userEvent.type(within(sheet).getByTestId("discount-value"), "15");
    await userEvent.type(within(sheet).getByTestId("discount-reason"), "staff family");
    expect(await within(sheet).findByTestId("discount-tier")).toHaveTextContent("the pharmacy in-charge must approve");
    await userEvent.click(within(sheet).getByRole("button", { name: "Ask the pharmacy in-charge" }));
    await waitFor(() => expect(bodies("POST", "/d1/discount-requests")).toEqual([{ kind: "percent_bps", value: 1500, reason: "staff family" }]));

    expect(await within(rail).findByTestId("discount-wait")).toHaveTextContent("Waiting for the pharmacy in-charge to approve");
    await userEvent.type(within(rail).getByRole("textbox", { name: /UTR/i }), "4255");
    expect(within(rail).getByRole("button", { name: /Received ₹28.56/ })).toBeDisabled();
    expect(within(rail).queryByTestId("desk-credit")).toBeNull();

    status = "granted";
    expect(await within(rail).findByText(/Discount approved by the pharmacy in-charge/, {}, { timeout: 7000 })).toBeInTheDocument();
    await userEvent.click(within(rail).getByRole("button", { name: /Received ₹28.56/ }));
    await waitFor(() => expect(bodies("POST", "/d1/bill")).toEqual([{
      tenders: [{ mode: "upi", amountPaise: 2856, refText: "4255" }],
      discount: { kind: "percent_bps", value: 1500, reason: "staff family", approvalId: "ap-7" },
    }]));
  }, 15_000);
});
