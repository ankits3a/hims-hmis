import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { resetPaperNotice } from "./paper";
import { istToday } from "./work";
import i18n from "../../lib/i18n";
import { billQtyText } from "../../lib/pharmacy-bill";
import type { WireDispense, WireDispenseLine, WirePricedDraft, WireQueueRow } from "../../lib/pharmacy-api";

/**
 * The staging walk of the two-column desk (spec #1055, PR #1057), 2026-11-13: what it found, each pinned here.
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

const ME = "u-anita";
/** A ticket number minted on `day` (IST, `YYYY-MM-DD`): `P` + YYMMDD + the serial, as the server mints it. */
const noOn = (day: string, serial: number): string => `P${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}${String(serial).padStart(4, "0")}`;
const TODAY = istToday();
const YESTERDAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() - 24 * 60 * 60_000));
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
    id: "d1", status, dispenseNo: noOn(TODAY, 4), orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
    scheduled: false, invoiceId: status === "billed" || status === "handed_over" ? "inv1" : null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: status === "claimed" || status === "verified" ? null : new Date().toISOString(), billedAt: null, handedOverAt: null, cancelReason: null,
    claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p1", uhid: "U001", name: "Sunita Devi", alias: null, restricted: false }, allergies: [], lines, ...over,
  };
}
const ROW = (lineIdx: number, serviceName: string): WirePricedDraft["lines"][number] & { lineIdx: number } => ({
  lineId: `l${String(lineIdx)}`, serviceId: "s", serviceName, qty: 10, unitPaise: 200, grossPaise: 2000, discountPaise: 0, netPaise: 2000, gst: { rateBps: 1200, exempt: false }, lineIdx,
});
const preview = (lines: WirePricedDraft["lines"]): WirePricedDraft => ({
  lines,
  totals: { grossPaise: 2000 * lines.length, discountPaise: 0, cgstPaise: 107, sgstPaise: 107, rawTotalPaise: 2000 * lines.length, netPayablePaise: 2000 * lines.length, roundingPaise: 0 },
  byTender: { cash: { netPayablePaise: 2000 * lines.length, roundingPaise: 0 }, digital: { netPayablePaise: 2000 * lines.length, roundingPaise: 0 } },
});
const queueRow = (id: string, name: string, over: Partial<WireQueueRow> = {}): WireQueueRow => ({
  dispenseId: id, status: "queued", dispenseNo: noOn(TODAY, 3), scheduled: false, lineCount: 1,
  createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), claimedAt: null, drugs: ["Crocin 500"],
  patient: { id: `p-${id}`, uhid: `U-${id}`, name, alias: null, restricted: false }, ...over,
});
const desk = (current: () => WireDispense | null, extra: Record<string, Handler> = {}, queue: WireQueueRow[] = []): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: queue } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "cs", cashierUserId: ME, status: "open", openedAt: "2026-11-13T03:00:00.000Z", openingFloatPaise: 50000, countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null } } },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: preview([ROW(0, "Crocin 500 tablet")]) },
  "GET /api/pharmacy/dispenses/d1/print": { status: 200, body: { jobs: [] } },
  "POST /api/pharmacy/dispenses/d1/print": { status: 201, body: { via: "relay", jobs: [] } },
  ...extra,
});

