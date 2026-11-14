import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyBillAnnex } from "../../components/pharmacy-bill-annex";
import { PharmacyDesk } from "../pharmacy-desk/pharmacy-desk";
import { resetDeskLog } from "../pharmacy-desk/log";
import { resetPaperNotice } from "../pharmacy-desk/paper";
import type { WireDispense, WireDispenseLine, WireLabel, WirePricedDraft, WireQueueRow, WireRetailShelfEntry } from "../../lib/pharmacy-api";

/**
 * ACCEPTANCE — issue #1055, spec docs/specs/1055-pharmacy-desk-two-columns.md (owner APPROVED 2026-11-13, ruling 0094).
 * The desk in two columns like Desk One; the bill column only at billing, until hand-over; medicines added by hand.
 * D5's server rules are `apps/core/src/modules/pharmacy/acceptance/add-medicine-1055.test.ts`.
 */
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<typeof import("@tanstack/react-router")>()), useNavigate: () => navigate }));
vi.mock("../../lib/print-api", async (orig) => ({
  ...(await orig<typeof import("../../lib/print-api")>()),
  printInFrame: () => true,
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
function bodies(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const ME = "u-anita";
const quote = (unitPaise: number): NonNullable<WireDispenseLine["quote"]> => ({ batchId: "b", batchNo: "B-1", expiryDate: "2028-01-31", unitPaise, pack: null, lastKnown: false });
function lineOf(lineIdx: number, drug: string, over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  const m = { id: `m${String(lineIdx)}`, brandName: drug, strengthLabel: null, form: "tablet", scheduleFlag: "OTC" };
  return {
    lineIdx, rxLine: { drug, medicineId: m.id, dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "OTC",
    orderedMedicine: m, dispensedMedicine: m,
    item: { id: `it${String(lineIdx)}`, code: `C${String(lineIdx)}`, name: drug, baseUom: "tablet", uoms: [] }, saleable: true, available: 200,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false, quote: quote(200),
    batches: [{ batchId: `b${String(lineIdx)}`, batchNo: `B-${String(lineIdx)}`, expiryDate: "2028-01-31", available: 200 }], pickedBatch: null,
    ...over,
  };
}
const picked = (l: WireDispenseLine): WireDispenseLine => ({ ...l, batches: [], batchId: `b${String(l.lineIdx)}`, reservationId: "r", pickedBatch: { batchNo: `B-${String(l.lineIdx)}`, expiryDate: "2028-01-31" } });
function dispense(status: string, lines: WireDispenseLine[], over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: "P2611130004", orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
    scheduled: false, invoiceId: status === "billed" || status === "handed_over" ? "inv1" : null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: status === "claimed" || status === "verified" ? null : new Date().toISOString(), billedAt: null, handedOverAt: null, cancelReason: null,
    claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p1", uhid: "U001", name: "Sunita Devi", alias: null, restricted: false }, allergies: [], lines, ...over,
  };
}
const PREVIEW: WirePricedDraft = {
  lines: [{ lineId: "l", serviceId: "s", serviceName: "Crocin 500 tablet", qty: 10, unitPaise: 200, grossPaise: 2000, discountPaise: 0, netPaise: 2000, gst: { rateBps: 1200, exempt: false } }],
  totals: { grossPaise: 2000, discountPaise: 0, cgstPaise: 107, sgstPaise: 107, rawTotalPaise: 2000, netPayablePaise: 2000, roundingPaise: 0 },
  byTender: { cash: { netPayablePaise: 2000, roundingPaise: 0 }, digital: { netPayablePaise: 2000, roundingPaise: 0 } },
};
const queueRow = (id: string, name: string, drugs: string[]): WireQueueRow => ({
  dispenseId: id, status: "queued", dispenseNo: `P261113000${id.slice(-1)}`, scheduled: false, lineCount: drugs.length,
  createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), claimedAt: null, drugs,
  patient: { id: `p-${id}`, uhid: `U-${id}`, name, alias: null, restricted: false },
});
const desk = (current: () => WireDispense | null, extra: Record<string, Handler> = {}, queue: WireQueueRow[] = []): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: queue } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs", cashierUserId: ME, status: "open", openedAt: "2026-11-13T03:00:00.000Z", openingFloatPaise: 50000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: PREVIEW },
  "GET /api/pharmacy/dispenses/d1/print": { status: 200, body: { jobs: [] } },
  "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "relay", jobs: [] } },
  ...extra,
});
/** The two columns the desk's body holds, left to right. */
const columns = (): Element[] => [...screen.getByTestId("desk-ticket-panel").parentElement!.children].filter((c) => !(c as HTMLElement).hidden);

