import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, waitFor } from "@testing-library/react";
import { GuardianReports } from "../components/guardian-reports";
import { GuardianLine, PatientAbsentTag } from "../components/patient-absent";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { PatientBrief } from "./opd-consult-v2";

/**
 * ═══ OWNER 2026-10-09 — "GUARDIAN ONLY", BOXED, AND THE LAST VISIT BEFORE THE PATIENT WALKS IN ═══
 *
 * "does the doctor's screen highlight that the patient's guardian is here to only show report? so that
 * doctor is pre-prepared … avoid too much text." The brief shows a boxed amber card in a few words and,
 * on every revisit and renewal, what the doctor recorded last time. Display only: no rule changes.
 */
const GUARDIAN = { relation: "son", name: "Rakesh", by: "asha.devi", at: "2026-10-09T04:00:00.000Z" };
const VITALS = { id: "v1", status: "active", sbp: 132, dbp: 84, pulse: 80, spo2: 98, tempC: 36.9, weightKg: 71, recordedAt: "2026-10-09T04:10:00.000Z", recordedByName: "Sr. Kavita" };
const today = (over: Record<string, unknown> = {}, visitType = "revisit") => ({
  encounter: { id: "e13", visitNo: "V2610090013", patientId: "p13", visitType },
  deskComplaint: { text: "Reports dikhane aaye hain", by: "Ramesh", at: "2026-10-09T04:00:00.000Z" },
  patientAbsent: null, vitals: [], ...over,
});
const LAST = (enc: Record<string, unknown> = {}) => ({
  encounter: {
    id: "e0", visitNo: "V2608240007", serviceDate: "2026-08-24", visitType: "new", chiefComplaint: "Tingling in both feet", diagnosis: "Type 2 diabetes mellitus",
    advisedTests: [{ name: "HbA1c" }, { name: "Lipid profile" }], ...enc,
  },
  deskComplaint: { text: "Pair mein jhunjhuni" }, vitals: [], diagnoses: [],
  prescriptions: [{ status: "active", lines: [{ drug: "Metformin 1 g", dose: "1 tab" }, { drug: "Glimepiride 1 mg" }] }],
});
const TIMELINE = [
  { encounterId: "e13", serviceDate: "2026-10-09", openedAt: "2026-10-09T03:50:00.000Z", status: "waiting", visitType: "revisit", doctorName: "Dr. Chandan Kumar", diagnosis: null, prescriptionLineCount: 0 },
  { encounterId: "e0", serviceDate: "2026-08-24", openedAt: "2026-08-24T04:00:00.000Z", status: "completed", visitType: "new", doctorName: "Dr. Chandan Kumar", diagnosis: "Type 2 diabetes mellitus", prescriptionLineCount: 2 },
];

function mount(routes: Record<string, unknown>): { asked: () => string[] } {
  const asked: string[] = [];
  const refuse = (): never => { throw new Error("refused"); };
  stubFetch({
    "GET /api/opd/visits/e13": today(),
    "GET /api/opd/visits/e0": () => { asked.push("e0"); return LAST(); },
    "GET /api/patients/p13/allergies": { items: [] },
    "GET /api/opd/patients/p13/timeline": { items: TIMELINE },
    "GET /api/opd/patients/p13/prescriptions": { items: [] },
    "GET /api/opd/patients/p13/reminder": { reminder: null },
    "GET /api/lab/results/patient/p13": { items: [] },
    "GET /api/radiology/reports/patient/p13": { items: [] },
    "GET /api/pharmacy/doctor/patients/p13/dispenses": { items: [] },
    ...Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, v === "refuse" ? refuse : v])),
  });
  setToken("t-1");
  renderWithProviders(<PatientBrief encounterId="e13" patientId="p13" patientName="Suresh Prasad" onStart={() => undefined} />);
  return { asked: () => asked };
}

afterEach(() => { setToken(null); });

