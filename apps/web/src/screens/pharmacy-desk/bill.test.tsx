import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { heldUntil, holdEnded, tendersFor } from "./bill";
import type { WireDispense, WireDispenseLine, WirePricedDraft } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

type Reply = { status: number; body: unknown } | "network";
type Handler = Reply | ((init?: RequestInit) => Reply);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(init) : handler;
    if (reply === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function calls(method: string, path: string): { body: unknown; key: string | null }[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => ({
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown,
      key: new Headers(init?.headers).get("Idempotency-Key"),
    }));
}

const ME = "u-anita";
const LINE: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Azee 500", medicineId: "m", dose: "1 tab", route: "oral", frequency: "1-0-0", durationDays: 3, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 3, scheduleFlag: "H1",
  orderedMedicine: { id: "m", brandName: "Azee 500", strengthLabel: null, form: "tablet" }, dispensedMedicine: { id: "m", brandName: "Azee 500", strengthLabel: null, form: "tablet", scheduleFlag: "H1" },
  item: { id: "it", code: "AZEE500", name: "Azee 500 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 197, batchId: "b1",
  reservationId: "r1", ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false,
  pickNote: null, partlyChecked: false, batches: [], pickedBatch: { batchNo: "AZEE500-2026001", expiryDate: "2028-09-19" },
};
function dispense(id: string, status: string, over: Partial<WireDispense> = {}): WireDispense {
  return {
    id, status, dispenseNo: "P2609190004", orderId: "o1", prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: true, invoiceId: status === "picked" ? null : "inv1", identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: "2026-09-19T06:14:00.000Z", billedAt: null, handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U004", name: "Mohammed Salim", alias: null, restricted: false }, allergies: [], lines: [LINE], ...over,
  };
}
const PREVIEW: WirePricedDraft = {
  lines: [{ lineId: "l", serviceId: "s", serviceName: "Azee 500 tablet", qty: 3, unitPaise: 1500, grossPaise: 4500, discountPaise: 0, netPaise: 4500, gst: { rateBps: 1200, exempt: false } }],
  totals: { grossPaise: 4500, discountPaise: 0, cgstPaise: 241, sgstPaise: 241, rawTotalPaise: 4500, netPayablePaise: 4500, roundingPaise: 0 },
};
const base = (current: () => WireDispense, drawer: "open" | null, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: drawer === null ? null : { id: "cs", cashierUserId: ME, status: "open", openedAt: "2026-09-19T03:00:00.000Z", openingFloatPaise: 200000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } },
  "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: PREVIEW },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  ...extra,
});

describe("the money, pure (PD-6)", () => {
  it("E20 — a cash tender short of the bill is no tender at all; over it, the difference is the change", () => {
    expect(tendersFor("cash", 4500, "40", "")).toBeNull();
    expect(tendersFor("cash", 4500, "50", "")).toEqual({ tenders: [{ mode: "cash", amountPaise: 4500 }], changePaise: 500 });
    expect(tendersFor("split", 4500, "20", "25", "UTR 4411")).toEqual({ tenders: [{ mode: "cash", amountPaise: 2000 }, { mode: "upi", amountPaise: 2500, refText: "UTR 4411" }], changePaise: 0 });
    expect(tendersFor("split", 4500, "20", "20", "UTR 4411")).toBeNull();
  });
  it("WALK FINDING — a UPI or card tender with no settlement reference is no tender (billing's tender_ref_required)", () => {
    expect(tendersFor("upi", 4500, "", "", "")).toBeNull();
    expect(tendersFor("card", 4500, "", "", "  ")).toBeNull();
    expect(tendersFor("upi", 4500, "", "", " 425512345678 ")).toEqual({ tenders: [{ mode: "upi", amountPaise: 4500, refText: "425512345678" }], changePaise: 0 });
    expect(tendersFor("split", 4500, "20", "25", "")).toBeNull();
  });
  it("E27 — the draft names the reservation's deadline, thirty minutes after the pick, in IST", () => {
    expect(heldUntil("2026-09-19T06:14:00.000Z")).toBe("12:14");
    expect(heldUntil(null)).toBeNull();
  });

  it("E13 — a hold is over the moment its thirty minutes are, by the desk's own clock", () => {
    expect(holdEnded("2026-09-19T06:14:00.000Z", new Date("2026-09-19T06:43:59.000Z"))).toBe(false);
    expect(holdEnded("2026-09-19T06:14:00.000Z", new Date("2026-09-19T06:44:00.000Z"))).toBe(true);
    expect(holdEnded(null, new Date("2026-09-19T06:44:00.000Z"))).toBe(false);
  });
});

