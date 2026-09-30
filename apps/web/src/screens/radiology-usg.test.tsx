import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyUsg, biometryInput, obstetricDraft } from "./radiology-usg";
import { deriveObstetric } from "../lib/obstetric";

/**
 * PLAN 18-S RS7 T3/T4 — the Ultrasound & PCPNDT station: the room's Form F → scan → report → sign,
 * and the three books (register by serial, registration, monthly return).
 */
type Reply = { status: number; body: unknown };
type Call = { method: string; path: string; body: unknown };

const SONO = ["pcpndt.form_f.write", "pcpndt.form_f.read", "pcpndt.registrations.read", "radiology.worklist.read"];

function mockRoutes(handlers: Record<string, Reply>, permissions: string[] = SONO): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (path === "/api/auth/me") {
      return new Response(JSON.stringify({
        actor: { type: "user", id: "U1" },
        permissions: { hospital: permissions, scoped: { department: {}, floor: {} } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const reply = handlers[`${method} ${path}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const devices: Reply = {
  status: 200,
  body: {
    devices: [
      { id: "US2", code: "US-2", name: "Voluson", modality: "usg", room: "Room 111", portable: false, status: "available", ionising: false, licensedNow: null },
      { id: "CT1", code: "CT-1", name: "CT", modality: "ct", room: null, portable: false, status: "available", ionising: true, licensedNow: true },
    ],
  },
};
const row = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "R2609280001", status: "checked_in", priority: "routine", studyTypeCode: "USG-OBS",
  scheduledAt: null, deviceResourceId: "US2", encounterNo: "V1", patientId: "P1", patientName: "Anita Kumari",
  formFRequired: true, restricted: false, createdAt: "2026-09-28T04:00:00.000Z", checkedInAt: "2026-09-28T04:10:00.000Z", ...over,
});
const study = (over: Record<string, unknown>) => ({
  ...row({}), laterality: "na", ionising: false, contrastGiven: false, acquiredAt: null, authorisedBy: null,
  studyInstanceUid: null, imageSource: null, mintedStudyInstanceUid: "1.2", views: [], canOpenImages: false, reports: [], ...over,
});
const formF = (over: Record<string, unknown>) => ({
  formFId: "F1", serialNo: 418, serialYear: 2026, status: "open", applicability: "pregnant", indicationCode: "ii",
  gestationWeeks: null, sections: {}, declaration: {}, referral: {}, resultSummary: null, signedBy: null, signedAt: null,
  verifiedBy: null, verifiedAt: null, patientName: "Anita Kumari", patientUhid: "HMS-1", patientIsConfidential: false,
  machine: { id: "M1", make: "GE", model: "Voluson", serial: "VE8" }, person: { id: "PP", userId: "U1", qualification: "MD" }, ...over,
});
const emptyRegister: Reply = { status: 200, body: { month: "2026-09", rows: [], serials: [] } };

function roomRoutes(over: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    "GET /api/radiology/devices": devices,
    "GET /api/radiology/worklist": { status: 200, body: { rows: [row({}), row({ studyId: "S9", deviceResourceId: "CT1", studyTypeCode: "CT-HEAD", patientName: "Ravi", formFRequired: false })] } },
    "GET /api/radiology/pcpndt/register": emptyRegister,
    "GET /api/radiology/studies/S1": { status: 200, body: { study: study({}) } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "checked_in", ready: false, gates: [], open: ["form_f"] } },
    "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: null } },
    ...over,
  };
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the scan room", () => {
  it("lists only the ultrasound machines' studies, marks the Form F owed, and opens with the Act's indication list", async () => {
    const calls = mockRoutes(roomRoutes({
      "POST /api/pcpndt/form-f": { status: 201, body: { formFId: "F1", serialNo: 418, serialYear: 2026 } },
    }));
    renderWithProviders(<RadiologyUsg view="room" />);
    const right = within(await screen.findByTestId("station-right"));
    expect(await right.findByTestId("usg-row-S1")).toHaveTextContent("Form F owed");
    expect(right.queryByTestId("usg-row-S9")).toBeNull();

    await userEvent.click(right.getByTestId("usg-row-S1"));
    expect(await screen.findByTestId("usg-formf-open")).toHaveTextContent("cannot be given back");
    const act = screen.getByTestId("usg-dock-act");
    expect(act).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Estimation of gestational age/));
    await waitFor(() => { expect(act).toBeEnabled(); });
    await userEvent.click(act);
    await waitFor(() => {
      expect(calls.find((c) => c.method === "POST" && c.path === "/api/pcpndt/form-f")?.body).toEqual({
        studyId: "S1", patientId: "P1", deviceResourceId: "US2", indicationCode: "ii", applicability: "pregnant",
      });
    });
  });

  it("will not sign Form F until her declaration and the Act's fields are in, then closes the gate from the register", async () => {
    const calls = mockRoutes(roomRoutes({
      "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: formF({}) } },
      "POST /api/pcpndt/form-f/F1/record": { status: 201, body: { formFId: "F1", serialNo: 418 } },
      "POST /api/radiology/pcpndt/studies/S1/form-f-gate": { status: 201, body: { state: "ready", open: [] } },
    }));
    renderWithProviders(<RadiologyUsg view="room" />);
    await userEvent.click(await within(await screen.findByTestId("station-right")).findByTestId("usg-row-S1"));
    await screen.findByTestId("usg-formf-fill");
    const act = screen.getByTestId("usg-dock-act");
    expect(act).toBeDisabled();
    expect(screen.getByTestId("usg-dock")).toHaveTextContent("Missing");
    await userEvent.type(screen.getByTestId("ff-relative"), "Manoj Kumar");
    await userEvent.type(screen.getByTestId("ff-sons"), "0");
    await userEvent.type(screen.getByTestId("ff-daughters"), "1");
    await userEvent.type(screen.getByTestId("ff-lmp"), "2026-05-11");
    expect(act).toBeDisabled();
    await userEvent.click(screen.getByTestId("ff-declared"));
    await waitFor(() => { expect(act).toBeEnabled(); });
    await userEvent.click(act);
    await waitFor(() => { expect(calls.some((c) => c.path === "/api/radiology/pcpndt/studies/S1/form-f-gate")).toBe(true); });
    const rec = calls.find((c) => c.path === "/api/pcpndt/form-f/F1/record")!.body as { sections: Record<string, unknown>; referral: unknown };
    expect(rec.sections).toMatchObject({
      relative_name: "Manoj Kumar", living_children: { sons: 0, daughters: 1 }, lmp: "2026-05-11", procedure: "ultrasonography",
    });
    expect(rec.sections.patient_declaration).toEqual(expect.objectContaining({ language: "hi" }));
    expect(rec.referral).toEqual({ self_referral: true });
  });

  it("measures with live GA/EFW, records the scan, drafts from the numbers and saves the biometry with the report", async () => {
    const calls = mockRoutes(roomRoutes({
      "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: formF({ status: "recorded", signedBy: "U1", sections: { lmp: "2026-05-11" } }) } },
      "GET /api/radiology/studies/S1": { status: 200, body: { study: study({ status: "in_acquisition" }) } },
      "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "in_acquisition", ready: true, gates: [], open: [] } },
      "POST /api/radiology/studies/S1/acquisition/acquired": { status: 201, body: {} },
      "POST /api/radiology/studies/S1/reports/draft": { status: 201, body: { reportId: "RP1", version: 1 } },
    }));
    renderWithProviders(<RadiologyUsg view="room" />);
    await userEvent.click(await within(await screen.findByTestId("station-right")).findByTestId("usg-row-S1"));
    await screen.findByTestId("usg-biometry");
    for (const [k, v] of [["bpd", "47"], ["hc", "175"], ["ac", "150"], ["fl", "33"], ["fhr", "148"]] as const) {
      await userEvent.type(screen.getByTestId(`bio-${k}-A`), v);
    }
    await userEvent.type(screen.getByTestId("bio-afi"), "12");
    expect(screen.getByTestId("bio-derived-A")).toHaveTextContent("342 g");
    expect(screen.getByTestId("bio-derived-A")).toHaveTextContent("by Hadlock");
    await userEvent.click(screen.getByTestId("usg-dock-act"));
    expect(await screen.findByTestId("usg-report")).toBeInTheDocument();
    await waitFor(() => { expect(calls.some((c) => c.path === "/api/radiology/studies/S1/acquisition/acquired")).toBe(true); });
    expect(calls.find((c) => c.path === "/api/radiology/studies/S1/acquisition/acquired")!.body).toEqual({ imageSource: "no_pacs_images" });
    expect((screen.getByTestId("usg-findings") as HTMLTextAreaElement).value).toMatch(/BPD 47 mm, HC 175 mm, AC 150 mm, FL 33 mm/);
    expect(screen.getByTestId("usg-declaration")).toHaveTextContent("neither detected nor disclosed the sex of her foetus");
    await userEvent.click(screen.getByTestId("usg-dock-act"));
    await waitFor(() => { expect(calls.some((c) => c.path === "/api/radiology/studies/S1/reports/draft")).toBe(true); });
    const draft = calls.find((c) => c.path === "/api/radiology/studies/S1/reports/draft")!.body as { templateKey: string; body: Record<string, unknown> };
    expect(draft.templateKey).toBe("usg_obstetric");
    expect(draft.body.obstetric_biometry).toMatchObject({ lmp: "2026-05-11", afiCm: 12, foetuses: [{ label: "A", bpdMm: 47, fhrBpm: 148 }] });
    expect(JSON.stringify(draft)).not.toMatch(/"(sex|gender)"/);
  });

  it("signs with a fresh second factor first, and shows a foetal-sex refusal in the room's words", async () => {
    const calls = mockRoutes(roomRoutes({
      "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: formF({ status: "recorded", signedBy: "U1" }) } },
      "GET /api/radiology/studies/S1": { status: 200, body: { study: study({ status: "acquired", reports: [{ id: "RP1", version: 1, status: "draft", publishedAt: null, machineDrafted: false }] }) } },
      "GET /api/radiology/reports/RP1": { status: 200, body: { report: { reportId: "RP1", body: { findings: "Single live intrauterine male foetus." }, impression: "SLIUP" } } },
      "POST /api/auth/totp/verify": { status: 200, body: {} },
      "POST /api/radiology/studies/S1/reports/sign": {
        status: 422, body: { statusCode: 422, code: "foetal_sex_disclosure", message: "this report states the sex of a foetus (\"male foetus\")", detail: { matched: ["male foetus"] } },
      },
    }));
    renderWithProviders(<RadiologyUsg view="room" />);
    await userEvent.click(await within(await screen.findByTestId("station-right")).findByTestId("usg-row-S1"));
    const totp = within(await screen.findByTestId("usg-totp")).getByRole("textbox");
    const act = screen.getByTestId("usg-dock-act");
    expect(act).toBeDisabled();
    await userEvent.type(totp, "123456");
    await waitFor(() => { expect(act).toBeEnabled(); });
    await userEvent.click(act);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("states the sex of the foetus (male foetus)");
    expect(alert).toHaveTextContent("nobody can approve it");
    const verify = calls.findIndex((c) => c.path === "/api/auth/totp/verify");
    const sign = calls.findIndex((c) => c.path === "/api/radiology/studies/S1/reports/sign");
    expect(verify).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(verify);
    expect(calls[verify]!.body).toEqual({ code: "123456" });
    expect(calls[sign]!.body).toEqual({ reportId: "RP1" });
  });

  it("names the machine and the person when the sonologist is not registered on it, and links the registration", async () => {
    mockRoutes(roomRoutes({
      "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: formF({ status: "recorded", signedBy: "U1" }) } },
      "GET /api/radiology/studies/S1": { status: 200, body: { study: study({ status: "ready" }) } },
      "POST /api/radiology/pcpndt/studies/S1/form-f-gate": { status: 201, body: { state: "ready", open: [] } },
      "POST /api/radiology/studies/S1/acquisition/start": {
        status: 403, body: { statusCode: 403, code: "person_not_registered", message: "U1 is not a registered person on registration R1" },
      },
    }));
    renderWithProviders(<RadiologyUsg view="room" />);
    await userEvent.click(await within(await screen.findByTestId("station-right")).findByTestId("usg-row-S1"));
    await screen.findByTestId("usg-biometry");
    await userEvent.click(screen.getByTestId("usg-dock-act"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("registered on the PCPNDT registration that covers US-2");
    expect(within(alert).getByRole("link")).toHaveAttribute("href", "/radiology/usg?view=register");
  });
});

describe("the rule-built draft", () => {
  it("writes sentences from the measurements and never a sex", () => {
    const m = {
      lmp: "2026-05-11", afiCm: "12", placenta: "posterior", anomalySurvey: true,
      foetuses: [{ label: "A", crlMm: "", bpdMm: "47", hcMm: "175", acMm: "150", flMm: "33", fhrBpm: "148", presentation: "cephalic" }],
    };
    const input = biometryInput(m)!;
    const d = obstetricDraft(m, deriveObstetric(input, "2026-09-28"));
    expect(d.findings).toMatch(/^Single live intrauterine foetus\. BPD 47 mm/);
    expect(d.findings).toMatch(/Estimated foetal weight 342 g \(Hadlock\)/);
    expect(d.impression).toMatch(/^Single live intrauterine pregnancy of \d+ w \d d by scan\. EDD by scan \d\d-\d\d-\d{4}\./);
    expect(`${d.findings} ${d.impression}`).not.toMatch(/\b(male|female|boy|girl|sex)\b/i);
  });
});

describe("the books", () => {
  it("the Form F register lists serials with state and missing fields — and no names", async () => {
    mockRoutes({
      "GET /api/radiology/pcpndt/register": {
        status: 200,
        body: {
          month: "2026-09",
          rows: [
            { formFId: "F1", serial: "US-2/2026/0418", serialNo: 418, serialYear: 2026, deviceResourceId: "US2", deviceCode: "US-2", openedAt: "2026-09-28T05:00:00.000Z", state: "recorded", studyId: "S1", accessionNo: "R1", studyStatus: "acquired", indicationCode: "ii", gestationWeeks: 20, signedByName: "Dr Farah", verifiedByName: null, missing: ["referral"] },
            { formFId: "F2", serial: "US-2/2026/0419", serialNo: 419, serialYear: 2026, deviceResourceId: "US2", deviceCode: "US-2", openedAt: "2026-09-28T06:00:00.000Z", state: "cancelled", studyId: "S2", accessionNo: "R2", studyStatus: "cancelled", indicationCode: "i", gestationWeeks: null, signedByName: null, verifiedByName: null, missing: [] },
          ],
          serials: [{ deviceResourceId: "US2", deviceCode: "US-2", year: 2026, minted: 419, gaps: [] }],
        },
      },
    });
    renderWithProviders(<RadiologyUsg view="formf" />);
    const table = await screen.findByTestId("usg-register");
    expect(table).toHaveTextContent("US-2/2026/0418");
    expect(table).toHaveTextContent("signed, not verified");
    expect(table).toHaveTextContent("referral");
    expect(table).toHaveTextContent("cancelled (serial kept)");
    expect(within(screen.getByTestId("station-right")).getByTestId("usg-gaps")).toHaveTextContent("no gap");
  });

  it("the registration view is the first reader of GET /pcpndt/registrations, naming machines and people", async () => {
    const calls = mockRoutes({
      "GET /api/pcpndt/registrations": {
        status: 200,
        body: {
          registrations: [{
            registration: { id: "R1", site: "Main", registrationNo: "PNDT/JSR/2025/0042", validFrom: "2025-04-01", validTo: "2030-03-31", inchargeUserId: null, status: "active" },
            machines: [{ id: "M1", deviceResourceId: "US2", make: "GE", model: "Voluson E8", serial: "VE8-A11902", formBRef: null, active: true, deviceCode: "US-2", deviceName: "Voluson" }],
            persons: [{ id: "P1", userId: "U1", qualification: "MD Radiodiagnosis", councilRegNo: "JMC/2014/4471", active: true, fullName: "Dr Farah Siddiqui" }],
          }],
        },
      },
    });
    renderWithProviders(<RadiologyUsg view="register" />);
    const reg = await screen.findByTestId("usg-registration");
    expect(await within(reg).findByText("PNDT/JSR/2025/0042")).toBeInTheDocument();
    expect(screen.getByTestId("usg-matrix")).toHaveTextContent("Dr Farah Siddiqui");
    expect(screen.getByTestId("usg-matrix")).toHaveTextContent("US-2");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/pcpndt/registrations")).toBe(true);
  });

  it("the monthly return shows counts, discrepancies, the 5th and the CSV to copy", async () => {
    mockRoutes({
      "GET /api/radiology/pcpndt/monthly-return": {
        status: 200,
        body: {
          month: "2026-09", dueBy: "2026-10-05", today: "2026-09-28", daysLeft: 7,
          machines: [{ deviceResourceId: "US2", code: "US-2", name: "Voluson", registrationNo: "PNDT/JSR/2025/0042", scans: 118, pcpndtScans: 102, short: 1, formF: { opened: 103, recorded: 102, verified: 101, open: 1, cancelled: 0 } }],
          totals: { scans: 118, pcpndtScans: 102, short: 1, formF: { opened: 103, recorded: 102, verified: 101, open: 1, cancelled: 0 } },
          discrepancies: [{ kind: "recorded_not_verified", deviceCode: "US-2", serial: "US-2/2026/0411", accessionNo: "R9", studyId: "S9" }],
          csv: "month,machine\n2026-09,US-2",
        },
      },
    }, ["pcpndt.registrations.read"]);
    renderWithProviders(<RadiologyUsg view="monthly" />);
    expect(await screen.findByTestId("usg-due")).toHaveTextContent("05-10-2026");
    expect(screen.getByTestId("usg-return")).toHaveTextContent("PNDT/JSR/2025/0042");
    expect(within(screen.getByTestId("station-right")).getByTestId("usg-discrepancies")).toHaveTextContent("US-2/2026/0411");
    expect((screen.getByTestId("usg-csv") as HTMLTextAreaElement).value).toBe("month,machine\n2026-09,US-2");
    /** An in-charge sees the books, not the room. */
    expect(screen.queryByTestId("usg-view-room")).toBeNull();
  });
});
