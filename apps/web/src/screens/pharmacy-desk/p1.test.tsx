import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { paperState, resetPaperNotice } from "./paper";
import { readsAsShortage } from "./short-book";
import type { WireDispense, WireDispenseLine, WirePharmacyPrintJob } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
const printed = vi.fn();
vi.mock("../../lib/print-api", async (orig) => ({
  ...(await orig<typeof import("../../lib/print-api")>()),
  printInFrame: (doc: { html: string }) => { printed(doc.html); return true; },
}));

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
function calls(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const ME = "u-anita";
const LINE: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Pan 40", medicineId: "m", dose: "1 tab", route: "oral", frequency: "1-0-0", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: null,
  orderedMedicine: { id: "m", brandName: "Pan 40", strengthLabel: null, form: "tablet" }, dispensedMedicine: { id: "m", brandName: "Pan 40", strengthLabel: null, form: "tablet", scheduleFlag: null },
  item: { id: "it-pan", code: "PAN40", name: "Pan 40 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 0, batchId: null,
  reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false,
  pickNote: null, partlyChecked: false, batches: [], pickedBatch: null,
};
function dispense(status: string, over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: "P2609190004", orderId: "o1", prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
    scheduled: false, invoiceId: status === "handed_over" || status === "billed" ? "inv1" : null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: null, billedAt: null, handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p", uhid: "U004", name: "Mohammed Salim", alias: null, restricted: false }, allergies: [], lines: [LINE], ...over,
  };
}
const CLOSING = {
  ticket: { dispenseNo: "P2609190004", claimedByName: "Anita Verma", claimedAt: null, handedOverAt: "2026-09-19T06:20:00.000Z", lines: 1, substituted: 0, declined: 0 },
  money: { invoiceNo: "PH/26-27/000009", netPayablePaise: 4500, cgstPaise: 107, sgstPaise: 107, receiptNo: "R9", changeGivenPaise: 0, tenders: [{ mode: "cash", amountPaise: 4500, refText: null }] },
  registers: { h1Rows: 0, batches: 1 },
};
const SHIFT = {
  day: "2026-09-19", handedOver: 7, takenPaise: 312_000, byMode: { cash: 200_000, upi: 112_000, card: 0 }, receipts: 7, returns: 1, refunds: 0,
  drawer: { status: "open", openingFloatPaise: 50_000, expectedCashPaise: 250_000 },
};
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/pharmacy/summary/mine": { status: 200, body: SHIFT },
  "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs", cashierUserId: ME, status: "open", openedAt: "2026-09-19T03:00:00.000Z", openingFloatPaise: 50_000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/closing": { status: 200, body: CLOSING },
  "GET /api/pharmacy/dispenses/d1/print": { status: 200, body: { jobs: [] } },
  ...extra,
});

beforeEach(() => { setToken("t"); resetDeskLog(); resetPaperNotice(); printed.mockReset(); navigate.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("parity P1, pure", () => {
  it("a decline reason that says the drug is not there offers the short book; any other does not", () => {
    for (const r of ["not stocked", "out of stock", "Pan 40 khatam", "stock nahi hai", "short"]) expect(readsAsShortage(r)).toBe(true);
    for (const r of ["patient refused", "doctor changed it", "allergy"]) expect(readsAsShortage(r)).toBe(false);
  });
  it("the paper's state is its newest job per document: printed, failed, not taken after 30 s, or with the printer", () => {
    const job = (document: string, status: string, createdAt = "2026-09-19T06:00:00.000Z"): WirePharmacyPrintJob =>
      ({ id: `${document}-${createdAt}`, document, status, lastError: null, printedAt: null, createdAt });
    expect(paperState([], null, 0)).toBe("none");
    expect(paperState([job("pharmacy_bill", "printed"), job("pharmacy_labels", "printed")], 0, 1)).toBe("printed");
    expect(paperState([job("pharmacy_bill", "queued"), job("pharmacy_labels", "queued")], 0, 10_000)).toBe("with_printer");
    expect(paperState([job("pharmacy_bill", "queued"), job("pharmacy_labels", "queued")], 0, 31_000)).toBe("not_taken");
    // a reprint that printed supersedes the failed copy before it
    expect(paperState([job("pharmacy_bill", "failed"), job("pharmacy_bill", "printed", "2026-09-19T06:05:00.000Z")], 0, 1)).toBe("printed");
    expect(paperState([job("pharmacy_bill", "failed")], 0, 1)).toBe("failed");
  });
});

describe("the desk prints (parity P1)", () => {
  it("after a hand-over at this desk, sends the bill and labels to the counter printer and says so; ⋯ offers a Reprint", async () => {
    let current = dispense("billed");
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/handover": () => { current = dispense("handed_over"); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "relay", jobs: [
        { id: "j1", document: "pharmacy_bill", status: "queued", lastError: null, printedAt: null, createdAt: "2026-09-19T06:20:00.000Z" },
        { id: "j2", document: "pharmacy_labels", status: "queued", lastError: null, printedAt: null, createdAt: "2026-09-19T06:20:00.000Z" },
      ] } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: /Handed over/ }));
    expect(await screen.findByTestId("desk-done")).toBeInTheDocument();
    await waitFor(() => expect(calls("POST", "/d1/print")).toEqual([{}]));
    expect(await screen.findByTestId("desk-paper-status")).toHaveTextContent("Bill and label are with the printer.");
    expect(printed).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("desk-paper-menu"));
    await userEvent.click(screen.getByRole("button", { name: "Reprint bill and labels" }));
    await waitFor(() => expect(calls("POST", "/d1/print")).toEqual([{}, { reprint: true }]));
  });

  it("with no relay serving the roll, prints the same documents from this screen and says so once, quietly", async () => {
    let current = dispense("billed");
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/handover": () => { current = dispense("handed_over"); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "browser", documents: ["pharmacy_bill", "pharmacy_labels"] } },
      "GET /api/pharmacy/dispenses/d1/paper": { status: 200, body: { html: "<html>TAX INVOICE · CR-1</html>", title: "t", page: { widthMm: 72, heightMm: null } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: /Handed over/ }));
    await waitFor(() => expect(printed).toHaveBeenCalledWith("<html>TAX INVOICE · CR-1</html>"));
    expect(await screen.findByTestId("desk-paper-status")).toHaveTextContent("Bill and label printed from this screen.");
    expect(screen.getByTestId("desk-ticker")).toHaveTextContent("No counter printer is set up");
  });

  it("reopening a ticket handed over earlier does NOT print it again by itself", async () => {
    mockRoutes(base(() => dispense("handed_over")));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    expect(await screen.findByTestId("desk-paper-status")).toHaveTextContent("not printed from this desk");
    expect(calls("POST", "/d1/print")).toEqual([]);
  });
});