describe("the bill rail and the hand-over (PD-6)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("collected → priced → taken by UPI → handed over against an EMPTY identity box → done", async () => {
    let current = dispense("d1", "picked");
    mockRoutes(base(() => current, "open", {
      "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("d1", "billed"); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/handover": () => { current = dispense("d1", "handed_over"); return { status: 201, body: current }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    expect(await within(rail).findByTestId("desk-payable")).toHaveTextContent("₹45.00");
    expect(rail).toHaveTextContent("CGST (inside the MRP)");
    expect(within(rail).getByRole("button", { name: /Received ₹45.00/ })).toBeDisabled(); // no UTR yet
    await userEvent.type(within(rail).getByRole("textbox", { name: /UPI reference/ }), "425512345678");
    await userEvent.click(within(rail).getByRole("button", { name: /Received ₹45.00/ }));
    await waitFor(() => expect(calls("POST", "/d1/bill").map((c) => c.body)).toEqual([{ tenders: [{ mode: "upi", amountPaise: 4500, refText: "425512345678" }] }]));

    const hand = await screen.findByTestId("desk-handover");
    const box = within(hand).getByRole("textbox");
    expect(box).toHaveValue(""); // E18 — never prefilled
    expect(within(hand).getByRole("button", { name: /Handed over/ })).toBeDisabled();
    await userEvent.type(box, "14");
    await userEvent.click(within(hand).getByRole("button", { name: /Handed over/ }));
    await waitFor(() => expect(calls("POST", "/d1/handover").map((c) => c.body)).toEqual([{ identity: { via: "token", value: "14" } }]));
    expect(await screen.findByTestId("desk-done")).toHaveTextContent("Mohammed Salim has their medicine.");
  });

  it("E21, measured — with no drawer open NO money can be taken, UPI included, and the keys do nothing either", async () => {
    mockRoutes(base(() => dispense("d1", "picked"), null));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    expect(await within(rail).findByText(/UPI and card included/)).toBeInTheDocument();
    expect(within(rail).queryByRole("radio")).toBeNull();
    expect(within(rail).queryByRole("button", { name: /Received/ })).toBeNull();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(calls("POST", "/d1/bill")).toEqual([]);
    await userEvent.click(within(rail).getByRole("button", { name: /open a drawer/ }));
    expect(navigate).toHaveBeenCalledWith({ to: "/billing/session" });
  });

  it("E20 — cash is chosen by its key; short of the bill the button will not take it, and the change is shown once it covers", async () => {
    mockRoutes(base(() => dispense("d1", "picked"), "open"));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    await within(rail).findByTestId("desk-payable");
    await userEvent.keyboard("1");
    expect(within(rail).getByRole("radio", { name: /Cash/ })).toHaveAttribute("aria-checked", "true");
    const tendered = within(rail).getByRole("textbox", { name: /tendered/ });
    await userEvent.type(tendered, "40");
    expect(within(rail).getByRole("button", { name: /Received/ })).toBeDisabled();
    await userEvent.clear(tendered);
    await userEvent.type(tendered, "50");
    expect(within(rail).getByTestId("desk-change")).toHaveTextContent("₹5.00");
    expect(within(rail).getByRole("button", { name: /Received/ })).toBeEnabled();
  });

  it("E26 — a payment whose answer never came is retried with the SAME key; one the server refused is retried with a new one", async () => {
    let attempt = 0;
    let current = dispense("d1", "picked");
    mockRoutes(base(() => current, "open", {
      "POST /api/pharmacy/dispenses/d1/bill": () => {
        attempt += 1;
        if (attempt === 1) return "network";
        if (attempt === 2) return { status: 409, body: { statusCode: 409, code: "invoice_not_settled", message: "…" } };
        current = dispense("d1", "billed"); return { status: 201, body: current };
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    const received = await within(rail).findByRole("button", { name: /Received ₹45.00/ });
    await userEvent.type(within(rail).getByRole("textbox", { name: /UPI reference/ }), "425512345678");
    await userEvent.click(received);
    expect(await within(rail).findByRole("alert")).toHaveTextContent(/cannot be charged twice/);
    await userEvent.click(received);
    await waitFor(() => expect(calls("POST", "/d1/bill")).toHaveLength(2));
    await userEvent.click(received);
    await waitFor(() => expect(calls("POST", "/d1/bill")).toHaveLength(3));
    const [first, second, third] = calls("POST", "/d1/bill").map((c) => c.key);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(third).not.toBe(second);
  });

  it("E27 — Save draft clears the desk and says until when the strips are held", async () => {
    /* Relative to the clock: whether a hold still runs is now a question the screen asks of it (E13). */
    const pickedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const until = heldUntil(pickedAt)!;
    mockRoutes(base(() => dispense("d1", "picked", { pickedAt }), "open"));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    expect(within(rail).getByText(new RegExp(`held until ${until}`))).toBeInTheDocument();
    await userEvent.click(within(rail).getByRole("button", { name: "Save draft" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk" });
    expect(screen.getByTestId("desk-ticker")).toHaveTextContent(`the strips are held until ${until}`);
  });

  it("E13 — a hold that has run out is said to have ENDED, not still to run; the draft keeps only the claim", async () => {
    const pickedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const until = heldUntil(pickedAt)!;
    mockRoutes(base(() => dispense("d1", "picked", { pickedAt }), "open"));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    expect(within(rail).getByText(`The hold ended at ${until}. The counter puts the strips back and cancels this ticket within a minute — collect again if the patient is still here.`)).toBeInTheDocument();
    expect(within(rail).queryByText(/held until/)).toBeNull();
    await userEvent.click(within(rail).getByRole("button", { name: "Save draft" }));
    expect(screen.getByTestId("desk-ticker")).toHaveTextContent("saved as a draft — your claim stays");
  });
});
