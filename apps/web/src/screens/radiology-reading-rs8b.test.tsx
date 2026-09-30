import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReading } from "./radiology-reading";

/**
 * PLAN 18-S RS8b T4 — the reading room, part 2: a resident signs FOR CO-SIGN (nothing published);
 * the consultant sees "Awaiting consultant" on top and co-signs; the prelim (STAT/ER only) carries
 * its banner; Amend takes a reason code, a note and the corrected text; the Critical calls view
 * walks the ladder — Call → No answer / Answered → the read-back — and shows the server's refusal.
 */
type Reply = { status: number; body: unknown } | ((body: unknown) => { status: number; body: unknown });
const calls: { key: string; body: unknown }[] = [];
let perms: string[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-rad" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    const reply = typeof h === "function" ? h(body) : h;
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const NOW = Date.now();
const iso = (minsFromNow: number) => new Date(NOW + minsFromNow * 60_000).toISOString();
const row = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "X1", status: "acquired", priority: "routine", studyTypeCode: "XR-CHEST",
  studyTypeName: "X-ray chest PA", modality: "xray", bodyPart: "chest", patientId: "P1", patientName: "Asha Devi",
  patientSex: "female", patientAge: 30, restricted: false, formFRequired: false, acquiredAt: iso(-60),
  tatClass: "opd", targetMinutes: 1440, dueAt: iso(1380), reportState: "none", readingBy: null, ...over,
});
const CTX = {
  studyId: "S1", accessionNo: "X1", status: "acquired", priority: "stat", studyTypeCode: "XR-CHEST",
  studyTypeName: "X-ray chest PA", modality: "xray", laterality: "na", bedsideLocation: null, acquiredAt: iso(-10),
  tatClass: "stat", targetMinutes: 30, dueAt: iso(20), clinicalQuestion: "Breathless after fall",
  referrer: { doctorCode: "DR-0114", department: "Emergency" },
  patient: { id: "P1", name: "Asha Devi", uhid: "HMS-00000001-5", sex: "female", age: 30, flags: [] },
  priors: [], cumulativeDlp12m: null, canOpenImages: true,
  templates: [{
    key: "xray_chest", name: "X-ray chest", governed: false,
    sections: [
      { key: "findings", label: "Findings", normal: "Lungs clear." },
      { key: "impression", label: "Impression", normal: "No active disease." },
    ],
    macros: [], coded: [],
  }],
  defaultTemplateKey: "xray_chest",
  working: { reportId: "R1", version: 1, status: "draft", templateKey: "xray_chest", body: { findings: "Left pneumothorax." }, impression: "Large left pneumothorax.", criticalCategory: null },
  signed: null, awaitingCosign: null, viewer: { consultant: true, resident: false }, prelimAllowed: true, readingBy: null,
};
const CHECKS_CLEAR = { status: 200, body: { findings: [], signable: true } };

beforeEach(() => { setToken("t"); calls.length = 0; perms = ["radiology.reports.write", "radiology.reports.amend", "radiology.criticals.ack"]; });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

/* ═══════════════════════ co-sign ═══════════════════════ */

it("a resident's dock is 'Sign for co-sign'; the signature is awaiting_cosign and NOTHING is published", async () => {
  perms = ["radiology.reports.write"];
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: { ...CTX, viewer: { consultant: false, resident: true } } } },
    "GET /api/radiology/reading/criticals": { status: 403, body: {} },
    "POST /api/radiology/studies/S1/reports/checks": CHECKS_CLEAR,
    "POST /api/radiology/studies/S1/reports/sign": { status: 201, body: { reportId: "R2", version: 2, awaitingCosign: true } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  await waitFor(() => expect(screen.getByTestId("dock-act")).toBeEnabled());
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Sign for co-sign");
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByTestId("awaiting-cosign")).toHaveTextContent("waiting for a consultant");
  expect(calls.map((c) => c.key)).not.toContain("POST /api/radiology/studies/S1/reports/publish");
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Next study");
});

