import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { doctorApi } from "../../src/doctor/api";
import { I18nProvider } from "../../src/i18n";
import { ConsultScreen } from "../../src/screens/consult";
import { SessionProvider, useSession } from "../../src/session";

/**
 * #608 — ACCEPTANCE, the owner's "done means" for the phone consult's "+ Allergy"
 * (spec approved 2026-10-10, /opt/hmis-context/SPEC-consult-allergy-add-2026-10-10.md):
 *   - typing "pen" shows Penicillin; picking it with Severe + "rash" saves; the pill appears without reopening;
 *   - a medicine containing that substance now shows the allergy warning;
 *   - no severity → Save disabled.
 * Plus the spec's own lines: a substance not in the list saves as typed, and a refusal is said, never swallowed.
 *
 * The server is a stub with STATE: the allergy list and the pre-check both answer from what the POST
 * wrote, so a warning can only appear if the screen asks again after the save.
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

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.consult", "patients.update"], scoped: { department: {}, floor: {} } } };
const CLASS = "Penicillins / Beta-Lactams";
const HITS = [
  { term: CLASS, kind: "class", allergenClass: CLASS, saltId: null, blocks: ["Amoxicillin", "Ampicillin", "Cloxacillin"] },
  { term: "Benzylpenicillin", kind: "moiety", allergenClass: null, saltId: "salt-benzpen", blocks: [] },
];
const AMOX = { id: "m-amox", name: "Amoxicillin 500 mg Capsule", form: "capsule", strength: "500 mg", code: "D0002", routeClass: "systemic", salts: ["amoxicillin"], prefix: true, reviewed: true };
const CLEAN = { allergyMatches: [], interactions: [], duplicates: [], drugDisease: [], notices: [], unresolvedLineIndexes: [] };
const VISIT = {
  encounter: { id: "e13", visitNo: "V2610070013", patientId: "p13", status: "in_consultation", serviceDate: "2026-10-07", visitType: "revisit", chiefComplaint: null, doctorNote: null, diagnosis: null, advice: null, advisedTests: null, dangerFlagged: false, consultStartedAt: "2026-10-07T05:00:00.000Z", rxDraft: null },
  feeUnpaid: false, feeBypass: null, deskComplaint: null, vitals: [], prescriptions: [],
};
const SUMMARY = { requestedId: "p13", id: "p13", uhid: "U0011013", name: "Suresh Prasad", alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z" };

type Allergy = { id: string; substance: string; reaction: string | null; severity: string | null; status: string; allergenClass: string | null };

function world(extra: Record<string, Route> = {}) {
  const allergies: Allergy[] = [];
  const calls: { key: string; body: unknown; url: string }[] = [];
  const routes: Record<string, Route> = {
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/visits/e13": () => ({ status: 200, body: VISIT }),
    "GET /patients/p13/allergies": () => ({ status: 200, body: { items: allergies } }),
    "POST /patients/p13/allergies": (body) => {
      const b = body as { substance: string; reaction?: string; severity?: string; allergenClass?: string | null };
      const id = `a${String(allergies.length + 1)}`;
      allergies.push({ id, substance: b.substance, reaction: b.reaction ?? null, severity: b.severity ?? null, status: "active", allergenClass: b.allergenClass ?? null });
      return { status: 201, body: { allergyId: id } };
    },
    "GET /opd/cds/complete/allergen": (_b, url) => {
      const q = decodeURIComponent(/q=([^&]*)/.exec(url)?.[1] ?? "").toLowerCase();
      const items = HITS.filter((h) => h.term.toLowerCase().includes(q) || h.blocks.some((x) => x.toLowerCase().includes(q)));
      return { status: 200, body: { items, known: items.length > 0 } };
    },
    "GET /opd/patients/p13/prescriptions": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/rx-sets": () => ({ status: 200, body: { headOf: [], departmentId: null, items: [] } }),
    "GET /opd/consult/medicines": () => ({ status: 200, body: { items: [AMOX] } }),
    "POST /opd/consult/signals": () => ({ status: 201, body: {} }),
    // The server's check reads the patient's allergies from the record: a coded penicillin class blocks amoxicillin.
    "POST /opd/visits/e13/rx-precheck": (body) => {
      const lines = (body as { lines: { drug: string }[] }).lines;
      const pen = allergies.find((a) => a.status === "active" && a.allergenClass === CLASS);
      const allergyMatches = pen === undefined ? [] : lines.flatMap((l, i) => (/amoxicillin/i.test(l.drug) ? [{ lineIndex: i, substance: pen.substance }] : []));
      return { status: 200, body: { ...CLEAN, allergyMatches } };
    },
    "PUT /opd/visits/e13/consult/note": () => ({ status: 200, body: { encounter: {} } }),
    "GET /opd/consult/suggestions": () => ({ status: 200, body: { on: true, hospitalOn: true, hidden: [] } }),
    "GET /opd/consult/voice/status": () => ({ status: 200, body: { enabled: false, configured: false, model: "", maxSeconds: 60, usedSecondsToday: 0, dailyMinutesCap: 0, why: "not_configured" } }),
    ...extra,
  };
  const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key), allergies };
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
const saveDisabled = (): boolean => screen.getByTestId("allergy-add-save").props.accessibilityState?.disabled === true;

async function addAmoxicillin(): Promise<void> {
  await press("open-meds");
  await fireEvent.changeText(await screen.findByTestId("med-input"), "amox");
  await fireEvent.press(await screen.findByTestId("med-hit-m-amox"));
  await press("dose-1 cap"); await press("freq-TDS"); await press("days-5");
  await press("line-add");
  await press("meds-drawer-done");
}

/** "+ Allergy" → "pen" → pick the class → Severe → "rash". */
async function recordPenicillin(): Promise<void> {
  await press("consult-allergy-add");
  await fireEvent.changeText(await screen.findByTestId("allergy-add-q"), "pen");
  await fireEvent.press(await screen.findByTestId(`allergy-add-hit-${CLASS}`));
  await press("allergy-add-sev-severe");
  await fireEvent.changeText(screen.getByTestId("allergy-add-reaction"), "rash");
  await press("allergy-add-save");
}

