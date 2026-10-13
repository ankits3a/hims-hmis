import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { Bedside } from "./ipd-emar-bedside";
import { IpdMar } from "./ipd-mar";
import { IpdPharmacy, LabelPrint } from "./ipd-pharmacy";
import { emarPatientOf, labelSheetOf, pharmacyQueueOf, scanOf, wardChartOf } from "./ipd-emar.fixture";

/*
  E4.3 (#735) — the eMAR screens: board D2 (the bedside), the inpatient pharmacy desk, the labels and the ward MAR chart.
  Every value is synthetic (`ipd-emar.fixture.ts`).
*/
const api = vi.hoisted(() => ({
  getEmarPatient: vi.fn(), scan: vi.fn(), give: vi.fn(), secondCheck: vi.fn(), hold: vi.fn(), getPharmacyQueue: vi.fn(), verify: vi.fn(),
  getWardChart: vi.fn(), issue: vi.fn(), getLabelSheet: vi.fn(),
}));
vi.mock("../lib/ipd-emar-api", async (orig) => ({ ...(await orig<typeof import("../lib/ipd-emar-api")>()), ...api }));
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const PERMS = ["ipd.emar.view", "ipd.emar.give", "ipd.emar.verify", "ipd.emar.issue", "ipd.nursing.view"];
const NOW = Date.now();

beforeEach(() => {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: PERMS, scoped: { department: {}, floor: {} } } }), { status: 200 })));
  for (const f of Object.values(api)) f.mockReset();
  api.getEmarPatient.mockResolvedValue(emarPatientOf(NOW));
  api.getPharmacyQueue.mockResolvedValue(pharmacyQueueOf(NOW));
  api.getWardChart.mockResolvedValue(wardChartOf(NOW));
  api.give.mockResolvedValue({ administrationId: "x", late: false, overrideCounted: false });
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

const bedside = (online: boolean, band: string | null = "IP26-000101-1") =>
  renderWithRouter(<Bedside admissionId={scanOf(NOW).admissionId} bandCode={band} online={online} onBack={() => {}} onDone={() => {}} onPivot={() => {}} />, "/ipd/my-shift");

describe("board D2 — the bedside (E4.3)", () => {
  it("shows the identity header, the allergy and the doses due; the band shows as scanned", async () => {
    bedside(true);
    const head = await screen.findByTestId("ipde-idhead");
    expect(head).toHaveTextContent("Test Patient Asha");
    expect(head).toHaveTextContent("UHID UH-FAKE-0101");
    expect(head).toHaveTextContent("Allergy: Penicillin (severe)");
    expect(head).toHaveTextContent("Band scanned");
    expect(screen.getAllByText(/Actrapid/).length).toBeGreaterThan(0);
  });

  it("scanning the label shows the five checks, and Give records with both codes", async () => {
    api.scan.mockResolvedValue(scanOf(NOW));
    bedside(true);
    await userEvent.type(await screen.findByTestId("ipde-label-input"), "EML-FAKE-LABEL{enter}");
    const checks = await screen.findByTestId("ipde-checks");
    for (const k of ["patient", "drug", "dose", "time", "route"]) expect(within(checks).getByTestId(`ipde-check-${k}`)).toHaveTextContent("✓");
    await userEvent.click(screen.getByTestId("ipde-give"));
    await waitFor(() => expect(api.give).toHaveBeenCalledTimes(1));
    expect(api.give.mock.calls[0]![0]).toMatchObject({ patientCheck: { kind: "scan", wristbandCode: "IP26-000101-1" }, labelCode: "EML-FAKE-LABEL" });
  });

  it("offline: Give is disabled with 'No network — use paper MAR' (doses never queue)", async () => {
    api.scan.mockResolvedValue(scanOf(NOW));
    bedside(false);
    expect(await screen.findByTestId("ipde-offline")).toHaveTextContent("No network — use paper MAR");
    await userEvent.type(await screen.findByTestId("ipde-label-input"), "EML-FAKE-LABEL{enter}");
    expect(await screen.findByTestId("ipde-give")).toBeDisabled();
    expect(screen.getByTestId("ipde-give")).toHaveTextContent("Offline — paper MAR");
  });

  it("a high-alert drug keeps Give off until a second nurse's PIN check passes", async () => {
    api.scan.mockResolvedValue(scanOf(NOW, { highAlert: true }));
    api.secondCheck.mockResolvedValue({ pinProof: "proof-1", userId: "u2", name: "Nurse Fake Two", expiresAt: new Date(NOW + 300_000).toISOString() });
    bedside(true);
    await userEvent.type(await screen.findByTestId("ipde-label-input"), "EML-FAKE-LABEL{enter}");
    expect(await screen.findByTestId("ipde-give")).toBeDisabled();
    const form = screen.getByTestId("ipde-second");
    await userEvent.type(within(form).getByLabelText("Username"), "fake.nurse2");
    await userEvent.type(within(form).getByLabelText("PIN"), "8642");
    await userEvent.click(within(form).getByRole("button", { name: "Check" }));
    await screen.findByText(/Checked by Nurse Fake Two/);
    // The proof is asked for THIS order and slot (E4.3 review 2).
    expect(api.secondCheck.mock.calls[0]!.slice(0, 2)).toEqual(["high_alert_dose", { orderId: scanOf(NOW, { highAlert: true }).label!.orderId, doseDueAt: scanOf(NOW, { highAlert: true }).label!.dose!.dueAt }]);
    expect(screen.getByTestId("ipde-give")).toBeEnabled();
  });

  it("a look-alike drug shows the tall-man name and needs its confirm", async () => {
    api.scan.mockResolvedValue(scanOf(NOW, { lasa: true }));
    bedside(true);
    await userEvent.type(await screen.findByTestId("ipde-label-input"), "EML-FAKE-LABEL{enter}");
    expect(await screen.findByTestId("ipde-checks")).toHaveTextContent("hydrOXYzine vs hydrALAZINE");
    expect(screen.getByTestId("ipde-give")).toBeDisabled();
    await userEvent.click(screen.getByTestId("ipde-lasa"));
    expect(screen.getByTestId("ipde-give")).toBeEnabled();
  });

  it("a weight-based dose keeps Give off until the weight is typed (E4.3 review 29)", async () => {
    api.scan.mockResolvedValue(scanOf(NOW, { weight: true }));
    bedside(true);
    await userEvent.type(await screen.findByTestId("ipde-label-input"), "EML-FAKE-LABEL{enter}");
    expect(await screen.findByTestId("ipde-give")).toBeDisabled();
    await userEvent.type(screen.getByTestId("ipde-weight"), "58");
    expect(screen.getByTestId("ipde-give")).toBeEnabled();
  });

  it("an oral dose under NPO needs the sips confirmation with its reason, and sends it", async () => {
    api.scan.mockResolvedValue(scanOf(NOW, { npo: "sips" }));
    bedside(true);
    await userEvent.type(await screen.findByTestId("ipde-label-input"), "EML-FAKE-LABEL{enter}");
    expect(await screen.findByTestId("ipde-give")).toBeDisabled();
    await userEvent.type(screen.getByTestId("ipde-npo-reason"), "Dr allows with sips");
    await userEvent.click(screen.getByTestId("ipde-give"));
    await waitFor(() => expect(api.give).toHaveBeenCalledTimes(1));
    expect(api.give.mock.calls[0]![0]).toMatchObject({ npoMeds: { kind: "sips_allowed", reason: "Dr allows with sips" } });
  });

  it("no band scanned: the override needs a reason and a note", async () => {
    bedside(true, null);
    await userEvent.click(await screen.findByTestId("ipde-override-open"));
    const o = screen.getByTestId("ipde-override");
    expect(within(o).getByRole("button", { name: "Use override" })).toBeDisabled();
    expect(o).toHaveTextContent("Override is counted");
  });
});

