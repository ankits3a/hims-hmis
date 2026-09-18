import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { addDays, adviceFor, canTick, freshTick, istToday, pickBody, sigOf, verifyBody } from "./work";
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
const med = (id: string, brandName: string, scheduleFlag = "OTC"): WireDispenseLine["dispensedMedicine"] =>
  ({ id, brandName, strengthLabel: null, form: "tablet", scheduleFlag });
function lineOf(lineIdx: number, over: Partial<WireDispenseLine> & { drug: string }): WireDispenseLine {
  const { drug, ...rest } = over;
  return {
    lineIdx, rxLine: { drug, medicineId: `m${String(lineIdx)}`, dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "OTC",
    orderedMedicine: med(`m${String(lineIdx)}`, drug), dispensedMedicine: med(`m${String(lineIdx)}`, drug),
    item: { id: `it${String(lineIdx)}`, code: `C${String(lineIdx)}`, name: drug, baseUom: "tablet", uoms: [] }, saleable: true, available: 200,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false,
    batches: [{ batchId: `b${String(lineIdx)}`, batchNo: `B-${String(lineIdx)}`, expiryDate: "2028-01-31", available: 200 }], pickedBatch: null,
    ...rest,
  };
}
function dispense(status: string, lines: WireDispenseLine[], over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: null, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p1", uhid: "U001", name: "Ramesh Paswan", alias: null, restricted: false }, allergies: [], lines, ...over,
  };
}
const base = (current: () => WireDispense, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current() }),
  ...extra,
});

describe("the line rules, pure (PD-4)", () => {
  it("PD-D3 / E19 — a triplet becomes the shorthand; anything else is the doctor's words", () => {
    expect(sigOf({ dose: "1 tab", frequency: "1-0-1", durationDays: 5 })).toBe("1-0-1 × 5d");
    expect(sigOf({ dose: "10 ml", frequency: "1-1-1", durationDays: 5 })).toBe("10 ml 1-1-1 × 5d");
    expect(sigOf({ dose: "5 mg/kg", frequency: "BD", durationDays: 3 })).toBe("5 mg/kg · BD × 3d");
  });
  it("E9 — a short quantity cannot be ticked until it says why; more than prescribed never can", () => {
    const l = lineOf(0, { drug: "Glycomet 500", qtyBase: 270 });
    expect(canTick(l, { ...freshTick(l), qty: "200" })).toBe(false);
    expect(canTick(l, { ...freshTick(l), qty: "200", reason: "only 200 on the shelf" })).toBe(true);
    expect(canTick(l, { ...freshTick(l), qty: "300", reason: "x" })).toBe(false);
    expect(canTick(lineOf(1, { drug: "Ascoril", dispensedMedicine: null }), freshTick(l))).toBe(false);
  });
  it("verify is told the PRESCRIBED quantity, and the short is the pick's with its reason", () => {
    const l = lineOf(0, { drug: "Glycomet 500", qtyBase: 270 });
    const ticks = { 0: { ticked: true, qty: "200", reason: "only 200 on the shelf", batchId: null, scan: " 890123 ", sub: null } };
    expect(verifyBody([l], ticks)).toEqual([{ lineIdx: 0, qtyBase: 270 }]);
    expect(pickBody([l], ticks)).toEqual([{ lineIdx: 0, qtyBase: 200, pickNote: "only 200 on the shelf", scan: "890123" }]);
  });
  it("E8 — the earliest batch that dies inside the course is named, with the batch that would not", () => {
    const soon = { batchId: "soon", batchNo: "PAN-NEAR", expiryDate: addDays(TODAY, 12), available: 20 };
    const late = { batchId: "late", batchNo: "PAN-FRESH", expiryDate: "2028-09-19", available: 200 };
    const l = lineOf(0, { drug: "Pan 40", qtyBase: 30, batches: [soon, late], rxLine: { drug: "Pan 40", dose: "1 tab", route: "oral", frequency: "1-0-0", durationDays: 30, instructions: null, noSubstitution: false } });
    expect(adviceFor(l, 30, TODAY, null)).toEqual({ kind: "first_short", batch: soon, better: late });
    expect(adviceFor(l, 10, TODAY, null)).toEqual({ kind: "dies_in_course", batch: soon, better: late });
    expect(adviceFor(l, 10, TODAY, "late")).toEqual({ kind: "ok", batch: late });
  });
});

