import { screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { RadiologyReading } from "../radiology-reading";

/**
 * ACCEPTANCE — issue #1082, spec docs/specs/1082-imaging-copilot.md (owner APPROVED 2026-11-14), the web
 * half: the imaging stations pass the station shell's `copilot` slot, so with a study in hand the reading
 * room's right column holds the copilot and the list folds to its one line.
 */
type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
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
  studyId: "S1", accessionNo: "X2611140001", status: "acquired", priority: "routine", studyTypeCode: "USG-ABDO",
  studyTypeName: "USG abdomen", modality: "usg", bodyPart: "abdomen", patientId: "P1", patientName: "Asha Devi",
  patientSex: "female", patientAge: 30, restricted: false, formFRequired: false, acquiredAt: iso(-60),
  tatClass: "opd", targetMinutes: 1440, dueAt: iso(1380), reportState: "none", readingBy: null,
};
const NEXT = { ...ROW, studyId: "S2", accessionNo: "X2611140002", patientName: "Kamla Devi" };
const CTX = {
  studyId: "S1", accessionNo: "X2611140001", status: "acquired", priority: "routine", studyTypeCode: "USG-ABDO",
  studyTypeName: "USG abdomen", modality: "usg", laterality: "na", bedsideLocation: null, acquiredAt: iso(-60),
  tatClass: "opd", targetMinutes: 1440, dueAt: iso(1380), clinicalQuestion: "Pain abdomen",
  referrer: { doctorCode: "DR-0114", department: "General Surgery" },
  patient: { id: "P1", name: "Asha Devi", uhid: "HMS-00000001-5", sex: "female", age: 30, flags: [] },
  priors: [], cumulativeDlp12m: null, canOpenImages: false,
  templates: [{
    key: "usg", name: "Ultrasound", governed: false,
    sections: [
      { key: "technique", label: "Technique", normal: null },
      { key: "findings", label: "Findings", normal: null },
      { key: "impression", label: "Impression", normal: null },
    ],
    macros: [], coded: [],
  }],
  defaultTemplateKey: "usg", working: null, signed: null, readingBy: null, proposal: null,
};

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("spec #1082 D13: the reading room with a study in hand renders the copilot column and the list folded to one line", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [ROW, NEXT] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: CTX } },
    "POST /api/radiology/reading/studies/S1/claim": { status: 201, body: { claimed: true, heldBy: null } },
    "POST /api/radiology/studies/S1/reports/checks": { status: 200, body: { findings: [], signable: true } },
    "POST /api/radiology/studies/S1/reports/propose": { status: 201, body: null },
    "GET /api/copilot/notice": { status: 200, body: { seen: true } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  const right = await screen.findByTestId("station-right");
  const folded = await within(right).findByTestId("station-list-folded");
  await waitFor(() => expect(folded.textContent).toContain("Kamla Devi"));
  const column = within(right).getByTestId("radiology-copilot");
  expect(within(column).getByTestId("agent-dock")).toBeInTheDocument();
  expect(within(column).getByTestId("agent-ask")).toBeInTheDocument();
  expect(within(right).queryByTestId("reading-list")).toBeNull();
});
