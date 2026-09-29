import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyHod } from "./radiology-hod";

/**
 * PLAN 18-S RS10 T5 — THE SUPERVISOR & HOD STATION. The floor reads the server's read model; an
 * escalation is answered with the spine's own acts (`/alerts/:id/ack`) and its one docked act opens
 * the seat; a gate override is granted through the existing decide route; quality says "not
 * measured" rather than a false zero; the access log flags break-glass.
 */
type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>, permissions: string[] = ["radiology.definitions.manage"]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({
        actor: { type: "user", id: "u-hod" },
        permissions: { hospital: permissions, scoped: { department: {}, floor: {} } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function bodiesOf(key: string): unknown[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as unknown);
}

const stage = (s: string, count = 0, held = 0, oldest: { accessionNo: string; waitMin: number } | null = null) => ({
  stage: s, count, held, oldest: oldest === null ? null : { studyId: "S", studyTypeCode: "CT-HEAD", ...oldest },
});
const FLOOR = {
  generatedAt: new Date().toISOString(), day: "2026-09-29",
  pipeline: [
    stage("scheduled", 4), stage("checked_in", 2, 1, { accessionNo: "I2609290012", waitMin: 41 }), stage("ready", 1),
    stage("in_acquisition", 1, 0, { accessionNo: "I2609290015", waitMin: 9 }), stage("to_read", 3, 0, { accessionNo: "I2609290003", waitMin: 22 }),
    stage("drafted", 1), stage("reported", 0), stage("published", 6),
  ],
  rooms: [
    { deviceId: "d1", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 2", status: "down", licensedNow: true, queue: 3, onTable: null, nextFreeAt: null, technologist: null },
    { deviceId: "d2", code: "XR-1", name: "X-ray", modality: "xray", room: "Room 1", status: "available", licensedNow: false, queue: 1, onTable: null, nextFreeAt: new Date().toISOString(), technologist: null },
  ],
  readers: { toRead: 3, stat: 1, drafted: 1, claimed: [{ userId: "r1", name: "Dr. Anjali Mehta", studies: 2 }], unclaimed: 2 },
  turnaround: {
    from: "2026-09-23", to: "2026-09-29",
    rows: [{ modality: "ct", source: "ER", n: 4, medianMin: 22, p90Min: 41, targetMin: 30, withinTarget: false }],
    northStar: { orderToActed: { n: 5, medianMin: 300, p90Min: 900 }, signedUnreadOver24h: 1, publishedNotActedOver72h: 0 },
  },
  leakage: { open: 1, estimatedPaise: 180000, unpriced: 0, rows: [] },
  criticals: { openRed: 1, openAll: 1, oldestRedMin: 18 },
  unmatchedPacs: { measured: false, open: 0, olderThan24h: 0 },
  licenceGaps: [{ deviceId: "d2", code: "XR-1", name: "X-ray", booked: 1 }],
  qaOverdue: [],
  escalations: { open: 2, raised: 2 },
  approvals: { pending: 1 },
};
const ESC_STAT = {
  cause: "stat_unread", subjectType: "imaging_study", subjectId: "S9", since: new Date(Date.now() - 22 * 60_000).toISOString(),
  studyId: "S9", accessionNo: "I2609290003", studyTypeCode: "CT-HEAD", deviceCode: null, detail: "images in, no preliminary or signed report",
  seat: "/radiology/read?study=S9", title: "STAT study unread past 15 minutes", ageMin: 22, instanceId: "W1",
  raisedAt: new Date().toISOString(), myAlert: { alertId: "AL1", ackKind: null, ownedUntil: null, handedToUserId: null },
};
const ESC_DOWN = {
  ...ESC_STAT, cause: "machine_down", subjectType: "resource", subjectId: "d1", studyId: null, accessionNo: null, studyTypeCode: null,
  deviceCode: "CT-1", detail: "CT-1 · CT scanner is down; 3 booked to move", seat: "/radiology/room?view=downtime", instanceId: "W2", myAlert: null,
};
const ROSTER = {
  resolverEnabled: false, department: { code: "RAD", name: "Radiodiagnosis" }, source: "static", positions: [],
  roles: [{ roleKey: "radiologist", people: [{ userId: "r1", name: "Dr. Anjali Mehta" }] }], note: "",
};
const APPROVALS = {
  rows: [
    { approvalId: "AP1", typeKey: "imaging_gate_override", approverRole: "radiologist", urgencyClass: "urgent", requesterName: "Rekha Soren",
      requestedAt: new Date().toISOString(), ageMin: 12, note: "creatinine 1.9, patient in pain", subject: "renal_function · I2609290012 · CT-HEAD", studyId: "S1", gateKind: "renal_function" },
    { approvalId: "AP2", typeKey: "imaging_definition_publish", approverRole: "medical_superintendent", urgencyClass: "routine", requesterName: "Dr. Sahay",
      requestedAt: new Date().toISOString(), ageMin: 90, note: "new templates", subject: "imaging_definition", studyId: null, gateKind: null },
  ],
  billDecisions: [{ billDecisionId: "B1", kind: "acquired_unbilled", studyId: "S3", accessionNo: "I2609280035", studyTypeCode: "XR-CHEST", raisedAt: new Date().toISOString(), ageMin: 1600, listPricePaise: 45000 }],
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("the floor: pipeline with each stage's longest wait, rooms, turnaround against target, the five priorities — and no patient name", async () => {
  mockRoutes({
    "GET /api/radiology/supervisor/floor": { status: 200, body: FLOOR },
    "GET /api/radiology/supervisor/escalations": { status: 200, body: { rows: [ESC_STAT, ESC_DOWN], notActive: [] } },
  });
  renderWithProviders(<RadiologyHod view="floor" />);
  const pipe = await screen.findByTestId("hod-pipeline");
  const checked = within(pipe).getByText("Checked in").closest("li")!;
  expect(checked).toHaveAttribute("data-acc", "I2609290012");
  expect(within(checked).getByText("1 held")).toBeInTheDocument();
  const rooms = screen.getByTestId("hod-rooms");
  expect(within(rooms).getByText("CT-1").closest("tr")).toHaveAttribute("data-down", "CT-1");
  expect(within(rooms).getAllByText("the roster does not say").length).toBe(2);
  expect(within(screen.getByTestId("hod-tat")).getByText(/30 min ✗/)).toBeInTheDocument();
  expect(screen.getByTestId("hod-brief")).toHaveTextContent("XR-1 cannot expose");
  expect(within(screen.getByTestId("hod-five")).getByText("Dashboard UX")).toBeInTheDocument();
  // The right list is the escalations, red first; one item per cause.
  const list = screen.getByRole("region", { name: "Escalated to you" });
  expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-esc"))).toEqual(["stat_unread", "machine_down"]);
  // Eight header views, the escalated count on its link.
  for (const v of ["floor", "escalations", "approvals", "quality", "equipment", "roster", "money", "audit"]) {
    expect(screen.getAllByTestId(`hod-view-${v}`).length).toBeGreaterThan(0);
  }
  expect(screen.getAllByTestId("hod-view-escalations")[0]).toHaveTextContent("2");
  expect(document.body.textContent).not.toMatch(/Asha|Farida/);
});

it("an escalation in hand is answered with the spine's acts, and its one docked act names the seat", async () => {
  mockRoutes({
    "GET /api/radiology/supervisor/floor": { status: 200, body: FLOOR },
    "GET /api/radiology/supervisor/escalations": { status: 200, body: { rows: [ESC_STAT, ESC_DOWN], notActive: [] } },
    "GET /api/radiology/supervisor/roster": { status: 200, body: ROSTER },
    "POST /api/alerts/AL1/ack": { status: 200, body: { alertId: "AL1", kind: "owned", acknowledgedAt: new Date().toISOString(), ownedUntil: new Date().toISOString(), handedToUserId: null, ackExtensions: 0, changed: true } },
  });
  const user = userEvent.setup();
  renderWithProviders(<RadiologyHod view="escalations" item="stat_unread:S9" />);
  const acts = await screen.findByTestId("hod-acts");
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Open the reading room");
  await user.click(within(acts).getByRole("button", { name: "Take it on" }));
  await waitFor(() => expect(bodiesOf("POST /api/alerts/AL1/ack")).toEqual([{ kind: "owned", untilMinutes: 60 }]));
  expect(await screen.findByText("It is yours now, with a deadline.")).toBeInTheDocument();

  // One the ladder has not reached this person: no acts offered, and it says why.
  await user.click(within(screen.getByRole("region", { name: "Escalated · red first" })).getByText("Machine out of service"));
  expect(await screen.findByText(/The ladder has not reached you/)).toBeInTheDocument();
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Open downtime");
});

it("a gate override is granted here with a reason (the existing decide route); a book goes to the MS's inbox", async () => {
  mockRoutes({
    "GET /api/radiology/supervisor/floor": { status: 200, body: FLOOR },
    "GET /api/radiology/supervisor/approvals": { status: 200, body: APPROVALS },
    "POST /api/radiology/gate-override-requests/AP1/decide": { status: 200, body: { verdict: "granted", override: { kind: "renal_function", state: "overridden" }, study: null, note: null } },
  }, ["radiology.definitions.manage", "radiology.gates.override"]);
  const user = userEvent.setup();
  renderWithProviders(<RadiologyHod view="approvals" />);
  const list = await screen.findByRole("region", { name: "Waiting on you" });
  await user.click(within(list).getByText("Book to publish"));
  expect(await screen.findByRole("link", { name: "Open the approvals inbox" })).toHaveAttribute("href", "/approvals?focus=AP2");
  await user.click(within(list).getByText("Gate override (prep bay asks)"));
  const dock = await screen.findByTestId("dock-act");
  expect(dock).toBeDisabled();
  await user.type(screen.getByLabelText("Your reason (kept with your name)"), "plain study first, hydration given");
  await user.click(dock);
  await waitFor(() => expect(bodiesOf("POST /api/radiology/gate-override-requests/AP1/decide"))
    .toEqual([{ verdict: "grant", reason: "plain study first, hydration given" }]));
  expect(within(screen.getByTestId("hod-bills")).getByText("I2609280035").closest("tr")).toHaveAttribute("data-bill", "B1");
  expect(screen.getByTestId("hod-discount-note")).toHaveTextContent("moved to the billing plan");
});

it("without the override grant, the gate request is not decidable here", async () => {
  mockRoutes({
    "GET /api/radiology/supervisor/floor": { status: 200, body: FLOOR },
    "GET /api/radiology/supervisor/approvals": { status: 200, body: APPROVALS },
  });
  const user = userEvent.setup();
  renderWithProviders(<RadiologyHod view="approvals" />);
  await user.click(within(await screen.findByRole("region", { name: "Waiting on you" })).getByText("Gate override (prep bay asks)"));
  expect(await screen.findByRole("link", { name: "Open the approvals inbox" })).toBeInTheDocument();
  expect(screen.queryByTestId("hod-approval-dock")).toBeNull();
});

it("quality shows 'not measured yet' where there is nothing to count, never a zero", async () => {
  const ind = (key: string, value: number | null, status: string) => ({
    key, unit: "%", comparator: "≤", target: 2, value, numerator: value === null ? null : 1, denominator: value === null ? null : 50, status, note: "",
    days: [{ day: "2026-09-29", value, status }],
  });
  mockRoutes({
    "GET /api/radiology/supervisor/floor": { status: 200, body: FLOOR },
    "GET /api/radiology/supervisor/quality": { status: 200, body: { from: "2026-09-29", to: "2026-09-29", indicators: [ind("repeat_rate", 2, "ok"), ind("peer_review_discrepancy", null, "not_measured")] } },
  });
  renderWithProviders(<RadiologyHod view="quality" />);
  const q = await screen.findByTestId("hod-quality");
  const peer = await within(q).findByText("Peer-review discrepancy");
  expect(peer.closest("tr")).toHaveAttribute("data-status", "not_measured");
  expect(within(peer.closest("tr")!).getByText("not measured yet")).toBeInTheDocument();
  expect(within(q).getByText("Repeat rate").closest("tr")).toHaveTextContent("2 %");
});

it("the access log lists who opened whose images and flags break-glass in the right-hand list", async () => {
  const at = new Date().toISOString();
  mockRoutes({
    "GET /api/radiology/supervisor/floor": { status: 200, body: FLOOR },
    "GET /api/radiology/supervisor/access-log": { status: 200, body: {
      from: "2026-09-29", to: "2026-09-29", truncated: false, counts: { openings: 2, images: 1, breakGlass: 1, noCareContext: 0 },
      rows: [
        { at, who: "u1", whoName: "Dr. Rohan Das", roles: ["doctor"], kind: "images", what: "images (external_pacs)", patientUhid: "HMS-9", patientName: "Bablu Yadav", accessionNo: "I2609290003", context: null, reason: null, sealed: false, breakGlass: true },
        { at, who: "u2", whoName: "Anil Kujur", roles: ["radiographer"], kind: "record", what: "imaging.study", patientUhid: "HMS-9", patientName: "Bablu Yadav", accessionNo: null, context: "serving", reason: null, sealed: false, breakGlass: false },
      ],
    } },
  });
  renderWithProviders(<RadiologyHod view="audit" />);
  const bg = await screen.findByRole("region", { name: "Break-glass openings" });
  expect(await within(bg).findByText("Dr. Rohan Das")).toBeInTheDocument();
  const table = screen.getByRole("table", { name: "Who opened what" });
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  expect(within(table).getByText("break-glass")).toBeInTheDocument();
});
