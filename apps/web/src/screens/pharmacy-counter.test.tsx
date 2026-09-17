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

  /**
   * PHARMACY P3 — a line whose medicine has a component nobody reviewed says so, beside the
   * schedule. The flag is optional on the wire: an older server sends none and nothing is shown.
   */
  it("P3 — marks a line the checks could see only in part, and says nothing when the server does not", async () => {
    const d = dispense("claimed");
    const lines = [d.lines[0]!, { ...d.lines[1]!, partlyChecked: true }];
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "claimed", dispenseNo: null, scheduled: false, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: { ...d, lines } },
      "GET /api/pharmacy/dispenses/d1/lines/0/alternatives": { status: 200, body: { items: [] } },
      "GET /api/pharmacy/dispenses/d1/lines/1/alternatives": { status: 200, body: { items: [] } },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    const line1 = (await screen.findByText(/2\. Azee 500/)).closest("li")!;
    const chip = within(line1).getByTestId("line-partly-checked-1");
    expect(chip).toHaveTextContent("Checked only in part");
    expect(chip).toHaveAttribute("title", expect.stringContaining("not yet reviewed"));
    const line0 = screen.getByText(/1\. Crocin 500/).closest("li")!;
    expect(within(line0).queryByTestId("line-partly-checked-0")).toBeNull();
  });

  /**
   * PHARMACY P5 — a paid dispense that cannot be collected: the counter cancels it with a refund.
   * The button waits for a reason, the request carries the class and an idempotency key, and the
   * answer names the credit note the patient takes to billing.
   */
  it("P5 — cancels a billed dispense with a refund, and says which credit note was raised", async () => {
    let current = dispense("billed", { invoiceId: "inv-1", dispenseNo: "P2608170001" });
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "billed", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current }),
      "POST /api/pharmacy/dispenses/d1/refund": () => {
        current = dispense("cancelled", { invoiceId: "inv-1", dispenseNo: "P2608170001", cancelReason: "batch expired before collection" });
        return { status: 201, body: { dispense: current, creditNoteId: "cn-1", creditNoteNo: "CN-2608-0001", refundApprovalId: "ap-1" } };
      },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    const form = await screen.findByTestId("refund-form");
    const submit = within(form).getByRole("button", { name: "Cancel & request refund" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(form).getByRole("textbox", { name: "Reason" }), "batch expired before collection");
    await userEvent.click(submit);
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/refund")).toEqual([
      { reason: "batch expired before collection", reasonClass: "genuine" },
    ]));
    const call = vi.mocked(fetch).mock.calls.find(([input, init]) => init?.method === "POST" && String(input).endsWith("/refund"));
    expect(new Headers(call?.[1]?.headers).get("idempotency-key")).not.toBeNull();
    expect(await screen.findByRole("status")).toHaveTextContent("Credit note CN-2608-0001 raised; the refund waits for approval at billing.");
    expect(screen.queryByTestId("refund-form")).toBeNull();
  });

  /**
   * PHARMACY P6 — a sealed pack comes back after the hand-over. The button waits for a quantity,
   * the sealed attestation and a reason; the body carries only the lines with a quantity.
   */
  it("P6 — accepts a sealed return with its quantity, attestation and reason", async () => {
    const current = dispense("handed_over", { invoiceId: "inv-1", dispenseNo: "P2608170001" });
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "handed_over", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: current },
      "GET /api/pharmacy/dispenses/d1/label": { status: 200, body: { dispenseNo: "P2608170001", status: "handed_over", patient: { display: "Sita Devi", uhid: PATIENT.uhid }, handedOverAt: "2026-08-17T04:40:00.000Z", lines: [] } },
      "POST /api/pharmacy/dispenses/d1/returns": { status: 201, body: { dispense: current, creditNoteId: "cn-2", creditNoteNo: "CN-2608-0002", refundApprovalId: "ap-2" } },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    const form = await screen.findByTestId("return-form");
    const submit = within(form).getByRole("button", { name: "Accept return" });
    await userEvent.type(within(form).getByRole("textbox", { name: "Return qty, line 1" }), "10");
    await userEvent.type(within(form).getByRole("textbox", { name: "Reason for the return" }), "doctor changed the medicine");
    expect(submit).toBeDisabled(); // not yet attested
    await userEvent.click(within(form).getByRole("checkbox", { name: "I have inspected it: sealed and intact" }));
    await userEvent.click(submit);
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/returns")).toEqual([{
      lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "doctor changed the medicine", reasonClass: "genuine",
    }]));
    expect(await screen.findByRole("status")).toHaveTextContent("Return accepted. Credit note CN-2608-0002 raised");
  });

  /**
   * PHARMACY P10 — THE PATIENT'S BILL, FROM THE COUNTER. The invoice is billing's own printed document;
   * the counter adds what a chemist's bill carries and billing's lines do not: each pack's batch and
   * expiry, and who dispensed it. The counter steps aside while the bill is on screen, because only
   * one printable document may be mounted at a time.
   */
  it("P10 — prints the bill with each pack's batch and expiry, then goes back to the counter", async () => {
    const current = dispense("billed", { invoiceId: "inv-9", dispenseNo: "P2608170001" });
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "billed", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: current },
      "GET /api/pharmacy/dispenses/d1/label": { status: 200, body: {
        dispenseNo: "P2608170001", status: "billed", patient: { display: "Sita Devi", uhid: PATIENT.uhid }, handedOverAt: null,
        lines: [
          { lineIdx: 0, drug: "Calpol 500", strength: "500 mg", form: "tablet", qtyBase: 15, unit: "tablet", packs: null, batchNo: "CP-7", expiryDate: "2027-03-31", directions: "", substitutedFor: "Crocin 500" },
          { lineIdx: 1, drug: "Azee 500", strength: "500 mg", form: "tablet", qtyBase: 3, unit: "tablet", packs: null, batchNo: "AZ-1", expiryDate: "2027-06-30", directions: "", substitutedFor: null },
        ],
        pharmacist: { name: "Kavita Joshi", council: "Maharashtra State Pharmacy Council", registrationNo: "MSPC-123456" },
      } },
      "GET /api/billing/invoices/inv-9/print": { status: 200, body: {
        letterhead: { name: "CRKM Charitable Hospital", addressLines: ["Pune"] },
        invoice: {
          id: "inv-9", invoiceNo: "INV/26-27/000901", patientId: "p1", encounterId: "e1", tariffVersionId: "tv", intendedPayer: "self",
          buyerGstin: null, buyerLegalName: null, grossPaise: 30000, discountPaise: 0, taxableBasePaise: 26786, cgstPaise: 1607, sgstPaise: 1607,
          rawTotalPaise: 30000, roundingPaise: 0, netPayablePaise: 30000, creditExtended: false, creditReason: null, creditApprovalId: null,
          issuedBy: "u", issuedAt: "2026-08-17T04:30:00.000Z", serviceDay: "2026-08-17", seq: 901,
        },
        lines: [],
        patient: { requestedId: "p1", id: "p1", uhid: PATIENT.uhid, name: "Sita Devi", alias: null, restricted: false, administrativeGender: "female", dob: null },
        settlement: { state: "settled", outstandingPaise: 0 },
        qrPayload: "bil1.invoice.inv-9.sig",
      } },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    await userEvent.click(await screen.findByRole("button", { name: "Print bill" }));

    expect(await screen.findByTestId("invoice-no")).toHaveTextContent("INV/26-27/000901");
    const calpol = await screen.findByTestId("bill-batch-0");
    expect(calpol).toHaveTextContent("Calpol 500 500 mg tablet (for Crocin 500)");
    expect(calpol).toHaveTextContent("CP-7");
    expect(calpol).toHaveTextContent("03/2027");
    expect(calpol).toHaveTextContent("15 tablet");
    expect(screen.getByTestId("bill-batch-1")).toHaveTextContent("AZ-106/2027");
    expect(screen.getByTestId("bill-dispensed-by")).toHaveTextContent("Dispensed by Kavita Joshi · Reg. MSPC-123456");
    // The counter stepped aside: its own controls are not on screen with the bill.
    expect(screen.queryByTestId("refund-form")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Back to the counter" }));
    expect(await screen.findByTestId("refund-form")).toBeInTheDocument();
    expect(screen.queryByTestId("invoice-no")).toBeNull();
  });

  it("P10 — offers no bill before there is one", async () => {
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "picked", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: dispense("picked", { dispenseNo: "P2608170001" }) },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    expect(await screen.findByText(/Allergies:/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Print bill" })).toBeNull();
  });

  /** PHARMACY P13 — the pack in hand is scanned before the pick; a wrong pack is said at once and never sent. */
  it("P13 — a scanned pack is checked as it is scanned, and the pick carries only the scan that matched", async () => {
    const current = dispense("verified", { dispenseNo: "P2608170001", orderId: "o1" });
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "verified", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: current },
      "GET /api/pharmacy/dispenses/d1/lines/0/scan": { status: 200, body: { itemCode: "CROC500", batchNo: "CR-2", expiryDate: "2027-12-31" } },
      "GET /api/pharmacy/dispenses/d1/lines/1/scan": { status: 409, body: { code: "scan_wrong_item", message: "no" } },
      "POST /api/pharmacy/dispenses/d1/pick": { status: 201, body: dispense("picked", { dispenseNo: "P2608170001" }) },
      "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: { lines: [], totals: { grossPaise: 0, discountPaise: 0, cgstPaise: 0, sgstPaise: 0, rawTotalPaise: 0, netPayablePaise: 0, roundingPaise: 0 } } },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));
    await userEvent.type(await screen.findByRole("textbox", { name: "Scan pack 1" }), "(01)08901234567897(17)271231(10)CR-2{enter}");
    expect(await screen.findByTestId("scan-ok-0")).toHaveTextContent("CROC500 · CR-2 · 2027-12-31");
    await userEvent.type(screen.getByRole("textbox", { name: "Scan pack 2" }), "8909876543217{enter}");
    expect(await screen.findByTestId("scan-bad-1")).toHaveTextContent("This pack is a different medicine — put it back");

    // The wrong pack is still in hand: no pick until its scan is cleared.
    const pickButton = screen.getByRole("button", { name: "Pick from shelf" });
    expect(pickButton).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Dispense fewer 2" }), "2");
    await userEvent.type(screen.getByRole("textbox", { name: "Why fewer? 2" }), "only two left in the strip");
    await userEvent.clear(screen.getByRole("textbox", { name: "Scan pack 2" }));
    expect(screen.queryByTestId("scan-bad-1")).toBeNull();
    await userEvent.click(pickButton);
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/pick")).toEqual([{
      lines: [
        { lineIdx: 0, scan: "(01)08901234567897(17)271231(10)CR-2" },
        { lineIdx: 1, qtyBase: 2, pickNote: "only two left in the strip" },
      ],
    }]));
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Recorded allergy that no prescriber has overridden");
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
        pharmacist: { name: "Rohit Mehta", council: "Maharashtra State Pharmacy Council", registrationNo: "MSPC-123456" },
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
    // P2 — the pharmacist the dispense was verified by, with the registration current then.
    expect(screen.getByTestId("label-pharmacist-0")).toHaveTextContent("Dispensed by Rohit Mehta · Reg. MSPC-123456");
  });
  /**
   * THE REQUIRED FIELD SAYS SO IN THE CONTROL, RATHER THAN AS "API 400" AFTER THE CLICK.
   *
   * `handOver` always sent `{ via, value: identityValue.trim() }` for a scheduled dispense, and the
   * controller parses `z.string().min(1).max(12)` ONE LINE ABOVE its try/catch. So an empty box was
   * refused by zod rather than by the pharmacy guard: the BadRequestException carries a zod issue
   * array and no `code`, `pharmacyErrorText` has nothing to look up, and the screen fell through to
   * `ApiError.message` — the literal string "API 400", on the Schedule H1 hand-over.
   *
   * The assertion that matters is the SECOND one: that no request was sent. A test that only read
   * `toBeDisabled()` would pass against a button that merely looked disabled while still firing, and
   * the whole defect is about what reaches the wire.
   */
  it("a scheduled hand-over with an empty identity box cannot be clicked, and sends nothing", async () => {
    const current = dispense("billed", { dispenseNo: "P2608170001", orderId: "o1", invoiceId: "inv1" });
    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [{ dispenseId: "d1", status: "billed", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT }] } },
      "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: current }),
      "POST /api/pharmacy/dispenses/d1/handover": { status: 201, body: dispense("handed_over", { dispenseNo: "P2608170001", orderId: "o1", invoiceId: "inv1", identityConfirmedVia: "token" }) },
    });
    renderWithProviders(<PharmacyCounter />);
    await userEvent.click(await screen.findByText(/Sita Devi/));

    const handOver = await screen.findByRole("button", { name: "Hand over" });
    expect(handOver).toBeDisabled();
    await userEvent.click(handOver);
    expect(bodiesOf("POST", "/pharmacy/dispenses/d1/handover")).toEqual([]); // nothing reached the wire

    // and it opens the moment the pharmacist confirms the person
    await userEvent.type(screen.getByRole("textbox", { name: "Value" }), "14");
    expect(handOver).toBeEnabled();
  });
  /**
   * ═══ 5A.3 — THE ASSEMBLY, THROUGH A FULL CYCLE, WITH TWO PATIENTS ═══
   *
   * Every test above takes ONE patient and one state, which is the shape RC-3's close warned about:
   * the parts were proved and the whole was trusted. A counter's own cycle is take A, act, clear
   * the desk, take B — and the second identity confirmation D7 requires (doc 16 A1) is an ACT, not
   * a field left lying on the desk. `take()` reset the lines, the alternatives, the picks, the
   * draft and the label; it did not reset the identity, so B's Schedule H1 hand-over went out
   * confirmed by A's token. The server refuses the mismatch, which is why no suite noticed — but
   * the control the law asks for is the pharmacist confirming THIS patient, and a prefilled box
   * that says "14" is the control already answered.
   */
  it("two patients: the desk is clear between them, and B's identity is never A's", async () => {
    const RAM = { id: "p2", uhid: "HMS-00000002-2", name: "Ram Prasad", alias: null, restricted: false };
    let a = dispense("billed", { dispenseNo: "P2608170001", orderId: "o1", invoiceId: "inv1" });
    const b = dispense("billed", { id: "d2", dispenseNo: "P2608170002", orderId: "o2", invoiceId: "inv2", patient: RAM });
    const label = (no: string, who: string): unknown => ({ dispenseNo: no, status: "handed_over", patient: { display: who, uhid: "u" }, handedOverAt: "2026-08-17T04:40:00.000Z",
      lines: [{ lineIdx: 0, drug: "Crocin 500", strength: "500 mg", form: "tablet", qtyBase: 20, unit: "tablet", packs: "2 strip", batchNo: "CR-EARLY", expiryDate: "2027-01-31", directions: "1 tab · TDS · 5 days", substitutedFor: null }] });

    mockRoutes({
      "GET /api/pharmacy/queue": { status: 200, body: { items: [
        { dispenseId: "d1", status: "billed", dispenseNo: "P2608170001", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:00:00.000Z", claimedAt: null, patient: PATIENT },
        { dispenseId: "d2", status: "billed", dispenseNo: "P2608170002", scheduled: true, lineCount: 2, createdAt: "2026-08-17T04:05:00.000Z", claimedAt: null, patient: RAM },
      ] } },
      "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: a }),
      "GET /api/pharmacy/dispenses/d2": { status: 200, body: b },
      "POST /api/pharmacy/dispenses/d1/handover": () => { a = dispense("handed_over", { dispenseNo: "P2608170001", orderId: "o1", invoiceId: "inv1", identityConfirmedVia: "token" }); return { status: 201, body: a }; },
      "POST /api/pharmacy/dispenses/d2/handover": { status: 201, body: dispense("handed_over", { id: "d2", dispenseNo: "P2608170002", orderId: "o2", invoiceId: "inv2", patient: RAM, identityConfirmedVia: "token" }) },
      "GET /api/pharmacy/dispenses/d1/label": { status: 200, body: label("P2608170001", "Sita Devi") },
      "GET /api/pharmacy/dispenses/d2/label": { status: 200, body: label("P2608170002", "Ram Prasad") },
    });
    renderWithProviders(<PharmacyCounter />);

    // ── patient A: hand over against her own token ──
    await userEvent.click(await screen.findByText(/Sita Devi/));
    await userEvent.type(await screen.findByRole("textbox", { name: "Value" }), "14");
    await userEvent.click(screen.getByRole("button", { name: "Hand over" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d1/handover")).toEqual([{ identity: { via: "token", value: "14" } }]));
    expect(await screen.findByTestId("label-0")).toBeInTheDocument();

    // ── clear the desk: take patient B off the queue ──
    await userEvent.click(await screen.findByText(/Ram Prasad/));
    // the QUEUE still lists both patients, rightly; it is the DESK that must be clear
    const desk = await screen.findByTestId("in-hand");
    await within(desk).findByText(/HMS-00000002-2/);

    // nothing of A survives: not her label, not her name, and above all not her token
    expect(within(desk).queryByTestId("label-0")).not.toBeInTheDocument();
    expect(within(desk).queryByText(/Sita Devi/)).not.toBeInTheDocument();
    const identity = await within(desk).findByRole("textbox", { name: "Value" });
    expect(identity).toHaveValue("");

    // and B goes out against B's token
    await userEvent.type(identity, "27");
    await userEvent.click(screen.getByRole("button", { name: "Hand over" }));
    await waitFor(() => expect(bodiesOf("POST", "/pharmacy/dispenses/d2/handover")).toEqual([{ identity: { via: "token", value: "27" } }]));
  });
});
