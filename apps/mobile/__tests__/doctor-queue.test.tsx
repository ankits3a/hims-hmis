import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
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
  id: "v1", heightCm: null, weightKg: 71, sbp: 178, dbp: 106, pulse: 88, rr: 18, spo2: 97, tempC: 37.1, muacCm: null, notes: null, glucoseMgDl: 186, glucoseTiming: "random",
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
    expect(screen.getByTestId("line-row-13")).toHaveTextContent(/Revisit · follow-up/);
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

  it("TELE-CALL (owner 2026-10-09): the row shows its SLOT TIME where the token sits and a phone ICON named Tele-call — no word, and never a money mark", async () => {
    const w = world(queue({ ordered: [
      entry(13, { position: 1, tele: true, kind: "appointment", appointmentAt: "2026-10-06T05:50:00.000Z", feeStatus: null }, {}, { name: "Meena Kumari", administrativeGender: "female", dob: "1993-01-01T00:00:00.000Z" }),
      entry(14, { position: 2 }, {}, { name: "Suresh Prasad" }),
    ] }));
    await mount(w.fetcher);
    const tele = await screen.findByTestId("line-row-13");
    expect(screen.getByTestId("line-row-13-slot")).toHaveTextContent("11:20");
    expect(within(tele).getByLabelText("Tele-call").props).toMatchObject({ accessibilityRole: "image", testID: "line-row-13-tele" });
    expect(tele).not.toHaveTextContent(/tele|paid|unpaid|fee|₹/i);
    expect(tele).not.toHaveTextContent(/^13/);
    // an ordinary row beside it is exactly what it was
    expect(screen.getByTestId("line-row-14")).toHaveTextContent(/^14/);
    expect(screen.queryByTestId("line-row-14-tele")).toBeNull();
    expect(screen.queryByTestId("line-row-14-slot")).toBeNull();
  });

  it("TELE-CALL: the patient page shows the phone card — Tele-call and the slot — no vitals block, and no money word", async () => {
    const w = world(queue({ ordered: [entry(13, { position: 1, tele: true, kind: "appointment", appointmentAt: "2026-10-06T05:50:00.000Z", feeStatus: null }, {}, { name: "Meena Kumari" })] }), {
      "GET /opd/visits/e13": () => {
        const v = visit("e13", { vitals: [], teleSlotAt: "2026-10-06T05:50:00.000Z" }, { consultMode: "tele", teleOutcome: null, teleNoAnswerCount: 0 }) as Record<string, unknown>;
        delete v.feeUnpaid; delete v.feeBypass;
        return { status: 200, body: v };
      },
    });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-tele")).toHaveTextContent(/Tele-call.*11:20/);
    expect(screen.queryByTestId("brief-vitals-card")).toBeNull();
    expect(screen.queryByTestId("brief-unpaid")).toBeNull();
    expect(screen.getByTestId("brief-who")).not.toHaveTextContent(/paid|unpaid|fee|₹/i);
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
    // Owner 2026-10-08 — the bay's finger-prick glucose with when it was taken, and no verdict on it
    expect(screen.getByTestId("brief-vital-glucose")).toHaveTextContent(/Glucose\s*186 mg\/dL\s*Random/);
    expect(screen.getByTestId("brief-result-0")).toHaveTextContent(/HbA1c 8\.9 %/);
    expect(screen.getByTestId("brief-rx")).toHaveTextContent(/Metformin 1 g/);
    expect(screen.getByTestId("brief-refill")).toHaveTextContent("Pharmacy: not bought at this hospital's pharmacy");
    expect(screen.getByTestId("brief-visits")).toHaveTextContent(/Type 2 diabetes mellitus/);
    // Today's own visit is not listed among the PAST visits.
    expect(screen.getByTestId("brief-visits")).not.toHaveTextContent(/06-Oct-2026/);
  });

  // ——— owner 2026-10-09: the guardian came alone, and what the doctor recorded last time ———
  const GUARDIAN = { relation: "son", name: "Rakesh", by: "asha.devi", at: minsAgo(30) };
  const LAST = (enc: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
    encounter: {
      id: "e0", visitNo: "V2608240007", patientId: "p13", status: "completed", serviceDate: "2026-08-24", visitType: "new",
      chiefComplaint: "Tingling in both feet · worse at night", diagnosis: "Type 2 diabetes mellitus", dangerFlagged: false, consultStartedAt: null,
      advisedTests: [{ serviceId: "s1", code: "HBA1C", name: "HbA1c", pricePaise: 40000 }, { serviceId: "s2", code: "LIPID", name: "Lipid profile", pricePaise: 60000 }],
      ...enc,
    },
    deskComplaint: { text: "Pair mein jhunjhuni", by: "Ramesh", at: "2026-08-24T04:00:00.000Z" },
    vitals: [],
    prescriptions: [
      { id: "rx0", status: "active", lines: [{ drug: "Metformin 1 g", dose: "1 tab" }, { drug: "Glimepiride 1 mg", dose: "1 tab" }] },
      { id: "rxOld", status: "superseded", lines: [{ drug: "Struck-out drug" }] },
    ],
    ...over,
  });
  const guardianLine = () => queue({ ordered: [entry(13, { position: 1 }, { visitType: "revisit", patientAbsent: GUARDIAN }, { name: "Suresh Prasad" })] });

  it("a guardian-only revisit: a chip on the line, a boxed card under the name, no vitals block, and the last visit as the doctor recorded it", async () => {
    const w = world(guardianLine(), {
      "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13", { vitals: [], patientAbsent: GUARDIAN }) }),
      "GET /opd/visits/e0": () => ({ status: 200, body: LAST() }),
    });
    await mount(w.fetcher);
    // The row says who, not the name — the name is on the card.
    expect(await screen.findByTestId("line-guardian-13")).toHaveTextContent("Guardian · Son");
    expect(screen.getByTestId("line-row-13")).not.toHaveTextContent(/Rakesh/);
    await fireEvent.press(screen.getByTestId("line-row-13-open"));
    const card = await screen.findByTestId("brief-patient-absent");
    expect(card).toHaveTextContent(/Guardian only/);
    // Two pieces on one line (the name may give way, the fixed words never): read together they are the brief's sentence.
    expect(card.props.accessibilityLabel).toBe("Guardian only. Son: Rakesh · reports · no vitals");
    expect(card).toHaveTextContent(/Son: Rakesh/);
    expect(card).toHaveTextContent(/· reports · no vitals/);
    expect(card).not.toHaveTextContent(/Patient absent/);
    const last = await screen.findByTestId("brief-last-visit");
    expect(last).toHaveTextContent(/Last visit · 24 Aug/);
    expect(last).toHaveTextContent(/Dr\. Chandan Kumar/);
    expect(screen.getByTestId("brief-last-complaint")).toHaveTextContent("ComplaintTingling in both feet · worse at night");
    expect(screen.getByTestId("brief-last-diagnosis")).toHaveTextContent("DiagnosisType 2 diabetes mellitus");
    expect(screen.getByTestId("brief-last-tests")).toHaveTextContent("TestsHbA1c, Lipid profile");
    expect(screen.getByTestId("brief-last-medicines")).toHaveTextContent("MedicinesMetformin 1 g, Glimepiride 1 mg");
    expect(last).not.toHaveTextContent(/Struck-out|1 tab/);
    // The card's "no vitals" says it: no heading, no "not charted" line.
    await waitFor(() => expect(screen.getByTestId("brief-why")).toHaveTextContent(/Pair mein jhunjhuni/));
    expect(screen.queryByTestId("brief-vitals-card")).toBeNull();
    expect(screen.queryByTestId("brief-vitals-none")).toBeNull();
  });

  it("a guardian-only visit that somehow has a chart shows it: a recorded value is never hidden", async () => {
    const w = world(guardianLine(), { "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13", { patientAbsent: GUARDIAN }) }) });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-patient-absent")).toHaveTextContent(/Guardian only/);
    expect(await screen.findByTestId("brief-vital-bp")).toHaveTextContent(/178\/106/);
  });

  it("a NEW patient's guardian visit (owner 2026-10-09): the same boxed card saying 'new', the same chip, no vitals block and no last-visit card", async () => {
    const w = world(queue({ ordered: [entry(13, { position: 1 }, { visitType: "new", patientAbsent: GUARDIAN }, { name: "Suresh Prasad" })] }), {
      "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13", { vitals: [], patientAbsent: GUARDIAN }, { visitType: "new" }) }),
      "GET /opd/patients/p13/timeline": () => ({ status: 200, body: { items: [] } }),
    });
    await mount(w.fetcher);
    expect(await screen.findByTestId("line-guardian-13")).toHaveTextContent("Guardian · Son");
    await fireEvent.press(screen.getByTestId("line-row-13-open"));
    const card = await screen.findByTestId("brief-patient-absent");
    expect(card.props.accessibilityLabel).toBe("Guardian only. Son: Rakesh · new · no vitals");
    expect(card).not.toHaveTextContent(/reports/);
    await waitFor(() => expect(screen.getByTestId("brief-why")).toHaveTextContent(/Pair mein jhunjhuni/));
    expect(screen.queryByTestId("brief-vitals-card")).toBeNull();
    expect(screen.queryByTestId("brief-last-visit")).toBeNull();
  });

  it("an ordinary revisit with no chart keeps today's line, and has no guardian card", async () => {
    const w = world(queue(), { "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13", { vitals: [] }) }) });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-vitals-none")).toHaveTextContent("Vitals are not charted for this visit.");
    expect(screen.queryByTestId("brief-patient-absent")).toBeNull();
    expect(screen.queryByTestId("line-guardian-13")).toBeNull();
  });

  it("the last visit's complaint falls back to that visit's front-desk words when the doctor recorded none; empty rows say —", async () => {
    const w = world(queue(), { "GET /opd/visits/e0": () => ({ status: 200, body: LAST({ chiefComplaint: null, advisedTests: null }, { prescriptions: [] }) }) });
    await mount(w.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-last-complaint")).toHaveTextContent("ComplaintPair mein jhunjhuni");
    expect(screen.getByTestId("brief-last-tests")).toHaveTextContent("Tests—");
    expect(screen.getByTestId("brief-last-medicines")).toHaveTextContent("Medicines—");
  });

  it("no last-visit card for a new patient, for a history the login may not read, or for a visit the server will not open", async () => {
    // A new visit: nothing is even asked for.
    const fresh = world(queue({ ordered: [entry(13, { position: 1 }, { visitType: "new" }, { name: "Suresh Prasad" })] }), {
      "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13", {}, { visitType: "new" }) }),
      "GET /opd/visits/e0": () => ({ status: 200, body: LAST() }),
    });
    const a = await mount(fresh.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    await waitFor(() => expect(screen.getByTestId("brief-visits")).toHaveTextContent(/Type 2 diabetes mellitus/));
    expect(screen.queryByTestId("brief-last-visit")).toBeNull();
    expect(fresh.of("GET /opd/visits/e0")).toHaveLength(0);
    await a.unmount();

    // The timeline is refused: the same rule that hides "Past visits" hides the card.
    const hidden = world(queue(), {
      "GET /opd/patients/p13/timeline": () => ({ status: 403, body: { message: "forbidden" } }),
      "GET /opd/visits/e0": () => ({ status: 200, body: LAST() }),
    });
    const b = await mount(hidden.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    expect(await screen.findByTestId("brief-hidden")).toBeTruthy();
    expect(screen.queryByTestId("brief-last-visit")).toBeNull();
    expect(hidden.of("GET /opd/visits/e0")).toHaveLength(0);
    await b.unmount();

    // The earlier visit answers 404 (sealed, or gone): no card and no error.
    const sealedVisit = world(queue());
    await mount(sealedVisit.fetcher);
    await fireEvent.press(await screen.findByTestId("line-row-13-open"));
    await waitFor(() => expect(sealedVisit.of("GET /opd/visits/e0")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("brief-visits")).toHaveTextContent(/Type 2 diabetes mellitus/));
    expect(screen.queryByTestId("brief-last-visit")).toBeNull();
    expect(screen.queryByTestId("brief-error")).toBeNull();
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
