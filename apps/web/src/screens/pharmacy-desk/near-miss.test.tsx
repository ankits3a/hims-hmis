import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import type { WireDispense, WireDispenseLine } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

/**
 * PHARMACY STAGE D2 — "Record a near miss" on the desk line's ⋯ menu. The line in hand is the context: the
 * dispense and the line's index go to the server (which takes the patient and the item from that line); the
 * pharmacist says only what the line cannot. The entry is the record grant's: without it, the menu has none.
 */
const ME = "u-anita";
function mock(perms: string[], current: WireDispense): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (key === "GET /api/auth/me") return json(200, { actor: { type: "user", id: ME }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (key === "GET /api/pharmacy/queue") return json(200, { items: [] });
    if (key === "GET /api/pharmacy/dispenses/d1") return json(200, current);
    if (key === "POST /api/pharmacy/incidents") return json(201, { incidentId: "i1", no: "MI-000007" });
    return new Response("{}", { status: 404 });
  }));
}
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const line: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Glycomet 500", medicineId: "m0", dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "OTC",
  orderedMedicine: { id: "m0", brandName: "Glycomet 500", strengthLabel: null, form: "tablet", scheduleFlag: "OTC" },
  dispensedMedicine: { id: "m0", brandName: "Glycomet 500", strengthLabel: null, form: "tablet", scheduleFlag: "OTC" },
  item: { id: "it0", code: "C0", name: "Glycomet 500", baseUom: "tablet", uoms: [] }, saleable: true, available: 200,
  batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
  fefoOverride: false, pickNote: null, partlyChecked: false,
  batches: [{ batchId: "b0", batchNo: "B-0", expiryDate: "2028-01-31", available: 200 }], pickedBatch: null,
};
const claimed: WireDispense = {
  id: "d1", status: "claimed", dispenseNo: null, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
  scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
  handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
  patient: { id: "p1", uhid: "U001", name: "Ramesh Paswan", alias: null, restricted: false }, allergies: [], lines: [line],
};

beforeEach(() => { setToken("t"); resetDeskLog(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("record a near miss from the desk line (pharmacy stage D2)", () => {
  it("opens from the line's ⋯, posts the dispense and the line — never a typed patient or item — once", async () => {
    mock(["pharmacy.dispense.place", "pharmacy.incidents.record"], claimed);
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Glycomet 500/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Record a near miss" }));
    const form = await screen.findByTestId("near-miss-form");
    expect(within(form).getByTestId("near-miss-save")).toBeDisabled();
    await userEvent.selectOptions(within(form).getByTestId("near-miss-type"), "lasa_mixup");
    await userEvent.click(within(form).getByTestId("near-miss-factor-lasa"));
    await userEvent.type(within(form).getByTestId("near-miss-what"), "Glyciphage picked for Glycomet; caught at the tick");
    await userEvent.click(within(form).getByTestId("near-miss-save"));
    expect(await screen.findByTestId("near-miss-said")).toHaveTextContent("MI-000007");
    await waitFor(() => expect(posted("/pharmacy/incidents")).toHaveLength(1));
    expect(posted("/pharmacy/incidents")[0]).toEqual({
      kind: "near_miss", category: "B", stage: "dispensing", type: "lasa_mixup", factors: ["lasa"],
      whatHappened: "Glyciphage picked for Glycomet; caught at the tick", dispenseLine: { dispenseId: "d1", lineIdx: 0 },
    });
    expect(screen.queryByTestId("near-miss-form")).toBeNull();
  });

  it("a desk without the record grant has no near-miss entry on the line", async () => {
    mock(["pharmacy.dispense.place"], claimed);
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Glycomet 500/ }));
    expect(within(row).getByRole("button", { name: "Decline this line" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Record a near miss" })).toBeNull();
  });
});
