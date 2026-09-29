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
 * PHARMACY STAGE D1 (deferral closed) — "Report a reaction" from the desk. The patient in hand is the
 * report's patient; launched from a line's ⋯, the line's medicine (and its batch, once picked) is the
 * first suspect. D1's own record sheet is reused, so the allergy write and PvPI clock are the server's as
 * before. The entry is the ADR record grant's: without it, the desk offers none.
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
    if (key === "POST /api/pharmacy/adr") return json(201, { reportId: "a1", no: "ADR-000004", allergyIds: [] });
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

describe("report a reaction from the pharmacy desk (stage D1 deferral)", () => {
  it("from a line's ⋯: the patient in hand and the line's medicine are pre-filled; one report is posted for that patient", async () => {
    mock(["pharmacy.dispense.place", "pharmacy.adr.record"], claimed);
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Glycomet 500/ }));
    await userEvent.click(within(row).getByRole("button", { name: "Report a reaction" }));
    const form = await screen.findByTestId("adr-record-form");
    expect(within(form).getByTestId("adr-patient-picked")).toHaveTextContent("Ramesh Paswan · U001");
    expect(within(form).getByTestId("adr-brand-0")).toHaveValue("Glycomet 500");
    await userEvent.type(within(form).getByTestId("adr-reaction-text"), "Itchy rash on both forearms");
    await userEvent.click(within(form).getByTestId("adr-record-save"));
    expect(await screen.findByTestId("adr-said")).toHaveTextContent("ADR-000004");
    await waitFor(() => expect(posted("/pharmacy/adr")).toHaveLength(1));
    const sent = posted("/pharmacy/adr")[0] as { patientId: string; reaction: string; suspects: { name: string | null }[] };
    expect(sent.patientId).toBe("p1");
    expect(sent.reaction).toBe("Itchy rash on both forearms");
    expect(sent.suspects.map((s) => s.name)).toEqual(["Glycomet 500"]);
    expect(screen.queryByTestId("adr-record-form")).toBeNull();
  });

  it("from the ticket: the patient in hand is pre-filled and the suspect is left to the pharmacist", async () => {
    mock(["pharmacy.dispense.place", "pharmacy.adr.record"], claimed);
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await userEvent.click(await screen.findByTestId("desk-report-reaction"));
    const form = await screen.findByTestId("adr-record-form");
    expect(within(form).getByTestId("adr-patient-picked")).toHaveTextContent("Ramesh Paswan · U001");
    expect(within(form).getByTestId("adr-brand-0")).toHaveValue("");
  });

  it("a desk without the ADR record grant offers no reaction report", async () => {
    mock(["pharmacy.dispense.place"], claimed);
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const row = await screen.findByTestId("desk-line-0");
    await userEvent.click(within(row).getByRole("button", { name: /What else for Glycomet 500/ }));
    expect(within(row).queryByRole("button", { name: "Report a reaction" })).toBeNull();
    expect(screen.queryByTestId("desk-report-reaction")).toBeNull();
  });
});
