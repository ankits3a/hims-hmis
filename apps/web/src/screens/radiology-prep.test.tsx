import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { RadiologyPrep } from "./radiology-prep";
import { suggestedVolumeMl } from "../components/radiology/contrast-panel";
import type { WirePrepGate, WirePrepRow, WirePrepStudy } from "../lib/radiology-api";

/**
 * PLAN 18-S RS5 T3 / T4 / T5 — the prep & safety bay. The server owns every rule; these pin what the
 * screen owes it: the right list is the server's, the room gates carry no controls, every prep gate
 * is a FORM that sends the exact evidence shape `gates.ts` parses (no JSON box anywhere), "Ask the
 * radiologist" files the request, a positive MRI screen asks rather than sends, the contrast record
 * refuses an expired vial before sending and says the reaction writes the allergy.
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];
const bodies: Record<string, unknown[]> = {};

function mockRoutes(handlers: Record<string, Reply>, permissions: string[] = ["radiology.gates.satisfy", "radiology.contrast.record"]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    if (typeof init?.body === "string") (bodies[key] ??= []).push(JSON.parse(init.body));
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({
        actor: { type: "user", id: "u-nurse" },
        permissions: { hospital: permissions, scoped: { department: {}, floor: {} } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const ROW: WirePrepRow = {
  studyId: "S1", accessionNo: "I2609290001", priority: "routine", studyTypeCode: "CT-ABD-C",
  scheduledAt: "2026-09-29T06:30:00.000Z", checkedInAt: "2026-09-29T05:50:00.000Z", deviceCode: "CT-1",
  patientId: "P1", patientName: "Farida Khatoon", restricted: false,
  openPrep: ["contrast_consent", "prior_contrast_reaction", "renal_function"], openRoom: ["identity_two_factor"], asked: [],
};

const gate = (kind: string, over: Partial<WirePrepGate> = {}): WirePrepGate => ({
  id: `g-${kind}`, kind, state: "open", waivable: false, room: kind === "identity_two_factor" || kind === "laterality_confirm",
  neverWaive: kind === "form_f" || kind === "identity_two_factor", neverOverride: kind === "form_f" || kind === "laterality_confirm",
  evidence: null, satisfiedAt: null, override: null, asked: null, ...over,
});

const VIEW = (over: Partial<WirePrepStudy> = {}): WirePrepStudy => ({
  study: {
    studyId: "S1", accessionNo: "I2609290001", status: "checked_in", priority: "routine", studyTypeCode: "CT-ABD-C",
    studyTypeName: "CT abdomen with contrast", modality: "ct", ionising: true, contrastOption: "required",
    laterality: "na", lateralityApplicable: false, encounterNo: "V2609290001",
    scheduledAt: "2026-09-29T06:30:00.000Z", deviceCode: "CT-1", formFRequired: false,
  },
  patient: { id: "P1", name: "Farida Khatoon", uhid: "HMS-00000001-5", sex: "female", dob: "1966-01-01", ageYears: 60 },
  allergies: [{ substance: "Penicillin", severity: "moderate", reaction: null, contrast: false }],
  weight: { kg: 62, recordedAt: "2026-09-29T05:00:00.000Z" },
  kidney: {
    creatinine: { resultId: "R1", umolL: 88.42, reported: { value: "1.00", unit: "mg/dL" }, sampledAt: "2026-09-27T04:00:00.000Z" },
    egfr: { computed: true, egfr: 64, band: "clear", creatinineMgDl: 1, ageYears: 60, sex: "female", metforminHold: false },
    validDays: 30, ceilingUmolL: 176.8,
    hydrationInstruction: "IV 0.9% normal saline 1 mL/kg/h for 6 hours before and 6 hours after contrast",
    metforminNote: "If the patient takes metformin: hold it for 48 hours",
  },
  lmpDate: null,
  gates: [gate("contrast_consent"), gate("identity_two_factor"), gate("prior_contrast_reaction"), gate("renal_function")],
  guardians: [],
  staff: [
    { id: "u-nurse", name: "Rekha Soren", roles: ["radiology_nurse"] },
    { id: "u-rad", name: "Dr. Anjali Mehta", roles: ["radiologist"] },
  ],
  contrast: { administrations: [], reactions: [] },
  ...over,
});

beforeEach(() => { setToken("t"); calls.length = 0; for (const k of Object.keys(bodies)) delete bodies[k]; });
afterEach(() => { vi.unstubAllGlobals(); });

it("lists the bay's studies from the server, and says so when nobody waits", async () => {
  mockRoutes({ "GET /api/radiology/prep": { status: 200, body: { rows: [{ ...ROW, asked: ["renal_function"] }] } } });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep");
  const row = await screen.findByTestId("prep-row-S1");
  expect(row.textContent).toContain("Farida Khatoon");
  expect(row.textContent).toMatch(/Renal function \(asked\)/);
  vi.unstubAllGlobals();

  mockRoutes({ "GET /api/radiology/prep": { status: 200, body: { rows: [] } } });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep");
  expect(await screen.findByTestId("prep-empty")).toBeInTheDocument();
});

it("in hand: the room gate is 'closed at the console' with no control; prep gates are forms; no JSON box", async () => {
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: VIEW() } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const identity = await screen.findByTestId("gate-identity_two_factor");
  expect(within(identity).getByTestId("room-gate")).toHaveTextContent("closed at the console");
  expect(within(identity).queryByTestId("gate-submit")).toBeNull();
  expect(within(identity).queryByTestId("ask-radiologist")).toBeNull();
  expect(document.querySelector("textarea")).toBeNull();
  /** The first open prep gate is the dock's next act and its form is open. */
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Record Contrast consent");
  expect(within(screen.getByTestId("gate-contrast_consent")).getByTestId("consent-text")).toBeInTheDocument();
  /** The lane: the lab's creatinine and the gate's eGFR. */
  expect(screen.getByTestId("lane-kidney")).toHaveTextContent(/1\.00 mg\/dL.*eGFR 64/);
});

