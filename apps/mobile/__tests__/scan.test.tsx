import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import * as model from "../src/scan/model";
import { AccountScreen } from "../src/screens/account";
import { DeskOne } from "../src/screens/desk-one";
import { todayIst } from "../src/vitals/rules";
import { DoctorQueue } from "../src/screens/doctor-queue";
import { LoginScreen } from "../src/screens/login";
import { ScanScreen } from "../src/screens/scan";
import { SeatHome } from "../src/screens/seat-home";
import { VitalsBay } from "../src/screens/vitals-bay";
import { SessionProvider, useSession } from "../src/session";

/**
 * QUICK SCAN, ON THE SCREENS (owner 2026-10-08; board `2026-10-08-scan-vitals`, parts "scan" and
 * "gestures"). Each test is one of the owner's "done means": the icon in the header, the fastest
 * road after a scan, the one card, a miss that says why, and a hold or swipe on a row.
 */
const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock("expo-router", () => ({ useRouter: () => mockRouter }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
const mockCam = { granted: true, canAskAgain: true };
const mockAsk = jest.fn();
jest.mock("expo-camera", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  return {
    useCameraPermissions: () => [mockCam, mockAsk],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (r: { data: string }) => void }) =>
      React.createElement(Pressable, { testID: "fake-camera", onPress: () => onBarcodeScanned({ data: (globalThis as { __scan?: string }).__scan ?? "" }) }),
  };
});

