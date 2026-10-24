import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { AllergyFlags } from "./ipd-emar-flags";
import { renderWithRouter } from "../test-utils";
import { Bedside } from "./ipd-emar-bedside";
import { IpdMar } from "./ipd-mar";
import { IpdPharmacy, LabelPrint } from "./ipd-pharmacy";
import { eid, emarPatientOf, flagsOf, labelSheetOf, pharmacyQueueOf, scanOf, wardChartOf } from "./ipd-emar.fixture";

/*
  E4.3 (#735) — the eMAR screens: board D2 (the bedside), the inpatient pharmacy desk, the labels and the ward MAR chart.
  Every value is synthetic (`ipd-emar.fixture.ts`).
*/
const api = vi.hoisted(() => ({
  getEmarPatient: vi.fn(), scan: vi.fn(), give: vi.fn(), secondCheck: vi.fn(), hold: vi.fn(), getPharmacyQueue: vi.fn(), verify: vi.fn(),
  getWardChart: vi.fn(), issue: vi.fn(), getLabelSheet: vi.fn(), getAdmissionFlags: vi.fn(), decideFlag: vi.fn(), infusion: vi.fn(), wastage: vi.fn(),
}));
vi.mock("../lib/ipd-emar-api", async (orig) => ({ ...(await orig<typeof import("../lib/ipd-emar-api")>()), ...api }));
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const PERMS = ["ipd.emar.view", "ipd.emar.give", "ipd.emar.verify", "ipd.emar.issue", "ipd.nursing.view", "ipd.order.place"];
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

describe("web gaps closed (E4.3 review): flag decision, re-issue, infusions, wastage", () => {
  it("the doctor decides an allergy flag on the round page: a reason, then stop or continue", async () => {
    api.getAdmissionFlags.mockResolvedValue(flagsOf(NOW));
    api.decideFlag.mockResolvedValue({});
    renderWithRouter(<AllergyFlags admissionId={eid(100)} />, "/ipd/rounds");
    const box = await screen.findByTestId("ipde-flags");
    expect(box).toHaveTextContent("Ceftriaxone 1 g");
    expect(box).toHaveTextContent("No dose is given until you decide");
    expect(screen.getByTestId("ipde-flag-stop")).toBeDisabled();
    await userEvent.type(screen.getByTestId("ipde-flag-reason"), "Switch to a macrolide");
    await userEvent.click(screen.getByTestId("ipde-flag-stop"));
    await waitFor(() => expect(api.decideFlag).toHaveBeenCalledWith(eid(21), "stop", "Switch to a macrolide"));
  });

  it("a decided flag shows the decision and no buttons", async () => {
    api.getAdmissionFlags.mockResolvedValue(flagsOf(NOW, true));
    renderWithRouter(<AllergyFlags admissionId={eid(100)} />, "/ipd/rounds");
    expect(await screen.findByTestId("ipde-flags")).toHaveTextContent("Doctor continues: Mild rash; benefit outweighs");
    expect(screen.queryByTestId("ipde-flag-stop")).toBeNull();
  });

  it("re-issue on the pharmacy desk sends its reason and note, and shows the daily cap's refusal", async () => {
    api.issue.mockRejectedValue(new ApiError(409, { statusCode: 409, code: "reissue_limit", message: "x", rule: "This order has had its three extra issues in a day.", fix: "Ask the pharmacist in charge" }));
    renderWithRouter(<IpdPharmacy />, "/ipd/pharmacy");
    const card = await screen.findByTestId(`ipde-reissue-${eid(15)}`);
    await userEvent.click(within(card).getByTestId("ipde-reissue-open"));
    expect(within(card).getByTestId("ipde-reissue-btn")).toBeDisabled();
    await userEvent.selectOptions(within(card).getByLabelText("Why again"), "lost");
    expect(card).toHaveTextContent("The old labels stop working");
    await userEvent.type(within(card).getByLabelText("Note"), "Strip dropped");
    await userEvent.click(within(card).getByTestId("ipde-reissue-btn"));
    await waitFor(() => expect(api.issue).toHaveBeenCalledTimes(1));
    expect(api.issue.mock.calls[0]![0]).toMatchObject({ orderId: eid(15), reissue: { reason: "lost", note: "Strip dropped" } });
    expect(await within(card).findByTestId("ipde-reissue-refusal")).toHaveTextContent("three extra issues in a day");
  });

  it("an infusion starts through the same scans as a give; stop needs no label", async () => {
    api.scan.mockResolvedValue(scanOf(NOW));
    api.infusion.mockResolvedValue({ infusionState: "running" });
    bedside(true);
    await userEvent.click(await screen.findByTestId("ipde-infusion-stop"));
    await waitFor(() => expect(api.infusion).toHaveBeenCalledWith({ orderId: eid(6), event: "stop" }));
    await userEvent.type(screen.getByTestId("ipde-label-input"), "EML-FAKE-LABEL{enter}");
    const box = await screen.findByTestId("ipde-infusion");
    expect(within(box).getByTestId("ipde-infusion-go")).toBeDisabled();
    await userEvent.type(within(box).getByTestId("ipde-infusion-rate"), "100");
    await userEvent.click(within(box).getByTestId("ipde-infusion-go"));
    await waitFor(() => expect(api.infusion).toHaveBeenCalledTimes(2));
    expect(api.infusion.mock.calls[1]![0]).toEqual({ orderId: eid(1), event: "start", rateMlPerHour: 100, patientCheck: { kind: "scan", wristbandCode: "IP26-000101-1" }, labelCode: "EML-FAKE-LABEL" });
  });

  it("narcotic wastage takes the amount in issue units, a reason and a witnessing second nurse", async () => {
    api.secondCheck.mockResolvedValue({ pinProof: "proof-w", userId: "u2", name: "Nurse Fake Two", expiresAt: new Date(NOW + 300_000).toISOString() });
    api.wastage.mockResolvedValue({});
    bedside(true);
    await userEvent.click(await screen.findByTestId("ipde-wastage-open"));
    const form = screen.getByTestId("ipde-wastage");
    await userEvent.type(within(form).getByTestId("ipde-wastage-qty"), "0.5");
    await userEvent.type(within(form).getByTestId("ipde-wastage-reason"), "Half ampoule unused");
    expect(within(form).getByTestId("ipde-wastage-save")).toBeDisabled();
    await userEvent.type(within(form).getByLabelText("Username"), "fake.nurse2");
    await userEvent.type(within(form).getByLabelText("PIN"), "8642");
    await userEvent.click(within(form).getByRole("button", { name: "Check" }));
    await within(form).findByText(/Witness: Nurse Fake Two/);
    expect(api.secondCheck.mock.calls[0]!.slice(0, 2)).toEqual(["narcotic_wastage", { orderId: eid(7) }]);
    await userEvent.click(within(form).getByTestId("ipde-wastage-save"));
    await waitFor(() => expect(api.wastage).toHaveBeenCalledWith(eid(7), 0.5, "Half ampoule unused", { userId: "u2", pinProof: "proof-w" }));
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