it("the kidney form sends the lab result BY POINTER, with the hydration flag", async () => {
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: VIEW() } },
    "POST /api/radiology/studies/S1/gates/renal_function/satisfy": { status: 200, body: { state: "satisfied", kind: "renal_function" } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const kidney = await screen.findByTestId("gate-renal_function");
  await userEvent.click(within(kidney).getByRole("button", { name: /Renal function/ }));
  await userEvent.click(within(kidney).getByTestId("gate-submit"));
  await waitFor(() => expect(bodies["POST /api/radiology/studies/S1/gates/renal_function/satisfy"]).toHaveLength(1));
  expect(bodies["POST /api/radiology/studies/S1/gates/renal_function/satisfy"]![0]).toEqual({
    labResultId: "R1", creatinineUmolL: 88.42, sampledAt: "2026-09-27T04:00:00.000Z", source: "internal",
    ckdFlagged: false, ivHydration: false,
  });
});

it("eGFR under 30: the form says the gate is held; 'Ask the radiologist' files the request with the note", async () => {
  const held = VIEW();
  held.kidney.egfr = { computed: true, egfr: 28, band: "hold", creatinineMgDl: 1.8, ageYears: 80, sex: "female", metforminHold: true };
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: held } },
    "POST /api/radiology/studies/S1/gates/renal_function/override-request": { status: 200, body: { approvalId: "A1", kind: "renal_function" } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const kidney = await screen.findByTestId("gate-renal_function");
  await userEvent.click(within(kidney).getByRole("button", { name: /Renal function/ }));
  expect(within(kidney).getByRole("note")).toHaveTextContent(/eGFR under 30/);
  expect(within(kidney).getByTestId("kidney-metformin")).toBeInTheDocument();
  await userEvent.click(within(kidney).getByTestId("ask-radiologist"));
  await userEvent.type(within(kidney).getByTestId("ask-note"), "eGFR 28, suspected bleed");
  await userEvent.click(within(kidney).getByTestId("ask-send"));
  await waitFor(() => expect(bodies["POST /api/radiology/studies/S1/gates/renal_function/override-request"]).toEqual([{ reason: "eGFR 28, suspected bleed" }]));
});