describe("#1055 — the pharmacy desk in two columns", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); resetPaperNotice(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("spec #1055 D1: with nobody in hand the desk has two columns (the 296 px rail and the main), the line is listed under the search, and there is no right column", async () => {
    mockRoutes(desk(() => null, {}, [queueRow("q1", "Sunita Devi", ["Paracetamol 650", "Amoxicillin 500"]), queueRow("q2", "Ramesh Kumar", ["Metformin 500"])]));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    const main = await screen.findByTestId("desk-ticket-panel");
    const list = await within(main).findByTestId("desk-queue");
    expect(within(list).getByTestId("queue-row-q1")).toHaveTextContent("Sunita Devi");
    expect(within(list).getByTestId("queue-row-q2")).toHaveTextContent("Ramesh Kumar");
    const find = within(main).getByRole("textbox", { name: /slip QR/ });
    expect(find.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const [rail, work, ...rest] = columns();
    expect(rail).toHaveAttribute("data-testid", "desk-dossier");
    expect(rail).toHaveClass("rail"); // Desk One's rail: 296 px (252 px at ≤1220 px)
    expect(work).toBe(main);
    expect(rest).toEqual([]);
    expect(screen.queryByTestId("desk-bill")).toBeNull();
  });

  it("spec #1055 D2: with a ticket in hand and a line unsettled there is no bill column; the ticket's foot shows 'n of m settled' and the running total", async () => {
    const lines = [lineOf(0, "Crocin 500"), lineOf(1, "Pan 40", { quote: quote(500) })];
    mockRoutes(desk(() => dispense("claimed", lines)));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const foot = await screen.findByTestId("desk-ticket-foot");
    expect(within(foot).getByTestId("desk-settled")).toHaveTextContent("0 of 2 settled");
    expect(within(foot).getByTestId("desk-sofar")).toHaveTextContent("₹70.00");
    expect(screen.queryByTestId("desk-bill")).toBeNull();
    expect(columns()).toHaveLength(2);
    await userEvent.click(within(screen.getByTestId("desk-line-0")).getByRole("checkbox"));
    expect(within(foot).getByTestId("desk-settled")).toHaveTextContent("1 of 2 settled");
    expect(screen.queryByTestId("desk-bill")).toBeNull();
  });

  it("spec #1055 D3: when every line is settled and something is to be billed, a 296 px bill column opens with the payment controls", async () => {
    const open = [lineOf(0, "Crocin 500")];
    let current = dispense("claimed", open);
    mockRoutes(desk(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", open); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => { current = dispense("picked", open.map(picked)); return { status: 201, body: current }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(screen.queryByTestId("desk-bill")).toBeNull();
    await userEvent.click(within(row).getByRole("checkbox"));
    const bill = await screen.findByTestId("desk-bill");
    expect(bill.tagName).toBe("ASIDE");
    expect(bill).toHaveClass("pd-billcol"); // 296 px, as Desk One's rail (252 px at ≤1220 px)
    const cols = columns();
    expect(cols).toHaveLength(3);
    expect(cols[2]).toBe(bill);
    expect(within(bill).getByRole("radiogroup", { name: "how they are paying" })).toBeInTheDocument();
    expect(await within(bill).findByTestId("desk-payable")).toHaveTextContent("₹20.00");
    expect(within(bill).getByTestId("desk-take")).toBeInTheDocument();
  });

  it("spec #1055 D4: after payment the bill column stays open, showing paid and the printed bill, until hand-over; after hand-over the desk is back to two columns", async () => {
    const lines = [picked(lineOf(0, "Crocin 500"))];
    let current = dispense("billed", lines);
    mockRoutes(desk(() => current, {
      "GET /api/pharmacy/dispenses/d1/closing": { status: 200, body: {
        ticket: { dispenseNo: "P2611130004", claimedByName: "Anita Verma", claimedAt: null, handedOverAt: null, lines: 1, substituted: 0, declined: 0 },
        money: { invoiceNo: "INV-1", netPayablePaise: 2000, roundingPaise: 0, cgstPaise: 107, sgstPaise: 107, receiptNo: "R-1", changeGivenPaise: 0, tenders: [{ mode: "cash", amountPaise: 2000, refText: null }] },
        registers: { h1Rows: 0, batches: 1 },
      } },
      "POST /api/pharmacy/dispenses/d1/handover": () => { current = dispense("handed_over", lines); return { status: 201, body: current }; },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const bill = await screen.findByTestId("desk-bill");
    expect(within(bill).getByText("PAID")).toBeInTheDocument();
    expect(await within(bill).findByTestId("desk-paper")).toBeInTheDocument(); // the bill's paper, said where the bill is
    expect(columns()).toHaveLength(3);
    await userEvent.click(within(screen.getByTestId("desk-handover")).getByRole("button", { name: /Handed over/ }));
    await waitFor(() => expect(screen.queryByTestId("desk-bill")).toBeNull());
    expect(await screen.findByTestId("desk-done")).toBeInTheDocument();
    expect(columns()).toHaveLength(2);
  });

  it("spec #1055 D5: '+ Add a medicine' adds a Schedule H medicine as not prescribed and another as written on paper (with the slip photo); narcotics are refused; each added line says 'added at the counter by <name>' with its reason, on the ticket and the bill", async () => {
    const shelf = (itemId: string, brandName: string): WireRetailShelfEntry => ({
      medicineId: `m-${itemId}`, brandName, strengthLabel: null, form: "tablet", scheduleFlag: "H", itemId, itemCode: itemId.toUpperCase(), itemName: `${brandName} tablet`, baseUom: "tablet", available: 40, scannedBatchId: null,
    });
    const SHELF = [shelf("i-bruf", "Brufen 400"), shelf("i-vove", "Voveran 50"), shelf("i-morc", "Morcontin 10")];
    let current = dispense("claimed", [lineOf(0, "Crocin 500")]);
    mockRoutes(desk(() => current, {
      "GET /api/pharmacy/paper-rx/shelf": { status: 200, body: { items: SHELF } },
      "POST /api/pharmacy/dispenses/d1/lines": (init) => {
        const body = JSON.parse(String(init?.body)) as { itemId: string; reason: "not_prescribed" | "paper"; qtyBase: number };
        if (body.itemId === "i-morc") return { status: 409, body: { statusCode: 409, code: "paper_rx_controlled", message: "…" } };
        const entry = SHELF.find((s) => s.itemId === body.itemId)!;
        const idx = current.lines.length;
        current = dispense("claimed", [...current.lines, lineOf(idx, entry.brandName, {
          scheduleFlag: "H", qtyBase: body.qtyBase,
          added: { reason: body.reason, by: ME, byName: "Anita Verma", at: "2026-11-13T05:00:00.000Z", documentId: body.reason === "paper" ? "doc-1" : null, prescriberName: null, prescriberRegNo: null },
        })]);
        return { status: 201, body: current };
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");

    const addOne = async (q: string, brand: RegExp, reason: RegExp, qty: string): Promise<HTMLElement> => {
      await userEvent.click(screen.getByRole("button", { name: /Add a medicine/ }));
      const sheet = await screen.findByRole("dialog", { name: /Add a medicine/ });
      await userEvent.type(within(sheet).getByRole("textbox", { name: "Medicine" }), q);
      await userEvent.click(await within(sheet).findByRole("button", { name: brand }));
      await userEvent.click(within(sheet).getByRole("radio", { name: reason }));
      await userEvent.type(within(sheet).getByRole("textbox", { name: "Quantity" }), qty);
      return sheet;
    };

    // Not prescribed — a Schedule H medicine (ruling 0094).
    let sheet = await addOne("bru", /Brufen 400/, /Not prescribed/, "10");
    await userEvent.click(within(sheet).getByRole("button", { name: /Add to the ticket/ }));
    await waitFor(() => expect(bodies("POST", "/d1/lines")).toEqual([{ itemId: "i-bruf", reason: "not_prescribed", qtyBase: 10 }]));
    const first = await screen.findByTestId("desk-line-1-added");
    expect(first).toHaveTextContent("added at the counter by Anita Verma");
    expect(first).toHaveTextContent("not prescribed");

    // The doctor wrote it on paper — a Schedule H medicine needs the slip's photo (quick desk mode is off).
    sheet = await addOne("vov", /Voveran 50/, /doctor wrote it on paper/, "10");
    const add = within(sheet).getByRole("button", { name: /Add to the ticket/ });
    expect(add).toBeDisabled();
    await userEvent.upload(within(sheet).getByLabelText(/Photo of the slip/), new File([new Uint8Array([0xff, 0xd8, 0xff])], "slip.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(add).toBeEnabled());
    await userEvent.click(add);
    await waitFor(() => expect(bodies("POST", "/d1/lines")[1]).toMatchObject({ itemId: "i-vove", reason: "paper", qtyBase: 10, photo: { mimeType: "image/jpeg" } }));
    const second = await screen.findByTestId("desk-line-2-added");
    expect(second).toHaveTextContent("added at the counter by Anita Verma");
    expect(second).toHaveTextContent("the doctor wrote it on paper");

    // A narcotic is refused, and the sheet says why.
    sheet = await addOne("mor", /Morcontin 10/, /Not prescribed/, "10");
    await userEvent.click(within(sheet).getByRole("button", { name: /Add to the ticket/ }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(/narcotic/);
    expect(screen.queryByTestId("desk-line-3")).toBeNull();

    // The bill names it too: the browser's annex prints the mark beside the line.
    const label: WireLabel = {
      dispenseNo: "P2611130004", status: "billed", patient: { display: "Sunita Devi", uhid: "U001" }, handedOverAt: null,
      lines: [
        { lineIdx: 0, drug: "Crocin 500", strength: null, form: "tablet", qtyBase: 10, unit: "tablet", packs: null, batchNo: "B-0", expiryDate: "2028-01-31", directions: "", substitutedFor: null },
        { lineIdx: 1, drug: "Brufen 400", strength: null, form: "tablet", qtyBase: 10, unit: "tablet", packs: null, batchNo: "B-1", expiryDate: "2028-01-31", directions: "", substitutedFor: null, added: { reason: "not_prescribed", byName: "Anita Verma" } },
      ],
    };
    render(<PharmacyBillAnnex label={label} />);
    expect(screen.getByTestId("bill-added-1")).toHaveTextContent("added at the counter by Anita Verma · not prescribed");
    expect(screen.queryByTestId("bill-added-0")).toBeNull();
  });

  describe("on a phone (≤900 px)", () => {
    const phone = (on: boolean): void => {
      Object.defineProperty(window, "matchMedia", {
        configurable: true, writable: true,
        value: on
          ? (query: string) => ({
            matches: /max-width:\s*900px/.test(query), media: query, onchange: null,
            addEventListener: () => undefined, removeEventListener: () => undefined,
            addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
          })
          : undefined,
      });
    };
    beforeEach(() => { phone(true); });
    afterEach(() => { phone(false); });

    it("spec #1055 D6: on a phone the Bill tab appears only when the bill column would", async () => {
      const open = [lineOf(0, "Crocin 500")];
      let current = dispense("claimed", open);
      mockRoutes(desk(() => current, {
        "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", open); return { status: 201, body: current }; },
        "POST /api/pharmacy/dispenses/d1/pick": () => { current = dispense("picked", open.map(picked)); return { status: 201, body: current }; },
      }));
      renderWithProviders(<PharmacyDesk ticketId="d1" />);
      const row = await screen.findByTestId("desk-line-0");
      const tabs = screen.getByRole("tablist");
      expect(within(tabs).getByRole("tab", { name: /Ticket/ })).toBeInTheDocument();
      expect(within(tabs).queryByRole("tab", { name: /Bill/ })).toBeNull();
      await userEvent.click(within(row).getByRole("checkbox"));
      expect(await within(tabs).findByRole("tab", { name: /Bill/ })).toBeInTheDocument();
    });
  });
});
