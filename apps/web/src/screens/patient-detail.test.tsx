import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { PatientDetail } from "./patient-detail";

// The screen reads its patient id from the route param, which only exists inside a
// <RouterProvider>. A component test mounts no router, so useParams is stubbed to the
// one value this screen consumes — mirroring T14's useNavigate mock.
/**
 * PLAN 07b T2 — the screen gained onward actions, so it now calls `useNavigate` as well as
 * `useParams`. A factory that returns only what the screen needed YESTERDAY fails at access time
 * with "No 'useNavigate' export is defined on the mock" — which is the failure mode
 * `billing-counter.test.tsx`'s own comment warns about, met here for real.
 */
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ patientId: "p-1" }),
  useNavigate: () => navigate,
}));

const PATIENT = {
  id: "p-1",
  uhid: "HMS0000001234",
  name: "Asha Devi",
  phone: "9876543210",
  altPhone: null,
  dob: "1990-04-02T00:00:00.000Z",
  dobEstimated: false,
  sex: "female",
  administrativeGender: "female",
  identityAssurance: "id_verified",
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
  promotionalOptIn: false,
  deceasedAt: null,
  deathCertificateNo: null,
  createdAt: "2011-01-12T05:00:00.000Z",
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
  payload: "1.p-1.1.abc123", uhid: "HMS0000001234", name: "Asha Devi", administrativeGender: "female",
  dob: "1990-04-02T00:00:00.000Z",
};

/**
 * UX-AUDIT 2026-09-29 · BOARD — acts follow permissions, so every render now happens as a SEAT: the
 * screen asks `GET /auth/me` and draws only what that seat may do. `ALL` is a seat holding every
 * permission this screen consults, so the behavioural tests keep testing behaviour; the seat tests
 * at the foot of the file pin what each role does and does not see.
 */
const ALL = [
  "patients.read", "patients.register", "patients.update", "patients.deceased.write", "patients.merge",
  "opd.visits.read", "opd.visits.open", "opd.appointments.manage", "billing.invoice.read", "billing.receipt.record",
];
function me(perms: string[]): unknown {
  return { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } };
}
/** `stubFetch` as a seat: the token is set and `/auth/me` answers with `perms`. */
function stubSeat(routes: Record<string, unknown>, perms: string[] = ALL): void {
  setToken("t");
  stubFetch({ "GET /api/auth/me": me(perms), ...routes });
}
/** The form moved into the "Edit details" drawer (board §2): open it, and return the drawer. */
async function openEdit(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Edit details" }));
  return screen.findByTestId("edit-drawer");
}

function fetchCalls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
  }));
}

const BASE = {
  "GET /api/patients/p-1": { patient: PATIENT, resolvedFrom: null },
  "GET /api/patients/p-1/allergies": { items: [] },
  "GET /api/patients/p-1/guardians": { items: [] },
  "GET /api/patients/p-1/qr": QR,
};

