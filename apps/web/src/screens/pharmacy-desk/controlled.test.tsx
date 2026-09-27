import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { HandOver } from "./ticket";
import { blockedOf } from "./work";
import type { WireControlledChecklist, WireDispense, WireDispenseLine } from "../../lib/pharmacy-api";

vi.mock("../slip-capture", () => ({ downscaleToJpeg: async () => "QUJD" }));

/**
 * PHARMACY P6 — a controlled line at the desk. The counter agent's card lists what the law asks (the
 * server's reading, ✓ or ✗), and the hand-over stays shut until the pharmacist has the prescription
 * photographed, the Schedule X endorsement ticked, who took it written down, and a witness's username and
 * PIN — then it sends exactly those. A blocking ✗ on the record keeps it shut whatever is typed.
 */
const LINE: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Alprax 0.5", medicineId: "m", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 10, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "X", ndpsClass: null, controlled: true,
  orderedMedicine: { id: "m", brandName: "Alprax 0.5", strengthLabel: null, form: "tablet" }, dispensedMedicine: { id: "m", brandName: "Alprax 0.5", strengthLabel: null, form: "tablet", scheduleFlag: "X" },
  item: { id: "it", code: "ALPRAX05", name: "Alprax 0.5 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 50, batchId: "b1",
  reservationId: "r1", ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false,
  pickNote: null, partlyChecked: false, batches: [], pickedBatch: { batchNo: "AX-1", expiryDate: "2027-12-31" },
};
const CHECKS = (blocking: boolean): WireControlledChecklist => ({
  lines: [{ lineIdx: 0, drug: "Alprax 0.5", scheduleX: true, ndpsClass: null, prescribedQty: 10, qtyBase: 10 }],
  checks: [
    { key: "licence_schedule_x", ok: !blocking, atHandover: false, detail: blocking ? "no Form 20F on file" : "Form 20F 20F-MH-0042 · valid until 2030-12-31" },
    { key: "prescriber_reg_no", ok: true, atHandover: false, detail: "Dr Sen · BMC/12345" },
    { key: "patient_address", ok: true, atHandover: false, detail: "12 MG Road, Pune" },
    { key: "quantity", ok: true, atHandover: false, detail: "line 1 Alprax 0.5: 10 of 10 prescribed" },
    { key: "retained_prescription", ok: false, atHandover: true, detail: "the duplicate, kept two years (r.65(9)(a))" },
    { key: "endorsement", ok: false, atHandover: true, detail: "r.65(11)(c)" },
    { key: "collected_by", ok: false, atHandover: true, detail: "" },
    { key: "witness", ok: false, atHandover: true, detail: "" },
  ],
  blocking: blocking ? ["licence_schedule_x"] : [],
});
const dispense = (blocking = false): WireDispense => ({
  id: "d1", status: "billed", dispenseNo: "P2609260004", orderId: "o1", prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
  scheduled: true, invoiceId: "inv1", identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null, handedOverAt: null,
  cancelReason: null, patient: { id: "p", uhid: "U004", name: "Asha Devi", alias: null, restricted: false }, allergies: [], lines: [LINE], controlled: CHECKS(blocking),
});

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 800;
  naturalHeight = 600;
  set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
}

beforeEach(() => {
  setToken("t");
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.endsWith("/api/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "u" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (init?.method === "POST" && raw.endsWith("/api/pharmacy/dispenses/d1/retained-prescription")) {
      return new Response(JSON.stringify({ documentId: "doc-1" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function fill(): Promise<void> {
  await userEvent.upload(screen.getByTestId("controlled-photo"), new File([new Uint8Array([1, 2, 3])], "rx.jpg", { type: "image/jpeg" }));
  await screen.findByTestId("controlled-photo-kept");
  await userEvent.click(screen.getByTestId("controlled-endorsed"));
  await userEvent.type(screen.getByTestId("controlled-who"), "Ramesh Devi");
  await userEvent.type(screen.getByTestId("controlled-relation"), "son");
  await userEvent.type(screen.getByTestId("controlled-id"), "Aadhaar ending 4321");
  await userEvent.type(screen.getByTestId("controlled-witness"), "ph.incharge");
  await userEvent.type(screen.getByTestId("controlled-pin"), "2468");
  await userEvent.type(screen.getByPlaceholderText(/ask — do not read it/i), "14");
}

describe("a controlled line's hand-over at the desk (pharmacy P6)", () => {
  it("the agent's card lists what the law asks; the hand-over opens only when the pharmacist has supplied all of it, and sends exactly that", async () => {
    const onHandOver = vi.fn();
    renderWithProviders(<HandOver dispense={dispense()} busy={false} error={null} onHandOver={onHandOver} />);
    expect(screen.getByTestId("desk-controlled-agent")).toHaveTextContent("Form 20F 20F-MH-0042");
    expect(screen.getByTestId("controlled-check-witness")).toHaveAttribute("data-ok", "no");
    const button = screen.getByRole("button", { name: /handed over/i });
    expect(button).toBeDisabled();
    await fill();
    expect(screen.getByTestId("controlled-check-witness")).toHaveAttribute("data-ok", "yes");
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(onHandOver).toHaveBeenCalledWith({ via: "token", value: "14" }, {
      witness: { username: "ph.incharge", pin: "2468" },
      collectedBy: { name: "Ramesh Devi", relation: "son", idProof: "Aadhaar ending 4321" },
      retainedDocumentId: "doc-1", endorsed: true,
    });
  });

  it("a ✗ on the record (no Form 20F) keeps it shut whatever is typed", async () => {
    renderWithProviders(<HandOver dispense={dispense(true)} busy={false} error={null} onHandOver={vi.fn()} />);
    expect(screen.getByTestId("desk-controlled-blocked")).toBeInTheDocument();
    await fill();
    expect(screen.getByRole("button", { name: /handed over/i })).toBeDisabled();
  });

  it("a Schedule X line the server calls controlled can be ticked; one from an older server that does not say so stays blocked", () => {
    expect(blockedOf({ ...LINE, pickedBatch: null })).toBeNull();
    expect(blockedOf({ ...LINE, pickedBatch: null, controlled: undefined })).toBe("schedule_x");
  });
});
