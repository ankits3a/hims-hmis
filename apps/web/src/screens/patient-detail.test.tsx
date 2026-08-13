import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { PatientDetail } from "./patient-detail";

// The screen reads its patient id from the route param, which only exists inside a
// <RouterProvider>. A component test mounts no router, so useParams is stubbed to the
// one value this screen consumes — mirroring T14's useNavigate mock.
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({ patientId: "p-1" }) }));

const PATIENT = {
  id: "p-1",
  uhid: "HMS0000001234",
  name: "Asha Devi",
  phone: "9876543210",
  altPhone: null,
  dob: "1990-04-02T00:00:00.000Z",
  dobEstimated: false,
  sex: "female",
  addressLine: "12 MG Road",
  district: "Pune",
  stateName: "Maharashtra",
  pincode: "411001",
  language: "hi",
  bloodGroup: "O+",
  isConfidential: false,
  alias: null,
  sensitiveContext: false,
  abhaAddress: "asha@abdm",
  abhaNumber: "12345678901234",
  abhaVerificationStatus: "verified",
  abhaLinkToken: null,
  legacyUhid: null,
  qrVersion: 1,
  status: "active",
  mergedIntoPatientId: null,
};

const ALLERGIES = [
  {
    id: "al-2", patientId: "p-1", substance: "Peanuts", reaction: "Swelling", severity: "severe",
    source: "registration", status: "entered_in_error", recordedBy: "u1",
    recordedAt: "2025-12-01T00:00:00.000Z", correctedBy: "u2", correctedAt: "2025-12-05T00:00:00.000Z",
    correctionReason: "Wrong patient chart",
  },
  {
    id: "al-1", patientId: "p-1", substance: "Penicillin", reaction: "Rash", severity: "moderate",
    source: "registration", status: "active", recordedBy: "u1",
    recordedAt: "2026-01-01T00:00:00.000Z", correctedBy: null, correctedAt: null, correctionReason: null,
  },
];

// Teeth: stored authority flags are all TRUE, the server-computed effectiveAuthority is all
// FALSE. A screen that renders the stored flags instead of the server's computed field would
// show the opposite (permissive) badges and every assertion below would fail.
const GUARDIANS = {
  items: [
    {
      guardian: {
        id: "g-1", patientId: "p-1", name: "Sunita Kumar", phone: "9998887771", relationship: "mother",
        idType: null, idNumberMasked: null, idVerified: false,
        authorityMessages: true, authorityConsents: true, authorityDsr: true, authorityBills: true,
        consentNote: null, validFrom: "2020-01-01T00:00:00.000Z", validTo: null, status: "active",
      },
      effectiveAuthority: { messages: false, consents: false, dsr: false, bills: false },
    },
  ],
};

const QR = {
  payload: "1.p-1.1.abc123", uhid: "HMS0000001234", name: "Asha Devi", sex: "female",
  dob: "1990-04-02T00:00:00.000Z",
};

function fetchCalls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
  }));
}