describe("the inpatient pharmacy desk (E4.3)", () => {
  it("lists orders to verify with their findings; Verify waits for the four ticks and the note", async () => {
    renderWithRouter(<IpdPharmacy />, "/ipd/pharmacy");
    const card = await screen.findByTestId(`ipde-verify-${pharmacyQueueOf(NOW).toVerify[0]!.order.orderId}`);
    expect(card).toHaveTextContent("Allergy: Penicillin");
    expect(card).toHaveTextContent("No interaction data in the formulary");
    const btn = within(card).getByTestId("ipde-verify-btn");
    expect(btn).toBeDisabled();
    for (const k of ["Allergy", "Interaction", "Dose", "Duplicate therapy"]) await userEvent.click(within(card).getByLabelText(k));
    expect(btn).toBeDisabled();
    await userEvent.type(within(card).getByLabelText("Note (needed)"), "Spoke to the doctor");
    // An allergy finding also needs the structured override reason and its text (E4.3 review 11).
    expect(btn).toBeDisabled();
    await userEvent.selectOptions(within(card).getByLabelText("Allergy override"), "tolerated_before");
    await userEvent.type(within(card).getByLabelText("Why (text)"), "Took it in 2025");
    expect(btn).toBeEnabled();
  });

  it("the labels carry the QR code, the drug, the dose and the UHID", async () => {
    renderWithRouter(<LabelPrint sheet={labelSheetOf(NOW)} onClose={() => {}} />, "/ipd/pharmacy");
    const labels = await screen.findAllByTestId("ipde-label");
    expect(labels).toHaveLength(3);
    expect(labels[0]!.querySelector("svg")).not.toBeNull();
    expect(labels[0]).toHaveTextContent("Actrapid 100 IU/ml");
    expect(labels[0]).toHaveTextContent("8 unit · SC · TDS");
    expect(labels[0]).toHaveTextContent("UH-FAKE-0101");
  });
});

describe("the ward MAR chart (E4.3)", () => {
  it("places each dose in its IST hour with a symbol AND a word", async () => {
    renderWithRouter(<IpdMar />, "/ipd/mar");
    await screen.findByTestId("ipd-mar");
    await screen.findAllByText("Test Patient Bina", { exact: false });
    expect(screen.getAllByText("Missed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Held").length).toBeGreaterThan(0);
    expect(screen.getAllByText("✓").length).toBeGreaterThan(0);
  });
});