type Reply = { status: number; body?: unknown };
/** A stub server keyed on `METHOD /path` (no query); the full URL of every call is kept, so a test can read what was asked. */
function server(routes: Record<string, (url: string) => Reply>) {
  const calls: { key: string; url: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path.replace(/\?.*$/, "")}`;
    calls.push({ key, url: path });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(path);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}
const me = (hospital: string[]) => ({ status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } } });
const NURSE = ["opd.visits.read", "opd.queue.read", "opd.vitals.record"];
const DESK = ["opd.visits.read", "opd.visits.open", "opd.appointments.manage", "billing.invoice.issue", "billing.session.own", "patients.read"];
const DOCTOR = ["opd.visits.read", "opd.consult", "opd.queue.read", "opd.queue.operate"];

const RAM = { id: "p9", uhid: "U00110009", name: "Ram Pravesh Yadav", alias: null, restricted: false, administrativeGender: "male", dob: "1972-01-10T00:00:00.000Z" };
const visit = (over: Record<string, unknown> = {}) => ({
  encounterId: "e9", patientId: "p9", visitNo: "V2610080009", serviceDate: "2026-10-08", tokenNo: 9, departmentCode: "MED", departmentName: "General Medicine",
  stage: "vitals", vitalsDone: false, slip: "none", feeUnpaid: false, mine: false, patient: RAM, ...over,
});
const found = (permitted: string[], over: Record<string, unknown> = {}) => () => ({ status: 200, body: { outcome: "visit", visit: visit(over), permitted } });

function Gate({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  return state.status === "signedIn" ? <>{children}</> : state.status === "signedOut" ? <LoginScreen expired={false} /> : null;
}
async function mount(fetcher: typeof fetch, child: React.ReactNode) {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate>{child}</Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
async function typeCode(text: string) {
  await fireEvent.changeText(await screen.findByTestId("scan-typed"), text);
  await fireEvent.press(screen.getByTestId("scan-go"));
}

beforeEach(() => {
  mockStore.clear();
  mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" }));
  mockRouter.push.mockClear(); mockRouter.replace.mockClear(); mockRouter.back.mockClear(); mockAsk.mockClear();
  mockCam.granted = true; mockCam.canAskAgain = true;
  jest.restoreAllMocks();
});

describe("the scan button in the header", () => {
  it("is on the home screen, first on the right, and opens the scan screen", async () => {
    const { fetcher } = server({ "GET /auth/me": () => me(NURSE) });
    await mount(fetcher, <SeatHome />);
    const icon = await screen.findByTestId("band-scan");
    expect(icon.props.accessibilityLabel).toBe("Scan a patient");
    await fireEvent.press(icon);
    expect(mockRouter.push).toHaveBeenCalledWith("/scan");
  });

  it("is on a work screen (the doctor's line)", async () => {
    const { fetcher } = server({ "GET /auth/me": () => me(DOCTOR) });
    await mount(fetcher, <DoctorQueue />);
    expect(await screen.findByTestId("band-scan")).toBeTruthy();
  });

  it("is not on the account screen", async () => {
    const { fetcher } = server({ "GET /auth/me": () => me(NURSE) });
    await mount(fetcher, <AccountScreen />);
    await screen.findByTestId("account");
    expect(screen.queryByTestId("band-scan")).toBeNull();
  });

  it("is not on the sign-in screen", async () => {
    mockStore.clear();
    const { fetcher } = server({});
    await mount(fetcher, <SeatHome />);
    await screen.findByTestId("username");
    expect(screen.queryByTestId("band-scan")).toBeNull();
  });

  it("comes from the one shared header on every work screen — no screen switches it off but account and the scan screen itself", () => {
    const src = (f: string): string => readFileSync(join(__dirname, "../src/screens", f), "utf8");
    for (const f of ["seat-home.tsx", "vitals-bay.tsx", "slip-desk.tsx", "doctor-queue.tsx", "desk-one.tsx", "paper-consults.tsx", "roster-on-now.tsx", "roster-my-duties.tsx", "alerts.tsx"]) {
      expect([f, /<Band\b/.test(src(f)), /scan=\{false\}/.test(src(f))]).toEqual([f, true, false]);
      expect([f, /band-scan/.test(src(f))]).toEqual([f, false]); // nobody hand-copies the icon
    }
    for (const f of ["account.tsx", "scan.tsx"]) expect([f, /<Band scan=\{false\}/.test(src(f))]).toEqual([f, true]);
  });
});

describe("after a code resolves — the fastest road", () => {
  it("a vitals nurse scans a patient waiting for vitals: the vitals form opens with the green line, and no card", async () => {
    const plan = jest.spyOn(model, "scanPlan");
    const s = server({ "GET /auth/me": () => me(NURSE), "GET /opd/scan": found(["vitals"]) });
    await mount(s.fetcher, <ScanScreen />);
    (globalThis as { __scan?: string }).__scan = "V2610080009";
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledTimes(1));
    expect(mockRouter.replace.mock.calls[0]![0]).toMatchObject({
      pathname: "/seat/[key]",
      params: { key: "vitals", act: "vitals", scan: "e9", pid: "p9", said: "Scanned · MED-9 · waiting for vitals" },
    });
    expect(screen.queryByTestId("action-card")).toBeNull();
    expect(s.of("GET /opd/scan")[0]!.url).toBe("/opd/scan?by=visit&value=V2610080009");
    expect(plan).toHaveBeenCalled();
  });

  it("the front desk scans the same patient with a cash session open: one card, the unpaid fee on top, vitals greyed with its reason", async () => {
    const s = server({
      "GET /auth/me": () => me(DESK), "GET /opd/scan": found(["slip", "collect", "visit", "move", "book", "newVisit"], { feeUnpaid: true }),
      "GET /billing/sessions/current": () => ({ status: 200, body: { session: { id: "c1", status: "open" } } }),
    });
    await mount(s.fetcher, <ScanScreen />);
    await typeCode("med-9");
    expect(await screen.findByTestId("card-next")).toHaveTextContent(/Collect fee/);
    expect(screen.getByTestId("card-token")).toHaveTextContent("MED-9");
    expect(screen.getByTestId("card-name")).toHaveTextContent("Ram Pravesh Yadav");
    expect(screen.getByTestId("card-state")).toHaveTextContent(/Male · waiting for vitals · fee not paid/);
    expect(screen.getByTestId("card-act-visit")).toHaveTextContent(/See today's visit/);
    expect(screen.getByTestId("card-off-vitals")).toHaveTextContent(/Take vitals · not your job/);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(s.of("GET /opd/scan")[0]!.url).toBe("/opd/scan?by=token&value=9&departmentCode=MED");
    // Choosing the large button goes to Desk One for this visit.
    await fireEvent.press(screen.getByTestId("card-next"));
    expect(mockRouter.replace.mock.calls[0]![0]).toMatchObject({ params: { key: "counter", act: "collect", scan: "e9", pid: "p9" } });
  });

  it("the front desk with NO cash session open: the large button is today's visit", async () => {
    const s = server({
      "GET /auth/me": () => me(DESK), "GET /opd/scan": found(["slip", "collect", "visit", "move", "book", "newVisit"], { feeUnpaid: true }),
      "GET /billing/sessions/current": () => ({ status: 200, body: { session: null } }),
    });
    await mount(s.fetcher, <ScanScreen />);
    await typeCode("med-9");
    expect(await screen.findByTestId("card-next")).toHaveTextContent(/See today's visit/);
    expect(screen.getByTestId("card-act-collect")).toHaveTextContent(/Collect fee · open a cash session first/);
    expect(screen.getByTestId("card-off-vitals")).toHaveTextContent(/not your job/);
  });

  it("a doctor scans another doctor's patient: no Start consultation, the brief only", async () => {
    const s = server({ "GET /auth/me": () => me(DOCTOR), "GET /opd/scan": found(["brief"], { stage: "waiting", vitalsDone: true, mine: false }) });
    await mount(s.fetcher, <ScanScreen />);
    await typeCode("V2610080009");
    expect(await screen.findByTestId("card-next")).toHaveTextContent(/Patient brief/);
    expect(screen.queryByText(/Start consultation/)).toBeNull();
    expect(screen.queryByTestId("card-act-consult")).toBeNull();
    expect(screen.getByTestId("card-state")).toHaveTextContent(/another doctor's patient/);
  });

  it("a doctor whose login may not read briefs sees no brief either", async () => {
    const s = server({ "GET /auth/me": () => me(["opd.visits.read", "opd.consult"]), "GET /opd/scan": found([], { stage: "waiting", vitalsDone: true }) });
    await mount(s.fetcher, <ScanScreen />);
    await typeCode("V2610080009");
    await screen.findByTestId("card-nothing");
    expect(screen.queryByText(/Patient brief/)).toBeNull();
  });

  it("nothing permitted for this patient: the strip and one sentence — no button, nothing greyed", async () => {
    const s = server({ "GET /auth/me": () => me(["opd.visits.read"]), "GET /opd/scan": found([], { feeUnpaid: true }) });
    await mount(s.fetcher, <ScanScreen />);
    await typeCode("9");
    expect(await screen.findByTestId("card-nothing")).toHaveTextContent("Nothing for you to do for this patient");
    expect(screen.getByTestId("card-name")).toHaveTextContent("Ram Pravesh Yadav");
    expect(screen.queryByTestId("card-next")).toBeNull();
    expect(screen.queryAllByTestId(/^card-(act|off)-/)).toHaveLength(0);
  });

  it("an old slip: the dated reason, a new visit for the desk, and Scan another", async () => {
    const s = server({
      "GET /auth/me": () => me(DESK),
      "GET /opd/scan": () => ({ status: 200, body: { outcome: "miss", reason: "other_day", visitNo: "V2610060021", serviceDate: "2026-10-06", status: "completed", patient: RAM, permitted: ["book", "newVisit"] } }),
    });
    await mount(s.fetcher, <ScanScreen />);
    await typeCode("V2610060021");
    expect(await screen.findByTestId("card-miss-title")).toHaveTextContent("This slip is from 06-Oct-2026");
    expect(screen.getByTestId("card-miss-body")).toHaveTextContent(/Visit V2610060021 was completed that day/);
    expect(screen.getByTestId("card-new-visit")).toHaveTextContent(/Open a new visit/);
    await fireEvent.press(screen.getByTestId("card-again"));
    await waitFor(() => expect(screen.queryByTestId("action-card")).toBeNull());
    expect(await screen.findByTestId("fake-camera")).toBeTruthy();
  });

  it("a token two patients hold: the two are listed to pick from — never a guess", async () => {
    const s = server({
      "GET /auth/me": () => me(NURSE),
      "GET /opd/scan": (url) => (url.includes("by=token")
        ? { status: 200, body: { outcome: "ambiguous", candidates: [
          { encounterId: "e9", visitNo: "V2610080009", tokenNo: 9, departmentCode: "MED", departmentName: "General Medicine", patient: RAM },
          { encounterId: "e19", visitNo: "V2610080019", tokenNo: 9, departmentCode: "ORT", departmentName: "Orthopaedics", patient: { ...RAM, id: "p19", name: "Sunita Devi" } },
        ] } }
        : found(["vitals"], { encounterId: "e19", visitNo: "V2610080019", departmentCode: "ORT" })()),
    });
    await mount(s.fetcher, <ScanScreen />);
    await typeCode("9");
    expect(await screen.findByTestId("card-pick-title")).toHaveTextContent("2 patients hold this token today");
    expect(screen.getByTestId("card-pick-e9")).toHaveTextContent(/Ram Pravesh Yadav/);
    expect(screen.getByTestId("card-pick-e19")).toHaveTextContent(/Sunita Devi/);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("card-pick-e19"));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledTimes(1));
    expect(s.of("GET /opd/scan")[1]!.url).toBe("/opd/scan?by=encounter&value=e19");
    expect(mockRouter.replace.mock.calls[0]![0]).toMatchObject({ params: { key: "vitals", scan: "e19" } });
  });

  it("the camera refused: the typed box alone, with one line saying why", async () => {
    mockCam.granted = false; mockCam.canAskAgain = false;
    const s = server({ "GET /auth/me": () => me(NURSE), "GET /opd/scan": found(["vitals"]) });
    await mount(s.fetcher, <ScanScreen />);
    expect(await screen.findByTestId("scan-denied")).toHaveTextContent(/camera is not allowed/);
    expect(screen.queryByTestId("fake-camera")).toBeNull();
    await typeCode("V2610080009");
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledTimes(1));
  });
});

describe("a patient row, held or swiped", () => {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const entry = (tokenNo: number, name: string) => ({
    id: `q${tokenNo}`, seq: tokenNo, sessionId: "s1", encounterId: `e${tokenNo}`, tokenNo, kind: "walk_in", appointmentAt: null, status: "waiting",
    danger: false, reEntry: false, perk: false, eligibleAt: minsAgo(10), calledAt: null, callCount: 0, skips: 0, doneAt: null, createdAt: minsAgo(20),
    parkedAt: null, parkedBy: null, skipReason: null, skipNote: null, skippedAt: null, position: null, queueClass: null,
    encounter: { id: `e${tokenNo}`, patientId: `p${tokenNo}`, visitType: "new", dangerFlagged: false, status: "waiting", referredFromEncounterId: null, feeBypassReason: null, consultFeeOverrideReason: null },
    patient: { requestedId: `p${tokenNo}`, id: `p${tokenNo}`, uhid: `U0011${tokenNo}`, name, alias: null, restricted: false, administrativeGender: "male", dob: "1972-01-10T00:00:00.000Z" },
    feeStatus: "settled",
  });
  const DOC = { id: "d1", userId: "u1", displayName: "Dr. Chandan Kumar", code: "DR-0028", departmentId: "dep1", designation: null };
  const line = () => {
    const ordered = [entry(9, "Ram Pravesh Yadav"), entry(10, "Sunita Devi")];
    return {
      session: { id: "s1", doctorId: "d1", serviceDate: "2026-10-08", roomId: "r1", status: "in" }, doctor: DOC, ordered, current: null, inConsult: [], left: [], heldForPayment: [], waitingVitals: 0,
      counts: { waiting: 2, called: 0, inConsult: 0, done: 0, left: 0, heldForPayment: 0 },
    };
  };
  const doctorWorld = (extra: Record<string, (url: string) => Reply> = {}) => server({
    "GET /auth/me": () => me(DOCTOR), "GET /opd/me/doctor": () => ({ status: 200, body: DOC }), "GET /opd/queues": () => ({ status: 200, body: line() }),
    "GET /opd/scan": found(["consult", "brief", "paper"], { stage: "waiting", vitalsDone: true, mine: true }),
    "POST /opd/visits/e9/consult/start": () => ({ status: 200, body: {} }),
    ...extra,
  });

  it("press and hold on the doctor's line opens the SAME card a scan opens — one component, one model function", async () => {
    const plan = jest.spyOn(model, "scanPlan");
    const s = doctorWorld();
    await mount(s.fetcher, <DoctorQueue />);
    await fireEvent(await screen.findByTestId("line-row-9-open"), "longPress");
    expect(await screen.findByTestId("action-card")).toBeTruthy();
    expect(await screen.findByTestId("card-next")).toHaveTextContent(/Start consultation/);
    expect(screen.getByTestId("card-act-brief")).toHaveTextContent(/Patient brief/);
    expect(screen.getByTestId("card-act-paper")).toHaveTextContent(/I wrote on paper/);
    expect(s.of("GET /opd/scan")[0]!.url).toBe("/opd/scan?by=encounter&value=e9");
    // The hold path asked the one model function, with what the server said — exactly as the scan path does.
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ encounterId: "e9" }), ["consult", "brief", "paper"], { cashOpen: false });
    // A hold never jumps and never writes: the card is up, and nothing has been started.
    expect(s.of("POST /opd/visits/e9/consult/start")).toHaveLength(0);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("a plain tap still opens the brief, as it always did", async () => {
    const s = doctorWorld();
    await mount(s.fetcher, <DoctorQueue />);
    await fireEvent.press(await screen.findByTestId("line-row-9-open"));
    expect(await screen.findByTestId("act-start")).toBeTruthy();
    expect(screen.queryByTestId("action-card")).toBeNull();
    expect(s.of("GET /opd/scan")).toHaveLength(0);
  });

  it("swipe right on the doctor's line starts that patient — the Start button's own call, once", async () => {
    const s = doctorWorld();
    await mount(s.fetcher, <DoctorQueue />);
    const row = await screen.findByTestId("line-swipe-9");
    expect(row.props.accessibilityActions).toEqual([{ name: "swipe", label: "Start now" }]);
    await fireEvent(row, "accessibilityAction", { nativeEvent: { actionName: "swipe" } });
    await waitFor(() => expect(s.of("POST /opd/visits/e9/consult/start")).toHaveLength(1));
    // …and it is the visible button's call: the brief's Start sends the same request.
    await fireEvent.press(await screen.findByTestId("act-start"));
    await waitFor(() => expect(s.of("POST /opd/visits/e9/consult/start")).toHaveLength(2));
    expect(s.of("POST /opd/visits/e10/consult/start")).toHaveLength(0);
  });

  it("the swipe hint shows under the list the first three times it is opened, then never", async () => {
    mockStore.set("hmis.hint.swipe.line", "3");
    const s = doctorWorld();
    await mount(s.fetcher, <DoctorQueue />);
    await screen.findByTestId("line-row-9");
    await waitFor(() => expect(mockStore.get("hmis.hint.swipe.line")).toBe("4"));
    expect(screen.queryByTestId("swipe-hint")).toBeNull();
  });

  it("the vitals bay opened by a scan takes that patient off the bench and says what was scanned", async () => {
    const bench = { encounterId: "e9", entryId: "q9", tokenNo: 9, seq: 9, visitNo: "V2610080009", departmentCode: "MED", doctorId: "d1", doctorName: "Dr Chandan Kumar", serviceDate: "2026-10-08",
      patient: { requestedId: "p9", ...RAM }, benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false };
    const s = server({ "GET /auth/me": () => me(NURSE), "GET /opd/bench": () => ({ status: 200, body: { items: [bench] } }), "GET /opd/queues/summary": () => ({ status: 200, body: { items: [] } }) });
    await mount(s.fetcher, <VitalsBay scanned={{ encounterId: "e9", patientId: "p9", visitNo: "V2610080009", tokenNo: 9, act: "vitals", banner: "Scanned · MED-9 · waiting for vitals" }} />);
    expect(await screen.findByTestId("who-name")).toHaveTextContent("Ram Pravesh Yadav");
    expect(screen.getByTestId("scanned-banner")).toHaveTextContent("Scanned · MED-9 · waiting for vitals");
    expect(s.calls.filter((c) => c.key.startsWith("POST"))).toHaveLength(0);
  });

  it("Desk One opened by a scan holds the person and opens the visit the code named, at its bill — and has written nothing", async () => {
    const s = server({
      "GET /auth/me": () => me(DESK),
      "GET /patients/p9": () => ({ status: 200, body: { patient: { uhid: "U00110009", name: "Ram Pravesh Yadav", alias: null, dob: "1972-01-10T00:00:00.000Z", phone: null, addressLine: null, administrativeGender: "male" } } }),
      "GET /opd/patients/p9/timeline": () => ({ status: 200, body: { items: [
        { encounterId: "e9", visitNo: "V2610080009", serviceDate: todayIst(), status: "waiting", visitType: "new", departmentId: "dep1", departmentName: "General Medicine", doctorId: "d1", doctorName: "Dr. Chandan Kumar", diagnosis: null, prescriptionLineCount: 0 },
      ] } }),
    });
    await mount(s.fetcher, <DeskOne scanned={{ encounterId: "e9", patientId: "p9", visitNo: "V2610080009", tokenNo: 9, act: "collect", banner: "Scanned · MED-9 · vitals done" }} />);
    expect(await screen.findByTestId("bill-block")).toBeTruthy();
    expect(screen.getByTestId("counter-person")).toHaveTextContent(/Ram Pravesh Yadav/);
    expect(screen.getByTestId("visit-no")).toHaveTextContent("V2610080009");
    expect(screen.getByTestId("scanned-banner")).toHaveTextContent("Scanned · MED-9 · vitals done");
    expect(s.calls.filter((c) => c.key.startsWith("POST"))).toHaveLength(0);
  });
});