describe("PatientDetail", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders demographics, UHID, a struck-through corrected allergy (still present), and the guardian's SERVER-COMPUTED effective authority", async () => {
    stubFetch({
      "GET /patients/p-1": { patient: PATIENT, resolvedFrom: null },
      "GET /patients/p-1/allergies": { items: ALLERGIES },
      "GET /patients/p-1/guardians": GUARDIANS,
      "GET /patients/p-1/qr": QR,
    });
    renderWithProviders(<PatientDetail />);

    expect(await screen.findByText("Asha Devi")).toBeInTheDocument();
    expect(screen.getByText("HMS0000001234")).toBeInTheDocument();

    // corrected row: struck through, but the substance and its reason stay visible (E-8 — never hidden)
    const correctedCell = await screen.findByText("Peanuts");
    expect(correctedCell).toHaveClass("line-through");
    expect(screen.getByText("Wrong patient chart", { exact: false })).toBeInTheDocument();
    // the still-active row is untouched
    expect(screen.getByText("Penicillin")).not.toHaveClass("line-through");

    // guardian: stored flags are all true; the screen must render the server's
    // effectiveAuthority (all false) — the exact opposite of what a stored-flags
    // implementation would show.
    expect(screen.getByText("Messages")).toHaveClass("line-through");
    expect(screen.getByText("Consents")).toHaveClass("line-through");
    expect(screen.getByText("Data requests")).toHaveClass("line-through");
    expect(screen.getByText("Bills")).toHaveClass("line-through");
  });

  it("D-31: shows the sealed-guardian-messages banner when the patient has sensitiveContext", async () => {
    stubFetch({
      "GET /patients/p-1": { patient: { ...PATIENT, sensitiveContext: true }, resolvedFrom: null },
      "GET /patients/p-1/allergies": { items: [] },
      "GET /patients/p-1/guardians": { items: [] },
      "GET /patients/p-1/qr": QR,
    });
    renderWithProviders(<PatientDetail />);

    expect(
      await screen.findByText("Sensitive context: guardian messages are sealed (D-31)"),
    ).toBeInTheDocument();
  });

  it("dirty-field PATCH: editing only the phone number sends a body with exactly that one key", async () => {
    stubFetch({
      "GET /patients/p-1": { patient: PATIENT, resolvedFrom: null },
      "GET /patients/p-1/allergies": { items: [] },
      "GET /patients/p-1/guardians": { items: [] },
      "GET /patients/p-1/qr": QR,
      "PATCH /patients/p-1": { patient: { ...PATIENT, phone: "9998887766" }, changed: ["phone"] },
    });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    const phoneInput = await screen.findByLabelText("Mobile number");
    await user.clear(phoneInput);
    await user.type(phoneInput, "9998887766");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "PATCH")).toBe(true));
    const patched = fetchCalls().find((c) => c.method === "PATCH");
    const body = JSON.parse(patched?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["phone"]);
    expect(body.phone).toBe("9998887766");
  });

  it("E-8: a correction posts to entered-in-error with the typed reason, and is blocked without one", async () => {
    stubFetch({
      "GET /patients/p-1": { patient: PATIENT, resolvedFrom: null },
      "GET /patients/p-1/allergies": { items: [ALLERGIES[1]] }, // the still-active one
      "GET /patients/p-1/guardians": { items: [] },
      "GET /patients/p-1/qr": QR,
      "POST /patients/p-1/allergies/al-1/entered-in-error": { ok: true },
    });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    await screen.findByText("Penicillin");
    await user.click(screen.getByRole("button", { name: "Entered in error" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Entered in error" });

    // Teeth: blocked with an empty reason.
    expect(submit).toBeDisabled();
    expect(fetchCalls().some((c) => c.method === "POST")).toBe(false);

    await user.type(within(dialog).getByLabelText("Reason"), "Wrong patient chart");
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST")).toBe(true));
    const posted = fetchCalls().find((c) => c.method === "POST");
    const body = JSON.parse(posted?.body ?? "{}") as Record<string, unknown>;
    expect(body.reason).toBe("Wrong patient chart");
  });

  it("shows the merged-record banner when the server resolved the URL id to a different canonical patient", async () => {
    stubFetch({
      "GET /patients/p-1": { patient: { ...PATIENT, id: "p-2" }, resolvedFrom: "p-1" },
      "GET /patients/p-2/allergies": { items: [] },
      "GET /patients/p-2/guardians": { items: [] },
      "GET /patients/p-2/qr": QR,
    });
    renderWithProviders(<PatientDetail />);

    expect(await screen.findByText("This record was merged")).toBeInTheDocument();
  });

  it("card reissue calls POST /patients/:id/qr/reissue and renders the new payload", async () => {
    stubFetch({
      "GET /patients/p-1": { patient: PATIENT, resolvedFrom: null },
      "GET /patients/p-1/allergies": { items: [] },
      "GET /patients/p-1/guardians": { items: [] },
      "GET /patients/p-1/qr": QR,
      "POST /patients/p-1/qr/reissue": { qrVersion: 2, payload: "2.p-1.2.def456" },
    });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    expect(await screen.findByText("1.p-1.1.abc123")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reissue card" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Reissuing invalidates every previously printed card for this patient."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reissue card" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST")).toBe(true));
    expect(await screen.findByText("2.p-1.2.def456")).toBeInTheDocument();
    expect(screen.queryByText("1.p-1.1.abc123")).not.toBeInTheDocument();
  });
});