describe("the doctor's brief — guardian only, and the last visit (owner 2026-10-09)", () => {
  it("a guardian-only revisit: a boxed card in a few words, no vitals, and the last visit as the doctor recorded it — above why the patient came", async () => {
    mount({ "GET /api/opd/visits/e13": today({ patientAbsent: GUARDIAN }) });
    const card = await screen.findByTestId("brief-patient-absent");
    expect(card.textContent).toBe("Guardian onlySon: Rakesh · reports · no vitals");
    expect(card.style.border).toContain("2px solid");
    expect(card.style.background).toContain("--gold-soft");
    const last = await screen.findByTestId("brief-last-visit");
    expect(last.textContent).toContain("Last visit · 24 Aug");
    expect(last.textContent).toContain("Dr. Chandan Kumar");
    expect(screen.getByTestId("brief-last-visit-complaint").textContent).toBe("ComplaintTingling in both feet");
    expect(screen.getByTestId("brief-last-visit-diagnosis").textContent).toBe("DiagnosisType 2 diabetes mellitus");
    expect(screen.getByTestId("brief-last-visit-tests").textContent).toBe("TestsHbA1c, Lipid profile");
    expect(screen.getByTestId("brief-last-visit-medicines").textContent).toBe("MedicinesMetformin 1 g, Glimepiride 1 mg");
    expect(screen.queryByTestId("brief-vitals")).not.toBeInTheDocument();
    // Order on the page: guardian card, last visit, then the desk's words.
    const words = await screen.findByTestId("brief-desk-words");
    expect(card.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(last.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a chart that exists on a guardian's visit is shown — a recorded value is never hidden", async () => {
    mount({ "GET /api/opd/visits/e13": today({ patientAbsent: GUARDIAN, vitals: [VITALS] }) });
    expect(await screen.findByTestId("brief-patient-absent")).toBeInTheDocument();
    expect((await screen.findByTestId("brief-vitals")).textContent).toContain("132/84");
  });

  it("the doctor recorded no complaint: that visit's front-desk words stand in; an ordinary revisit has the card and no guardian box", async () => {
    mount({ "GET /api/opd/visits/e0": LAST({ chiefComplaint: null, advisedTests: [] }) });
    expect((await screen.findByTestId("brief-last-visit-complaint")).textContent).toBe("ComplaintPair mein jhunjhuni");
    expect(screen.getByTestId("brief-last-visit-tests").textContent).toBe("Tests—");
    expect(screen.queryByTestId("brief-patient-absent")).not.toBeInTheDocument();
  });

  it("a NEW patient's guardian visit (owner 2026-10-09): the same box, saying 'new' where a returning patient's says 'reports'", async () => {
    mount({ "GET /api/opd/visits/e13": today({ patientAbsent: GUARDIAN }, "new"), "GET /api/opd/patients/p13/timeline": { items: [] } });
    expect((await screen.findByTestId("brief-patient-absent")).textContent).toBe("Guardian onlySon: Rakesh · new · no vitals");
    await screen.findByTestId("brief-desk-words");
    expect(screen.queryByTestId("brief-last-visit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("brief-vitals")).not.toBeInTheDocument();
  });

  it("a new patient has no card and the earlier visit is not even read", async () => {
    const m = mount({ "GET /api/opd/visits/e13": today({}, "new") });
    await screen.findByTestId("brief-desk-words");
    await waitFor(() => { expect(screen.getByTestId("brief-last").textContent).toContain("2026-08-24"); });
    expect(screen.queryByTestId("brief-last-visit")).not.toBeInTheDocument();
    expect(m.asked()).toEqual([]);
  });

  it("a history the login may not read, or an earlier visit the server will not open, shows no card", async () => {
    const hidden = mount({ "GET /api/opd/patients/p13/timeline": "refuse" });
    await screen.findByTestId("brief-desk-words");
    expect(screen.queryByTestId("brief-last-visit")).not.toBeInTheDocument();
    expect(hidden.asked()).toEqual([]);
  });

  it("…and a sealed earlier visit (the visit read refuses) shows none either", async () => {
    let tried = 0;
    mount({ "GET /api/opd/visits/e0": () => { tried++; throw new Error("unknown_encounter"); } });
    await screen.findByTestId("brief-desk-words");
    await waitFor(() => { expect(tried).toBeGreaterThan(0); });
    expect(screen.queryByTestId("brief-last-visit")).not.toBeInTheDocument();
  });

  it("a guardian's consultation carries a Reports card: three newest in-house results since the last visit, one line each, then +n", async () => {
    const lab = (analyteName: string, value: string, unit: string | null, verifiedAt: string, flag = "N") => ({ orderableName: analyteName, analyteName, value, unit, flag, verifiedAt });
    stubFetch({
      "GET /api/lab/results/patient/p13": { items: [
        lab("HbA1c", "8.9", "%", "2026-10-06T06:00:00.000Z", "H"), lab("Creatinine", "1.3", "mg/dL", "2026-10-05T06:00:00.000Z"),
        lab("Hb", "11.2", "g/dL", "2026-10-03T06:00:00.000Z"), lab("Old sugar", "140", "mg/dL", "2026-08-01T06:00:00.000Z"),
      ] },
      "GET /api/radiology/reports/patient/p13": { items: [{ studyName: "X-ray chest PA", impression: "No active lung lesion", criticalCategory: null, signedAt: "2026-10-04T07:00:00.000Z" }] },
    });
    setToken("t-1");
    renderWithProviders(<GuardianReports patientId="p13" lastVisitDay="2026-08-24" />);
    const card = await screen.findByTestId("panel-reports");
    expect(card.textContent).toMatch(/^Reports/);
    expect(screen.getByTestId("panel-reports-0").textContent).toBe("HbA1c · 8.9 % · 6 Oct");
    expect(screen.getByTestId("panel-reports-1").textContent).toBe("Creatinine · 1.3 mg/dL · 5 Oct");
    expect(screen.getByTestId("panel-reports-2").textContent).toBe("X-ray chest PA · ready · 4 Oct");
    expect(screen.getByTestId("panel-reports-more").textContent).toBe("+1");
    expect(card.textContent).not.toContain("Old sugar");
    // Drawn only on a guardian's visit, beside the line that says so.
    const consult = readFileSync(resolve(__dirname, "opd-consult.tsx"), "utf8");
    expect(consult).toMatch(/visit\.data\?\.patientAbsent != null && active !== null && \(\s*<GuardianReports\b/);
  });

  it("nothing since the last visit, or results that cannot be read: no Reports card", async () => {
    stubFetch({
      "GET /api/lab/results/patient/p13": { items: [{ orderableName: "Sugar", analyteName: "Sugar", value: "140", unit: null, flag: "N", verifiedAt: "2026-08-01T06:00:00.000Z" }] },
      "GET /api/radiology/reports/patient/p13": () => { throw new Error("forbidden"); },
    });
    setToken("t-1");
    renderWithProviders(<><GuardianReports patientId="p13" lastVisitDay="2026-08-24" /><span data-testid="after" /></>);
    await screen.findByTestId("after");
    await waitFor(() => { expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2); });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("panel-reports")).not.toBeInTheDocument();
  });

  it("where the doctor writes it is one line, and the queue row carries a filled chip without the name", () => {
    renderWithProviders(<><GuardianLine absent={GUARDIAN} testId="line" /><PatientAbsentTag absent={GUARDIAN} testId="chip" /></>);
    expect(screen.getByTestId("line").textContent).toBe("Guardian only · Son: Rakesh");
    expect(screen.getByTestId("line").style.whiteSpace).toBe("nowrap");
    const chip = screen.getByTestId("chip");
    expect(chip.textContent).toBe("Guardian · Son");
    expect(chip.style.background).toContain("--gold");
    // The consultation's header strip (above every tab) and the queue row use exactly these two.
    const consult = readFileSync(resolve(__dirname, "opd-consult.tsx"), "utf8");
    expect(consult).toMatch(/<GuardianLine absent=\{visit\.data\.patientAbsent\} testId="panel-patient-absent" \/>/);
    expect(consult).toMatch(/<PatientAbsentTag absent=\{e\.encounter\.patientAbsent\} visitType=\{e\.encounter\.visitType\} testId=\{`queue-absent-\$\{e\.id\}`\} \/>/);
    expect(consult).not.toMatch(/PatientAbsentNotice/);
  });
});
