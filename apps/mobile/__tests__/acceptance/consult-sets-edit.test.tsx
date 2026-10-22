import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { doctorApi } from "../../src/doctor/api";
import { I18nProvider } from "../../src/i18n";
import { ConsultScreen } from "../../src/screens/consult";
import { SessionProvider, useSession } from "../../src/session";

/**
 * #610 — ACCEPTANCE, the phone's half of the owner's "done means" for editing a saved set
 * (spec approved 2026-10-10, /opt/hmis-context/SPEC-consult-sets-edit-2026-10-10.md):
 *   - edit own set: change one medicine and the name, save, reopen — the change is there;
 *   - another doctor's set: no Edit;
 *   - a head edits a department set (and, being its signer, signs the edited set);
 *   - Cancel leaves the set unchanged; the visit on screen is never touched by an edit.
 * The server's half (403 for another doctor's set, head vs non-head) is
 * apps/core/src/modules/opd/acceptance/rx-sets-edit.e2e.test.ts.
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
jest.mock("../../src/consult/recorder", () => ({ useVoiceRecorder: () => ({ allow: jest.fn(async () => true), start: jest.fn(), take: jest.fn(), discard: jest.fn() }) }));

type Reply = { status: number; body?: unknown };
type Route = (body: unknown, url: string) => Reply;

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.consult"], scoped: { department: {}, floor: {} } } };
const PARA_LINE = { drug: "Paracetamol 500 mg Tablet", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", medicineId: "m-para" };
const CET = { id: "m-cet", name: "Cetirizine 10 mg Tablet", form: "tablet", strength: "10 mg", code: "D0150", routeClass: "systemic", salts: ["cetirizine"], prefix: true, reviewed: true };
const VISIT = {
  encounter: { id: "e13", visitNo: "V2610070013", patientId: "p13", status: "in_consultation", serviceDate: "2026-10-07", visitType: "revisit", chiefComplaint: null, doctorNote: null, diagnosis: null, advice: null, advisedTests: null, dangerFlagged: false, consultStartedAt: "2026-10-07T05:00:00.000Z", rxDraft: null },
  feeUnpaid: false, feeBypass: null, deskComplaint: null, vitals: [], prescriptions: [],
};
const SUMMARY = { requestedId: "p13", id: "p13", uhid: "U0011013", name: "Suresh Prasad", alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z" };

type WSet = { id: string; scope: "doctor" | "department"; name: string; body: { lines: typeof PARA_LINE[]; tests: unknown[]; advice: string | null; reviewDays: number | null };
  mine: boolean; signed: boolean; signedByName: string | null; signedAt: string | null; maySign: boolean; departmentId: string | null; departmentName: string | null };
const own = (): WSet => ({ id: "s1", scope: "doctor", name: "Viral fever", mine: true, signed: false, signedByName: null, signedAt: null, maySign: false, departmentId: null, departmentName: null,
  body: { lines: [PARA_LINE], tests: [], advice: "Plenty of fluids", reviewDays: 5 } });
const dept = (maySign: boolean): WSet => ({ id: "s2", scope: "department", name: "URTI — adult", mine: false, signed: true, signedByName: "Dr. Chandan Kumar", signedAt: "2026-10-01T00:00:00.000Z", maySign,
  departmentId: "dep1", departmentName: "General Medicine", body: { lines: [PARA_LINE], tests: [], advice: "Steam inhalation", reviewDays: 3 } });

function world(sets: WSet[]) {
  const calls: { key: string; body: unknown; url: string }[] = [];
  const routes: Record<string, Route> = {
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/visits/e13": () => ({ status: 200, body: VISIT }),
    "GET /patients/p13/allergies": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/patients/p13/prescriptions": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/rx-sets": () => ({ status: 200, body: { headOf: [], departmentId: "dep1", items: sets } }),
    "GET /opd/consult/medicines": () => ({ status: 200, body: { items: [CET] } }),
    "POST /opd/consult/signals": () => ({ status: 201, body: {} }),
    "POST /opd/visits/e13/rx-precheck": () => ({ status: 200, body: { allergyMatches: [], interactions: [], duplicates: [], drugDisease: [], notices: [], unresolvedLineIndexes: [] } }),
    "PUT /opd/visits/e13/consult/note": () => ({ status: 200, body: { encounter: {} } }),
    "GET /opd/consult/suggestions": () => ({ status: 200, body: { on: true, hospitalOn: true, hidden: [] } }),
    "GET /tariff/price-list": () => ({ status: 200, body: { items: [] } }),
  };
  for (const s of sets) {
    routes[`PUT /opd/rx-sets/${s.id}`] = (b) => {
      const x = b as { name: string; body: WSet["body"] };
      s.name = x.name; s.body = x.body; s.signed = false; s.signedByName = null;
      return { status: 200, body: { setId: s.id } };
    };
    routes[`POST /opd/rx-sets/${s.id}/sign`] = () => { s.signed = true; s.signedByName = "Dr. Chandan Kumar"; return { status: 201, body: { ok: true } }; };
  }
  const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: fetcher as unknown as typeof fetch, of: (key: string) => calls.filter((c) => c.key === key) };
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
  await screen.findByTestId("visit-empty");
}
const press = async (id: string): Promise<void> => { await fireEvent.press(await screen.findByTestId(id)); };

beforeEach(() => {
  mockStore.clear();
  mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" }));
});

describe("#610 — edit a saved set from the phone consult", () => {
  it("edit own set: change one medicine and the name, save, reopen — the change is there; the visit is untouched", async () => {
    const w = world([own()]);
    await mount(w);
    await press("my-sets");
    await press("set-edit-s1");
    expect(screen.getByTestId("set-edit-name").props.value).toBe("Viral fever");
    await fireEvent.changeText(screen.getByTestId("set-edit-name"), "Viral fever — adult");

    // The medicines open in the consult's own medicine editor; one line changes its medicine.
    await press("set-edit-meds");
    await press("line-edit-0");
    await press("line-change-drug");
    await fireEvent.changeText(await screen.findByTestId("med-input"), "cet");
    await press("med-hit-m-cet");
    await press("line-add");
    await press("meds-drawer-done");

    expect(await screen.findByTestId("set-edit-meds")).toHaveTextContent(/Cetirizine 10 mg Tablet/);
    await press("set-edit-save");
    await waitFor(() => expect(w.of("PUT /opd/rx-sets/s1")).toHaveLength(1));
    const sent = w.of("PUT /opd/rx-sets/s1")[0]!.body as { name: string; body: WSet["body"] };
    expect(sent.name).toBe("Viral fever — adult");
    expect(sent.body.lines.map((l) => [l.drug, l.medicineId])).toEqual([["Cetirizine 10 mg Tablet", "m-cet"]]);
    expect(sent.body.advice).toBe("Plenty of fluids");
    expect(sent.body.reviewDays).toBe(5);
    expect(w.of("POST /opd/rx-sets/s1/sign")).toHaveLength(0);

    // Back in "My sets", read again: the change is there.
    expect(await screen.findByTestId("set-s1")).toHaveTextContent(/Viral fever — adult/);
    expect(screen.getByTestId("set-s1")).toHaveTextContent(/Cetirizine/);
    await press("sets-drawer-done");
    // The visit on screen was never the editor's: still empty, nothing written to its note.
    expect(screen.getByTestId("visit-empty")).toBeTruthy();
  });

  it("another doctor's set shows no Edit; your own does", async () => {
    const w = world([own(), dept(false)]);
    await mount(w);
    await press("my-sets");
    await screen.findByTestId("set-s2");
    expect(screen.getByTestId("set-edit-s1")).toBeTruthy();
    expect(screen.queryByTestId("set-edit-s2")).toBeNull();
  });

  it("a unit head edits a department set and signs the edited set in the same tap", async () => {
    const w = world([dept(true)]);
    await mount(w);
    await press("my-sets");
    await press("set-edit-s2");
    expect(screen.getByTestId("set-edit-save")).toHaveTextContent("Save and sign");
    await fireEvent.changeText(screen.getByTestId("set-edit-advice"), "Steam inhalation, salt-water gargles");
    await press("set-edit-save");
    await waitFor(() => expect(w.of("POST /opd/rx-sets/s2/sign")).toHaveLength(1));
    expect((w.of("PUT /opd/rx-sets/s2")[0]!.body as { body: WSet["body"] }).body.advice).toBe("Steam inhalation, salt-water gargles");
    expect(await screen.findByTestId("set-s2")).toHaveTextContent(/signed by/);
  });

  it("Cancel leaves the set unchanged", async () => {
    const w = world([own()]);
    await mount(w);
    await press("my-sets");
    await press("set-edit-s1");
    await fireEvent.changeText(screen.getByTestId("set-edit-name"), "Something else");
    await press("set-edit-cancel");
    expect(await screen.findByTestId("set-s1")).toHaveTextContent(/Viral fever/);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(w.of("PUT /opd/rx-sets/s1")).toHaveLength(0);
  });
});
