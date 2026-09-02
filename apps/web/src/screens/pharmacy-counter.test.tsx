import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PharmacyCounter } from "./pharmacy-counter";
import type { WireDispense } from "../lib/pharmacy-api";

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init?: RequestInit) => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler(init) : handler;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function bodiesOf(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const PATIENT = { id: "p1", uhid: "HMS-00000001-1", name: "Sita Devi", alias: null, restricted: false };
const CROCIN = { id: "m-croc", brandName: "Crocin 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "OTC" };
const AZEE = { id: "m-azee", brandName: "Azee 500", strengthLabel: "500 mg", form: "tablet", scheduleFlag: "H1" };
const rx = (drug: string, medicineId: string | null): WireDispense["lines"][number]["rxLine"] =>
  ({ drug, medicineId, dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false });

function dispense(status: string, over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: null, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1",
    storeResourceId: "store", scheduled: true, invoiceId: null, identityConfirmedVia: null,
    claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null, handedOverAt: null, cancelReason: null,
    patient: PATIENT, allergies: [{ substance: "Sulfa", severity: null }],
    lines: [
      { lineIdx: 0, rxLine: rx("Crocin 500", "m-croc"), status: "open", declinedReason: null, substitutionType: "none", qtyBase: 15, scheduleFlag: "OTC",
        orderedMedicine: CROCIN, dispensedMedicine: CROCIN, item: { id: "it-c", code: "CROC500", name: "Crocin 500 tablet", baseUom: "tablet", uoms: [] },
        saleable: true, available: 40, batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false, pickNote: null },
      { lineIdx: 1, rxLine: rx("Azee 500", "m-azee"), status: "open", declinedReason: null, substitutionType: "none", qtyBase: null, scheduleFlag: "H1",
        orderedMedicine: AZEE, dispensedMedicine: AZEE, item: { id: "it-a", code: "AZEE500", name: "Azee 500 tablet", baseUom: "tablet", uoms: [] },
        saleable: true, available: 6, batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false, pickNote: null },
    ],
    ...over,
  };
}

describe("PharmacyCounter (16c T3)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("finds by the field, claims, edits a quantity, picks a generic with consent, and verifies with exactly those lines", async () => {
    let current = dispense("queued");
    mockRoutes({
      "GET /api/pharmacy/queue": () => ({ status: 200, body: { items: [] } }),
      "GET /api/pharmacy/find": () => ({ status: 200, body: { kind: "dispense", door: "token", dispense: current } }),
      "POST /api/pharmacy/dispenses": () => { current = dispense("claimed", { claimedAt: "2026-08-17T04:20:00.000Z" }); return { status: 201, body: current }; },
      "GET /api/pharmacy/dispenses/d1/lines/0/alternatives": { status: 200, body: { items: [{ medicineId: "m-calp", brandName: "Calpol 500", strengthLabel: "500 mg", form: "tablet", itemId: "it-p", itemCode: "CALP500", available: 90 }] } },
      "GET /api/pharmacy/dispenses/d1/lines/1/alternatives": { status: 200, body: { items: [] } },
      "POST /api/pharmacy/dispenses/d1/verify": () => { current = dispense("verified", { dispenseNo: "P2608170001", orderId: "o1" }); return { status: 201, body: current }; },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.type(screen.getByRole("textbox", { name: /Scan the e-Rx/ }), "T-14{enter}");
    expect(await screen.findByText(/Sita Devi/)).toBeInTheDocument();
    expect(screen.getByText(/Allergies:/).closest("p")).toHaveTextContent("Sulfa");

    await userEvent.click(screen.getByRole("button", { name: "Take this Rx" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses")).toEqual([{ dispenseId: "d1", door: "rx_qr" }]));
    expect(await screen.findByRole("button", { name: "Verify & place order" })).toBeInTheDocument();

    const qty1 = screen.getByRole("textbox", { name: "Qty 2" });
    await userEvent.type(qty1, "3");
    const alt = await screen.findByRole("combobox", { name: "Generic equivalent 1" });
    await userEvent.selectOptions(alt, "m-calp");
    const line0 = screen.getByText(/1\. Crocin 500/).closest("li")!;
    await userEvent.click(within(line0).getByRole("checkbox"));

    await userEvent.click(screen.getByRole("button", { name: "Verify & place order" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/verify")).toEqual([{
      lines: [
        { lineIdx: 0, qtyBase: 15, dispensedMedicineId: "m-calp", patientConsent: true },
        { lineIdx: 1, qtyBase: 3 },
      ],
    }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Verified. Order P2608170001 placed.");
    expect(screen.getByText(/Dispense no\. P2608170001/)).toBeInTheDocument();
  });

  it("a refusal code from verify reads as the locale's sentence, and the queue offers today's rows", async () => {
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "queued", dispenseNo: null, scheduled: false, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: dispense("claimed") },
      "GET /api/pharmacy/dispenses/d1/lines/0/alternatives": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/dispenses/d1/lines/1/alternatives": { status: 200, body: { items: [] } },
      "POST /api/pharmacy/dispenses/d1/verify": { status: 409, body: { statusCode: 409, code: "allergy_block", message: "x" } },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    await userEvent.type(await screen.findByRole("textbox", { name: "Qty 2" }), "3");
    await userEvent.click(screen.getByRole("button", { name: "Verify & place order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recorded allergy, not overridden by the prescriber");
  });

  it("T4 — pick, bill at the previewed payable, hand over with the token, and print labels", async () => {
    let current = dispense("verified", { dispenseNo: "P2608170001", orderId: "o1" });
    const draft = { lines: [{ lineId: "l1", serviceId: "s", serviceName: "Crocin 500 tablet", qty: 15, unitPaise: 1200, grossPaise: 18000, discountPaise: 0, netPaise: 20160, gst: { rateBps: 1200, exempt: false } }],
      totals: { grossPaise: 18000, discountPaise: 0, cgstPaise: 1080, sgstPaise: 1080, rawTotalPaise: 20160, netPayablePaise: 20200, roundingPaise: 40 } };
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "verified", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current }),
      "POST /api/pharmacy/dispenses/d1/pick": () => { current = dispense("picked", { dispenseNo: "P2608170001", orderId: "o1" }); return { status: 201, body: current }; },
      "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: draft },
      "POST /api/pharmacy/dispenses/d1/bill": () => { current = dispense("billed", { dispenseNo: "P2608170001", orderId: "o1", invoiceId: "inv1" }); return { status: 201, body: current }; },
      "POST /api/pharmacy/dispenses/d1/handover": () => { current = dispense("handed_over", { dispenseNo: "P2608170001", orderId: "o1", invoiceId: "inv1", identityConfirmedVia: "token" }); return { status: 201, body: current }; },
      "GET /api/pharmacy/dispenses/d1/label": { status: 200, body: { dispenseNo: "P2608170001", status: "handed_over", patient: { display: "Sita Devi", uhid: PATIENT.uhid }, handedOverAt: "2026-08-17T04:40:00.000Z",
        lines: [{ lineIdx: 0, drug: "Crocin 500", strength: "500 mg", form: "tablet", qtyBase: 20, unit: "tablet", packs: "2 strip", batchNo: "CR-EARLY", expiryDate: "2027-01-31", directions: "1 tab · TDS · 5 days", substitutedFor: null }] } },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    await userEvent.click(await screen.findByRole("button", { name: "Pick from shelf" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/pick")).toEqual([{ lines: [] }]));
    expect(await screen.findByTestId("payable")).toHaveTextContent("₹202.00");
    await userEvent.click(screen.getByRole("button", { name: "Take payment & bill" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/bill")).toEqual([{ tenders: [{ mode: "cash", amountPaise: 20200 }] }]));
    await userEvent.type(await screen.findByRole("textbox", { name: "Value" }), "14");
    await userEvent.click(screen.getByRole("button", { name: "Hand over" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/handover")).toEqual([{ identity: { via: "token", value: "14" } }]));
    expect(await screen.findByTestId("label-0")).toHaveTextContent("Crocin 500 500 mg tablet");
    expect(screen.getByTestId("label-0")).toHaveTextContent("Batch CR-EARLY · Exp 2027-01-31");
  });
});