beforeEach(() => {
  mockStore.clear();
  mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" }));
});

describe("#608 — the doctor adds an allergy from the phone consult", () => {
  it('typing "pen" shows Penicillin; Severe + "rash" saves; the pill appears without reopening', async () => {
    const w = world();
    await mount(w);
    expect(screen.queryByTestId("consult-allergy")).toBeNull();

    await press("consult-allergy-add");
    await fireEvent.changeText(await screen.findByTestId("allergy-add-q"), "pen");
    const hit = await screen.findByTestId(`allergy-add-hit-${CLASS}`);
    expect(hit).toHaveTextContent(/Penicillin/);
    expect(await screen.findByTestId("allergy-add-hit-Benzylpenicillin")).toBeTruthy();
    expect(w.of("GET /opd/cds/complete/allergen").at(-1)?.url).toMatch(/q=pen$/);

    await fireEvent.press(hit);
    await press("allergy-add-sev-severe");
    await fireEvent.changeText(screen.getByTestId("allergy-add-reaction"), "rash");
    await press("allergy-add-save");

    await waitFor(() => expect(w.of("POST /patients/p13/allergies")).toHaveLength(1));
    expect(w.of("POST /patients/p13/allergies")[0]!.body).toEqual({
      substance: CLASS, severity: "severe", reaction: "rash", source: "consult", saltId: null, allergenClass: CLASS,
    });
    expect(await screen.findByTestId("consult-allergy")).toHaveTextContent(`Allergy · ${CLASS}`);
    expect(screen.queryByTestId("allergy-add-sheet")).toBeNull();
    // Still the same visit on screen — nothing was reopened.
    expect(w.of("GET /opd/visits/e13")).toHaveLength(1);
  });

  it("a medicine already on the visit now shows the allergy warning", async () => {
    const w = world();
    await mount(w);
    await addAmoxicillin();
    await waitFor(() => expect(w.of("POST /opd/visits/e13/rx-precheck").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("visit-warn-0")).toBeNull();

    await recordPenicillin();
    expect(await screen.findByTestId("visit-warn-0")).toHaveTextContent("1 warning needs your reason");
  });

  it("the next medicine added after the save shows the allergy warning", async () => {
    const w = world();
    await mount(w);
    await recordPenicillin();
    await screen.findByTestId("consult-allergy");

    await press("open-meds");
    await fireEvent.changeText(await screen.findByTestId("med-input"), "amox");
    await fireEvent.press(await screen.findByTestId("med-hit-m-amox"));
    await press("dose-1 cap"); await press("freq-TDS"); await press("days-5");
    await press("line-add");
    expect(await screen.findByTestId("warn-allergy-0")).toHaveTextContent(new RegExp(`Allergy on record: ${CLASS.replace(/[/]/g, "\\/")}`));
  });

  it("no severity → Save disabled; a severity enables it", async () => {
    const w = world();
    await mount(w);
    await press("consult-allergy-add");
    expect(saveDisabled()).toBe(true);
    await fireEvent.changeText(await screen.findByTestId("allergy-add-q"), "pen");
    await fireEvent.press(await screen.findByTestId(`allergy-add-hit-${CLASS}`));
    await fireEvent.changeText(screen.getByTestId("allergy-add-reaction"), "rash");
    expect(saveDisabled()).toBe(true);
    await press("allergy-add-save");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(w.of("POST /patients/p13/allergies")).toHaveLength(0);

    await press("allergy-add-sev-mild");
    expect(saveDisabled()).toBe(false);
  });

  it("a substance not in the list saves as typed, without a code, and says no check knows it", async () => {
    const w = world();
    await mount(w);
    await press("consult-allergy-add");
    await fireEvent.changeText(await screen.findByTestId("allergy-add-q"), "red syrup");
    expect(await screen.findByTestId("allergy-add-norule")).toBeTruthy();
    await press("allergy-add-sev-moderate");
    await press("allergy-add-save");
    await waitFor(() => expect(w.of("POST /patients/p13/allergies")).toHaveLength(1));
    expect(w.of("POST /patients/p13/allergies")[0]!.body).toEqual({ substance: "red syrup", severity: "moderate", source: "consult" });
    expect(await screen.findByTestId("consult-allergy")).toHaveTextContent("Allergy · red syrup");
  });

  it("changing the words after a pick drops the code — the typed words are what is saved", async () => {
    const w = world();
    await mount(w);
    await press("consult-allergy-add");
    await fireEvent.changeText(await screen.findByTestId("allergy-add-q"), "pen");
    await fireEvent.press(await screen.findByTestId(`allergy-add-hit-${CLASS}`));
    await fireEvent.changeText(screen.getByTestId("allergy-add-q"), "penicillin V only");
    await press("allergy-add-sev-severe");
    await press("allergy-add-save");
    await waitFor(() => expect(w.of("POST /patients/p13/allergies")).toHaveLength(1));
    expect(w.of("POST /patients/p13/allergies")[0]!.body).toEqual({ substance: "penicillin V only", severity: "severe", source: "consult" });
  });

  it("a refusal is said, the sheet keeps what was typed, and no pill appears", async () => {
    const w = world({ "POST /patients/p13/allergies": () => ({ status: 403, body: { message: "permission_denied" } }) });
    await mount(w);
    await press("consult-allergy-add");
    await fireEvent.changeText(await screen.findByTestId("allergy-add-q"), "pen");
    await fireEvent.press(await screen.findByTestId(`allergy-add-hit-${CLASS}`));
    await press("allergy-add-sev-severe");
    await press("allergy-add-save");
    expect(await screen.findByTestId("allergy-add-failed")).toBeTruthy();
    expect(screen.getByTestId("allergy-add-q").props.value).toBe(CLASS);
    expect(screen.queryByTestId("consult-allergy")).toBeNull();
  });
});
