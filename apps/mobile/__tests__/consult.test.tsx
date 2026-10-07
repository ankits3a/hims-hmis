import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { doctorApi } from "../src/doctor/api";
import { draftStore } from "../src/consult/draft";
import { I18nProvider } from "../src/i18n";
import { ConsultScreen } from "../src/screens/consult";
import { SessionProvider, useSession } from "../src/session";

const mockStore = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" })]]);
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
const mockRecorder = { allow: jest.fn(async () => true), start: jest.fn(async () => undefined), take: jest.fn(async (seconds: number) => ({ audio: "QUJD", mimeType: "audio/mp4", seconds })), discard: jest.fn(async () => undefined) };
jest.mock("../src/consult/recorder", () => ({ useVoiceRecorder: () => mockRecorder }));

type Reply = { status: number; body?: unknown } | "offline";
type Route = (body: unknown, url: string) => Reply;
function server(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown; url: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    if (reply === "offline") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.consult"], scoped: { department: {}, floor: {} } } };
const VISIT = {
  encounter: { id: "e13", visitNo: "V2610070013", patientId: "p13", status: "in_consultation", serviceDate: "2026-10-07", visitType: "revisit", chiefComplaint: null, doctorNote: null, diagnosis: null, advice: null, advisedTests: null, dangerFlagged: false, consultStartedAt: "2026-10-07T05:00:00.000Z", rxDraft: null },
  feeUnpaid: false, feeBypass: null, deskComplaint: { text: "bukhar 3 din se, khansi", by: "Asha", at: "2026-10-07T04:30:00.000Z" },
  vitals: [{ id: "v1", heightCm: null, weightKg: 62, sbp: 150, dbp: 90, pulse: 88, rr: null, spo2: 97, tempC: 38.4, muacCm: null, notes: null, dangerFlags: [], recordedAt: "2026-10-07T04:40:00.000Z", status: "active" }],
  prescriptions: [] as { id: string; status: string }[],
};
const PARA = { id: "m-para", name: "Paracetamol 500 mg Tablet", form: "tablet", strength: "500 mg", code: "D0001", routeClass: "systemic", salts: ["paracetamol"], prefix: true, reviewed: true };
const AMOX = { id: "m-amox", name: "Amoxicillin 500 mg Capsule", form: "capsule", strength: "500 mg", code: "D0002", routeClass: "systemic", salts: ["amoxicillin"], prefix: true, reviewed: true };
const HYDROX = { id: "m-hz", name: "Hydroxyzine 25 mg Tablet", form: "tablet", strength: "25 mg", code: "D0003", routeClass: "systemic", salts: ["hydroxyzine"], prefix: true, reviewed: true, drugClass: "Antihistamine", lasa: "hydralazine" };
const CLEAN = { allergyMatches: [], interactions: [], duplicates: [], drugDisease: [], notices: [], unresolvedLineIndexes: [] };
const SUMMARY = { requestedId: "p13", id: "p13", uhid: "U0011013", name: "Suresh Prasad", alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z" };

function world(extra: Record<string, Route> = {}) {
  const state = { visit: JSON.parse(JSON.stringify(VISIT)) as typeof VISIT };
  const s = server({
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/visits/e13": () => ({ status: 200, body: state.visit }),
    "GET /patients/p13/allergies": () => ({ status: 200, body: { items: [{ id: "a1", substance: "Penicillin", severity: "severe", status: "active" }] } }),
    "GET /opd/patients/p13/prescriptions": () => ({ status: 200, body: { items: [{ prescriptionId: "rx0", encounterId: "e0", serviceDate: "2026-09-12", issuedAt: "2026-09-12T06:00:00.000Z", status: "active", lines: [
      { drug: "Amlodipine 5 mg Tablet", dose: "1 tab", route: "oral", frequency: "OD", durationDays: 15, instructions: null },
      { drug: "Metformin 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "BD", durationDays: 30, instructions: "after food" },
    ] }] } }),
    "GET /opd/rx-sets": () => ({ status: 200, body: { headOf: [], departmentId: "dep1", items: [
      { id: "s1", scope: "doctor", name: "Viral fever", mine: true, signed: false, signedByName: null, signedAt: null, maySign: false, departmentId: null, departmentName: null,
        body: { lines: [{ drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", medicineId: "m-para" }], tests: [], advice: "Plenty of fluids, rest", reviewDays: 5 } },
      { id: "s2", scope: "department", name: "URTI — adult", mine: false, signed: true, signedByName: "Dr. Chandan Kumar", signedAt: "2026-10-01T00:00:00.000Z", maySign: false, departmentId: "dep1", departmentName: "General Medicine",
        body: { lines: [], tests: [], advice: "Steam inhalation", reviewDays: null } },
    ] } }),
    "GET /opd/consult/medicines": (_b, url) => ({ status: 200, body: { items: /q=amox/.test(url) ? [AMOX] : /q=hydrox/.test(url) ? [HYDROX] : /q=zzz/.test(url) ? [] : [PARA] } }),
    "POST /opd/consult/signals": () => ({ status: 201, body: { misses: 0, suggestions: 0 } }),
    "POST /opd/visits/e13/rx-precheck": () => ({ status: 200, body: CLEAN }),
    "PUT /opd/visits/e13/consult/note": () => ({ status: 200, body: { encounter: {} } }),
    "POST /opd/visits/e13/prescriptions": () => { state.visit.prescriptions = [{ id: "rx1", status: "active" }]; return { status: 201, body: { prescriptionId: "rx1", version: 1 } }; },
    "POST /opd/visits/e13/consult/complete": () => ({ status: 201, body: { encounter: {} } }),
    "GET /opd/consult/my-diagnoses": () => ({ status: 200, body: { items: [{ text: "Acute upper respiratory infection", icd10Code: "J06.9", uses: 41 }] } }),
    "GET /opd/cds/complete/complaint": () => ({ status: 200, body: { items: [], ghost: null } }),
    "GET /opd/consult/voice/status": () => ({ status: 200, body: { enabled: true, configured: true, model: "gpt-4o-transcribe", maxSeconds: 60, usedSecondsToday: 0, dailyMinutesCap: 120, why: null } }),
    "GET /opd/advice-templates": () => ({ status: 200, body: { items: [] } }),
    ...extra,
  });
  return { ...s, state };
}

function Host({ onDone, onPaper }: { onDone: (line: string) => void; onPaper: () => void }) {
  const { call, state } = useSession();
  if (state.status !== "signedIn") return null;
  return <ConsultScreen doctorApi={doctorApi(call)} encounterId="e13" patientId="p13" tokenNo={13} entry={null} summary={SUMMARY as never}
    cfg={{ followUpDefaultDays: 7, followUpExtensionDays: [14] }} onDone={onDone} onPaper={onPaper} onHistory={() => undefined} onPark={() => undefined} parkBusy={false} />;
}
async function mount(w: ReturnType<typeof world>) {
  const onDone = jest.fn();
  const onPaper = jest.fn();
  const view = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={w.fetcher}><Host onDone={onDone} onPaper={onPaper} /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
  return { ...view, onDone, onPaper };
}
const press = async (id: string): Promise<void> => { await fireEvent.press(screen.getByTestId(id)); };
const type = async (id: string, text: string): Promise<void> => { await fireEvent.changeText(screen.getByTestId(id), text); };

/** Adds one medicine through the drawer: search, pick, three chips, add. */
async function addMedicine(query: string, hitId: string): Promise<void> {
  await press("open-meds");
  const input = await screen.findByTestId("med-input");
  await fireEvent.changeText(input, query);
  await fireEvent.press(await screen.findByTestId(`med-hit-${hitId}`));
  await press(hitId === "m-amox" ? "dose-1 cap" : "dose-1 tab"); await press("freq-TDS"); await press("days-5");
  await press("line-add");
}

beforeEach(() => {
  mockStore.clear();
  mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" }));
  jest.clearAllMocks();
});

describe("the doctor's consultation on the phone (decision 0048)", () => {
  it("opens calm: the patient, the allergy, the desks' words, an empty visit — and nothing to issue yet", async () => {
    const w = world();
    await mount(w);
    expect(await screen.findByTestId("visit-empty")).toBeTruthy();
    expect(screen.getByTestId("consult-name")).toHaveTextContent("Suresh Prasad");
    expect(screen.getByTestId("consult-allergy")).toHaveTextContent("Allergy · Penicillin");
    expect(screen.getByTestId("consult-desk-words")).toHaveTextContent(/bukhar 3 din se/);
    expect(screen.getByTestId("consult-vitals")).toHaveTextContent(/BP 150\/90/);
    for (const k of ["notes", "dx", "meds", "tests", "advice"]) expect(screen.getByTestId(`open-${k}`)).toBeTruthy();
    expect(screen.getByTestId("issue-complete").props.accessibilityState.disabled).toBe(true);
    // No print anywhere on this screen (owner 2026-10-07).
    expect(screen.queryByText(/print/i)).toBeNull();
  });

  it("a medicine is searched, built from chips, checked by the server, issued and the visit completed — then straight back to the line", async () => {
    const w = world();
    const m = await mount(w);
    await screen.findByTestId("visit-empty");
    await addMedicine("para", "m-para");
    await press("meds-drawer-done");
    await waitFor(() => expect(w.of("POST /opd/visits/e13/rx-precheck").length).toBeGreaterThan(0));
    expect(screen.getByTestId("visit-line-0")).toHaveTextContent(/Paracetamol 500 mg Tablet · 1 tab · TDS · 5 days/);
    await press("issue-complete");
    await waitFor(() => expect(m.onDone).toHaveBeenCalledTimes(1));
    const issued = w.of("POST /opd/visits/e13/prescriptions")[0]!.body as { lines: Record<string, unknown>[] };
    expect(issued.lines).toEqual([{ drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false, medicineId: "m-para", source: "search" }]); // where the line came from rides the issue, for audit
    const done = w.of("POST /opd/visits/e13/consult/complete")[0]!.body as { note: { rxDraft: unknown; diagnoses: unknown }; testsOrderedReturnToday: boolean; followUpDays?: number };
    // The completion NAMES the draft as gone — which is what tells the server nothing was left behind.
    expect(done.note.rxDraft).toBeNull();
    expect(done.testsOrderedReturnToday).toBe(false);
    expect(done.followUpDays).toBeUndefined();
    expect(m.onDone.mock.calls[0]![0]).toBe("#13 issued and completed · 1 medicine to the pharmacy");
    // The order on the wire: the note, the prescription, the completion.
    const order = w.calls.map((c) => c.key).filter((k) => /consult\/note|prescriptions$|consult\/complete/.test(k) && !k.startsWith("GET"));
    expect(order.slice(-3)).toEqual(["PUT /opd/visits/e13/consult/note", "POST /opd/visits/e13/prescriptions", "POST /opd/visits/e13/consult/complete"]);
    expect(await draftStore.load("e13")).toBeNull();
  });

  it("an allergy warning sits on the line and BLOCKS the issue until the doctor types a reason — which then rides the issue", async () => {
    const w = world({
      "POST /opd/visits/e13/rx-precheck": () => ({ status: 200, body: { ...CLEAN, allergyMatches: [{ lineIndex: 0, substance: "Penicillin" }] } }),
    });
    const m = await mount(w);
    await screen.findByTestId("visit-empty");
    await addMedicine("amox", "m-amox");
    expect(await screen.findByTestId("warn-allergy-0")).toHaveTextContent(/Allergy on record: Penicillin/);
    await press("meds-drawer-done");
    expect(await screen.findByTestId("visit-warn-0")).toHaveTextContent("1 warning needs your reason");
    expect(screen.getByTestId("issue-complete")).toHaveTextContent("1 warning needs your reason");
    await press("issue-complete"); // opens the medicines drawer; sends nothing
    await screen.findByTestId("reason-allergy-0");
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(0);
    await type("reason-allergy-0", "tolerated it last year");
    await press("meds-drawer-done");
    await waitFor(() => expect(screen.getByTestId("issue-complete")).toHaveTextContent("Issue and complete"));
    await press("issue-complete");
    await waitFor(() => expect(m.onDone).toHaveBeenCalled());
    expect((w.of("POST /opd/visits/e13/prescriptions")[0]!.body as { overrides: unknown }).overrides).toEqual([{ lineIndex: 0, substance: "Penicillin", reason: "tolerated it last year" }]);
  });

  it("diagnosis is optional, and a visit with only a note completes without issuing anything", async () => {
    const w = world();
    const m = await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-notes");
    await type("notes-input", "Throat congested, chest clear.");
    await press("complaint-Fever");
    await press("notes-drawer-done");
    expect(screen.getByTestId("issue-complete")).toHaveTextContent("Complete");
    await press("issue-complete");
    await waitFor(() => expect(m.onDone).toHaveBeenCalled());
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(0);
    const done = w.of("POST /opd/visits/e13/consult/complete")[0]!.body as { note: Record<string, unknown> };
    expect(done.note).toMatchObject({ chiefComplaint: "Fever", doctorNote: "Throat congested, chest clear.", diagnoses: null, rxDraft: null });
  });

  it("the doctor's most-used diagnosis is one tap, and it is sent coded", async () => {
    const w = world();
    const m = await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-dx");
    await fireEvent.press(await screen.findByTestId("dx-mine-0"));
    await press("dx-drawer-done");
    expect(screen.getByTestId("visit-dx")).toHaveTextContent(/Acute upper respiratory infection\s+J06\.9/);
    await press("issue-complete");
    await waitFor(() => expect(m.onDone).toHaveBeenCalled());
    expect((w.of("POST /opd/visits/e13/consult/complete")[0]!.body as { note: { diagnoses: unknown } }).note.diagnoses).toEqual([{ text: "Acute upper respiratory infection", icd10Code: "J06.9" }]);
  });

  it("Repeat last copies the last prescription in, and every copied line goes through today's check", async () => {
    const w = world();
    await mount(w);
    await screen.findByTestId("visit-empty");
    await waitFor(() => expect(screen.getByTestId("repeat-last")).toHaveTextContent(/2026-09-12 · 2 medicines/));
    await press("repeat-last");
    expect(await screen.findByTestId("visit-line-1")).toHaveTextContent(/Metformin 500 mg Tablet · 1 tab · BD · 30 days/);
    expect(screen.getByTestId("visit-state")).toHaveTextContent("copied from 2026-09-12");
    await waitFor(() => expect(w.of("POST /opd/visits/e13/rx-precheck").length).toBeGreaterThan(0));
    const checked = (w.of("POST /opd/visits/e13/rx-precheck").at(-1)!.body as { lines: { drug: string; instructions: string | null }[] }).lines;
    expect(checked.map((l) => l.drug)).toEqual(["Amlodipine 5 mg Tablet", "Metformin 500 mg Tablet"]);
    expect(checked[1]!.instructions).toBe("after food");
  });

  it("a set only fills the lines — yours and the hospital's signed ones are offered, and what it adds is checked for THIS patient", async () => {
    const w = world();
    await mount(w);
    await screen.findByTestId("visit-empty");
    await waitFor(() => expect(screen.getByTestId("my-sets")).toHaveTextContent(/1 yours · 1 hospital/));
    await press("my-sets");
    expect(await screen.findByTestId("set-s2")).toHaveTextContent(/signed by Dr\. Chandan Kumar/);
    await press("set-use-s1");
    expect(await screen.findByTestId("visit-line-0")).toHaveTextContent(/Paracetamol 500 mg Tablet · 1 tab · TDS · 5 days/);
    expect(screen.getByTestId("visit-advice")).toHaveTextContent(/Plenty of fluids, rest\. Review after 5 days\./);
    expect(screen.getByTestId("visit-state")).toHaveTextContent("from “Viral fever”");
    await waitFor(() => expect(w.of("POST /opd/visits/e13/rx-precheck").length).toBeGreaterThan(0));
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(0); // a set issues nothing
  });

  it("what is written is kept on the phone: the screen closed and reopened shows the same visit", async () => {
    const w = world();
    const first = await mount(w);
    await screen.findByTestId("visit-empty");
    await addMedicine("para", "m-para");
    await press("meds-drawer-done");
    await waitFor(async () => expect((await draftStore.load("e13"))?.lines).toHaveLength(1));
    await first.unmount();
    await mount(w);
    expect(await screen.findByTestId("visit-line-0")).toHaveTextContent(/Paracetamol 500 mg Tablet/);
    // …and the stored draft is under the secure store, not in plain storage.
    expect([...mockStore.keys()].some((k) => k.startsWith("hmis.consult.e13"))).toBe(true);
  });

  it("with no network NOTHING is sent and nothing is queued: the visit stays on screen and says so", async () => {
    const w = world({ "PUT /opd/visits/e13/consult/note": () => "offline", "POST /opd/visits/e13/rx-precheck": () => "offline" });
    const m = await mount(w);
    await screen.findByTestId("visit-empty");
    await addMedicine("para", "m-para");
    await press("meds-drawer-done");
    expect(await screen.findByTestId("consult-offline")).toBeTruthy();
    await press("issue-complete");
    expect(await screen.findByTestId("consult-error")).toHaveTextContent(/nothing was sent/i);
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(0);
    expect(w.of("POST /opd/visits/e13/consult/complete")).toHaveLength(0);
    expect(m.onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId("visit-line-0")).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(0); // still nothing: no retry by itself
  });

  it("an answer lost after the prescription was issued is NOT issued twice — the retry asks the server what it holds", async () => {
    let completes = 0;
    const w = world({ "POST /opd/visits/e13/consult/complete": () => { completes += 1; return completes === 1 ? "offline" : { status: 201, body: { encounter: {} } }; } });
    const m = await mount(w);
    await screen.findByTestId("visit-empty");
    await addMedicine("para", "m-para");
    await press("meds-drawer-done");
    await waitFor(() => expect(w.of("POST /opd/visits/e13/rx-precheck").length).toBeGreaterThan(0));
    await press("issue-complete");
    expect(await screen.findByTestId("consult-error")).toHaveTextContent(/nothing is issued twice/i);
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(1);
    await press("issue-complete");
    await waitFor(() => expect(m.onDone).toHaveBeenCalled());
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(1); // not again
    expect(completes).toBe(2);
  });

  it("the spoken note: a one-time notice, then what was heard is shown to be read — a medicine is offered, never added by itself", async () => {
    const w = world({
      "POST /opd/visits/e13/consult/voice": () => ({ status: 201, body: { voiceId: "vx1", model: "gpt-4o-transcribe", text: "Teen din se bukhar. Pan 40 subah khali pet.",
        suggestions: [{ kind: "medicine", heard: "Pan 40", medicineId: "m-pan", name: "Pantoprazole 40 mg Tablet", form: "tablet", strength: "40 mg" }] } }),
      "POST /opd/consult/voice/vx1/kept": () => ({ status: 201, body: { ok: true } }),
    });
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-notes");
    await fireEvent.press(await screen.findByTestId("voice-start"));
    expect(await screen.findByTestId("voice-notice")).toHaveTextContent(/sends no name as data — but a name you say travels in the recording/);
    expect(mockRecorder.start).not.toHaveBeenCalled();
    await press("voice-notice-ok");
    await fireEvent.press(await screen.findByTestId("voice-stop"));
    const heard = await screen.findByTestId("voice-text");
    expect(heard.props.value).toBe("Teen din se bukhar. Pan 40 subah khali pet.");
    const sent = w.of("POST /opd/visits/e13/consult/voice")[0]!.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["audio", "mimeType", "seconds"]); // the phone adds no patient field of its own
    // The doctor corrects a word, then keeps it: the note gets the corrected text, the meter gets COUNTS.
    await fireEvent.changeText(heard, "Teen din se bukhar. Pan 40 subah khali pet, 5 din.");
    await press("voice-keep");
    await waitFor(() => expect(w.of("POST /opd/consult/voice/vx1/kept")).toHaveLength(1));
    expect(w.of("POST /opd/consult/voice/vx1/kept")[0]!.body).toEqual({ changedChars: 7, keptChars: 50 });
    expect(screen.getByTestId("notes-input").props.value).toBe("Teen din se bukhar. Pan 40 subah khali pet, 5 din.");
    await press("notes-drawer-done");
    expect(screen.queryByTestId("visit-line-0")).toBeNull(); // heard is not prescribed
    // The second time there is no notice.
    await press("open-notes");
    await fireEvent.press(await screen.findByTestId("voice-start"));
    expect(await screen.findByTestId("voice-stop")).toBeTruthy();
    expect(screen.queryByTestId("voice-notice")).toBeNull();
  });

  it("a medicine heard in the note is OFFERED with its strength and class; tapped, it is an unfinished line marked as from voice — and what was heard stays on screen", async () => {
    const w = world({
      "POST /opd/visits/e13/consult/voice": () => ({ status: 201, body: { voiceId: "vx2", model: "m", text: "Pan 40 subah.", suggestions: [
        { kind: "medicine", heard: "Pan 40", medicineId: "m-pan", name: "Pantoprazole 40 mg Tablet", form: "tablet", strength: "40 mg", drugClass: "PPI", lasa: null },
        { kind: "test", heard: "CBC", serviceId: "s-cbc", code: "CBC", name: "Complete blood count", pricePaise: 25000 },
      ] } }),
      "POST /opd/consult/voice/vx2/kept": () => ({ status: 201, body: { ok: true } }),
    });
    mockStore.set("hmis.consult.voice-notice", "1");
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-notes");
    await fireEvent.press(await screen.findByTestId("voice-start"));
    await fireEvent.press(await screen.findByTestId("voice-stop"));
    expect(await screen.findByTestId("voice-suggest-0")).toHaveTextContent(/40 mg · tablet · PPI/);
    await press("voice-suggest-add-0");
    expect(screen.getByTestId("voice-text").props.value).toBe("Pan 40 subah."); // still here, still editable
    await press("voice-keep");
    // The test was offered and left: counted as dismissed. The medicine's count comes at issue.
    await waitFor(() => expect(w.of("POST /opd/consult/signals")).toHaveLength(1));
    expect(w.of("POST /opd/consult/signals")[0]!.body).toEqual({ suggestions: [{ kind: "test", source: "voice", outcome: "dismissed" }] });
    await press("notes-drawer-done");
    expect(screen.getByTestId("visit-line-0")).toHaveTextContent(/Pantoprazole 40 mg Tablet/);
    // No dose yet: it cannot be issued, and the screen opens the medicines to say so.
    await press("issue-complete");
    expect(await screen.findByTestId("line-source-0")).toHaveTextContent("offered from your spoken note");
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(0);
  });

  it("a look-alike name takes a second tap — “Hydroxyzine — not hydralazine?” — and the row shows strength, form and class", async () => {
    const w = world();
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-meds");
    await fireEvent.changeText(await screen.findByTestId("med-input"), "hydrox");
    expect(await screen.findByTestId("med-hit-sub-m-hz")).toHaveTextContent("25 mg · tablet · Antihistamine");
    await press("med-hit-m-hz");
    expect(await screen.findByTestId("lasa-ask")).toHaveTextContent(/Hydroxyzine 25 mg Tablet — not hydralazine\?/);
    expect(screen.queryByTestId("line-drug")).toBeNull(); // nothing picked on one tap
    await press("lasa-no");
    expect(screen.queryByTestId("lasa-ask")).toBeNull();
    await press("med-hit-m-hz");
    await press("lasa-yes");
    expect(await screen.findByTestId("line-drug")).toHaveTextContent("Hydroxyzine 25 mg Tablet");
  });

  it("a word the hospital's list cannot answer is logged as the term alone, and the hand-typed line says it was typed", async () => {
    const w = world();
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-meds");
    await fireEvent.changeText(await screen.findByTestId("med-input"), "zzzodol sp");
    await fireEvent.press(await screen.findByTestId("med-free"));
    await waitFor(() => expect(w.of("POST /opd/consult/signals")).toHaveLength(1));
    expect(w.of("POST /opd/consult/signals")[0]!.body).toEqual({ misses: [{ kind: "medicine", term: "zzzodol sp", stage: "search" }] });
    await press("dose-1 tab"); await press("freq-BD"); await press("days-3"); await press("line-add");
    expect(await screen.findByTestId("line-source-0")).toHaveTextContent("typed by hand");
  });

  it("with the hospital's suggestions switched off, nothing worked-out is offered: no suggested tests", async () => {
    const tests = jest.fn(() => ({ status: 200, body: { items: [{ serviceId: "s-cbc", code: "CBC", name: "Complete blood count", pricePaise: 25000, mine: 1, hospital: 1 }] } }));
    const w = world({
      "GET /opd/consult/voice/status": () => ({ status: 200, body: { enabled: true, suggestionsEnabled: false, configured: true, model: "gpt-4o-transcribe", maxSeconds: 60, usedSecondsToday: 0, dailyMinutesCap: 120, why: null } }),
      "GET /opd/cds/suggest/tests": tests,
      "GET /tariff/price-list": () => ({ status: 200, body: { items: [] } }),
      "GET /opd/cds/complete/diagnosis": () => ({ status: 200, body: { items: [] } }),
    });
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-dx");
    await fireEvent.press(await screen.findByTestId("dx-mine-0"));
    await press("dx-drawer-done");
    await press("open-tests");
    await screen.findByTestId("tests-drawer");
    expect(tests).not.toHaveBeenCalled();
  });

  it("voice that is not set up says so and offers no microphone", async () => {
    const w = world({ "GET /opd/consult/voice/status": () => ({ status: 200, body: { enabled: true, configured: false, model: "gpt-4o-transcribe", maxSeconds: 60, usedSecondsToday: 0, dailyMinutesCap: 120, why: "not_configured" } }) });
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-notes");
    expect(await screen.findByTestId("voice-off")).toHaveTextContent(/Voice is not set up/);
    expect(screen.queryByTestId("voice-start")).toBeNull();
  });

  it("“I wrote on paper” withdraws the medicines typed here, forgets the draft and hands over to the paper road", async () => {
    const w = world();
    const m = await mount(w);
    await screen.findByTestId("visit-empty");
    await addMedicine("para", "m-para");
    await press("meds-drawer-done");
    await waitFor(async () => expect((await draftStore.load("e13"))?.lines).toHaveLength(1));
    await press("wrote-on-paper");
    // Asked once: the medicine typed here will not be issued.
    expect(await screen.findByTestId("paper-ask")).toHaveTextContent(/1 medicine typed here will NOT be issued/);
    expect(m.onPaper).not.toHaveBeenCalled();
    await press("wrote-on-paper");
    await waitFor(() => expect(m.onPaper).toHaveBeenCalledTimes(1));
    expect(w.of("PUT /opd/visits/e13/consult/note").at(-1)!.body).toEqual({ rxDraft: [] });
    expect(await draftStore.load("e13")).toBeNull();
    expect(w.of("POST /opd/visits/e13/prescriptions")).toHaveLength(0);
  });
});