it("the consultant: the resident's report sits at the TOP as 'Awaiting consultant', and the dock co-signs then publishes", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [
      row({ studyId: "S9", patientName: "Stat Sita", priority: "stat", tatClass: "stat", dueAt: iso(5) }),
      row({ studyId: "S1", patientName: "Asha Devi", reportState: "awaiting_cosign" }),
    ] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: {
      ...CTX, awaitingCosign: {
        reportId: "R2", version: 2, residentId: "u-res", residentName: "Dr Ravi (JR2)", signedAt: iso(-5),
        templateKey: "xray_chest", body: { findings: "Left pneumothorax." }, impression: "Large left pneumothorax.", criticalCategory: "red",
      },
    } } },
    "GET /api/radiology/reading/criticals": { status: 200, body: { open: [], acknowledged: [] } },
    "POST /api/radiology/studies/S1/reports/checks": CHECKS_CLEAR,
    "POST /api/radiology/studies/S1/reports/cosign": { status: 201, body: { reportId: "R3", version: 3, cosignedId: "R2" } },
    "POST /api/radiology/studies/S1/reports/publish": { status: 201, body: { reportId: "R3", version: 3, notified: true } },
  });
  const { unmount } = renderWithProviders(<RadiologyReading studyId={null} />);
  const wl = await screen.findByTestId("reading-worklist");
  await waitFor(() => expect(within(wl).getAllByRole("button")[0]).toHaveTextContent("Asha Devi"));
  expect(within(wl).getAllByRole("button")[0]).toHaveTextContent("Awaiting consultant");
  unmount();

  renderWithProviders(<RadiologyReading studyId="S1" />);
  expect(await screen.findByTestId("awaiting-cosign")).toHaveTextContent("Dr Ravi (JR2)");
  await waitFor(() => expect(screen.getByTestId("dock-act")).toBeEnabled());
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Co-sign and publish");
  await userEvent.click(screen.getByTestId("dock-act"));
  await screen.findByText(/Co-signed and published/);
  expect(calls.find((c) => c.key === "POST /api/radiology/studies/S1/reports/cosign")!.body).toEqual({ reportId: "R2", acknowledgedWarnings: [] });
  const keys = calls.map((c) => c.key);
  expect(keys.indexOf("POST /api/radiology/studies/S1/reports/publish")).toBeGreaterThan(keys.indexOf("POST /api/radiology/studies/S1/reports/cosign"));
});

/* ═══════════════════════ prelim ═══════════════════════ */

it("Prelim on a STAT study: issued through the prelim route, and the banner says a final report follows", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: CTX } },
    "GET /api/radiology/reading/criticals": { status: 200, body: { open: [], acknowledged: [] } },
    "POST /api/radiology/studies/S1/reports/checks": CHECKS_CLEAR,
    "POST /api/radiology/studies/S1/reports/prelim": { status: 201, body: { reportId: "R2", version: 2 } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  expect(screen.queryByTestId("prelim-banner")).not.toBeInTheDocument();
  await userEvent.click(await screen.findByTestId("issue-prelim"));
  expect(await screen.findByTestId("prelim-banner")).toHaveTextContent("PRELIMINARY — final report follows");
  const sent = calls.find((c) => c.key === "POST /api/radiology/studies/S1/reports/prelim")!.body as { impression: string };
  expect(sent.impression).toBe("Large left pneumothorax.");
});

it("no Prelim on a routine study (ER/STAT only)", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({})] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: { ...CTX, priority: "routine", prelimAllowed: false } } },
    "GET /api/radiology/reading/criticals": { status: 200, body: { open: [], acknowledged: [] } },
    "POST /api/radiology/studies/S1/reports/checks": CHECKS_CLEAR,
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  await screen.findByTestId("save-draft");
  expect(screen.queryByTestId("issue-prelim")).not.toBeInTheDocument();
});

/* ═══════════════════════ amend ═══════════════════════ */

it("Amend: a reason code + one-line note + the corrected text; the reason travels in the record's words", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [row({ reportState: "signed" })] } },
    "GET /api/radiology/reading/studies/S1": { status: 200, body: { study: {
      ...CTX, signed: { reportId: "R3", version: 3, publishedAt: iso(-30), templateKey: "xray_chest", body: { findings: "Left pneumothorax." }, impression: "Large left pneumothorax.", laterality: "na", criticalCategory: null },
    } } },
    "GET /api/radiology/reading/criticals": { status: 200, body: { open: [], acknowledged: [] } },
    "POST /api/radiology/studies/S1/reports/checks": CHECKS_CLEAR,
    "POST /api/radiology/studies/S1/reports/amend": { status: 201, body: { reportId: "R4", version: 4, supersededId: "R3" } },
  });
  renderWithProviders(<RadiologyReading studyId="S1" />);
  await userEvent.click(await screen.findByTestId("amend-open"));
  const panel = screen.getByTestId("amend-panel");
  expect(within(panel).getByTestId("amend-findings")).toHaveValue("Left pneumothorax.");
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  await userEvent.selectOptions(within(panel).getByTestId("amend-reason"), "laterality");
  await userEvent.clear(within(panel).getByTestId("amend-findings"));
  await userEvent.type(within(panel).getByTestId("amend-findings"), "Right pneumothorax.");
  await userEvent.clear(within(panel).getByTestId("amend-impression"));
  await userEvent.type(within(panel).getByTestId("amend-impression"), "Large right pneumothorax.");
  await userEvent.type(within(panel).getByTestId("amend-note"), "right, not left");
  await waitFor(() => expect(screen.getByTestId("dock-act")).toBeEnabled(), { timeout: 3000 });
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Sign the amendment");
  await userEvent.click(screen.getByTestId("dock-act"));
  await screen.findByText(/version 4 is released and the original recipients are told/);
  expect(calls.find((c) => c.key === "POST /api/radiology/studies/S1/reports/amend")!.body).toMatchObject({
    reason: "Correction of laterality: right, not left", impression: "Large right pneumothorax.",
    body: { findings: "Right pneumothorax." },
  });
});

/* ═══════════════════════ the critical calls view ═══════════════════════ */