describe("the short book at the counter (parity P1)", () => {
  it("N opens one field prefilled with the drug of the line in hand; ⏎ notes it by item", async () => {
    mockRoutes(base(() => dispense("claimed"), {
      "POST /api/pharmacy/short-book": { status: 201, body: { created: true, entry: { id: "sb1", drugName: "Pan 40 tablet", itemId: "it-pan" } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const line = await screen.findByTestId("desk-line-0");
    await userEvent.click(line);
    await userEvent.keyboard("n");
    const field = await screen.findByRole("textbox", { name: "medicine that is out" });
    expect(field).toHaveValue("Pan 40");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(calls("POST", "/short-book")).toEqual([{ drugName: "Pan 40", source: "desk", itemId: "it-pan", dispenseId: "d1" }]));
    expect(await screen.findByTestId("desk-ticker")).toHaveTextContent("Pan 40 tablet noted in the short book.");
  });

  it("a line declined as not stocked offers the short book, ticked, and notes it after the decline", async () => {
    let current = dispense("claimed");
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/lines/0/decline": () => {
        current = dispense("claimed", { lines: [{ ...LINE, status: "declined", declinedReason: "not stocked" }] });
        return { status: 201, body: current };
      },
      "POST /api/pharmacy/short-book": { status: 201, body: { created: false, entry: { id: "sb1", drugName: "Pan 40 tablet", itemId: "it-pan" } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: /What else for/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Decline/ }));
    await userEvent.click(await screen.findByTestId("desk-line-0-why-notStocked"));
    const offer = await screen.findByTestId("desk-line-0-also-short");
    expect(within(offer).getByRole("checkbox")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: /^Decline/ }));
    await waitFor(() => expect(calls("POST", "/short-book")).toEqual([{ drugName: "Pan 40", source: "desk", dispenseId: "d1", itemId: "it-pan" }]));
    expect(await screen.findByTestId("desk-ticker")).toHaveTextContent("already in the short book");
  });

  it("the agent's draft is a card; nothing is written until the pharmacist confirms it", async () => {
    mockRoutes(base(() => dispense("claimed"), {
      "POST /api/copilot/ask": { status: 200, body: {
        source: "phrasebook", intent: "draft_short_book_entry",
        answer: { key: "copilot.answer.shortBookDraft", params: { name: "Pan 40" }, payload: { kind: "short_book_draft", itemId: null, drugName: "Pan 40", available: null, alreadyOpen: false } },
      } },
      "POST /api/pharmacy/short-book": { status: 201, body: { created: true, entry: { id: "sb1", drugName: "Pan 40", itemId: null } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(await screen.findByRole("textbox", { name: /ask/i }), "Pan 40 khatam{Enter}");
    const card = await screen.findByTestId("desk-draft-card");
    expect(card).toHaveTextContent("Note Pan 40 in the short book?");
    expect(calls("POST", "/short-book")).toEqual([]);
    await userEvent.click(within(card).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls("POST", "/short-book")).toEqual([{ drugName: "Pan 40", source: "agent" }]));
    await waitFor(() => expect(screen.queryByTestId("desk-draft-card")).toBeNull());
  });
});

describe("sales today on the idle rail (parity P1)", () => {
  it("your day is this pharmacist's shift: hand-overs, money by tender, returns, and what the drawer should hold", async () => {
    mockRoutes(base(() => dispense("claimed")));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    expect(await screen.findByTestId("desk-shift-handed")).toHaveTextContent("you handed over7");
    const money = screen.getByTestId("desk-shift-money");
    expect(money).toHaveTextContent("₹3,120");
    expect(money).toHaveTextContent("₹2,000");
    expect(money).toHaveTextContent("₹1,120");
    expect(screen.getByTestId("desk-shift-returns")).toHaveTextContent("1 · 0");
    expect(screen.getByTestId("desk-shift-drawer")).toHaveTextContent("₹2,500");
    expect(screen.getByTestId("desk-keys")).toHaveTextContent("note a shortage");
  });
});
