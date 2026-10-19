import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { doctorApi } from "../../src/doctor/api";
import { I18nProvider } from "../../src/i18n";
import { ConsultScreen } from "../../src/screens/consult";
import { SessionProvider, useSession } from "../../src/session";
import { resetCrossed } from "../../src/consult/signals";

/**
 * ACCEPTANCE — issue #609, spec SPEC-consult-tests-search-2026-10-10 (owner APPROVED 2026-10-10,
 * "free-text tests: NO"). The phone consult's Tests tab searches the hospital's test list — the
 * LIMS catalogue's single parameters and panels — from two letters, by name or code; a pick carries
 * its catalogue identity (serviceId, code) onto the visit's advised tests, which is what the lab desk
 * reads; a name not in the list offers nothing to add. Locked once merged (tools/ci/acceptance-guard.mjs).
 */

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-haptics", () => ({ NotificationFeedbackType: { Success: "success", Warning: "warning" }, notificationAsync: jest.fn(async () => undefined) }));
const mockRecorder = { allow: jest.fn(async () => true), start: jest.fn(async () => undefined), take: jest.fn(async () => null), discard: jest.fn(async () => undefined) };
jest.mock("../../src/consult/recorder", () => ({ useVoiceRecorder: () => mockRecorder }));

type Route = (body: unknown, url: string) => { status: number; body?: unknown };
function server(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown; url: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, of: (key: string) => calls.filter((c) => c.key === key) };
}

