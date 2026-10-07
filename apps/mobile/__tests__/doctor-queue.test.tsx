import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { DoctorQueue } from "../src/screens/doctor-queue";
import { SessionProvider, useSession } from "../src/session";

jest.mock("expo-secure-store", () => {
  // Keyed, like the real store: the consult screen keeps a visit's draft beside the session token.
  const m = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { m.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { m.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));

type Reply = { status: number; body?: unknown } | "offline";
type Route = (body: unknown) => Reply;

function server(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body);
    if (reply === "offline") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.consult", "opd.queue.read", "opd.queue.operate"], scoped: { department: {}, floor: {} } } };
const DOCTOR = { id: "d1", userId: "u1", displayName: "Dr. Chandan Kumar", code: "DR-0028", departmentId: "dep1", designation: "Assistant Professor" };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const entry = (tokenNo: number, over: Record<string, unknown> = {}, enc: Record<string, unknown> = {}, patient: Record<string, unknown> | null = {}) => ({
  id: `q${tokenNo}`, seq: tokenNo, sessionId: "s1", encounterId: `e${tokenNo}`, tokenNo, kind: "walk_in", appointmentAt: null, status: "waiting",
  danger: false, reEntry: false, perk: false, eligibleAt: minsAgo(10), calledAt: null, callCount: 0, skips: 0, doneAt: null, createdAt: minsAgo(20),
  parkedAt: null, parkedBy: null, skipReason: null, skipNote: null, skippedAt: null, position: null, queueClass: null,
  encounter: { id: `e${tokenNo}`, patientId: `p${tokenNo}`, visitType: "new", dangerFlagged: false, status: "waiting", referredFromEncounterId: null, feeBypassReason: null, consultFeeOverrideReason: null, ...enc },
  patient: patient === null ? null : { requestedId: `p${tokenNo}`, id: `p${tokenNo}`, uhid: `U0011${tokenNo}`, name: `Patient ${tokenNo}`, alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z", ...patient },
  feeStatus: "settled",
  ...over,
});
type Entry = ReturnType<typeof entry>;

function queue(over: Partial<{ ordered: Entry[]; current: Entry | null; inConsult: Entry[]; left: Entry[]; heldForPayment: Entry[]; waitingVitals: number; status: string; done: number }> = {}) {
  const ordered = (over.ordered ?? [entry(13, { eligibleAt: minsAgo(41), position: 1 }, { visitType: "revisit" }, { name: "Suresh Prasad" }), entry(14, { position: 2 }, {}, { name: "Meena Kumari", administrativeGender: "female", dob: "1993-01-01T00:00:00.000Z" })]);
  const current = over.current ?? null;
  const inConsult = over.inConsult ?? [];
  const left = over.left ?? [];
  const held = over.heldForPayment ?? [];
  return {
    session: { id: "s1", doctorId: "d1", serviceDate: "2026-10-06", roomId: "r1", status: over.status ?? "in" },
    doctor: DOCTOR, ordered, current, inConsult, left, heldForPayment: held, waitingVitals: over.waitingVitals ?? 2,
    counts: { waiting: ordered.length, called: current === null ? 0 : 1, inConsult: inConsult.length, done: over.done ?? 12, left: left.length, heldForPayment: held.length },
  };
}

const VITALS = {
  id: "v1", heightCm: null, weightKg: 71, sbp: 178, dbp: 106, pulse: 88, rr: 18, spo2: 97, tempC: 37.1, muacCm: null, notes: null,
  dangerFlags: [{ vital: "sbp", value: 178, bound: "max", limit: 160, severity: "notice" }], recordedAt: minsAgo(15), recordedByName: "Sr. Kavita", status: "active", emergency: false,
};
const visit = (id: string, over: Record<string, unknown> = {}, enc: Record<string, unknown> = {}) => ({
  encounter: { id, visitNo: "V2610060013", patientId: "p13", status: "waiting", serviceDate: "2026-10-06", visitType: "revisit", chiefComplaint: null, diagnosis: null, dangerFlagged: false, consultStartedAt: null, rxDraft: null, ...enc },
  feeUnpaid: false, feeBypass: null, deskComplaint: { text: "Pair mein jhunjhuni, do hafte se.", by: "Ramesh", at: minsAgo(60) },
  vitals: [VITALS], prescriptions: [], ...over,
});

/** A server whose line the tests move by hand: `state.q` is what `GET /opd/queues` answers next. */
function world(q = queue(), extra: Record<string, Route> = {}) {
  const state = { q: q as ReturnType<typeof queue> | { session: null } };
  const s = server({
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/me/doctor": () => ({ status: 200, body: DOCTOR }),
    "GET /roster/doctor-units": () => ({ status: 200, body: [{ userId: "u1", short: "Unit I" }] }),
    "GET /opd/config": () => ({ status: 200, body: { followUpDefaultDays: 7, followUpExtensionDays: [14, 30] } }),
    "GET /opd/queues": () => ({ status: 200, body: state.q }),
    "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13") }),
    "GET /patients/p13": () => ({ status: 200, body: { patient: { uhid: "U001113", name: "Suresh Prasad", alias: null, dob: "1970-03-11T00:00:00.000Z", administrativeGender: "male" } } }),
    "GET /patients/p13/allergies": () => ({ status: 200, body: { items: [{ id: "a1", substance: "Sulfa", severity: "severe", status: "active" }, { id: "a2", substance: "Dust", severity: null, status: "entered_in_error" }] } }),
    "GET /opd/patients/p13/timeline": () => ({ status: 200, body: { items: [
      { encounterId: "e13", serviceDate: "2026-10-06", status: "waiting", visitType: "revisit", doctorName: "Dr. Chandan Kumar", departmentName: "General Medicine", diagnosis: null, prescriptionLineCount: 0 },
      { encounterId: "e0", serviceDate: "2026-08-24", status: "completed", visitType: "new", doctorName: "Dr. Chandan Kumar", departmentName: "General Medicine", diagnosis: "Type 2 diabetes mellitus", prescriptionLineCount: 3 },
    ] } }),
    "GET /opd/patients/p13/prescriptions": () => ({ status: 200, body: { items: [{
      prescriptionId: "rx0", encounterId: "e0", serviceDate: "2026-08-24", issuedAt: "2026-08-24T06:00:00.000Z", doctorName: "Dr. Chandan Kumar", status: "active", version: 1,
      lines: [{ drug: "Metformin 1 g", dose: "1 tab", route: "oral", frequency: "twice a day", durationDays: 60, instructions: null }],
    }] } }),
    "GET /lab/results/patient/p13": () => ({ status: 200, body: { items: [{ orderableName: "HbA1c", analyteName: "HbA1c", value: "8.9", unit: "%", flag: "H", verifiedAt: "2026-09-19T06:00:00.000Z" }] } }),
    "GET /radiology/reports/patient/p13": () => ({ status: 200, body: { items: [] } }),
    "GET /pharmacy/doctor/patients/p13/dispenses": () => ({ status: 200, body: { items: [] } }),
    ...extra,
  });
  return { ...s, state };
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <DoctorQueue /> : null;
}
async function mount(fetcher: typeof fetch) {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

describe("the doctor's OPD line on a phone", () => {
  it("shows my line: the counts, my name with my unit, each row's age, visit kind and wait — the long wait said in words of minutes", async () => {
    const w = world();
    await mount(w.fetcher);
    expect(await screen.findByTestId("line-row-13")).toHaveTextContent(/Suresh Prasad · 56 M/);
    expect(screen.getByTestId("line-row-13")).toHaveTextContent(/Revisit · free follow-up/);
    expect(screen.getByTestId("line-row-14")).toHaveTextContent(/Meena Kumari · 33 F/);
    expect(screen.getByTestId("doctor-name")).toHaveTextContent("Dr. Chandan Kumar · Unit I · Asst. Prof.");
    expect(screen.getByTestId("stat-waiting")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-seen")).toHaveTextContent("12");
    expect(screen.getByTestId("wait-13")).toHaveTextContent("41 min");
    expect(screen.getByTestId("line-longest")).toHaveTextContent("Longest wait 41 min");
    expect(screen.getByTestId("line-vitals")).toHaveTextContent("2 still at vitals");
    // Only MY profile's line is asked for, for today.
    expect(w.of("GET /opd/queues").length).toBeGreaterThan(0);
  });

  it("a user with no doctor profile is told so (404 is an answer, not an error) and no line is asked for", async () => {
    const w = world(queue(), { "GET /opd/me/doctor": () => ({ status: 404, body: { message: "no OPD doctor profile for this user", code: "not_a_doctor" } }) });
    await mount(w.fetcher);
    expect(await screen.findByTestId("not-a-doctor")).toHaveTextContent(/no OPD doctor profile/);
    expect(w.of("GET /opd/queues")).toHaveLength(0);
  });

  it("a day with no session says so instead of an empty list", async () => {
    const w = world();
    w.state.q = { session: null };
    await mount(w.fetcher);
    expect(await screen.findByTestId("no-session")).toHaveTextContent(/No session open for you today/);
    expect(screen.queryByTestId("call-next")).toBeNull();
  });

  it("call next posts to MY session and says which token the server called", async () => {
    const w = world(queue(), {
      "POST /opd/queues/s1/call-next": () => {
        w.state.q = queue({ current: entry(13, { status: "called", calledAt: minsAgo(0), callCount: 1 }, { visitType: "revisit" }, { name: "Suresh Prasad" }), ordered: [entry(14, { position: 1 })] });
        return { status: 201, body: { entry: { id: "q13", tokenNo: 13 }, encounter: {} } };
      },
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("call-next"));
    expect(await screen.findByTestId("called-card")).toHaveTextContent(/Called · token 13/);
    expect(screen.getByTestId("line-flash")).toHaveTextContent("Token 13 called");
    // With a token called, the server would refuse another call — the button is off and says why.
    expect(screen.getByTestId("call-next")).toBeDisabled();
    expect(screen.getByTestId("call-hint")).toHaveTextContent("Token 13 is called — start or skip it first.");
  });

  it("the server's refusal of a call is shown in its own words, and the line is re-read", async () => {
    const w = world(queue(), { "POST /opd/queues/s1/call-next": () => ({ status: 409, body: { message: "a token is already called — start or skip it first", code: "call_conflict" } }) });
    await mount(w.fetcher);
    const before = () => w.of("GET /opd/queues").length;
    await fireEvent.press(await screen.findByTestId("call-next"));
    const n = before();
    expect(await screen.findByTestId("line-error")).toHaveTextContent("a token is already called — start or skip it first");
    expect(before()).toBeGreaterThanOrEqual(n);
  });

  it("skip asks WHY: the reason travels coded, 'other' needs its note, and a mis-skip can be taken back", async () => {
    const called = entry(13, { status: "called", calledAt: minsAgo(1), callCount: 1 }, {}, { name: "Suresh Prasad" });
    const w = world(queue({ current: called, ordered: [] }), {
      "POST /opd/queues/entries/q13/skip": () => { w.state.q = queue({ ordered: [], left: [entry(13, { status: "left", skips: 3, skipReason: "at_billing" })] }); return { status: 201, body: { entry: {} } }; },
      "POST /opd/queues/entries/q13/undo-skip": () => { w.state.q = queue({ ordered: [entry(13, { position: 1 })] }); return { status: 201, body: { entry: {} } }; },
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("called-skip"));
    expect(screen.getByTestId("skip-sheet")).toHaveTextContent(/Skip token 13/);
    // "Other" with no note never reaches the server.
    await fireEvent.press(screen.getByTestId("skip-reason-other"));
    await fireEvent.press(screen.getByTestId("skip-go"));
    expect(screen.getByTestId("sheet-error")).toHaveTextContent("Say what the reason was (required)");
    expect(w.of("POST /opd/queues/entries/q13/skip")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("skip-reason-at_billing"));
    await fireEvent.press(screen.getByTestId("skip-go"));
    await waitFor(() => expect(w.of("POST /opd/queues/entries/q13/skip")).toHaveLength(1));
    expect(w.of("POST /opd/queues/entries/q13/skip")[0]!.body).toEqual({ reason: "at_billing", note: null });
    // Three skips took the token out: it is NAMED, with the way back on its row.
    await fireEvent.press(await screen.findByTestId("left-undo-13"));
    expect(await screen.findByTestId("line-row-13")).toBeTruthy();
    expect(w.of("POST /opd/queues/entries/q13/undo-skip")).toHaveLength(1);
  });

  it("tokens waiting for the bill are listed apart, and the doctor opens one only with a reason", async () => {
    const held = entry(15, { feeStatus: "unsettled" }, { feeBypassReason: "came by ambulance" }, { name: "Ram Pravesh" });
    const w = world(queue({ heldForPayment: [held] }), {
      "POST /opd/visits/e15/consult/open-unpaid": () => ({ status: 201, body: { encounter: {} } }),
    });
    await mount(w.fetcher);
    expect(await screen.findByTestId("held-row-15")).toHaveTextContent(/Ram Pravesh/);
    expect(screen.getByTestId("held-row-15")).toHaveTextContent(/NOT PAID/);
    expect(screen.getByTestId("held-group")).toHaveTextContent(/Waiting for the bill \(1\)/);
    await fireEvent.press(screen.getByTestId("held-open-15"));
    await fireEvent.press(screen.getByTestId("unpaid-go"));
    expect(screen.getByTestId("sheet-error")).toHaveTextContent("Write the reason first.");
    expect(w.of("POST /opd/visits/e15/consult/open-unpaid")).toHaveLength(0);
    await fireEvent.changeText(screen.getByTestId("unpaid-reason"), "elderly, cannot stand in the queue");
    await fireEvent.press(screen.getByTestId("unpaid-go"));
    await waitFor(() => expect(w.of("POST /opd/visits/e15/consult/open-unpaid")).toHaveLength(1));
    expect(w.of("POST /opd/visits/e15/consult/open-unpaid")[0]!.body).toEqual({ reason: "elderly, cannot stand in the queue" });
  });

  it("the brief: allergy first, the patient's own words, today's vitals with the bay's flag as a word, results since, the last prescription, past visits", async () => {
    const w = world();
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-name")).toHaveTextContent(/Suresh Prasad\s+56 M/);
    await waitFor(() => expect(screen.getByTestId("brief-allergy")).toHaveTextContent("Allergy: Sulfa (severe)"));
    // An allergy struck as entered-in-error is not an allergy.
    expect(screen.getByTestId("brief-allergy")).not.toHaveTextContent(/Dust/);
    expect(screen.getByTestId("brief-why")).toHaveTextContent(/Pair mein jhunjhuni, do hafte se\./);
    expect(screen.getByTestId("brief-why")).toHaveTextContent(/Typed by Ramesh/);
    expect(screen.getByTestId("brief-vital-bp")).toHaveTextContent(/178\/106/);
    expect(screen.getByTestId("brief-flag-bp")).toHaveTextContent("HIGH");
    expect(screen.queryByTestId("brief-flag-pulse")).toBeNull();
    expect(screen.getByTestId("brief-result-0")).toHaveTextContent(/HbA1c 8\.9 %/);
    expect(screen.getByTestId("brief-rx")).toHaveTextContent(/Metformin 1 g/);
    expect(screen.getByTestId("brief-refill")).toHaveTextContent("Pharmacy: not bought at this hospital's pharmacy");
    expect(screen.getByTestId("brief-visits")).toHaveTextContent(/Type 2 diabetes mellitus/);
    // Today's own visit is not listed among the PAST visits.
    expect(screen.getByTestId("brief-visits")).not.toHaveTextContent(/06-Oct-2026/);
  });

  it("a sealed record shows its alias and no demographics, allergies, prescriptions or papers", async () => {
    const sealed = entry(13, { position: 1 }, {}, { name: null, alias: "Patient K-7", restricted: true });
    const w = world(queue({ ordered: [sealed] }), { "GET /patients/p13": () => ({ status: 404, body: { message: "not_found" } }) });
    await mount(w.fetcher);
    expect(await screen.findByTestId("line-row-13")).toHaveTextContent(/Patient K-7/);
    expect(screen.getByTestId("line-row-13")).not.toHaveTextContent(/56 M/);
    await fireEvent.press(screen.getByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-sealed")).toHaveTextContent("Restricted record — identity hidden");
    expect(screen.getByTestId("brief-name")).toHaveTextContent("Patient K-7");
    expect(screen.queryByTestId("brief-allergy")).toBeNull();
    expect(screen.queryByTestId("brief-rx")).toBeNull();
    expect(screen.queryByTestId("brief-papers")).toBeNull();
  });

  it("a block the login may not read is absent, with one line saying parts are hidden — never an error", async () => {
    const w = world(queue(), {
      "GET /lab/results/patient/p13": () => ({ status: 403, body: { message: "forbidden" } }),
      "GET /radiology/reports/patient/p13": () => ({ status: 403, body: { message: "forbidden" } }),
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-hidden")).toBeTruthy();
    expect(screen.queryByTestId("brief-results")).toBeNull();
    expect(screen.queryByTestId("brief-error")).toBeNull();
  });

  it("filed papers are not read until asked for, and a page opens large with zoom", async () => {
    const w = world(queue(), {
      "GET /patients/p13/documents": () => ({ status: 200, body: { items: [{ id: "doc1", encounterId: "e0", kind: "prescription", mimeType: "image/jpeg", byteSize: 90_000, note: null, capturedAt: "2026-08-24T07:00:00.000Z" }] } }),
      "GET /patients/documents/doc1": () => ({ status: 200, body: { mimeType: "image/jpeg", imageBase64: "AAAA" } }),
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    await screen.findByTestId("brief-papers-show");
    expect(w.of("GET /patients/p13/documents")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("brief-papers-show"));
    await fireEvent.press(await screen.findByTestId("brief-paper-doc1"));
    expect(await screen.findByTestId("paper-viewer")).toBeTruthy();
    expect(w.of("GET /patients/documents/doc1")).toHaveLength(1);
    expect(screen.getByTestId("paper-zoom")).toHaveTextContent("100%");
    await fireEvent.press(screen.getByTestId("paper-zoom-in"));
    expect(screen.getByTestId("paper-zoom")).toHaveTextContent("150%");
    await fireEvent.press(screen.getByTestId("paper-close"));
    expect(screen.queryByTestId("paper-viewer")).toBeNull();
  });

  it("start → complete on paper: the completion sends NO note, the default follow-up is left out of the body, and the line follows", async () => {
    const called = entry(13, { status: "called", calledAt: minsAgo(1), callCount: 1 }, { visitType: "revisit" }, { name: "Suresh Prasad" });
    const w = world(queue({ current: called, ordered: [entry(14, { position: 1 })] }), {
      "POST /opd/visits/e13/consult/start": () => {
        w.state.q = queue({ inConsult: [entry(13, { status: "in_consult" }, { status: "in_consultation" }, { name: "Suresh Prasad" })], ordered: [entry(14, { position: 1 })] });
        return { status: 201, body: { encounter: {}, queueEntry: {} } };
      },
      "POST /opd/visits/e13/consult/complete": () => { w.state.q = queue({ ordered: [entry(14, { position: 1 })], done: 13 }); return { status: 201, body: { encounter: {} } }; },
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("called-start"));
    // Started: the consultation opens on that patient (decision 0048). Paper is one tap, and Park is under the visit.
    expect(await screen.findByTestId("issue-complete")).toBeTruthy();
    expect(screen.getByTestId("consult-park")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("wrote-on-paper"));
    expect(await screen.findByTestId("complete-sheet")).toHaveTextContent(/Complete · token 13/);
    expect(screen.getByTestId("follow-default")).toHaveTextContent("7 days (default)");
    await fireEvent.press(screen.getByTestId("complete-go"));
    await waitFor(() => expect(w.of("POST /opd/visits/e13/consult/complete")).toHaveLength(1));
    expect(w.of("POST /opd/visits/e13/consult/complete")[0]!.body).toEqual({ testsOrderedReturnToday: false });
    // Back on the line, which the server has moved on.
    expect(await screen.findByTestId("line-flash")).toHaveTextContent("Token 13 completed");
    expect(screen.getByTestId("stat-seen")).toHaveTextContent("13");
    expect(screen.queryByTestId("with-row-13")).toBeNull();
  });

  it("a chosen extension travels as its number; 'tests ordered — returns today' travels with no follow-up at all", async () => {
    const inside = entry(13, { status: "in_consult" }, { status: "in_consultation" }, { name: "Suresh Prasad" });
    const w = world(queue({ inConsult: [inside], ordered: [] }), {
      "POST /opd/visits/e13/consult/complete": () => ({ status: 201, body: { encounter: {} } }),
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("with-row-13-open"));
    await fireEvent.press(await screen.findByTestId("wrote-on-paper"));
    await fireEvent.press(await screen.findByTestId("follow-14"));
    await fireEvent.press(screen.getByTestId("complete-go"));
    await waitFor(() => expect(w.of("POST /opd/visits/e13/consult/complete")).toHaveLength(1));
    expect(w.of("POST /opd/visits/e13/consult/complete")[0]!.body).toEqual({ testsOrderedReturnToday: false, followUpDays: 14 });
  });

  it("medicines typed on the computer and not issued are SHOWN on the phone — paper asks before dropping them, and nothing completes until the doctor says so", async () => {
    const inside = entry(13, { status: "in_consult" }, { status: "in_consultation" }, { name: "Suresh Prasad" });
    const w = world(queue({ inConsult: [inside], ordered: [] }), {
      "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13", {}, { status: "in_consultation", rxDraft: [{ drug: "Metformin 1 g" }, { drug: "" }, { drug: "Telmisartan 40 mg" }] }) }),
      "PUT /opd/visits/e13/consult/note": () => ({ status: 200, body: { encounter: {} } }),
      "POST /opd/visits/e13/consult/complete": () => ({ status: 201, body: { encounter: {} } }),
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("with-row-13-open"));
    // The two named rows are on this visit's card (the blank editor row is not a medicine), each saying what it lacks.
    expect(await screen.findByTestId("visit-line-1")).toHaveTextContent(/Telmisartan 40 mg/);
    expect(screen.getByTestId("visit-line-0")).toHaveTextContent(/needs a dose and how often/);
    await fireEvent.press(screen.getByTestId("wrote-on-paper"));
    expect(await screen.findByTestId("paper-ask")).toHaveTextContent("2 medicines typed here will NOT be issued — the paper is the prescription. Tap again to go on.");
    expect(screen.queryByTestId("complete-sheet")).toBeNull();
    expect(w.of("PUT /opd/visits/e13/consult/note")).toHaveLength(0);
    expect(w.of("POST /opd/visits/e13/consult/complete")).toHaveLength(0);
    // Said twice: the typed rows are withdrawn on the server, then the paper road's own completion opens.
    await fireEvent.press(screen.getByTestId("wrote-on-paper"));
    await waitFor(() => expect(w.of("PUT /opd/visits/e13/consult/note")).toHaveLength(1));
    expect(w.of("PUT /opd/visits/e13/consult/note")[0]!.body).toEqual({ rxDraft: [] });
  });

  it("a completion that never reached the server is NOT shown as done: the patient stays with me and the phone says the server was not reached", async () => {
    const inside = entry(13, { status: "in_consult" }, { status: "in_consultation" }, { name: "Suresh Prasad" });
    const w = world(queue({ inConsult: [inside], ordered: [] }), { "POST /opd/visits/e13/consult/complete": () => "offline" });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("with-row-13-open"));
    await fireEvent.press(await screen.findByTestId("wrote-on-paper"));
    await fireEvent.press(await screen.findByTestId("complete-go"));
    expect(await screen.findByTestId("consult-line-error")).toHaveTextContent(/The server could not be reached/);
    expect(screen.queryByTestId("line-flash")).toBeNull();
    expect(screen.getByTestId("issue-complete")).toBeTruthy();
  });

  it("park and resume: a parked patient is shown as parked, with one way back in", async () => {
    const inside = entry(13, { status: "in_consult" }, { status: "in_consultation" }, { name: "Suresh Prasad" });
    const w = world(queue({ inConsult: [inside], ordered: [] }), {
      "POST /opd/visits/e13/consult/park": () => { w.state.q = queue({ inConsult: [entry(13, { status: "in_consult", parkedAt: minsAgo(0) }, { status: "in_consultation" }, { name: "Suresh Prasad" })], ordered: [] }); return { status: 201, body: {} }; },
      "POST /opd/visits/e13/consult/resume": () => { w.state.q = queue({ inConsult: [inside], ordered: [] }); return { status: 201, body: {} }; },
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("with-row-13-open"));
    await fireEvent.press(await screen.findByTestId("consult-park"));
    expect(await screen.findByTestId("with-state-13")).toHaveTextContent("Parked just now");
    await fireEvent.press(screen.getByTestId("with-row-13-open"));
    await fireEvent.press(await screen.findByTestId("act-resume"));
    expect(await screen.findByTestId("issue-complete")).toBeTruthy();
    expect(w.of("POST /opd/visits/e13/consult/resume")).toHaveLength(1);
  });

  it("a waiting patient who is not next can be started ahead of the line — said as such; the head of the line is simply started", async () => {
    const w = world(queue(), { "POST /opd/visits/e14/consult/start": () => ({ status: 201, body: {} }) });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-14-open"));
    expect(await screen.findByTestId("act-start")).toHaveTextContent("Start now, ahead of the line");
    await fireEvent.press(screen.getByTestId("brief-back"));
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("act-start")).toHaveTextContent("Start consultation");
  });

  it("stepping out is said to the server, and while out nobody can be called", async () => {
    const w = world(queue(), { "POST /opd/queues/s1/status": (b) => { w.state.q = queue({ status: (b as { status: string }).status }); return { status: 201, body: { session: {} } }; } });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("session-toggle"));
    expect(await screen.findByTestId("out-hint")).toBeTruthy();
    expect(w.of("POST /opd/queues/s1/status")[0]!.body).toEqual({ status: "out" });
    expect(screen.getByTestId("call-next")).toBeDisabled();
    expect(screen.getByTestId("session-status")).toHaveTextContent(/You are out/i);
  });

  it("when a re-read fails the last line stays, stamped with its time", async () => {
    const w = world();
    await mount(w.fetcher);
    await screen.findByTestId("line-row-13");
    // The next reads never arrive.
    (w.fetcher as unknown as jest.Mock).mockImplementation(async () => { throw new TypeError("Network request failed"); });
    await fireEvent.press(screen.getByTestId("call-next"));
    expect(await screen.findByTestId("line-stale")).toHaveTextContent(/No connection — showing the list as of/);
    expect(screen.getByTestId("line-row-13")).toBeTruthy();
  });

  it("in Hindi", async () => {
    const w = world();
    await mount(w.fetcher);
    await screen.findByTestId("line-row-13");
    await fireEvent.press(screen.getByTestId("lang-toggle"));
    expect(screen.getByTestId("line-longest")).toHaveTextContent("सबसे लंबी प्रतीक्षा 41 मिनट");
  });
});
