import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { FamilyPage } from "./ipd-family";
import { IpdFamilyCallbacks } from "./ipd-family-callbacks";
import type { IpdFamilyCallbackList, IpdFamilyView } from "@hmis/contracts";

/*
  E3.3 (#731) — the family page (board G) and the ward desk's callbacks. Every value is synthetic: ids `01FAKE…`, names
  invented, amounts made up; the shapes are the contract's (`packages/contracts/src/ipd/family.ts`).
*/

const api = vi.hoisted(() => ({
  getFamilyGate: vi.fn(), sendFamilyOtp: vi.fn(), verifyFamilyOtp: vi.fn(), getFamilyView: vi.fn(), getFamilyBillDetails: vi.fn(),
  requestFamilyCallback: vi.fn(), listFamilyCallbacks: vi.fn(), closeFamilyCallback: vi.fn(),
  getFamilyPanel: vi.fn(), issueFamilyLink: vi.fn(), revokeFamilyLink: vi.fn(), setCondition: vi.fn(),
}));
vi.mock("../lib/ipd-family-api", () => api);

const TOKEN = "FAKEtokenFAKEtokenFAKEtokenFAKEtoken0000";
const view = (over: Partial<IpdFamilyView> = {}): IpdFamilyView => ({
  status: "in_hospital", name: "Sunita", ward: "Ward 5B", dayOfStay: 4,
  condition: { word: "improving", setAt: "2030-01-04T04:10:00.000Z" },
  totals: { billPaise: 6_432_000, depositPaise: 7_000_000, balancePaise: 568_000, asOf: "2030-01-04T06:00:00.000Z" },
  tracker: {
    steps: [
      { key: "fit", state: "done", at: "2030-01-04T04:35:00.000Z" }, { key: "departments", state: "now", at: null },
      { key: "summary", state: "waiting", at: null }, { key: "bill", state: "waiting", at: null },
      { key: "gate_pass", state: "waiting", at: null }, { key: "exit", state: "waiting", at: null },
    ],
    expectedAt: "2030-01-04T08:10:00.000Z", todo: "nothing",
  },
  sessionExpiresAt: "2030-01-04T18:00:00.000Z", purpose: "inpatient_updates", ...over,
});

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  localStorage.removeItem("hmis.family.lang");
});