describe("PatientDetail", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setToken(null);
  });

  it("renders the name, UHID, a struck-through corrected allergy (still present), and the guardian's SERVER-COMPUTED effective authority", async () => {
    stubSeat({
      ...BASE,
      "GET /api/patients/p-1/allergies": { items: ALLERGIES },
      "GET /api/patients/p-1/guardians": GUARDIANS,
    });
    renderWithProviders(<PatientDetail />);

    expect(await screen.findByRole("heading", { name: "Asha Devi" })).toBeInTheDocument();
    expect(screen.getByText("HMS0000001234")).toBeInTheDocument();

    // UX-AUDIT 2026-09-29 · BOARD — the corrections table moved into "Edit details"; the lane's band
    // shows active allergies only and says a corrected one exists.
    const drawer = within(await openEdit());
    // corrected row: struck through, but the substance and its reason stay visible (E-8 — never hidden)
    const correctedCell = await drawer.findByText("Peanuts");
    expect(correctedCell).toHaveClass("line-through");
    expect(drawer.getByText("Wrong patient chart", { exact: false })).toBeInTheDocument();
    // the still-active row is untouched
    expect(drawer.getByText("Penicillin")).not.toHaveClass("line-through");

    // guardian: stored flags are all true; the screen must render the server's
    // effectiveAuthority (all false) — the exact opposite of what a stored-flags
    // implementation would show.
    expect(await drawer.findByText("Messages")).toHaveClass("line-through");
    expect(drawer.getByText("Consents")).toHaveClass("line-through");
    expect(drawer.getByText("Data requests")).toHaveClass("line-through");
    expect(drawer.getByText("Bills")).toHaveClass("line-through");
  });

  it("D-31: shows the sealed-guardian-messages banner when the patient has sensitiveContext", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1": { patient: { ...PATIENT, sensitiveContext: true }, resolvedFrom: null } });
    renderWithProviders(<PatientDetail />);

    // Beside the messages consent on the page, and again under Representative in the drawer.
    expect(await screen.findByText("Sensitive context: guardian messages are sealed (D-31)")).toBeInTheDocument();
    const drawer = within(await openEdit());
    expect(drawer.getByText("Sensitive context: guardian messages are sealed (D-31)")).toBeInTheDocument();
  });

  it("dirty-field PATCH: editing only the phone number sends a body with exactly that one key", async () => {
    stubSeat({ ...BASE, "PATCH /api/patients/p-1": { patient: { ...PATIENT, phone: "9998887766" }, changed: ["phone"] } });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();
    await openEdit();

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

  /**
   * PLAN 11g / T-D6, DD5 — the edit form's half. The control is gone, but the record's CURRENT value
   * stays in the form's state and is never marked dirty, so a PATCH of some other field cannot
   * silently UN-confidential a patient who already is one. UX-AUDIT 2026-09-29 · BOARD: a
   * confidential record's drawer carries no contact or address fields (owner, 28-Sep), so the
   * unrelated field amended here is the paper-era UHID.
   */
  it("DD5: the confidential control is off the edit form, and an unrelated PATCH does not carry the field", async () => {
    const confidential = { ...PATIENT, isConfidential: true, alias: "VIP-1" };
    stubSeat({
      ...BASE,
      "GET /api/patients/p-1": { patient: confidential, resolvedFrom: null },
      "PATCH /api/patients/p-1": { patient: { ...confidential, legacyUhid: "OLD-9" }, changed: ["legacyUhid"] },
    });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();
    await openEdit();

    const legacy = await screen.findByLabelText("Old UHID (paper era)");
    // The neighbour is still rendered, so this asserts the ONE control is gone.
    expect(screen.getByLabelText("Sensitive context (seals guardian messages)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Confidential record (VIP/staff)")).toBeNull();
    expect(screen.queryByLabelText("Public alias")).toBeNull();

    await user.type(legacy, "OLD-9");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(fetchCalls().find((c) => c.method === "PATCH")?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["legacyUhid"]);
    expect(body).not.toHaveProperty("isConfidential");
  });

  it("D9: the promotional opt-in toggle posts an exact single-field PATCH", async () => {
    stubSeat({ ...BASE, "PATCH /api/patients/p-1": { patient: { ...PATIENT, promotionalOptIn: true }, changed: ["promotionalOptIn"] } });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    // UX-AUDIT 2026-09-29 · BOARD — the consent is READ on the page ("promotional messages: no") and
    // changed behind "Change".
    await user.click(await within(await screen.findByTestId("profile-messages")).findByRole("button", { name: "Change" }));
    const toggle = (await screen.findByLabelText("Promotional messages (opted in)")) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save consent" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "PATCH")).toBe(true));
    const patched = fetchCalls().find((c) => c.method === "PATCH")!;
    const body = JSON.parse(patched.body) as Record<string, unknown>;
    expect(body).toEqual({ promotionalOptIn: true });
  });

  /**
   * OWNER RULING 2026-09-29 (law) — "Record a death" does not save without the death certificate
   * number (MCCD Form 4 / 4A for a death in this hospital). The screen holds the confirm until a
   * number is typed, and the PATCH carries the date AND the number.
   */
  it("OWNER RULING 2026-09-29: a death is not recorded without the death certificate number", async () => {
    stubSeat({
      ...BASE,
      "PATCH /api/patients/p-1": {
        patient: { ...PATIENT, deceasedAt: "2026-08-20T00:00:00.000Z", deathCertificateNo: "MCCD/2026/0412" },
        changed: ["deceasedAt", "deathCertificateNo"],
      },
    });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Record a death" }));
    const dialog = await screen.findByRole("dialog");
    // Typed in Indian order (coordinator review): DD-MM-YYYY in, the ISO calendar day out.
    const died = within(dialog).getByLabelText("Date of death");
    await user.clear(died);
    await user.type(died, "20-08-2026");
    const confirm = within(dialog).getByRole("button", { name: "Confirm deceased" });

    // Teeth: no number, no save.
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(fetchCalls().some((c) => c.method === "PATCH")).toBe(false);
    expect(within(dialog).getByText(/MCCD certificate number \(Form 4 \/ 4A\)/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Death certificate number"), "MCCD/2026/0412");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(fetchCalls().find((c) => c.method === "PATCH")!.body) as Record<string, unknown>;
    expect(body).toEqual({ deceasedAt: "2026-08-20T00:00:00.000Z", deathCertificateNo: "MCCD/2026/0412" });
  });

  it("OWNER RULING 2026-09-29: the server's refusal is shown in its own words", async () => {
    setToken("t");
    stubFetch({
      "GET /api/auth/me": me(ALL),
      ...BASE,
    });
    // A server that refuses: replace fetch with one that answers the PATCH 400.
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({
          statusCode: 400, code: "death_certificate_required",
          message: "death_certificate_required: a death is recorded only with its death certificate number — for a death in this hospital, the MCCD certificate (Form 4 / 4A) number",
        }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      return inner(input, init);
    }));
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Record a death" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Death certificate number"), "X");
    await user.click(within(dialog).getByRole("button", { name: "Confirm deceased" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/^A death is recorded only with its death certificate number/);
    expect(alert).not.toHaveTextContent(/ApiError|death_certificate_required/);
  });

  it("a half-typed date of death is not a date: the confirm stays held and nothing is sent", async () => {
    stubSeat(BASE);
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Record a death" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Death certificate number"), "MCCD/2026/0412");
    const died = within(dialog).getByLabelText("Date of death");
    await user.clear(died);
    await user.type(died, "31-02-2026"); // not a day
    expect(within(dialog).getByRole("button", { name: "Confirm deceased" })).toBeDisabled();
    expect(within(dialog).getByText(/DD-MM-YYYY/)).toBeInTheDocument();
    expect(fetchCalls().some((c) => c.method === "PATCH")).toBe(false);
  });

  it("D10/D-33: the deceased banner shows the printed date and number, and clearing posts an exact PATCH of null", async () => {
    const deceasedPatient = { ...PATIENT, deceasedAt: "2026-08-15T00:00:00.000Z", deathCertificateNo: "MCCD/2026/0400" };
    stubSeat({
      ...BASE,
      "GET /api/patients/p-1": { patient: deceasedPatient, resolvedFrom: null },
      "PATCH /api/patients/p-1": { patient: PATIENT, changed: ["deceasedAt"] },
    });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    expect(await screen.findByText("Marked deceased on 15-Aug-2026")).toBeInTheDocument();
    expect(screen.getByTestId("deceased-banner")).toHaveTextContent("death certificate MCCD/2026/0400");
    expect(screen.queryByRole("button", { name: "Record a death" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear deceased mark" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "PATCH")).toBe(true));
    const patched = fetchCalls().find((c) => c.method === "PATCH")!;
    const body = JSON.parse(patched.body) as Record<string, unknown>;
    expect(body).toEqual({ deceasedAt: null });
  });

  it("E-8: a correction posts to entered-in-error with the typed reason, and is blocked without one", async () => {
    stubSeat({
      ...BASE,
      "GET /api/patients/p-1/allergies": { items: [ALLERGIES[1]] }, // the still-active one
      "POST /api/patients/p-1/allergies/al-1/entered-in-error": { ok: true },
    });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    const drawer = within(await openEdit());
    await user.click(await drawer.findByRole("button", { name: "Entered in error" }));
    const dialog = await screen.findByRole("dialog", { name: "Entered in error" });
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
    stubSeat({
      "GET /api/patients/p-1": { patient: { ...PATIENT, id: "p-2" }, resolvedFrom: "p-1" },
      "GET /api/patients/p-2/allergies": { items: [] },
      "GET /api/patients/p-2/guardians": { items: [] },
      "GET /api/patients/p-2/qr": QR,
    });
    renderWithProviders(<PatientDetail />);

    expect(await screen.findByText("This record was merged")).toBeInTheDocument();
  });

  /**
   * D-23 — reissue kills every older card. UX-AUDIT 2026-09-29 · BOARD: the payload (it carries the
   * internal patient id) is no longer printed as text; it is what the card's QR encodes, so the
   * assertion reads it off the card that will be printed.
   */
  it("card reissue calls POST /patients/:id/qr/reissue and the card printed next carries the new payload", async () => {
    stubSeat({ ...BASE, "POST /api/patients/p-1/qr/reissue": { qrVersion: 2, payload: "2.p-1.2.def456" } });
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Reissue card/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Reissuing invalidates every previously printed card for this patient."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reissue card" }));

    await waitFor(() => expect(fetchCalls().some((c) => c.method === "POST")).toBe(true));
    expect(await screen.findByTestId("reissued-note")).toHaveTextContent("version 2");
    await user.click(screen.getByTestId("print-card"));
    await waitFor(() => expect(screen.getByTestId("qr-card-print")).toHaveAttribute("data-payload", "2.p-1.2.def456"));
    expect(document.body.textContent).not.toContain("1.p-1.1.abc123");
    expect(document.body.textContent).not.toContain("2.p-1.2.def456");
  });

  /**
   * PLAN 07b T2 — THE DEAD END, ENDED. The action must ALSO take the patient in hand, or the
   * destination is just another empty screen and nothing has been gained.
   */
  /**
   * Owner, 2026-10-01 — the shell's "in hand" strip is not drawn over this patient's own profile, so
   * the lane carries Release, at its foot, and only for the patient who is in hand.
   */
  it("the lane's foot offers Release while this patient is in hand, and releasing empties the hand", async () => {
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "p-1", encounterId: null }));
    stubSeat({
      "GET /api/patients/p-1": { patient: PATIENT, resolvedFrom: null },
      "GET /api/patients/p-1/allergies": { items: [] },
      "GET /api/patients/p-1/guardians": { items: [] },
    });
    renderWithProviders(<PatientDetail />);
    expect(await screen.findByTestId("lane-in-hand")).toHaveTextContent("This patient is in hand");
    await userEvent.setup().click(screen.getByTestId("lane-release"));
    expect(sessionStorage.getItem("hmis.inHand")).toBeNull();
    expect(screen.queryByTestId("lane-release")).toBeNull();
  });

  it("no Release in the lane when nobody, or somebody else, is in hand", async () => {
    sessionStorage.setItem("hmis.inHand", JSON.stringify({ patientId: "p-other", encounterId: null }));
    stubSeat({
      "GET /api/patients/p-1": { patient: PATIENT, resolvedFrom: null },
      "GET /api/patients/p-1/allergies": { items: [] },
      "GET /api/patients/p-1/guardians": { items: [] },
    });
    renderWithProviders(<PatientDetail />);
    await screen.findByTestId("onward-actions");
    expect(screen.queryByTestId("lane-release")).toBeNull();
    sessionStorage.clear();
  });

  it("an onward action takes the patient in hand and then navigates", async () => {
    sessionStorage.clear();
    stubSeat({
      "GET /api/patients/p-1": { patient: PATIENT, resolvedFrom: null },
      "GET /api/patients/p-1/allergies": { items: [] },
      "GET /api/patients/p-1/guardians": { items: [] },
    });
    renderWithProviders(<PatientDetail />);
    await screen.findByTestId("onward-actions");

    await userEvent.setup().click(await screen.findByTestId("onward-open-visit"));

    expect(JSON.parse(sessionStorage.getItem("hmis.inHand") ?? "{}")).toMatchObject({ patientId: "p-1" });
    expect(navigate).toHaveBeenCalledWith({ to: "/counter" });
  });
});