it("Form F: 'never overridden' and no ask; WAIVE shows only to a holder of the override grant", async () => {
  const v = VIEW({ gates: [gate("form_f"), gate("chaperone_present", { waivable: true })] });
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: v } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const formF = await screen.findByTestId("gate-form_f");
  expect(within(formF).getByText("Never overridden.")).toBeInTheDocument();
  expect(within(formF).queryByTestId("ask-radiologist")).toBeNull();
  const chaperone = screen.getByTestId("gate-chaperone_present");
  await userEvent.click(within(chaperone).getByRole("button", { name: /Chaperone/ }));
  expect(within(chaperone).getByTestId("chaperone-who")).toBeInTheDocument();
  expect(within(chaperone).queryByRole("button", { name: /Waive/ })).toBeNull();
});

it("WAIVE shows on a waivable gate to a holder of the override grant (a waiver is the radiologist's act)", async () => {
  const v = VIEW({ gates: [gate("chaperone_present", { waivable: true })] });
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: v } },
  }, ["radiology.gates.satisfy", "radiology.gates.override"]);
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const chaperone = await screen.findByTestId("gate-chaperone_present");
  await waitFor(() => expect(within(chaperone).getByRole("button", { name: /Waive/ })).toBeInTheDocument());
});

it("T4 — a positive MRI screen ASKS rather than sends; a clear one sends the full form", async () => {
  const v = VIEW({ gates: [gate("mri_safety")] });
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: v } },
    "POST /api/radiology/studies/S1/gates/mri_safety/satisfy": { status: 200, body: { state: "satisfied" } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const form = await screen.findByTestId("mri-screening");
  const answer = (q: string, v2: "No" | "Yes") => {
    const row = form.querySelector(`[data-q="${q}"]`)!;
    fireEvent.click(within(row as HTMLElement).getByText(v2));
  };
  for (const q of ["pacemaker", "cochlear", "clips", "neurostimulator", "metalFb", "orbitMetal", "welderOrMetalWork", "prosthesis", "tattoos", "claustrophobia"]) answer(q, "No");
  fireEvent.change(within(form).getAllByRole("combobox")[0]!, { target: { value: "no" } });
  fireEvent.change(within(form).getByTestId("mri-zone"), { target: { value: "IV" } });
  fireEvent.click(within(form).getByTestId("mri-sweep"));
  fireEvent.change(within(form).getByTestId("mri-tech"), { target: { value: "Pooja Gope" } });

  answer("pacemaker", "Yes");
  expect(within(form).getByTestId("mri-positive")).toBeInTheDocument();
  expect(within(form).queryByTestId("gate-submit")).toBeNull();
  expect(within(form).getByTestId("mri-ask")).toBeEnabled();

  answer("pacemaker", "No");
  await userEvent.click(within(form).getByTestId("gate-submit"));
  await waitFor(() => expect(bodies["POST /api/radiology/studies/S1/gates/mri_safety/satisfy"]).toHaveLength(1));
  expect(bodies["POST /api/radiology/studies/S1/gates/mri_safety/satisfy"]![0]).toMatchObject({
    pacemaker: false, cochlear: false, clips: false, metalFb: false, neurostimulator: false, orbitMetal: false,
    zone: "IV", metalSweep: true, weightKg: 62, pregnancy: "no",
    signatures: { signer: "patient", signerName: "Farida Khatoon", technologistName: "Pooja Gope" },
  });
});