describe("FamilyPage", () => {
  it("asks for the OTP first — only the masked phone and the purpose — then shows the verified page in Hindi by default", async () => {
    api.getFamilyGate.mockResolvedValue({ status: "needs_otp", phoneMasked: "******5678", purpose: "inpatient_updates" });
    api.sendFamilyOtp.mockResolvedValue({ phoneMasked: "******5678", expiresAt: "2030-01-04T06:10:00.000Z" });
    api.verifyFamilyOtp.mockResolvedValue({ verified: true, expiresAt: "2030-01-04T18:00:00.000Z" });
    api.getFamilyView.mockResolvedValue(view());
    renderWithRouter(<FamilyPage token={TOKEN} />);
    expect(await screen.findByText("हम ******5678 पर 6 अंकों का कोड भेजेंगे।")).toBeInTheDocument();
    expect(screen.getByText("यह पेज क्यों")).toBeInTheDocument();
    // Nothing about the patient before the OTP.
    expect(screen.queryByText("Sunita")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "कोड भेजें" }));
    const input = await screen.findByLabelText("SMS में आया कोड");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "जानकारी देखें" }));
    await waitFor(() => expect(api.verifyFamilyOtp).toHaveBeenCalledWith(TOKEN, "123456"));
    expect(await screen.findByText("Sunita")).toBeInTheDocument();
    expect(screen.getByText("Ward 5B · दिन 4")).toBeInTheDocument();
    expect(screen.getByText("छुट्टी की प्रगति")).toBeInTheDocument();
    // English on one tap.
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByText("Discharge progress")).toBeInTheDocument();
    expect(screen.getByText("Departments checking the bill")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("₹64,320")).toBeInTheDocument();
    expect(screen.getByText("Deposit left")).toBeInTheDocument();
  });

  it("shows no line items until the explicit second step, which says it is recorded", async () => {
    localStorage.setItem("hmis.family.lang", "en");
    api.getFamilyGate.mockResolvedValue({ status: "verified", phoneMasked: "******5678", purpose: "inpatient_updates" });
    api.getFamilyView.mockResolvedValue(view());
    api.getFamilyBillDetails.mockResolvedValue({ lines: [{ serviceDate: "2030-01-03", serviceName: "Room rent — general", qty: 1, amountPaise: 150_000 }], totalPaise: 150_000 });
    renderWithRouter(<FamilyPage token={TOKEN} />);
    expect(await screen.findByText("Bill so far")).toBeInTheDocument();
    expect(screen.queryByText("Room rent — general")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show bill details" }));
    expect(screen.getByText(/Opening them is recorded/)).toBeInTheDocument();
    expect(api.getFamilyBillDetails).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open bill details" }));
    const lines = await screen.findByTestId("family-lines");
    expect(within(lines).getByText("Room rent — general")).toBeInTheDocument();
    expect(api.getFamilyBillDetails).toHaveBeenCalledTimes(1);
  });

  it("sends a question as a callback request and answers only that the ward will call", async () => {
    localStorage.setItem("hmis.family.lang", "en");
    api.getFamilyGate.mockResolvedValue({ status: "verified", phoneMasked: "******5678", purpose: "inpatient_updates" });
    api.getFamilyView.mockResolvedValue(view({ condition: { word: null, setAt: null }, tracker: null }));
    api.requestFamilyCallback.mockResolvedValue({ callbackId: "01FAKE00000000000000000001", status: "open" });
    renderWithRouter(<FamilyPage token={TOKEN} />);
    expect(await screen.findByText("Ask the ward")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request a callback" }));
    fireEvent.change(screen.getByLabelText("Your question for the ward"), { target: { value: "Is her fever better?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to the ward" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent. The ward will call you on ******5678.");
    expect(api.requestFamilyCallback).toHaveBeenCalledWith(TOKEN, "Is her fever better?");
  });

  it("a closed link (death, absconding, expired, revoked) shows only a contact line", async () => {
    localStorage.setItem("hmis.family.lang", "en");
    api.getFamilyGate.mockResolvedValue({ status: "closed", phoneMasked: null, purpose: "inpatient_updates" });
    renderWithRouter(<FamilyPage token={TOKEN} />);
    expect(await screen.findByTestId("family-closed")).toHaveTextContent("This link is closed");
    expect(screen.queryByRole("button", { name: "Send code" })).toBeNull();
  });

  it("a link closed while the page is open falls back to the contact line", async () => {
    localStorage.setItem("hmis.family.lang", "en");
    api.getFamilyGate.mockResolvedValue({ status: "verified", phoneMasked: "******5678", purpose: "inpatient_updates" });
    api.getFamilyView.mockRejectedValue(new ApiError(410, { code: "family_link_closed" }));
    renderWithRouter(<FamilyPage token={TOKEN} />);
    expect(await screen.findByTestId("family-closed")).toBeInTheDocument();
  });
});

describe("IpdFamilyCallbacks", () => {
  const list = (over: Partial<IpdFamilyCallbackList["rows"][number]> = {}): IpdFamilyCallbackList => ({
    rows: [{
      id: "01FAKE00000000000000000009", admissionId: "01FAKE00000000000000000002", patientName: "Synthetic Patient", bedCode: "F5-MED-B12",
      wardName: "Ward 5B", privacy: null, text: "Can we meet the doctor?", phoneMasked: "******5678", status: "open", createdAt: "2030-01-04T06:00:00.000Z",
      closedAt: null, closedBy: null, note: null, ...over,
    }],
  });

  it("lists the waiting requests and marks one called back with a note", async () => {
    api.listFamilyCallbacks.mockResolvedValue(list());
    api.closeFamilyCallback.mockResolvedValue({ closed: true });
    renderWithRouter(<IpdFamilyCallbacks />);
    expect(await screen.findByText("Can we meet the doctor?")).toBeInTheDocument();
    expect(screen.getByText("******5678")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Called back" });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("What you told them"), { target: { value: "Doctor at 5 pm" } });
    fireEvent.click(btn);
    await waitFor(() => expect(api.closeFamilyCallback).toHaveBeenCalledWith("01FAKE00000000000000000009", "Doctor at 5 pm"));
  });
});

describe("IpdFamilyCallbacks — review #764 privacy", () => {
  it("shows a sealed patient as 'Sealed patient' with no bed or ward", async () => {
    api.listFamilyCallbacks.mockResolvedValue({ rows: [{
      id: "01FAKE00000000000000000019", admissionId: "01FAKE00000000000000000012", patientName: null, bedCode: null, wardName: null, privacy: "sealed",
      text: "Please call", phoneMasked: "******1111", status: "open", createdAt: "2030-01-04T06:00:00.000Z", closedAt: null, closedBy: null, note: null,
    }] });
    renderWithRouter(<IpdFamilyCallbacks />);
    expect(await screen.findByText("Sealed patient")).toBeInTheDocument();
    expect(screen.queryByText("—")).toBeNull();
  });
});

describe("FamilyCard (discharge desk)", () => {
  const panel = (over: Record<string, unknown> = {}) => ({
    admissionId: "01FAKE00000000000000000002", condition: { word: null, setAt: null, setBy: null }, familyOff: null, blocked: null, link: null,
    attendantPhoneMasked: "******5678", callbacks: [], can: { issue: true, revoke: false, setCondition: false, closeCallback: true }, ...over,
  });

  it("records the consent and issues the link once, as a QR and an address to hand over", async () => {
    const { FamilyCard } = await import("./ipd-family-panel");
    api.getFamilyPanel.mockResolvedValue(panel());
    api.issueFamilyLink.mockResolvedValue({ linkId: "01FAKE00000000000000000003", path: "/family#FAKEtoken", phoneMasked: "******5678" });
    renderWithRouter(<FamilyCard admissionId="01FAKE00000000000000000002" />);
    expect(await screen.findByTestId("family-link-status")).toHaveTextContent("No link yet · would go to ******5678");
    // A doctor-only control is not offered to the desk.
    expect(screen.queryByRole("group", { name: "Set the condition word" })).toBeNull();
    const issue = screen.getByRole("button", { name: "Issue link" });
    expect(issue).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Who agreed (name)"), { target: { value: "Sita Devi" } });
    fireEvent.click(issue);
    await waitFor(() => expect(api.issueFamilyLink).toHaveBeenCalledWith("01FAKE00000000000000000002", { consentedBy: "Sita Devi", relation: "spouse", method: "verbal" }));
    expect(await screen.findByTestId("family-issued")).toHaveTextContent("/family#FAKEtoken");
  });

  it("lets the doctor set the condition word; a sealed patient's link is shown off with the reason", async () => {
    const { FamilyCard } = await import("./ipd-family-panel");
    api.getFamilyPanel.mockResolvedValue(panel({ blocked: "sealed", can: { issue: false, revoke: false, setCondition: true, closeCallback: false } }));
    api.setCondition.mockResolvedValue({ word: "stable", familyOff: null });
    renderWithRouter(<FamilyCard admissionId="01FAKE00000000000000000002" />);
    expect(await screen.findByTestId("family-link-status")).toHaveTextContent("Off: sealed patient");
    expect(screen.queryByRole("button", { name: "Issue link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stable" }));
    await waitFor(() => expect(api.setCondition).toHaveBeenCalledWith("01FAKE00000000000000000002", "stable"));
  });
});