/**
 * PLAN 22c-A — CLOSE REVIEW m13. The assurance stamp, the administrative-gender select, the reason
 * select and the client-side Class-I gate.
 */
describe("22c-A T7 — the amendment surface", () => {
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });
  async function open(): Promise<void> {
    stubSeat({
      ...BASE,
      /* ABDM S1 — the shared fixture's ABHA is `verified`, and a verified record LOCKS name, birth and
         gender. These tests are about the Class I reason gate, so they amend a record whose ABHA is
         the patient's own statement. */
      "GET /api/patients/p-1": { patient: { ...PATIENT, abhaVerificationStatus: "self_declared" }, resolvedFrom: null },
    });
    renderWithProviders(<PatientDetail />);
    await openEdit();
  }
  const patches = (): Record<string, unknown>[] =>
    fetchCalls()
      .filter((c) => c.method === "PATCH")
      .map((c) => JSON.parse(c.body) as Record<string, unknown>);

  it("shows the identity assurance stamp", async () => {
    stubSeat(BASE);
    renderWithProviders(<PatientDetail />);
    expect(await screen.findByTestId("identity-assurance")).toHaveTextContent(/ID verified/i);
  });

  it("REFUSES to save a Class I change with no reason, and never calls the API", async () => {
    await open();
    const name = await screen.findByLabelText("Full name");
    await userEvent.clear(name);
    await userEvent.type(name, "Asha Sharma");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/needs a reason/i));
    expect(patches()).toHaveLength(0);
  });

  it("sends administrativeGender WITH its reason once one is chosen", async () => {
    // The round-trip that C1 broke on the server: the field must leave the browser named.
    await open();
    await userEvent.selectOptions(await screen.findByLabelText("Administrative gender"), "other");
    await userEvent.selectOptions(screen.getByLabelText("Reason for amendment"), "legal_change");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({ administrativeGender: "other", reasonClass: "legal_change" });
  });

  /* Coordinator review — the date of birth reads and takes Indian order, not the browser's US one. */
  it("the date of birth reads DD-MM-YYYY and a typed 12-03-1955 leaves as 1955-03-12, with its reason", async () => {
    await open();
    const dob = await screen.findByLabelText("Date of birth");
    expect(dob).toHaveValue("02-04-1990");
    expect(dob).toHaveAttribute("type", "text");
    await userEvent.clear(dob);
    await userEvent.type(dob, "12-03-1955");
    expect(screen.getByText("12-Mar-1955")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Reason for amendment"), "document_correction");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ dob: "1955-03-12", reasonClass: "document_correction" });
  });

  it("a date of birth that is not a real day is refused on the form and never sent", async () => {
    await open();
    const dob = await screen.findByLabelText("Date of birth");
    await userEvent.clear(dob);
    await userEvent.type(dob, "31-02-1990");
    await userEvent.selectOptions(screen.getByLabelText("Reason for amendment"), "document_correction");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Type the date of birth as DD-MM-YYYY")).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
  });

  it("a Class II edit still saves with no reason — the desk does not justify a typo fix", async () => {
    await open();
    const phone = await screen.findByLabelText("Mobile number");
    await userEvent.clear(phone);
    await userEvent.type(phone, "9000000000");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).not.toHaveProperty("reasonClass");
  });

  /**
   * FD-23 — the redesign's two structural claims, asserted rather than eyeballed: this screen wears
   * the counter's design scope, and the agent is on it.
   */
  it("wears the counter's paper-pine scope and carries the desk agent", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1/allergies": { items: ALLERGIES }, "GET /api/patients/p-1/guardians": GUARDIANS });
    renderWithProviders(<PatientDetail />);
    await screen.findByRole("heading", { name: "Asha Devi" });

    expect(document.querySelector(".pp")).not.toBeNull();
    expect(screen.getByTestId("agent-dock")).toBeInTheDocument();
    expect(screen.getByTestId("agent-ticker")).toHaveTextContent(/this patient's record only/);
  });

  /* The agent answers from the row already fetched — no lookup, and it names where it came from. */
  it("the agent answers about THIS record and says so", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1/allergies": { items: ALLERGIES }, "GET /api/patients/p-1/guardians": GUARDIANS });
    renderWithProviders(<PatientDetail />);
    await screen.findByRole("heading", { name: "Asha Devi" });

    const user = userEvent.setup();
    await user.type(screen.getByTestId("agent-ask"), "what is their uhid?{Enter}");
    /* Scoped to the dock: the UHID is also in the lane, and the claim here is about the ANSWER. */
    const dock = within(screen.getByTestId("agent-dock"));
    expect(dock.getByText(/HMS0000001234/)).toBeInTheDocument();
    // it names its source rather than sounding omniscient
    expect(dock.getByText(/from the patient row/)).toBeInTheDocument();
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * FD-34 — THE FAMILY A SHARED MOBILE MAKES
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * The symmetry is the SERVER's (`modules/patients/linked.ts`); these cases pin that the screen
   * renders what it is handed and says nothing it was not told. UX-AUDIT 2026-09-29 · BOARD: the
   * shared number is masked to its last four digits.
   */
  const LINKED = {
    numbers: ["9876543210"],
    total: 2,
    items: [
      {
        id: "p-2", uhid: "HMS0000001235", name: "Sunil Kumar", phone: "9876543210", altPhone: null,
        administrativeGender: "male", dob: "1988-06-11T00:00:00.000Z", isConfidential: false,
        registeredOn: "2026-02-02T00:00:00.000Z", sharedOn: ["9876543210"],
      },
      {
        id: "p-3", uhid: "HMS0000001236", name: "Bimla Devi", phone: "9000000000", altPhone: "9876543210",
        administrativeGender: "female", dob: "1962-01-09T00:00:00.000Z", isConfidential: false,
        registeredOn: "2026-02-03T00:00:00.000Z", sharedOn: ["9876543210"],
      },
    ],
  };

  it("lists the patients who share this mobile, and opens the one that is clicked", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1/linked": LINKED });
    renderWithProviders(<PatientDetail />);

    // The section paints before its query answers, so the ROW is what to wait for — not the heading.
    const section = within(await screen.findByTestId("linked-patients"));
    expect(await section.findByText("Sunil Kumar")).toBeInTheDocument();
    expect(section.getByText("Bimla Devi")).toBeInTheDocument();
    /*
      THE SECOND ROW IS THE TEETH. Bimla's PRIMARY number is a different one and she is family
      through her ALTERNATE — a row rendered from `phone` rather than from the server's `sharedOn`
      would print 0000 here and tell the clerk the two share a number they do not.
    */
    expect(section.getByTestId("linked-HMS0000001236")).toHaveTextContent("shares •••••• 3210");
    // …and it says what it knows: a shared number, never an invented relationship.
    expect(section.getByText(/is inferred, never a relationship/)).toBeInTheDocument();

    fireEvent.click(section.getByTestId("linked-HMS0000001235"));
    expect(navigate).toHaveBeenCalledWith({ to: "/patients/$patientId", params: { patientId: "p-2" } });
  });

  it("says so plainly when nobody else is on the number", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1/linked": { numbers: ["9876543210"], items: [], total: 0 } });
    renderWithProviders(<PatientDetail />);

    expect(await screen.findByTestId("linked-empty")).toHaveTextContent(
      "No other patient is registered on this number.",
    );
  });

  /**
   * A NUMBER ON THIRTY RECORDS IS A SHOP, NOT A HOUSEHOLD — and the screen has to say it. The server
   * caps the list; this line is what stops the cap from being a silent lie.
   */
  it("warns when the number is on more records than a household has", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1/linked": { ...LINKED, total: 30 } });
    renderWithProviders(<PatientDetail />);

    expect(await screen.findByTestId("linked-beyond-cap")).toHaveTextContent(
      "28 more records share this number, 30 in all",
    );
  });

  /* D-34 — a phoneless record is a designed path, and there is nothing to ask about it. */
  it("draws no family section at all for a patient with no number", async () => {
    stubSeat({
      ...BASE,
      "GET /api/patients/p-1": { patient: { ...PATIENT, phone: null, altPhone: null }, resolvedFrom: null },
      "GET /api/patients/p-1/linked": { numbers: [], items: [], total: 0 },
    });
    renderWithProviders(<PatientDetail />);
    await screen.findByRole("heading", { name: "Asha Devi" });

    expect(screen.queryByTestId("linked-patients")).toBeNull();
  });
});

