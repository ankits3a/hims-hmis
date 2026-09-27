import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { ExternalRecordsPanel } from "./abdm-external-records";

/**
 * ABDM S3 — "Records from other hospitals" in the consult's History: what another facility sent under
 * the patient's ABDM consent, grouped by that facility, newest first, EVERY record labelled external
 * and not verified by this hospital, with its consent's expiry; and the doctor's request, which says
 * what it asks for before it is sent.
 */
type Route = { status?: number; body: unknown } | ((init?: RequestInit) => { status?: number; body: unknown });

function stub(routes: Record<string, Route>, seen: { key: string; body: unknown }[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    seen.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const r = routes[key];
    if (r === undefined) return new Response("{}", { status: 404 });
    const { status = 200, body } = typeof r === "function" ? r(init) : r;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
}

const summary = (title: string, lines: string[]) => ({
  title, date: null, authors: ["Dr. Kavya Rao"], custodian: "Fortis Escorts Jaipur", subjectName: "Sunita Sharma",
  sections: [{ title: "Medications", lines }],
});
const record = (id: string, hiType: string, day: string, title: string, lines: string[], over: Record<string, unknown> = {}) => ({
  id, hiType, recordDate: `${day}T05:20:00.000Z`, title, careContextReference: "FORTIS-OP-7781", consentId: "artefact-1",
  consentExpiresAt: "2026-10-10T00:00:00.000Z", checksumVerified: true, receivedAt: "2026-09-26T06:01:00.000Z", summary: summary(title, lines), ...over,
});
const DATA = {
  hiuConfigured: true,
  abha: { address: "sunita.sharma@sbx", verified: true },
  purposes: [{ code: "CAREMGT", text: "Care Management" }, { code: "BTG", text: "Break the Glass" }],
  hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport", "DischargeSummary", "ImmunizationRecord", "HealthDocumentRecord", "WellnessRecord", "Invoice"],
  defaults: { purposeCode: "CAREMGT", hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"], from: "2025-09-26T06:00:00.000Z", to: "2026-09-26T06:00:00.000Z", dataEraseAt: "2026-10-26T06:00:00.000Z" },
  requests: [{
    id: "req-1", encounterId: "enc-1", status: "granted", purposeCode: "CAREMGT", purposeText: "Care Management", hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"],
    dateFrom: "2025-09-26T06:00:00.000Z", dateTo: "2026-09-26T06:00:00.000Z", dataEraseAt: "2026-10-26T06:00:00.000Z", createdAt: "2026-09-26T06:00:00.000Z",
    requesterName: "Dr. Anil Verma", consentRequestId: "cr-1", error: null,
    artefacts: [{ consentId: "artefact-1", hipId: "IN0810000123", hipName: "Fortis Escorts Jaipur", status: "GRANTED", dataEraseAt: "2026-10-10T00:00:00.000Z", erasedAt: null, erasedCount: 0, recordCount: 2, error: null }],
  }],
  facilities: [
    { hipId: "IN0810000123", hipName: "Fortis Escorts Jaipur", records: [
      // deliberately OLDEST first: the panel orders a facility's records newest first itself
      record("r-1", "Prescription", "2026-07-14", "Prescription · Cardiology · 2026-07-14", ["Atorvastatin 20 mg tablet — 1 tab · HS · oral · 30 days"], { checksumVerified: false }),
      record("r-2", "OPConsultation", "2026-08-01", "OPD consultation · Cardiology · 2026-08-01", ["Follow-up, breathless on stairs"]),
    ] },
    { hipId: "IN0910000456", hipName: "SMS Hospital", records: [record("r-3", "DiagnosticReport", "2026-06-02", "Laboratory report · Lipid profile", ["LDL cholesterol: 162 mg/dL · High"])] },
  ],
};

beforeEach(() => { setToken("t-1"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

describe("ExternalRecordsPanel — records from other hospitals, in the consult", () => {
  it("groups by facility, newest first, and labels EVERY record external — not verified by this hospital — with its consent's expiry", async () => {
    stub({ "GET /api/abdm/hiu/patients/p-1/records": { body: DATA } }, []);
    renderWithProviders(<ExternalRecordsPanel patientId="p-1" encounterId="enc-1" />);
    expect(await screen.findByTestId("abdm-external-facility-IN0810000123")).toBeInTheDocument();
    expect(screen.getByTestId("abdm-external-label")).toHaveTextContent(/not verified by this hospital/i);
    const fortis = screen.getByTestId("abdm-external-facility-IN0810000123");
    expect(within(fortis).getByTestId("abdm-external-facility-name")).toHaveTextContent("Fortis Escorts Jaipur");
    const rows = within(fortis).getAllByTestId(/^abdm-external-record-r-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["abdm-external-record-r-2", "abdm-external-record-r-1"]);
    for (const r of [...rows, screen.getByTestId("abdm-external-record-r-3")]) {
      expect(within(r).getByTestId("abdm-external-badge")).toHaveTextContent(/external/i);
      expect(within(r).getByTestId("abdm-external-expiry")).toHaveTextContent("10 Oct 2026");
    }
    expect(within(screen.getByTestId("abdm-external-facility-IN0910000456")).getByTestId("abdm-external-record-r-3")).toBeInTheDocument();
    expect(within(rows[1]!).getByTestId("abdm-external-lines")).toHaveTextContent("Atorvastatin 20 mg tablet — 1 tab · HS · oral · 30 days");
    expect(within(rows[1]!).getByTestId("abdm-external-unverified")).toBeInTheDocument();
    expect(within(rows[0]!).queryByTestId("abdm-external-unverified")).toBeNull();
    expect(screen.getByTestId("abdm-external-request-req-1")).toHaveTextContent(/Granted/);
  });

  it("the request: CAREMGT and the three rendered types by default, the last 12 months, 30 days — and what is sent names this consultation", async () => {
    const seen: { key: string; body: unknown }[] = [];
    stub({
      "GET /api/abdm/hiu/patients/p-1/records": { body: { ...DATA, requests: [], facilities: [] } },
      "POST /api/abdm/hiu/consent-requests": { status: 201, body: { ...DATA.requests[0], status: "requested", artefacts: [] } },
    }, seen);
    renderWithProviders(<ExternalRecordsPanel patientId="p-1" encounterId="enc-1" />);
    const user = userEvent.setup({ delay: null });
    expect(await screen.findByTestId("abdm-external-none")).toBeInTheDocument();
    await user.click(screen.getByTestId("abdm-external-request-open"));
    expect(screen.getByTestId("abdm-external-purpose")).toHaveValue("CAREMGT");
    expect(screen.getByTestId("abdm-external-type-OPConsultation")).toBeChecked();
    expect(screen.getByTestId("abdm-external-type-Prescription")).toBeChecked();
    expect(screen.getByTestId("abdm-external-type-DiagnosticReport")).toBeChecked();
    expect(screen.getByTestId("abdm-external-type-DischargeSummary")).not.toBeChecked();
    expect(screen.getByTestId("abdm-external-from")).toHaveValue("2025-09-26");
    expect(screen.getByTestId("abdm-external-to")).toHaveValue("2026-09-26");
    expect(screen.getByTestId("abdm-external-expires")).toHaveValue("2026-10-26");
    await user.click(screen.getByTestId("abdm-external-type-DischargeSummary"));
    await user.click(screen.getByTestId("abdm-external-send"));
    await waitFor(() => expect(screen.getByTestId("abdm-external-sent")).toBeInTheDocument());
    const sent = seen.find((s) => s.key === "POST /api/abdm/hiu/consent-requests")!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ encounterId: "enc-1", purposeCode: "CAREMGT", hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport", "DischargeSummary"] });
    expect(sent.from).toBe("2025-09-25T18:30:00.000Z"); // 26 Sep 2025, 00:00 IST
    expect(sent.dataEraseAt).toBe("2026-10-26T18:29:59.000Z"); // the end of 26 Oct 2026, IST
  });

  it("says why it cannot ask: ABDM off at this hospital, or the patient's ABHA not verified — and still shows what is held", async () => {
    stub({ "GET /api/abdm/hiu/patients/p-1/records": { body: { ...DATA, hiuConfigured: false } } }, []);
    const { unmount } = renderWithProviders(<ExternalRecordsPanel patientId="p-1" encounterId="enc-1" />);
    expect(await screen.findByTestId("abdm-external-off")).toBeInTheDocument();
    expect(screen.queryByTestId("abdm-external-request-open")).toBeNull();
    expect(screen.getByTestId("abdm-external-facility-IN0810000123")).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    stub({ "GET /api/abdm/hiu/patients/p-1/records": { body: { ...DATA, abha: { address: null, verified: false }, facilities: [] } } }, []);
    renderWithProviders(<ExternalRecordsPanel patientId="p-1" encounterId="enc-1" />);
    expect(await screen.findByTestId("abdm-external-no-abha")).toBeInTheDocument();
    expect(screen.queryByTestId("abdm-external-request-open")).toBeNull();
  });
});