describe("#1055 staging walk — the two-column desk", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); resetPaperNotice(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.removeItem("hmis.username"); });

  it("the header's chip counts what the line counts: my carried draft and a ticket another holds are in the line", async () => {
    const queue = [
      queueRow("q1", "Ankit Kumar", { status: "claimed", claimedBy: ME, claimedByName: "Anita Verma", dispenseNo: noOn(YESTERDAY, 3), queuedOn: YESTERDAY }),
      queueRow("q2", "Neha Prasad", { status: "claimed", claimedBy: "u-vikas", claimedByName: "Vikas Ranjan" }),
    ];
    mockRoutes(desk(() => null, {}, queue));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await screen.findByTestId("queue-row-q1");
    expect(screen.getByTestId("desk-queue").querySelectorAll(".pd-line-row")).toHaveLength(2);
    expect(screen.getByTestId("desk-waiting")).toHaveTextContent("2 in the line");
  });

  it("a ticket carried from an earlier day says its day beside its number, so it is not read as today's P-3", async () => {
    const queue = [
      queueRow("q1", "Ankit Kumar", { status: "claimed", claimedBy: ME, claimedByName: "Anita Verma", dispenseNo: noOn(YESTERDAY, 3), queuedOn: YESTERDAY }),
      queueRow("q2", "Neha Prasad", { dispenseNo: noOn(TODAY, 3) }),
    ];
    mockRoutes(desk(() => null, {}, queue));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    const carried = await screen.findByTestId("queue-row-q1");
    const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${YESTERDAY}T00:00:00Z`));
    expect(carried.querySelector(".pd-line-no")).toHaveTextContent(`P-3 · ${day}`);
    expect(screen.getByTestId("queue-row-q2").querySelector(".pd-line-no")!.textContent).toBe("P-3");
  });

  it("once paid, the hand-over is at the top of the work column and the lines follow it, compact", async () => {
    const lines = [picked(lineOf(0, "Crocin 500"))];
    mockRoutes(desk(() => dispense("billed", lines)));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const handover = await screen.findByTestId("desk-handover");
    const list = screen.getByTestId("desk-lines");
    expect(handover.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list).toHaveClass("compact");
  });

  it("the bill's total and the Received button sit outside the scrolling list of lines", async () => {
    const lines = [picked(lineOf(0, "Crocin 500"))];
    mockRoutes(desk(() => dispense("picked", lines)));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const bill = await screen.findByTestId("desk-bill");
    await within(bill).findByTestId("desk-payable");
    const scroller = within(bill).getByTestId("desk-bill-lines");
    expect(scroller.style.overflowY).toBe("auto");
    expect(within(scroller).getAllByTestId("desk-bill-line")).toHaveLength(1);
    expect(within(scroller).queryByTestId("desk-payable")).toBeNull();
    expect(within(scroller).queryByTestId("desk-take")).toBeNull();
  });

  it("the live bill marks a medicine added at the counter, as the printed bill does", async () => {
    const added = { reason: "not_prescribed" as const, by: ME, byName: "Anita Verma", at: "2026-11-13T05:00:00.000Z", documentId: null, prescriberName: null, prescriberRegNo: null };
    const lines = [picked(lineOf(0, "Crocin 500")), picked(lineOf(1, "Brufen 400", { added }))];
    mockRoutes(desk(() => dispense("picked", lines), {
      "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: preview([ROW(0, "Crocin 500 tablet"), ROW(1, "Brufen 400 tablet")]) },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const bill = await screen.findByTestId("desk-bill");
    expect(await within(bill).findByTestId("desk-bill-added-1")).toHaveTextContent("added at the counter");
    expect(within(bill).queryByTestId("desk-bill-added-0")).toBeNull();
  });

  it("the add-medicine sheet names the person by their full name, as the ticket does — not the login", async () => {
    localStorage.setItem("hmis.username", "anita.v");
    mockRoutes(desk(() => dispense("claimed", [lineOf(0, "Crocin 500")]), {
      "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME }, profile: { username: "anita.v", fullName: "Anita Verma", roles: [] } } },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    await userEvent.click(screen.getByRole("button", { name: /Add a medicine/ }));
    const sheet = await screen.findByRole("dialog", { name: /Add a medicine/ });
    await waitFor(() => expect(sheet).toHaveTextContent("added at the counter by Anita Verma"));
    expect(sheet).not.toHaveTextContent("by anita.v");
  });

  it("the patient's bill words a pack's code plainly: strip15 reads 'strip'", () => {
    const t = i18n.getFixedT("en");
    const pack = { uom: "strip15", multiplier: 15, packs: 1, loose: 5, baseUom: "tablet", packPaise: 15000 };
    expect(billQtyText(t, 20, pack)).toBe("1 strip + 5 tablet");
    expect(billQtyText(t, 30, { ...pack, packs: 2, loose: 0 })).toBe("2 strip");
  });
});