/**
 * ABDM S0 — `verified` is ABDM's answer, never a clerk's choice. A record the registry verified
 * still SHOWS the stamp (and a clerk may take it down), and any other record's control has no
 * "verified" to pick.
 */
describe("ABDM S0 — the counter cannot offer 'verified'", () => {
  async function openWith(status: string): Promise<void> {
    stubSeat({ ...BASE, "GET /api/patients/p-1": { patient: { ...PATIENT, abhaVerificationStatus: status }, resolvedFrom: null } });
    renderWithProviders(<PatientDetail />);
    await openEdit();
  }
  const statusSelect = async (): Promise<HTMLSelectElement> =>
    waitFor(() => {
      const el = document.getElementById("f-abhaVerificationStatus");
      expect(el).not.toBeNull();
      return el as HTMLSelectElement;
    });

  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("an unverified record's status control offers none and self_declared only, in printed words", async () => {
    await openWith("self_declared");
    const select = await statusSelect();
    expect([...select.options].map((o) => o.value)).toEqual(["none", "self_declared"]);
    expect([...select.options].map((o) => o.textContent)).toEqual(["Not recorded", "not verified"]);
    expect(select.value).toBe("self_declared");
  });

  it("an ABDM-verified record still shows verified, and offers taking it down", async () => {
    await openWith("verified");
    const select = await statusSelect();
    expect([...select.options].map((o) => o.value)).toEqual(["none", "self_declared", "verified"]);
    expect(select.value).toBe("verified");
  });
});

