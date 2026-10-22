import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../../lib/api";
import { renderWithProviders, stubFetch } from "../../test-utils";
import { PatientDetail } from "../patient-detail";
import en from "../../locales/en.json";
import hi from "../../locales/hi.json";

/**
 * ACCEPTANCE — issue #942, spec docs/specs/942-spouse-husband-name.md (owner APPROVED 2026-10-22):
 * the profile's "Add a representative" offers the same six relations as registration, and a spouse
 * saved there is stored as `spouse` and reads as a word in English and Hindi.
 */
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ patientId: "p-1" }),
  useNavigate: () => vi.fn(),
}));

const PATIENT = {
  id: "p-1", uhid: "HMS0000009420", name: "Asha Devi", phone: "9876543210", altPhone: null,
  dob: "1990-04-02T00:00:00.000Z", dobEstimated: false, sex: "female", administrativeGender: "female",
  identityAssurance: "id_verified", addressLine: null, district: null, stateName: null, pincode: null,
  language: "hi", bloodGroup: null, isConfidential: false, alias: null, sensitiveContext: false,
  abhaAddress: null, abhaNumber: null, abhaVerificationStatus: null, abhaLinkToken: null, legacyUhid: null,
  qrVersion: 1, status: "active", mergedIntoPatientId: null, promotionalOptIn: false, deceasedAt: null,
  deathCertificateNo: null, createdAt: "2011-01-12T05:00:00.000Z",
};
const PERMS = ["patients.read", "patients.register", "patients.update", "opd.visits.read"];

describe("#942 — spouse on the profile's representative list", () => {
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("spec #942 D1: the profile offers father, mother, spouse, sibling, legal guardian, other; Spouse posts `spouse`; the word exists in en and hi", async () => {
    setToken("t");
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-1" }, permissions: { hospital: PERMS, scoped: { department: {}, floor: {} } } },
      "GET /api/patients/p-1/profile": { patient: PATIENT, resolvedFrom: null },
      "GET /api/patients/p-1/allergies": { items: [] },
      "GET /api/patients/p-1/guardians": { items: [] },
      "GET /api/patients/p-1/qr": { payload: "1.p-1.1.x", uhid: PATIENT.uhid, name: PATIENT.name, administrativeGender: "female", dob: PATIENT.dob },
      "POST /api/patients/p-1/guardians": { ok: true },
    });
    renderWithProviders(<PatientDetail />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a representative" }));
    const dialog = within(await screen.findByRole("dialog"));
    const select = dialog.getByLabelText("Relationship") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["father", "mother", "spouse", "sibling", "legal_guardian", "other"]);
    expect([...select.options].find((o) => o.value === "spouse")!.text).toBe("spouse");

    fireEvent.change(dialog.getByLabelText("Guardian name"), { target: { value: "Ramesh Kumar" } });
    fireEvent.change(select, { target: { value: "spouse" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add guardian" }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ name: "Ramesh Kumar", relationship: "spouse" });
    });

    const words = (l: { profile: { relationship: Record<string, string> } }): Record<string, string> => l.profile.relationship;
    expect(words(en).spouse).toBe("spouse");
    expect(words(en).sibling).toBe("sibling");
    expect(words(hi).spouse).toBe("पति/पत्नी");
    expect(words(hi).sibling).toBe("भाई/बहन");
  });
});