const CALL = {
  criticalId: "C1", reportId: "R3", studyId: "S1", accessionNo: "X1", studyTypeName: "CT head",
  patientName: "Hari Oraon", patientUhid: "HMS-00000002-3", category: "red", finding: "Large left extradural haematoma.",
  flaggedAt: iso(-20), windowMin: 15, dueAt: iso(-5), overdue: true, ladderRung: 0,
  rungs: [
    { key: "treating_doctor", people: [{ userId: "u-doc", name: "Dr Mehra" }], source: "order" },
    { key: "unit_head", people: [], source: "role" },
    { key: "duty_rmo", people: [], source: "role" },
    { key: "hod", people: [{ userId: "u-ms", name: "Dr Iyer" }], source: "role" },
  ],
  attempts: [], acknowledgedAt: null, acknowledgedByName: null, readBack: null,
};

it("Critical calls: the overdue banner, the ladder with the rung in hand, Call → No answer records the ring on that rung", async () => {
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [] } },
    "GET /api/radiology/reading/criticals": { status: 200, body: { open: [CALL], acknowledged: [] } },
    "POST /api/radiology/criticals/C1/calls": { status: 201, body: { attemptId: "A1", ladderRung: 1 } },
  });
  renderWithProviders(<RadiologyReading studyId={null} view="criticals" />);
  expect(await screen.findByTestId("calls-overdue-banner")).toHaveTextContent("past its window");
  const ladder = screen.getByTestId("ladder");
  expect(within(ladder).getAllByRole("listitem").map((l) => l.getAttribute("data-rung-key"))).toEqual(["treating_doctor", "unit_head", "duty_rmo", "hod"]);
  expect(within(ladder).getAllByRole("listitem")[0]).toHaveAttribute("aria-current", "step");
  expect(within(ladder).getAllByRole("listitem")[0]).toHaveTextContent("Dr Mehra");
  expect(within(ladder).getAllByRole("listitem")[1]).toHaveTextContent("no roster published");
  expect(screen.getByTestId("call-finding")).toHaveTextContent("extradural haematoma");

  expect(screen.getByTestId("calls-dock-act")).toHaveTextContent("Call the Treating doctor");
  /** "Call" records nothing on its own — it opens the two outcomes. */
  await userEvent.click(screen.getByTestId("calls-dock-act"));
  expect(calls.filter((c) => c.key === "POST /api/radiology/criticals/C1/calls")).toHaveLength(0);
  await userEvent.click(screen.getByTestId("outcome-no-answer"));
  await waitFor(() => expect(calls.find((c) => c.key === "POST /api/radiology/criticals/C1/calls")).toBeDefined());
  expect(calls.find((c) => c.key === "POST /api/radiology/criticals/C1/calls")!.body).toEqual({
    rung: 0, outcome: "no_answer", calledUserId: "u-doc", calledName: null,
  });
});

it("Critical calls: Answered opens the read-back; a read-back that names nothing is refused in the server's words; the log lists closed calls", async () => {
  let acks = 0;
  mockRoutes({
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [] } },
    "GET /api/radiology/reading/criticals": { status: 200, body: { open: [CALL], acknowledged: [{ ...CALL, criticalId: "C0", patientName: "Old Case", acknowledgedAt: iso(-60), acknowledgedByName: "Dr Mehra", readBack: "tension pneumothorax, draining" }] } },
    "POST /api/radiology/criticals/C1/calls": { status: 201, body: { attemptId: "A1", ladderRung: 0 } },
    "POST /api/radiology/criticals/C1/acknowledge": () => {
      acks += 1;
      return acks === 1
        ? { status: 422, body: { statusCode: 422, code: "read_back_mismatch", message: "the read-back does not name the finding — ask the clinician to repeat what the report found" } }
        : { status: 201, body: { criticalId: "C1", acknowledgedAt: iso(0) } };
    },
  });
  renderWithProviders(<RadiologyReading studyId={null} view="criticals" />);
  await userEvent.click(await screen.findByTestId("calls-dock-act"));
  await userEvent.click(screen.getByTestId("outcome-answered"));
  const rb = await screen.findByTestId("read-back");
  expect(within(rb).getByTestId("clinician")).toHaveValue("u-doc");
  expect(screen.getByTestId("calls-dock-act")).toBeDisabled();
  await userEvent.type(within(rb).getByTestId("read-back-text"), "noted");
  await userEvent.click(screen.getByTestId("calls-dock-act"));
  expect(await screen.findByText(/does not name the finding/)).toBeInTheDocument();
  await userEvent.clear(within(rb).getByTestId("read-back-text"));
  await userEvent.type(within(rb).getByTestId("read-back-text"), "left extradural haematoma, to theatre");
  await userEvent.click(screen.getByTestId("calls-dock-act"));
  await waitFor(() => expect(acks).toBe(2));
  expect(calls.filter((c) => c.key === "POST /api/radiology/criticals/C1/acknowledge").at(-1)!.body).toEqual({
    acknowledgedByClinicianId: "u-doc", readBack: "left extradural haematoma, to theatre",
  });
  expect(screen.getByTestId("acknowledged-log")).toHaveTextContent("Old Case");
});
