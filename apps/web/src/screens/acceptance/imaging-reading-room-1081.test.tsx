import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { RadiologyReading } from "../radiology-reading";

/**
 * ACCEPTANCE — issue #1081, spec docs/specs/1081-imaging-reading-room.md (owner APPROVED 2026-11-14), the
 * web half: the reading room saves by itself after typing stops, shows where each drafted section came
 * from until the reader edits it, and opens an unreported study with its technique already written.
 */
type Reply = { status: number; body: unknown };
const calls: { key: string; body: unknown }[] = [];
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-rad" }, permissions: { hospital: ["radiology.reports.write"], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const NOW = Date.now();
const iso = (minsFromNow: number) => new Date(NOW + minsFromNow * 60_000).toISOString();
const ROW = {
  studyId: "S1", accessionNo: "X1", status: "acquired", priority: "routine", studyTypeCode: "CT-HEAD",
  studyTypeName: "CT head", modality: "ct", bodyPart: "head", patientId: "P1", patientName: "Asha Devi",
  patientSex: "female", patientAge: 30, restricted: false, formFRequired: false, acquiredAt: iso(-60),
  tatClass: "opd", targetMinutes: 1440, dueAt: iso(1380), reportState: "none", readingBy: null,
};
const TECHNIQUE = "CT: CT head. Dose: CTDIvol 6.400 mGy, DLP 320.500 mGy·cm.";
const SECTIONS = {
  technique: { sources: [
    { kind: "study_type", ref: "CT-HEAD", values: { code: "CT-HEAD", name: "CT head", modality: "ct" } },
    { kind: "dose_record", ref: "S1", values: { ctdivol: "6.400", dlp: "320.500", fluoroSeconds: null } },
  ] },
};
const CTX = {
  studyId: "S1", accessionNo: "X1", status: "acquired", priority: "routine", studyTypeCode: "CT-HEAD",
  studyTypeName: "CT head", modality: "ct", laterality: "na", bedsideLocation: null, acquiredAt: iso(-60),
  tatClass: "opd", targetMinutes: 1440, dueAt: iso(1380), clinicalQuestion: "Head injury",
  referrer: { doctorCode: "DR-0114", department: "General Surgery" },
  patient: { id: "P1", name: "Asha Devi", uhid: "HMS-00000001-5", sex: "female", age: 30, flags: [] },
  priors: [], cumulativeDlp12m: null, canOpenImages: false,
  templates: [{
    key: "ct", name: "Computed tomography", governed: false,
    sections: [
      { key: "technique", label: "Technique", normal: null },
      { key: "findings", label: "Findings", normal: null },
      { key: "impression", label: "Impression", normal: null },
      { key: "recommendation", label: "Recommendation", normal: null },
    ],
    macros: [], coded: [],
  }],
  defaultTemplateKey: "ct", working: null, signed: null, readingBy: null,
};
const PROPOSAL = {
  reportId: "RP1", version: 1, templateKey: "ct",
  body: { technique: TECHNIQUE, findings: "", impression: "" }, impression: null, laterality: null,
  provenance: { drafter: "offline_template", version: "1", at: iso(-1), inputs: {}, sections: SECTIONS },
};
const COMMON: Record<string, Reply> = {
  "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [ROW] } },
  "POST /api/radiology/reading/studies/S1/claim": { status: 201, body: { claimed: true, heldBy: null } },
  "POST /api/radiology/studies/S1/reports/checks": { status: 200, body: { findings: [], signable: true } },
  "POST /api/radiology/studies/S1/reports/autosave": { status: 201, body: { reportId: "RA1", version: 2, autosavedAt: iso(0) } },
  "POST /api/radiology/studies/S1/reports/propose": { status: 201, body: PROPOSAL },
};
const autosaves = () => calls.filter((c) => c.key === "POST /api/radiology/studies/S1/reports/autosave");

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("spec #1081 D11: typing and waiting calls autosave once; a drafted section shows a chip; editing it removes the chip", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  mockRoutes({
    ...COMMON,
    "GET /api/radiology/reading/studies/S1": {
      status: 200,
      body: { study: { ...CTX, proposal: { reportId: "RP1", templateKey: "ct", body: PROPOSAL.body, impression: null, sections: SECTIONS } } },
    },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  expect(await screen.findByTestId("drafted-chip-technique")).toBeInTheDocument();
  expect(screen.getByTestId("section-technique")).toHaveValue(TECHNIQUE);

  await user.type(screen.getByTestId("section-findings"), "Brain normal.");
  expect(autosaves()).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_500); });
  await waitFor(() => expect(autosaves()).toHaveLength(1));
  expect((autosaves()[0]!.body as { body: Record<string, string> }).body.findings).toBe("Brain normal.");
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  expect(autosaves()).toHaveLength(1);

  await user.type(screen.getByTestId("section-technique"), " Axial.");
  expect(screen.queryByTestId("drafted-chip-technique")).toBeNull();
});

it("spec #1081 D12: opening an unreported study shows the technique filled without any press", async () => {
  mockRoutes({ ...COMMON, "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: { ...CTX, proposal: null } } } });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  await waitFor(() => expect(screen.getByTestId("section-technique")).toHaveValue(TECHNIQUE));
  expect(calls.filter((c) => c.key === "POST /api/radiology/studies/S1/reports/propose")).toHaveLength(1);
});
