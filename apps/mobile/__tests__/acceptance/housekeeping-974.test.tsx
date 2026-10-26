import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../../src/i18n";
import { HkCheck } from "../../src/screens/hk-check";
import { HkTasks } from "../../src/screens/hk-tasks";
import { seatsFor } from "../../src/seats";
import { SessionProvider, useSession } from "../../src/session";

/**
 * SPEC #974 D6 — the staff app's half of housekeeping (docs/specs/974-housekeeping-reports.md): an attendant opens a
 * task from their own list, scans the door QR at the place, answers every checklist item and takes the photo, and the
 * task is done; a nurse opens what waits for a check, sees the proof and passes it. The same doors as HK-1's web phone
 * screens (`/tasks/mine`, `/housekeeping/tasks/:id/...`), plus the check list `/housekeeping/to-check`.
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "hk.one", since: new Date().toISOString() })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
// The camera reads the door QR: pressing the fake camera is the QR coming into view.
jest.mock("expo-camera", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  return {
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned?: (r: { data: string }) => void }) =>
      React.createElement(Pressable, { testID: "fake-camera", onPress: () => onBarcodeScanned?.({ data: "a1.area-1.1.sig" }) }),
  };
});
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(async () => ({
    canceled: false,
    assets: [{ uri: "file:///cache/place.jpg", width: 1200, height: 1600, base64: "UExBQ0U=", mimeType: "image/jpeg" }],
  })),
}));

type Reply = { status: number; body?: unknown };
type Route = (body: unknown, url: string) => Reply;
function server(perms: string[], routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    if (key === "GET /auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, of: (key: string) => calls.filter((c) => c.key === key) };
}
function Gate({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  return state.status === "signedIn" ? <>{children}</> : null;
}
async function mount(fetcher: typeof fetch, node: React.ReactNode, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate>{node}</Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const card = (state: string) => ({
  id: "t1", kind: "area_round", label: "Area round", priority: "routine", state, placeResourceId: "r1", placeName: "Floor 2 toilet (gents)",
  placeCode: "F2-WC", floorName: "Floor 2", note: null, dueAt: iso(30), createdAt: iso(-10), assigneeId: "u-me", assigneeName: "hk.one",
  proofNeeded: "scan", verifyRequired: false, mergedCount: 0, escalatedRung: 0, version: 1,
});
const FORM = {
  taskId: "t1", needsWork: true, areaName: "Floor 2 toilet (gents)",
  items: [{ id: "i1", text: "Floor mopped" }, { id: "i2", text: "Bin emptied" }], photoNeeded: true, lastReason: null,
};

describe("spec #974 D6 — housekeeping on the staff app", () => {
  it("spec #974 D6: an attendant completes a task (scan, checklist, photo) on the staff app, and a nurse passes it there", async () => {
    // The seats: the attendant's list behind tasks.work, the check list behind the ward nurse's ipd.beds.clean.
    const none = { scoped: { department: {}, floor: {} } };
    expect(seatsFor({ ...none, hospital: ["tasks.work"] }).map((s) => s.key)).toContain("hkWork");
    expect(seatsFor({ ...none, hospital: ["ipd.beds.clean"] }).map((s) => s.key)).toContain("hkCheck");
    expect(seatsFor({ ...none, hospital: ["housekeeping.confirm"] }).map((s) => s.key)).toContain("hkCheck");
    expect(seatsFor({ ...none, hospital: ["tasks.work"] }).map((s) => s.key)).not.toContain("hkCheck");

    // ── The attendant ──
    let state = "assigned";
    const a = server(["tasks.work"], {
      "GET /tasks/mine": () => ({ status: 200, body: { serverNow: iso(0), mine: [card(state)], pool: [] } }),
      "POST /tasks/t1/accept": () => { state = "accepted"; return { status: 200, body: { id: "t1", state, version: 2 } }; },
      "POST /tasks/t1/start": () => { state = "in_progress"; return { status: 200, body: { id: "t1", state, version: 3 } }; },
      "GET /housekeeping/tasks/t1/work-form": () => ({ status: 200, body: FORM }),
      "POST /housekeeping/tasks/t1/photo": () => ({ status: 200, body: { photoKey: "housekeeping/t1/p1.jpg" } }),
      "POST /housekeeping/tasks/t1/work": () => { state = "done"; return { status: 200, body: { id: "t1", state, version: 4 } }; },
    });
    const one = await mount(a.fetcher, <HkTasks />);
    await fireEvent.press(await screen.findByTestId("hk-task-t1"));
    await fireEvent.press(await screen.findByTestId("hk-start"));
    await waitFor(() => expect(a.of("POST /tasks/t1/start")).toHaveLength(1));
    expect(a.of("POST /tasks/t1/accept")).toHaveLength(1);
    // Done waits for the scan, every item and the photo.
    const doneButton = await screen.findByTestId("hk-done");
    await fireEvent.press(doneButton);
    expect(a.of("POST /housekeeping/tasks/t1/work")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("hk-scan"));
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    expect(await screen.findByTestId("hk-scanned")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("hk-yes-i1"));
    await fireEvent.press(screen.getByTestId("hk-no-i2"));
    await fireEvent.press(screen.getByTestId("hk-photo"));
    await waitFor(() => expect(a.of("POST /housekeeping/tasks/t1/photo")).toHaveLength(1));
    expect(a.of("POST /housekeeping/tasks/t1/photo")[0]!.body).toEqual({ mimeType: "image/jpeg", imageBase64: "UExBQ0U=" });
    expect(await screen.findByTestId("hk-photo-taken")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("hk-done"));
    await waitFor(() => expect(a.of("POST /housekeeping/tasks/t1/work")).toHaveLength(1));
    expect(a.of("POST /housekeeping/tasks/t1/work")[0]!.body).toEqual({
      scan: "a1.area-1.1.sig", answers: [{ itemId: "i1", ok: true }, { itemId: "i2", ok: false }], photoKey: "housekeeping/t1/p1.jpg",
    });
    expect(await screen.findByTestId("hk-finished")).toBeTruthy();
    await one.unmount();

    // ── The nurse ──
    const n = server(["ipd.beds.clean"], {
      "GET /housekeeping/to-check": () => ({ status: 200, body: [{ taskId: "t9", kind: "bed_clean_routine", kindLabel: "Bed clean", placeName: "W3-12", doneAt: iso(-4), terminal: false, fails: 0 }] }),
      "GET /housekeeping/tasks/t9/proof": () => ({ status: 200, body: { proof: {
        taskId: "t9", attempt: 1, doneByName: "hk.one", company: "In-house", scannedAt: iso(-5), scanAreaName: "Ward 3",
        answers: [{ text: "Floor mopped", ok: true }, { text: "Bin emptied", ok: true }], photo: { mimeType: "image/jpeg", imageBase64: "UExBQ0U=" }, fails: 0, lastReason: null,
      } } }),
      "POST /housekeeping/tasks/t9/confirm": () => ({ status: 200, body: { id: "t9", state: "verified", version: 6 } }),
    });
    await mount(n.fetcher, <HkCheck />);
    await fireEvent.press(await screen.findByTestId("hk-check-t9"));
    expect(await screen.findByTestId("hk-proof-photo")).toBeTruthy();
    // A fail needs a reason: nothing is sent without one.
    await fireEvent.press(screen.getByTestId("hk-fail"));
    expect(await screen.findByTestId("hk-need-reason")).toBeTruthy();
    expect(n.of("POST /housekeeping/tasks/t9/confirm")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("hk-pass"));
    await waitFor(() => expect(n.of("POST /housekeeping/tasks/t9/confirm")).toHaveLength(1));
    expect(n.of("POST /housekeeping/tasks/t9/confirm")[0]!.body).toEqual({ result: "pass" });
    expect(await screen.findByTestId("hk-confirmed")).toBeTruthy();
  });
});