/**
 * ABDM S1 — "Verify with ABDM" on the record: drawn only when this hospital can verify (the
 * capability says so), and it opens the verification flow pre-filled with the record's ABHA.
 * UX-AUDIT 2026-09-29 · BOARD: it lives under "Less often".
 */
describe("ABDM S1 — Verify with ABDM on the record", () => {
  function openWith(canVerify: boolean): void {
    stubSeat({
      ...BASE,
      "GET /api/patients/p-1": { patient: { ...PATIENT, abhaNumber: "91-2345-6789-0123", abhaVerificationStatus: "self_declared" }, resolvedFrom: null },
      "GET /api/patients/abha/capability": { configured: canVerify, canRecord: true, canCreate: false, canVerify, canScanShare: canVerify, reason: "test" },
    });
    renderWithProviders(<PatientDetail />);
  }
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("is not drawn when the hospital cannot verify", async () => {
    openWith(false);
    await screen.findByTestId("less-often");
    await waitFor(() => expect(fetchCalls().some((c) => c.url.includes("/abha/capability"))).toBe(true));
    expect(screen.queryByTestId("patient-abdm-verify")).toBeNull();
  });

  it("opens the flow with the record's ABHA number when it can", async () => {
    openWith(true);
    const button = await screen.findByTestId("patient-abdm-verify");
    await userEvent.setup({ delay: null }).click(button);
    expect(await screen.findByTestId("abdm-identifier")).toHaveValue("91-2345-6789-0123");
  });
});

/**
 * ABDM S1 — DECIDED (NHA M1 workbook): while the ABHA is verified, name, birth and gender are ABDM's.
 * The form says so and does not let them be typed over; mobile stays editable.
 */
describe("ABDM S1 — the demographics lock on the record", () => {
  async function openWith(status: string): Promise<void> {
    stubSeat({
      ...BASE,
      "GET /api/patients/p-1": { patient: { ...PATIENT, abhaNumber: "91-2345-6789-0123", abhaVerificationStatus: status }, resolvedFrom: null },
      "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, canScanShare: false, reason: "test" },
    });
    renderWithProviders(<PatientDetail />);
    await openEdit();
  }
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("verified: name and date of birth are read-only, gender inert, the phone editable, and the note says why", async () => {
    await openWith("verified");
    await screen.findByTestId("abdm-demographics-locked");
    await waitFor(() => expect(document.getElementById("f-name")).not.toBeNull());
    expect(document.getElementById("f-name")).toHaveAttribute("readonly");
    expect(document.getElementById("f-dob")).toHaveAttribute("readonly");
    expect(document.getElementById("f-administrativeGender")).toHaveAttribute("aria-disabled", "true");
    expect(document.getElementById("f-phone")).not.toHaveAttribute("readonly");
  });

  it("not verified: nothing is locked", async () => {
    await openWith("self_declared");
    await waitFor(() => expect(document.getElementById("f-name")).not.toBeNull());
    expect(screen.queryByTestId("abdm-demographics-locked")).toBeNull();
    expect(document.getElementById("f-name")).not.toHaveAttribute("readonly");
  });
});

/**
 * ═══ UX-AUDIT 2026-09-29 · BOARD — WHAT THE APPROVED BOARD CHANGES, PINNED ═══
 *
 * Each case below fails against the edit-form page this replaced (`git show origin/main:` of this
 * screen): allergies were below a 20-input form, there was no history, both mobiles printed in
 * full, dates were ISO, a sealed record's H1 was the real name, and every act drew for every role.
 */