it("T5 — contrast waits for the table; on the table an expired vial is refused before sending; the volume is suggested by weight", async () => {
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: VIEW() } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  expect(await screen.findByTestId("contrast-not-yet")).toBeInTheDocument();
  vi.unstubAllGlobals();

  const onTable = VIEW({ gates: [] });
  onTable.study.status = "in_acquisition";
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: onTable } },
    "POST /api/radiology/studies/S1/contrast": { status: 200, body: { administrationId: "C1" } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const form = (await screen.findAllByTestId("contrast-form")).at(-1)!;
  expect(within(form).getByTestId("contrast-suggestion")).toHaveTextContent("Suggested 62 mL for 62 kg");
  fireEvent.change(within(form).getByTestId("contrast-volume"), { target: { value: "62" } });
  fireEvent.change(within(form).getByTestId("contrast-expiry"), { target: { value: "2020-01-31" } });
  expect(within(form).getByTestId("contrast-submit")).toBeDisabled();
  expect(bodies["POST /api/radiology/studies/S1/contrast"]).toBeUndefined();

  fireEvent.change(within(form).getByTestId("contrast-expiry"), { target: { value: "2099-01-31" } });
  fireEvent.click(within(form).getByTestId("contrast-extravasation"));
  await userEvent.click(within(form).getByTestId("contrast-submit"));
  await waitFor(() => expect(bodies["POST /api/radiology/studies/S1/contrast"]).toHaveLength(1));
  expect(bodies["POST /api/radiology/studies/S1/contrast"]![0]).toMatchObject({
    agent: "Iohexol 350 (Omnipaque)", volumeMl: 62, route: "intravenous", vialExpiry: "2099-01-31", givenBy: "u-nurse",
    site: "power injector · extravasation checked: none",
  });
});

it("T5 — the reaction names the dose, needs treatment and a clinician when severe, and says it writes the allergy", async () => {
  const v = VIEW({ gates: [] });
  v.study.status = "acquired";
  v.contrast.administrations = [{
    id: "C1", studyId: "S1", agent: "Iohexol 350 (Omnipaque)", volumeMl: "62", route: "intravenous", site: null,
    vialBatchNo: "B12", vialExpiry: "2099-01-31", givenBy: "u-nurse", givenAt: "2026-09-29T06:40:00.000Z",
  }];
  mockRoutes({
    "GET /api/radiology/prep": { status: 200, body: { rows: [] } },
    "GET /api/radiology/prep/studies/S1": { status: 200, body: { view: v } },
    "POST /api/radiology/studies/contrast-reactions": { status: 200, body: { reactionId: "X1", allergyId: "AL1" } },
  });
  renderWithRouter(<RadiologyPrep />, "/radiology/prep?study=S1");
  const form = await screen.findByTestId("reaction-form");
  expect(form).toHaveTextContent("Iohexol 350 (Omnipaque) (contrast media)");
  await userEvent.click(within(form).getByRole("button", { name: "Hives / itching" }));
  fireEvent.change(within(form).getByTestId("reaction-severity"), { target: { value: "severe" } });
  expect(within(form).getByTestId("reaction-submit")).toBeDisabled();
  fireEvent.change(within(form).getByTestId("reaction-severity"), { target: { value: "mild" } });
  await userEvent.click(within(form).getByTestId("reaction-submit"));
  await waitFor(() => expect(bodies["POST /api/radiology/studies/contrast-reactions"]).toHaveLength(1));
  expect(bodies["POST /api/radiology/studies/contrast-reactions"]![0]).toMatchObject({
    administrationId: "C1", severity: "mild", onset: "immediate", manifestation: "Hives / itching", observedBy: "u-nurse",
  });
  expect(await within(form).findByTestId("reaction-done")).toHaveTextContent(/allergy list/);
});

it("the weight-based suggestion: iodinated 1 mL/kg to 100 mL, gadobutrol 0.1 mL/kg, a 0.5 M agent 0.2 mL/kg", () => {
  expect(suggestedVolumeMl("Iohexol 350 (Omnipaque)", 62)).toBe(62);
  expect(suggestedVolumeMl("Iohexol 350 (Omnipaque)", 130)).toBe(100);
  expect(suggestedVolumeMl("Gadobutrol 1.0 M (Gadovist)", 70)).toBe(7);
  expect(suggestedVolumeMl("Gadoterate 0.5 M (Dotarem)", 70)).toBe(14);
  expect(suggestedVolumeMl("Iohexol 350 (Omnipaque)", null)).toBeNull();
});