describe("the line list at the window (PD-4)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the LAST tick checks and collects — verify at the prescribed quantities, then pick — and there is no verify button", async () => {
    const lines = [lineOf(0, { drug: "Mox 500" }), lineOf(1, { drug: "Cetzine 10", qtyBase: 5 })];
    let current = dispense("claimed", lines);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", lines, { dispenseNo: "P2609190007" }); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => {
        current = dispense("picked", lines.map((l) => ({ ...l, batches: [], batchId: `b${String(l.lineIdx)}`, pickedBatch: { batchNo: `B-${String(l.lineIdx)}`, expiryDate: "2028-01-31" } })), { dispenseNo: "P2609190007" });
        return { status: 201, body: current };
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-lines");
    expect(screen.queryByRole("button", { name: /verify/i })).toBeNull();

    await userEvent.click(screen.getByRole("checkbox", { name: /Mox 500/ }));
    expect(posted("/verify")).toEqual([]);
    await userEvent.click(screen.getByRole("checkbox", { name: /Cetzine 10/ }));
    await waitFor(() => expect(posted("/pick")).toHaveLength(1));
    expect(posted("/verify")).toEqual([{ lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 5 }] }]);
    expect(posted("/pick")).toEqual([{ lines: [{ lineIdx: 0 }, { lineIdx: 1 }] }]);
    expect(await screen.findByTestId("desk-line-0-batch")).toHaveTextContent("given from B-0");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ticket P-7");
  });

  it("E9 — a partial asks why BEFORE the tick counts, and the pick carries the quantity and the reason", async () => {
    const lines = [lineOf(0, { drug: "Glycomet 500", qtyBase: 270, available: 200, batches: [{ batchId: "g1", batchNo: "GLY-1", expiryDate: "2028-01-31", available: 200 }] })];
    let current = dispense("claimed", lines);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", lines); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", lines) }),
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(within(row).getByTestId("desk-line-0-advice")).toHaveTextContent("holds 200 and this line wants 270");
    await userEvent.click(within(row).getByRole("button", { name: "give 200" }));
    const tick = within(row).getByRole("checkbox");
    expect(tick).toBeDisabled();
    await userEvent.type(within(row).getByRole("textbox", { name: /giving 200 of 270/ }), "only 200 on the shelf");
    expect(posted("/pick")).toEqual([]); // typing the reason never fires anything
    await userEvent.click(tick);
    await waitFor(() => expect(posted("/pick")).toEqual([{ lines: [{ lineIdx: 0, qtyBase: 200, pickNote: "only 200 on the shelf" }] }]));
    expect(posted("/verify")).toEqual([{ lines: [{ lineIdx: 0, qtyBase: 270 }] }]);
  });

  it("E7 — a pick refused on a line lands ON that line, unticks it, and the next tick re-fires the pick alone", async () => {
    const lines = [lineOf(0, { drug: "Mox 500" })];
    let current = dispense("claimed", lines);
    let picks = 0;
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", lines, { dispenseNo: "P2609190009" }); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => {
        picks += 1;
        if (picks === 1) return { status: 409, body: { statusCode: 409, code: "short_stock", message: "…", detail: { lineIdx: 0, offered: [], available: 4 } } };
        current = dispense("picked", lines); return { status: 201, body: current };
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.click(await screen.findByRole("checkbox", { name: /Mox 500/ }));
    const row = screen.getByTestId("desk-line-0");
    expect(await within(row).findByRole("alert")).toBeInTheDocument();
    expect(within(row).getByRole("checkbox")).not.toBeChecked();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ticket P-9"));

    await userEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() => expect(posted("/pick")).toHaveLength(2));
    expect(posted("/verify")).toHaveLength(1); // the check is not made twice
  });

  it("PD-D4 — the line the catalogue cannot place cannot be ticked; declining it is the act that settles the ticket", async () => {
    const lines = [lineOf(0, { drug: "Ascoril LS syrup", dispensedMedicine: null, orderedMedicine: null, item: null, saleable: false, available: null, batches: [] }), lineOf(1, { drug: "Cetzine 10", qtyBase: 5 })];
    let current = dispense("claimed", lines);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/lines/0/decline": () => {
        current = dispense("claimed", [{ ...lines[0]!, status: "declined", declinedReason: "not stocked here" }, lines[1]!]);
        return { status: 201, body: current };
      },
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", current.lines); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", current.lines) }),
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const odd = await screen.findByTestId("desk-line-0");
    expect(within(odd).getByText(/could not place this line/)).toBeInTheDocument();
    expect(within(odd).queryByRole("checkbox", { checked: false })).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox", { name: /Cetzine 10/ }));
    expect(posted("/verify")).toEqual([]);
    await userEvent.click(within(odd).getByRole("button", { name: /What else for Ascoril/ }));
    await userEvent.type(within(odd).getByRole("textbox", { name: /Why is Ascoril/ }), "not stocked here");
    await userEvent.click(within(odd).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(posted("/pick")).toHaveLength(1));
    expect(posted("/lines/0/decline")).toEqual([{ reason: "not stocked here" }]);
    expect(posted("/verify")).toEqual([{ lines: [{ lineIdx: 1, qtyBase: 5 }] }]);
  });

  it("E8 — the batch that dies inside the course is said at the tick, and taking the longer one names it to the pick", async () => {
    const soon = { batchId: "soon", batchNo: "PAN-NEAR", expiryDate: addDays(TODAY, 12), available: 40 };
    const late = { batchId: "late", batchNo: "PAN-FRESH", expiryDate: "2028-09-19", available: 200 };
    const lines = [lineOf(0, { drug: "Pan 40", qtyBase: 30, batches: [soon, late], rxLine: { drug: "Pan 40", medicineId: "m0", dose: "1 tab", route: "oral", frequency: "1-0-0", durationDays: 30, instructions: "before breakfast", noSubstitution: false } })];
    let current = dispense("claimed", lines);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", lines); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", lines) }),
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(within(row).getByTestId("desk-line-0-advice")).toHaveTextContent("before the 30-day course ends");
    await userEvent.click(within(row).getByRole("button", { name: "take PAN-FRESH" }));
    expect(within(row).getByTestId("desk-line-0-batch")).toHaveTextContent("batch PAN-FRESH");
    await userEvent.click(within(row).getByRole("checkbox"));
    await waitFor(() => expect(posted("/pick")).toEqual([{ lines: [{ lineIdx: 0, batchId: "late" }] }]));
  });

  it("WALK FINDING — a collected line is SETTLED even though the shelf now reads 0, and a short one says why", async () => {
    const lines = [lineOf(0, {
      drug: "Glycomet 500", qtyBase: 200, available: 0, batches: [], batchId: "g1", pickNote: "only 200 on the shelf",
      pickedBatch: { batchNo: "GLY-1", expiryDate: "2028-01-31" },
    })];
    mockRoutes(base(() => dispense("picked", lines, { dispenseNo: "P2609190002" })));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    expect(screen.getByTestId("desk-settled")).toHaveTextContent("1 of 1 settled");
    expect(row).toHaveTextContent("given short — only 200 on the shelf");
    expect(row).not.toHaveTextContent(/None on the shelf/);
  });

  it("WALK FINDING — a refusal that names its line is said ONCE, on that line", async () => {
    const lines = [lineOf(0, { drug: "Mox 500" }), lineOf(1, { drug: "Calpol 500", qtyBase: 6 })];
    const current = dispense("claimed", lines, { allergies: [{ substance: "Amoxicillin", severity: "moderate" }] });
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": {
        status: 409, body: { statusCode: 409, code: "allergy_block", message: "…", detail: { hits: [{ lineIdx: 0, substance: "Amoxicillin" }] } },
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.click(await screen.findByRole("checkbox", { name: /Mox 500/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Calpol 500/ }));
    const list = screen.getByTestId("desk-lines");
    expect(await within(screen.getByTestId("desk-line-0")).findByRole("alert")).toBeInTheDocument();
    expect(within(list).getAllByRole("alert")).toHaveLength(1);
    expect(within(screen.getByTestId("desk-line-1")).getByRole("checkbox")).toBeChecked();
  });

  it("a scan IS a tick — the pack's code goes to the pick, which is where the server judges it (E10, E11)", async () => {
    const lines = [lineOf(0, { drug: "Mox 500" })];
    let current = dispense("claimed", lines);
    mockRoutes(base(() => current, {
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", lines); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/pick": () => ({ status: 201, body: dispense("picked", lines) }),
    }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.type(await screen.findByRole("textbox", { name: /Scan the pack for Mox 500/ }), "(01)08901234567890(10)MOX-7{enter}");
    await waitFor(() => expect(posted("/pick")).toEqual([{ lines: [{ lineIdx: 0, scan: "(01)08901234567890(10)MOX-7" }] }]));
  });
});