describe("UX-AUDIT 2026-09-29 · BOARD — the profile", () => {
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  const FRONT_DESK = [
    "patients.read", "patients.register", "patients.update", "opd.visits.read", "opd.visits.open",
    "opd.appointments.manage", "opd.appointments.read", "opd.queue.read",
  ];
  const DOCTOR = ["patients.read", "patients.update", "opd.visits.read", "opd.consult", "lab.results.read", "radiology.reports.read"];
  const CASHIER = ["patients.read", "billing.invoice.read", "billing.invoice.issue", "billing.receipt.record"];

  const TIMELINE = {
    items: [{
      encounterId: "e-1", visitNo: "OP-26-18422", serviceDate: "2026-09-18", openedAt: "2026-09-18T04:30:00.000Z", status: "completed",
      visitType: "new", doctorId: "d-1", doctorName: "Dr. S. Rao", departmentId: "gm", departmentName: "General Medicine",
      diagnosis: "Type 2 diabetes", icd10Code: "E11.9", prescriptionLineCount: 4, dangerFlagged: false,
    }],
  };
  const INVOICES = {
    items: [
      { id: "inv-1", invoiceNo: "OP/26/004411", patientId: "p-1", encounterId: "e-1", netPayablePaise: 124000, creditExtended: false, issuedAt: "2026-09-18T05:00:00.000Z", serviceDay: "2026-09-18", seq: 2 },
      { id: "inv-2", invoiceNo: "OP/26/003982", patientId: "p-1", encounterId: null, netPayablePaise: 215000, creditExtended: false, issuedAt: "2026-08-02T05:00:00.000Z", serviceDay: "2026-08-02", seq: 1 },
    ],
  };
  const DUES = {
    items: [{ invoiceId: "inv-2", invoiceNo: "OP/26/003982", patientId: "p-1", uhid: "HMS0000001234", name: "Asha Devi", alias: null, restricted: false, serviceDay: "2026-08-02", issuedAt: "2026-08-02T05:00:00.000Z", netPayablePaise: 215000, outstandingPaise: 65000, creditExtended: false, seq: 1 }],
  };

  it("allergies are in the lane on arrival, before anything is opened — severe in brick red", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1/allergies": { items: [...ALLERGIES, { ...ALLERGIES[1], id: "al-3", substance: "Sulfa drugs", severity: "severe", reaction: "Anaphylaxis" }] } }, FRONT_DESK);
    renderWithProviders(<PatientDetail />);
    const band = within(await screen.findByTestId("allergy-band"));
    expect(await band.findByText("Allergies · 2 active")).toBeInTheDocument();
    expect(band.getByText("Penicillin")).toBeInTheDocument();
    expect(band.getByText("Severe")).toHaveClass("sev", "s");
    expect(band.queryByText("Peanuts")).toBeNull(); // the corrected one lives under Edit details
    expect(band.getByText(/1 corrected entry/)).toBeInTheDocument();
    expect(screen.queryByTestId("edit-drawer")).toBeNull();
    // Read first, edit behind a button: no form field is on the page until "Edit details".
    expect(document.getElementById("f-name")).toBeNull();
    expect(document.getElementById("f-phone")).toBeNull();
  });

  it("prints dates as 02-Apr-1990 and masks mobiles to their last four digits — no ISO, no full number", async () => {
    stubSeat({ ...BASE, "GET /api/patients/p-1": { patient: { ...PATIENT, altPhone: "9414022871" }, resolvedFrom: null }, "GET /api/patients/p-1/guardians": GUARDIANS }, FRONT_DESK);
    renderWithProviders(<PatientDetail />);
    const lane = within(await screen.findByTestId("profile-lane"));
    expect(await lane.findByText("02-Apr-1990")).toBeInTheDocument();
    expect(lane.getByText("•••••• 3210")).toBeInTheDocument();
    expect(lane.getByText("•••••• 2871")).toBeInTheDocument();
    expect(await lane.findByText(/Sunita Kumar/)).toBeInTheDocument();
    expect(lane.getByText(/declared · mother/)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(text).not.toMatch(/9876543210|9414022871|9998887771/);
    expect(text).not.toMatch(/self_declared|id_verified/);
  });

  /** Owner, 2026-10-01 — a booked future appointment was on no part of the profile: it has no visit yet. */
  it("front desk: an appointment booked ahead shows above the history, with its day, time, doctor and department", async () => {
    const ahead = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    stubSeat({
      ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE,
      "GET /api/opd/appointments": { items: [
        { id: "a-9", patientId: "p-1", doctorId: "doc-7", departmentId: "d-7", serviceDate: ahead, slotStart: `${ahead}T05:00:00.000Z`, slotEnd: `${ahead}T05:15:00.000Z`, status: "booked" },
        { id: "a-old", patientId: "p-1", doctorId: "doc-7", departmentId: "d-7", serviceDate: "2020-01-01", slotStart: "2020-01-01T05:00:00.000Z", slotEnd: "2020-01-01T05:15:00.000Z", status: "booked" },
      ] },
      "GET /api/opd/doctors": { items: [{ id: "doc-7", displayName: "Dr. Meera Nair", departmentId: "d-7" }] },
      "GET /api/opd/departments": { items: [{ id: "d-7", name: "Ophthalmology" }] },
    }, FRONT_DESK);
    renderWithProviders(<PatientDetail />);
    const rows = await screen.findAllByTestId("upcoming-row");
    expect(rows).toHaveLength(1); // the 2020 booking is not "upcoming"
    expect(rows[0]).toHaveTextContent("10:30"); // 05:00Z is 10:30 IST
    await waitFor(() => expect(rows[0]).toHaveTextContent("Dr. Meera Nair · Ophthalmology"));
    expect(fetchCalls().some((c) => c.url.includes("/opd/appointments?patientId=p-1"))).toBe(true);
  });

  /**
   * Owner, 2026-10-01: an Edit that leads to the appointment book; the appointment history; and a
   * tap on an appointment showing its bills.
   */
  it("an upcoming appointment carries Edit for a seat that may manage the book, and the history opens an appointment's bills", async () => {
    const ahead = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const row = (id: string, day: string, over: Record<string, unknown>): Record<string, unknown> => ({
      id, patientId: "p-1", doctorId: "doc-7", departmentId: "d-7", serviceDate: day, slotStart: `${day}T05:00:00.000Z`, slotEnd: `${day}T05:15:00.000Z`, status: "booked", encounterId: null, ...over,
    });
    stubSeat({
      ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE,
      "GET /api/opd/appointments": { items: [
        row("a-next", ahead, {}),
        row("a-kept", "2026-03-10", { status: "checked_in", encounterId: "e-77" }),
        row("a-missed", "2026-02-02", { status: "no_show" }),
      ] },
      "GET /api/opd/doctors": { items: [{ id: "doc-7", displayName: "Dr. Meera Nair", departmentId: "d-7" }] },
      "GET /api/opd/departments": { items: [{ id: "d-7", name: "Ophthalmology" }] },
      "GET /api/billing/invoices": (_init?: RequestInit, url?: string) => (String(url ?? "").includes("encounterId=e-77")
        ? { items: [{ id: "inv-1", invoiceNo: "INV/26/000123", encounterId: "e-77", serviceDay: "2026-03-10", grossPaise: 30000, netPayablePaise: 30000 }] }
        : { items: [] }),
    }, [...FRONT_DESK, "billing.invoice.read"]);
    renderWithProviders(<PatientDetail />);
    const user = userEvent.setup();

    expect(await screen.findByTestId("upcoming-edit-a-next")).toHaveTextContent("Edit");
    const history = await screen.findAllByTestId("appt-history-row");
    expect(history.map((r) => r.textContent)).toEqual([expect.stringContaining("10-Mar-2026"), expect.stringContaining("02-Feb-2026")]); // newest first; the one still ahead is not history
    expect(history[0]).toHaveTextContent("Checked in");
    expect(history[1]).toHaveTextContent("No-show");

    await user.click(history[0]!);
    const bill = await screen.findByTestId("appt-bill");
    expect(bill).toHaveTextContent("INV/26/000123");
    expect(bill).toHaveTextContent("₹300");

    // An appointment that never became a visit has no bill, and says why.
    await user.click(history[1]!);
    expect(await screen.findByTestId("appt-bills-note")).toHaveTextContent("not checked in");
  });

  it("a seat without billing.invoice.read is told bills are not shown to it, and asks the bill route nothing", async () => {
    stubSeat({
      ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE,
      "GET /api/opd/appointments": { items: [{ id: "a-kept", patientId: "p-1", doctorId: "doc-7", departmentId: "d-7", serviceDate: "2026-03-10", slotStart: "2026-03-10T05:00:00.000Z", slotEnd: "2026-03-10T05:15:00.000Z", status: "checked_in", encounterId: "e-77" }] },
      "GET /api/opd/doctors": { items: [] }, "GET /api/opd/departments": { items: [] },
    }, FRONT_DESK);
    renderWithProviders(<PatientDetail />);
    await userEvent.setup().click(await screen.findByTestId("appt-history-row"));
    expect(await screen.findByTestId("appt-bills-note")).toHaveTextContent("Bills are shown to billing staff");
    expect(fetchCalls().some((c) => c.url.includes("/billing/invoices"))).toBe(false);
  });

  it("front desk: with nothing booked ahead the profile says so; a seat without the appointment book is not shown the heading", async () => {
    stubSeat({ ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE, "GET /api/opd/appointments": { items: [] } }, FRONT_DESK);
    const first = renderWithProviders(<PatientDetail />);
    await waitFor(() => expect(screen.getByTestId("upcoming-empty")).toHaveTextContent("No appointment booked ahead"));
    first.unmount();
    stubSeat({ ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE }, FRONT_DESK.filter((p) => p !== "opd.appointments.read"));
    renderWithProviders(<PatientDetail />);
    await screen.findByTestId("timeline");
    expect(screen.queryByText("Upcoming appointments")).toBeNull();
    expect(fetchCalls().some((c) => c.url.includes("/opd/appointments"))).toBe(false);
  });

  it("front desk: one dated timeline with source chips, the diagnosis line only; no money reads; no Record a death", async () => {
    stubSeat({ ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE }, FRONT_DESK);
    renderWithProviders(<PatientDetail />);
    const tl = within(await screen.findByTestId("timeline"));
    expect(await tl.findByText("18-Sep-2026")).toBeInTheDocument();
    const row = tl.getByText("General Medicine · Dr. S. Rao").closest("[data-testid=timeline-row]") as HTMLElement;
    expect(row).toHaveTextContent("OPD");
    expect(row).toHaveTextContent("Type 2 diabetes");
    expect(row).not.toHaveTextContent("E11.9"); // the code and medicines are opd.consult's
    expect(row).not.toHaveTextContent("medicines");
    expect(row).toHaveTextContent("visit OP-26-18422");
    expect(fetchCalls().some((c) => c.url.includes("/billing/"))).toBe(false);
    expect(await screen.findByRole("button", { name: "Edit details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record a death" })).toBeNull();
    // No filter chips or tabs on the timeline (owner rule).
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("OWNER RULING 2026-09-30 · front desk with the narrow dues string: the Today band shows what is owed; no invoice history is asked", async () => {
    stubSeat({ ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE, "GET /api/billing/patients/p-1/dues": DUES }, [...FRONT_DESK, "billing.dues.patient.read"]);
    renderWithProviders(<PatientDetail />);
    expect(await screen.findByTestId("today-dues")).toHaveTextContent("₹650.00 due");
    expect(screen.getByTestId("today-dues")).toHaveTextContent("from 02-Aug-2026 · bill OP/26/003982");
    const tl = within(await screen.findByTestId("timeline"));
    expect(await tl.findByText("18-Sep-2026")).toBeInTheDocument();
    // The BILL rows are the invoice list's, and the ruling withholds it: never asked, never drawn.
    expect(fetchCalls().some((c) => c.url.includes("/billing/invoices"))).toBe(false);
    expect(fetchCalls().filter((c) => c.url.includes("/billing/")).map((c) => c.url)).toEqual([expect.stringContaining("/billing/patients/p-1/dues")]);
    expect(tl.queryByText("OP/26/004411")).toBeNull();
    expect(screen.queryByTestId("onward-bill")).toBeNull();
  });

  it("doctor seat: full clinical line, no money, no Edit details, no Record a death, no Take payment", async () => {
    stubSeat({ ...BASE, "GET /api/opd/patients/p-1/timeline": TIMELINE }, DOCTOR);
    renderWithProviders(<PatientDetail />);
    const tl = within(await screen.findByTestId("timeline"));
    expect(await tl.findByText(/Type 2 diabetes \(E11\.9\) · 4 medicines prescribed/)).toBeInTheDocument();
    expect(screen.queryByTestId("onward-bill")).toBeNull();
    expect(screen.queryByTestId("onward-open-visit")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record a death" })).toBeNull();
    expect(fetchCalls().some((c) => c.url.includes("/billing/"))).toBe(false);
    // patients.update: the doctor may still add an allergy and correct the record's details.
    expect(screen.getByRole("button", { name: "Edit details" })).toBeInTheDocument();
  });

  it("billing seat: bills with amounts and what is still due, a Take-payment act, and no visit reads", async () => {
    stubSeat({ ...BASE, "GET /api/billing/invoices": INVOICES, "GET /api/billing/patients/p-1/dues": DUES }, CASHIER);
    renderWithProviders(<PatientDetail />);
    expect(await screen.findByTestId("today-dues")).toHaveTextContent("₹650.00 due");
    expect(screen.getByTestId("today-dues")).toHaveTextContent("from 02-Aug-2026 · bill OP/26/003982");
    const tl = within(screen.getByTestId("timeline"));
    expect(await tl.findByText("OP/26/004411")).toBeInTheDocument();
    expect(tl.getByText("₹1,240.00")).toBeInTheDocument();
    expect(tl.getByText("₹1,500.00 paid · ₹650.00 due")).toBeInTheDocument();
    expect(screen.getByTestId("onward-bill")).toHaveTextContent("Take ₹650.00");
    expect(screen.queryByRole("button", { name: "Edit details" })).toBeNull();
    expect(fetchCalls().some((c) => c.url.includes("/opd/"))).toBe(false);
  });

  it("restricted record: the alias is the name; the real name, contact, address and family links are not drawn", async () => {
    const sealed = { ...PATIENT, isConfidential: true, alias: "Patient R-2291", sensitiveContext: true };
    stubSeat({ ...BASE, "GET /api/patients/p-1": { patient: sealed, resolvedFrom: null } }, [...FRONT_DESK, "patients.deceased.write"]);
    renderWithProviders(<PatientDetail />);
    expect(await screen.findByRole("heading", { name: "Patient R-2291" })).toBeInTheDocument();
    expect(screen.getByTestId("restricted-pill")).toHaveTextContent("Restricted record");
    expect(screen.getByTestId("restricted-banner")).toHaveTextContent("Medical Superintendent");
    await waitFor(() => expect(fetchCalls().some((c) => c.url.includes("/auth/me"))).toBe(true));
    const text = (): string => document.body.textContent ?? "";
    expect(text()).not.toContain("Asha Devi");
    expect(text()).not.toContain("3210");
    expect(text()).not.toContain("MG Road");
    expect(fetchCalls().some((c) => c.url.includes("/linked") || c.url.includes("/guardians"))).toBe(false);
    // …and not in the edit form either.
    const drawer = await openEdit();
    expect(drawer).toHaveTextContent("Edit details · Patient R-2291");
    expect(document.getElementById("f-name")).toBeNull();
    expect(document.getElementById("f-phone")).toBeNull();
    expect(document.getElementById("f-addressLine")).toBeNull();
    expect(text()).not.toContain("Asha Devi");
  });
});

/*
  Owner, staging 2026-10-01: "while typing allergy name, I got no suggestion". The profile's dialog
  was a plain text box — the bay and the doctor had the allergen typeahead and this seat did not.
*/
describe("Add allergy on the profile suggests as the clerk types", () => {
  it("offers coded allergens, a pick saves the class, and unknown free text says so", async () => {
    const posted: unknown[] = [];
    stubSeat({
      ...BASE,
      "GET /api/opd/cds/complete/allergen": (_init?: RequestInit, url?: string) =>
        (url ?? "").includes("q=penic")
          ? { items: [{ term: "Penicillins / Beta-Lactams", kind: "class", allergenClass: "penicillin", saltId: null, blocks: ["Amoxicillin"] }], known: true }
          : { items: [], known: false },
      "POST /api/patients/p-1/allergies": (init?: RequestInit) => { posted.push(JSON.parse(String(init?.body))); return { id: "al-9" }; },
    });
    const user = userEvent.setup();
    renderWithProviders(<PatientDetail />);
    await user.click((await screen.findAllByRole("button", { name: "Add allergy" }))[0]!);
    const box = await screen.findByLabelText("Substance");

    await user.type(box, "xyz");
    await waitFor(() => expect(screen.getByTestId("profile-allergy-unknown")).toBeInTheDocument());

    await user.clear(box);
    await user.type(box, "penic");
    await waitFor(() => expect(screen.getByTestId("profile-allergy-hits")).toBeInTheDocument());
    expect(screen.queryByTestId("profile-allergy-unknown")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("profile-allergy-hit-Penicillins / Beta-Lactams"));
    expect(box).toHaveValue("Penicillins / Beta-Lactams");
    await waitFor(() => expect(screen.queryByTestId("profile-allergy-hits")).not.toBeInTheDocument());

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add allergy" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      substance: "Penicillins / Beta-Lactams", severity: "mild", source: "registration",
      saltId: null, allergenClass: "penicillin",
    });
  });
});
