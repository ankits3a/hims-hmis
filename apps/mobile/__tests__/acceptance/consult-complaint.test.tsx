import { StyleSheet } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { doctorApi } from "../../src/doctor/api";
import { I18nProvider } from "../../src/i18n";
import { ConsultScreen } from "../../src/screens/consult";
import { SessionProvider, useSession } from "../../src/session";
import en from "../../src/locales/en.json";
import hi from "../../src/locales/hi.json";
import webEn from "../../../web/src/locales/en.json";
import webHi from "../../../web/src/locales/hi.json";

/**
 * ACCEPTANCE — issue #607, spec SPEC-consult-complaint-button-2026-10-10 (owner APPROVED 2026-10-10):
 * "Rename Notes to Complaint. But also keep Notes in the last to let doctor add his own general notes
 * for reference. Keep the scrollable." — plus "Park patient" becomes "Hold patient" in both apps.
 * These are the spec's "done means", one test each. Locked once merged (tools/ci/acceptance-guard.mjs).
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
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, of: (key: string) => calls.filter((c) => c.key === key) };
}

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.consult"], scoped: { department: {}, floor: {} } } };
const SUMMARY = { requestedId: "p13", id: "p13", uhid: "U0011013", name: "Suresh Prasad", alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z" };
function visit(chiefComplaint: string | null, doctorNote: string | null) {
  return {
    encounter: { id: "e13", visitNo: "V2610070013", patientId: "p13", status: "in_consultation", serviceDate: "2026-10-07", visitType: "revisit", chiefComplaint, doctorNote, diagnosis: null, advice: null, advisedTests: null, dangerFlagged: false, consultStartedAt: "2026-10-07T05:00:00.000Z", rxDraft: null },
    feeUnpaid: false, feeBypass: null, deskComplaint: { text: "bukhar 3 din se", by: "Asha", at: "2026-10-07T04:30:00.000Z" },
    vitals: [], prescriptions: [],
  };
}
function world(v: ReturnType<typeof visit>) {
  return server({
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/visits/e13": () => ({ status: 200, body: v }),
    "GET /patients/p13/allergies": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/patients/p13/prescriptions": () => ({ status: 200, body: { items: [] } }),
    "GET /opd/rx-sets": () => ({ status: 200, body: { headOf: [], departmentId: "dep1", items: [] } }),
    "POST /opd/visits/e13/rx-precheck": () => ({ status: 200, body: { allergyMatches: [], interactions: [], duplicates: [], drugDisease: [] } }),
    "PUT /opd/visits/e13/consult/note": () => ({ status: 200, body: { encounter: {} } }),
    "POST /opd/visits/e13/consult/complete": () => ({ status: 201, body: { encounter: {} } }),
    "GET /opd/cds/complete/complaint": () => ({ status: 200, body: { items: [], ghost: null } }),
    "GET /opd/consult/voice/status": () => ({ status: 200, body: { enabled: true, configured: true, model: "m", maxSeconds: 60, usedSecondsToday: 0, dailyMinutesCap: 120, why: null } }),
  });
}
function Host() {
  const { call, state } = useSession();
  if (state.status !== "signedIn") return null;
  return <ConsultScreen doctorApi={doctorApi(call)} encounterId="e13" patientId="p13" tokenNo={13} entry={null} summary={SUMMARY as never}
    cfg={{ followUpDefaultDays: 7, followUpExtensionDays: [14] }} onDone={() => undefined} onPaper={() => undefined} onHistory={() => undefined} onPark={() => undefined} parkBusy={false} />;
}
async function mount(w: ReturnType<typeof world>, width = 360) {
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={w.fetcher}><Host /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
const press = async (id: string): Promise<void> => { await fireEvent.press(screen.getByTestId(id)); };

beforeEach(() => {
  mockStore.clear();
  mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" }));
  jest.clearAllMocks();
});

const ORDER = ["complaint", "dx", "meds", "tests", "advice", "notes"];

describe("#607 — the Complaint button, Notes last, the row scrolls", () => {
  it("six buttons in order; at 360 px the row scrolls and every button is reachable", async () => {
    await mount(world(visit(null, null)), 360);
    await screen.findByTestId("visit-empty");
    expect(screen.getAllByTestId(/^open-/).map((n) => String(n.props.testID).slice(5))).toEqual(ORDER);
    expect(screen.getByTestId("open-complaint")).toHaveTextContent(/Complaint/);
    expect(screen.getByTestId("open-notes")).toHaveTextContent(/Notes/);

    // The six sit in ONE horizontal scroller — every button is reachable by a swipe.
    const row = screen.getByTestId("consult-six");
    expect(row.props.horizontal).toBe(true);
    for (const k of ORDER) expect(screen.getByTestId(`open-${k}`)).toBeTruthy();

    // Geometry at 360 px: readable buttons, more than fit — the last one starts on screen and is cut off.
    const cc = StyleSheet.flatten(row.props.contentContainerStyle) as { paddingHorizontal?: number; paddingLeft?: number; gap?: number; columnGap?: number };
    const pad = cc.paddingLeft ?? cc.paddingHorizontal ?? 0;
    const gap = cc.columnGap ?? cc.gap ?? 0;
    const widths = ORDER.map((k) => (StyleSheet.flatten(screen.getByTestId(`open-${k}`).props.style) as { minWidth?: number }).minWidth ?? 0);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(56);
    const lastLeft = pad + widths.slice(0, 5).reduce((a, b) => a + b + gap, 0);
    const lastRight = lastLeft + widths[5]!;
    expect(lastLeft).toBeLessThan(360);
    expect(lastRight).toBeGreaterThan(360);
  });

  it("choosing \"Fever\" in Complaint sets chiefComplaint \"Fever\" and shows ✓ on Complaint only", async () => {
    const w = world(visit(null, null));
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-complaint");
    expect(await screen.findByTestId("complaint-drawer")).toBeTruthy();
    // The Complaint drawer is the chips, the search and the desk's words — no free-text box, no microphone.
    expect(screen.getByTestId("complaint-input")).toBeTruthy();
    expect(screen.getByTestId("complaint-drawer")).toHaveTextContent(/bukhar 3 din se/);
    expect(screen.queryByTestId("notes-input")).toBeNull();
    expect(screen.queryByTestId("voice-start")).toBeNull();
    await press("complaint-Fever");
    await press("complaint-drawer-done");
    expect(screen.getByTestId("count-complaint")).toHaveTextContent("✓");
    expect(screen.queryByTestId("count-notes")).toBeNull();
    expect(screen.getByTestId("visit-complaint")).toHaveTextContent(/Fever/);
    expect(screen.queryByTestId("visit-notes")).toBeNull();
    await press("issue-complete");
    await waitFor(() => expect(w.of("POST /opd/visits/e13/consult/complete")).toHaveLength(1));
    expect((w.of("POST /opd/visits/e13/consult/complete")[0]!.body as { note: Record<string, unknown> }).note).toMatchObject({ chiefComplaint: "Fever", doctorNote: null });
  });

  it("typing in Notes sets doctorNote and shows ✓ on Notes only", async () => {
    const w = world(visit(null, null));
    await mount(w);
    await screen.findByTestId("visit-empty");
    await press("open-notes");
    expect(await screen.findByTestId("notes-drawer")).toBeTruthy();
    // The Notes drawer is the free text and the voice note — no complaint chips.
    expect(await screen.findByTestId("voice-start")).toBeTruthy();
    expect(screen.queryByTestId("complaint-input")).toBeNull();
    expect(screen.queryByTestId("complaint-Fever")).toBeNull();
    await fireEvent.changeText(screen.getByTestId("notes-input"), "Throat congested, chest clear.");
    await press("notes-drawer-done");
    expect(screen.getByTestId("count-notes")).toHaveTextContent("✓");
    expect(screen.queryByTestId("count-complaint")).toBeNull();
    expect(screen.getByTestId("visit-notes")).toHaveTextContent(/Throat congested, chest clear\./);
    expect(screen.queryByTestId("visit-complaint")).toBeNull();
    await press("issue-complete");
    await waitFor(() => expect(w.of("POST /opd/visits/e13/consult/complete")).toHaveLength(1));
    expect((w.of("POST /opd/visits/e13/consult/complete")[0]!.body as { note: Record<string, unknown> }).note).toMatchObject({ chiefComplaint: null, doctorNote: "Throat congested, chest clear." });
  });

  it("an old visit with both fields opens with each in its own drawer and its own card line", async () => {
    await mount(world(visit("Fever, Cough", "Chest clear. Review sugar.")));
    expect(await screen.findByTestId("visit-complaint")).toHaveTextContent(/Fever, Cough/);
    expect(screen.getByTestId("visit-complaint")).not.toHaveTextContent(/Chest clear/);
    expect(screen.getByTestId("visit-notes")).toHaveTextContent(/Chest clear\. Review sugar\./);
    expect(screen.getByTestId("visit-notes")).not.toHaveTextContent(/Fever/);
    expect(screen.getByTestId("count-complaint")).toHaveTextContent("✓");
    expect(screen.getByTestId("count-notes")).toHaveTextContent("✓");

    await press("open-complaint");
    await screen.findByTestId("complaint-drawer");
    expect(screen.getByTestId("complaint-Fever").props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId("complaint-Cough").props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByTestId("notes-input")).toBeNull();
    await press("complaint-drawer-done");

    await press("open-notes");
    await screen.findByTestId("notes-drawer");
    expect(screen.getByTestId("notes-input").props.value).toBe("Chest clear. Review sugar.");
    expect(screen.queryByTestId("complaint-Fever")).toBeNull();
  });
});

describe("#607 — en + hi strings", () => {
  it("five.complaint is \"Complaint\" / \"शिकायत\"; five.notes stays \"Notes\"", () => {
    const five = (j: unknown) => (j as { mobile: { consult: { five: Record<string, string> } } }).mobile.consult.five;
    expect(five(en).complaint).toBe("Complaint");
    expect(five(hi).complaint).toBe("शिकायत");
    expect(five(en).notes).toBe("Notes");
  });
});

describe("#607 — \"Park patient\" becomes \"Hold patient\" (owner 2026-10-10)", () => {
  function leaves(o: unknown, out: string[] = []): string[] {
    if (typeof o === "string") out.push(o);
    else if (o !== null && typeof o === "object") for (const v of Object.values(o)) leaves(v, out);
    return out;
  }
  it.each([["mobile en", en], ["mobile hi", hi], ["web en", webEn], ["web hi", webHi]])("no visible Park / Parked in %s", (_n, j) => {
    // "park" as a whole word or a stem (park, parked, parking a patient) — "sparkline" and the like are not it.
    expect(leaves(j).filter((s) => /\bpark/i.test(s))).toEqual([]);
  });
  it("says Hold in the words the spec names", () => {
    const op = (j: unknown) => (j as { opdConsult: Record<string, string> }).opdConsult;
    for (const j of [en, webEn]) {
      expect(op(j).park).toBe("Hold patient");
      expect(op(j).parkedFor).toBe("On hold {{minutes}} min");
      expect(op(j).parkedJustNow).toBe("On hold just now");
    }
    const toast = (j: unknown) => (j as { mobile: { doctor: { parked: string } } }).mobile.doctor.parked;
    expect(toast(en)).toBe("Token {{token}} on hold");
    expect(toast(hi)).toBe("टोकन {{token}} होल्ड पर");
    for (const j of [hi, webHi]) expect(op(j).park).toContain("होल्ड");
  });
});