/** The hospital's test list as the server's test search answers it: lab parameters and panels, by code or name. */
const CATALOGUE = [
  { serviceId: "svc-hb", code: "HB", name: "Haemoglobin", department: "lab", departmentName: null },
  { serviceId: "svc-hba1c", code: "HBA1C", name: "Glycated haemoglobin (HbA1c)", department: "lab", departmentName: null },
  { serviceId: "svc-hbsag", code: "HBSAG", name: "Hepatitis B surface antigen", department: "lab", departmentName: null },
  { serviceId: "svc-cbc", code: "CBC", name: "Complete blood count", department: "lab", departmentName: null },
];
const search: Route = (_b, url) => {
  const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? "").trim().toLowerCase();
  return { status: 200, body: { items: q.length < 2 ? [] : CATALOGUE.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) } };
};

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.consult"], scoped: { department: {}, floor: {} } } };
const SUMMARY = { requestedId: "p13", id: "p13", uhid: "U0011013", name: "Suresh Prasad", alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z" };
function world(diagnosis: string | null = null) {
  const v = {
    encounter: { id: "e13", visitNo: "V2610070013", patientId: "p13", status: "in_consultation", serviceDate: "2026-10-07", visitType: "revisit", chiefComplaint: null, doctorNote: null, diagnosis, advice: null, advisedTests: null, dangerFlagged: false, consultStartedAt: "2026-10-07T05:00:00.000Z", rxDraft: null },
    feeUnpaid: false, feeBypass: null, deskComplaint: null, vitals: [], prescriptions: [],
  };
  return server({
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/visits/e13": () => ({ status: 200, body: v }),
    "GET /patients/p13/allergies": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/patients/p13/prescriptions": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/rx-sets": () => ({ status: 200, body: { headOf: [], departmentId: "dep1", items: [] } }),
    "PUT /opd/visits/e13/consult/note": () => ({ status: 200, body: { encounter: {} } }),
    "POST /opd/visits/e13/consult/complete": () => ({ status: 201, body: { encounter: {} } }),
    "POST /opd/consult/signals": () => ({ status: 201, body: {} }),
    "GET /opd/consult/suggestions": () => ({ status: 200, body: { on: true, hospitalOn: true, hidden: [] } }),
    "GET /opd/cds/suggest/tests": () => ({ status: 200, body: { items: [{ serviceId: "svc-crp", code: "CRP", name: "C-reactive protein", pricePaise: 40000, mine: 2, hospital: 5 }] } }),
    "GET /tariff/price-list": () => ({ status: 200, body: { items: [] } }),
    "GET /ordering/tests": search,
  });
}
function Host() {
  const { call, state } = useSession();
  if (state.status !== "signedIn") return null;
  return <ConsultScreen doctorApi={doctorApi(call)} encounterId="e13" patientId="p13" tokenNo={13} entry={null} summary={SUMMARY as never}
    cfg={{ followUpDefaultDays: 7, followUpExtensionDays: [14] }} onDone={() => undefined} onPaper={() => undefined} onHistory={() => undefined} onPark={() => undefined} parkBusy={false} />;
}
async function mount(w: ReturnType<typeof world>) {
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={w.fetcher}><Host /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
const press = async (id: string): Promise<void> => { await fireEvent.press(screen.getByTestId(id)); };
/** Types into the test box and lets the search's short pause run out. */
async function typeTest(text: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId("test-input"), text);
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
}

beforeEach(() => {
  mockStore.clear();
  mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" }));
  jest.clearAllMocks();
  resetCrossed();
});

describe("#609 — the Tests tab searches the lab's list", () => {
  it("typing \"hb\" lists the catalogue's rows by name or code; one letter asks nothing", async () => {
    const w = world();
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-tests");
    await screen.findByTestId("tests-drawer");
    await typeTest("h");
    expect(w.of("GET /ordering/tests")).toHaveLength(0);
    await typeTest("hb");
    expect(await screen.findByTestId("test-hit-svc-hb")).toHaveTextContent(/Haemoglobin/);
    expect(screen.getByTestId("test-hit-svc-hba1c")).toBeTruthy();
    expect(screen.getByTestId("test-hit-svc-hbsag")).toBeTruthy();
    expect(w.of("GET /ordering/tests").some((c) => /[?&]q=hb\b/.test(c.url))).toBe(true);
  });

  it("typing \"cbc\" lists the panel; picking it puts it on the visit with its catalogue identity", async () => {
    const w = world();
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-tests");
    await screen.findByTestId("tests-drawer");
    await typeTest("cbc");
    await fireEvent.press(await screen.findByTestId("test-hit-svc-cbc"));
    expect(screen.getByTestId("test-on-svc-cbc")).toHaveTextContent(/Complete blood count/);
    await press("tests-drawer-done");
    expect(screen.getByTestId("visit-tests")).toHaveTextContent(/Complete blood count/);
    expect(screen.getByTestId("count-tests")).toHaveTextContent("1");
    await press("issue-complete");
    await waitFor(() => expect(w.of("POST /opd/visits/e13/consult/complete")).toHaveLength(1));
    const note = (w.of("POST /opd/visits/e13/consult/complete")[0]!.body as { note: { advisedTests: Record<string, unknown>[] } }).note;
    // What the lab desk reads: the catalogue's own service id and code (lab/desk.ts advisedLinesFor).
    expect(note.advisedTests).toEqual([expect.objectContaining({ serviceId: "svc-cbc", code: "CBC", name: "Complete blood count" })]);
  });

  it("a name not in the catalogue offers nothing to add, and says to ask the lab", async () => {
    const w = world();
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-tests");
    await screen.findByTestId("tests-drawer");
    await typeTest("vitamin zz");
    expect(await screen.findByTestId("test-none")).toHaveTextContent("Not in the lab's list — ask the lab to add it");
    expect(screen.queryAllByTestId(/^test-hit-/)).toHaveLength(0);
    // No free text: the box's own "done" key adds nothing either.
    await fireEvent(screen.getByTestId("test-input"), "submitEditing");
    expect(screen.queryAllByTestId(/^test-on-/)).toHaveLength(0);
    await press("tests-drawer-done");
    expect(screen.queryByTestId("visit-tests")).toBeNull();
    expect(screen.getByTestId("visit-empty")).toBeTruthy();
  });

  it("the diagnosis-based suggestions stay above the search box", async () => {
    await mount(world("Acute pharyngitis"));
    await screen.findByTestId("visit-dx");
    await press("open-tests");
    await screen.findByTestId("test-before-svc-crp");
    const order = screen.getAllByTestId(/^(test-before-svc-crp|test-input)$/).map((n) => String(n.props.testID));
    expect(order).toEqual(["test-before-svc-crp", "test-input"]);
  });
});
