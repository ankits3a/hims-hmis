import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../../src/i18n";
import { _forgetLabModeForTests } from "../../src/lab/mode";
import { QuickBench } from "../../src/screens/lab-qbench";
import { seatsFor } from "../../src/seats";
import { SessionProvider, useSession } from "../../src/session";

/**
 * SPEC #934 D12 — the phone's half of "scan the analyser's printed slip" (docs/specs/934-lab-slip-scan.md).
 * Scan slip on the Quick Bench, the camera or the system gallery, an upload inside the 1.5 MB budget with
 * the phone's copies mockDeleted afterwards, an explicit Yes before a slip that names someone else fills the
 * open report, Hindi strings that fit, and an Android build that asks for no photo-library permission.
 * (The staging-APK half of D12 is a release step, not a test.)
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "lab.tech", since: new Date().toISOString() })]]);
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
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
jest.mock("expo-camera", () => {
  const React = require("react");
  const { View } = require("react-native");
  const Cam = React.forwardRef((_p: unknown, ref: { current: unknown }) => {
    if (ref !== null && typeof ref === "object") ref.current = { takePictureAsync: async () => ({ uri: "file:///cache/shot.jpg", width: 3000, height: 4000 }) };
    return React.createElement(View, { testID: "fake-camera" });
  });
  return { useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()], CameraView: Cam };
});
const mockDeleted: string[] = [];
jest.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache/" } },
  File: class {
    uri: string;
    constructor(uri: string | { uri: string }) { this.uri = typeof uri === "string" ? uri : uri.uri; }
    get exists() { return true; }
    delete() { mockDeleted.push(this.uri); }
  },
}));
const mockPicked: { exif: Record<string, unknown> | null } = { exif: null };
jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(async () => ({
    canceled: false,
    assets: [{ uri: "file:///cache/pick.jpg", width: 1200, height: 3200, exif: mockPicked.exif }],
  })),
}));
const mockFlattenEdges: number[] = [];
jest.mock("../../src/slips/imaging", () => ({
  WORK_EDGE: 2560,
  normalize: jest.fn(async (p: { uri: string }) => ({ uri: p.uri.replace(/[^/]+$/, "norm.jpg"), width: 1200, height: 3200 })),
  findPage: jest.fn(async () => null),
  flatten: jest.fn(async (_p: unknown, _q: unknown, maxEdge: number) => {
    mockFlattenEdges.push(maxEdge);
    return { base64: Buffer.alloc(900_000, 7).toString("base64"), width: 900, height: 2400, straightened: false };
  }),
}));
jest.mock("../../src/slips/crop", () => ({ Crop: () => null }));

const ImagePicker = jest.requireMock("expo-image-picker") as { launchImageLibraryAsync: jest.Mock };

type Reply = { status: number; body?: unknown };
type Route = (body: unknown, url: string) => Reply;
function server(perms: string[], routes: Record<string, Route>) {
  const calls: { key: string; body: unknown; url: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url });
    if (key === "GET /auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
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

const BENCH = ["lab.results.enter"];
const RAM = { id: "p1", uhid: "UH00001", display: "Ram Kumar", administrativeGender: "male", dob: "1990-03-01" };
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const exifDate = (d: Date) => `${d.getFullYear()}:${String(d.getMonth() + 1).padStart(2, "0")}:${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
const CBC = [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count" }];
const row = (id: string) => ({
  id, status: "waiting", patient: RAM, encounterNo: null, tests: CBC, collectedAt: ago(40), collectedBy: "u-c",
  reportedAt: null, reportedBy: null, orderId: null, orderNo: null, sampleNo: "S2610210007", handedOverAt: null, handedOverBy: null,
});
const report = (id: string) => ({
  ...row(id), analyteIds: [], groups: [], lines: [], summary: "", collectedByName: null, reportedByName: null, slips: [],
  hospital: { name: "H", address: "A", hotline: "1", emergency: "2", email: "e", website: "w" }, visitQrSvg: null,
});
const scanView = (over: Record<string, unknown>) => ({
  id: "scan-1", status: "attached", source: "gallery", instrumentId: "i-1", instrumentName: "Haematology 3-part",
  header: { name: "RAM KUMAR", patientId: "S2610210007", sampleId: null, gender: "M", age: "36Y", printedAt: null },
  rows: [], counts: { rows: 21, placed: 14, crossCheck: 3, ignoredBySetting: 4, ignored: 0, notPlaced: 0, openChecks: 2 },
  rowsMissing: [], match: { idKind: "sample_no", hint: null }, differences: [], candidates: [], requestedReportId: null,
  attached: { quickReportId: "r1", matchKind: "sample_no", patient: RAM, sampleNo: "S2610210007", tests: CBC },
  error: null, discard: null, imagePurged: false, ...over,
});
const routes = (o: { reading?: boolean; post?: Route; extra?: Record<string, Route> } = {}): Record<string, Route> => ({
  "GET /lab/desk/mode": () => ({ status: 200, body: { mode: "quick" } }),
  "GET /lab/quick/queue": () => ({ status: 200, body: { waiting: [row("r1")], reportedToday: [] } }),
  "GET /lab/quick/catalogue": () => ({ status: 200, body: { tests: [], analytes: [] } }),
  "GET /lab/quick/reports/r1": () => ({ status: 200, body: report("r1") }),
  "GET /lab/quick/ranges": () => ({ status: 200, body: { items: [] } }),
  "GET /lab/slips/setup": () => ({ status: 200, body: { reading: o.reading ?? true, analysers: [{ id: "i-1", name: "Haematology 3-part" }] } }),
  "GET /lab/slips": () => ({ status: 200, body: { items: [] } }),
  "POST /lab/slips": o.post ?? (() => ({ status: 200, body: scanView({}) })),
  ...(o.extra ?? {}),
});

beforeEach(() => {
  _forgetLabModeForTests();
  mockDeleted.length = 0;
  mockFlattenEdges.length = 0;
  mockPicked.exif = { DateTimeOriginal: exifDate(new Date(Date.now() - 10 * 60_000)) };
  ImagePicker.launchImageLibraryAsync.mockClear();
});

describe("spec #934 D12 — scan slip on the phone", () => {
  it("Scan slip is offered only to lab.results.enter, in quick mode, while reading is on", async () => {
    const perms = { hospital: BENCH, scoped: { department: {}, floor: {} } };
    expect(seatsFor(perms, "quick").map((s) => s.key)).toContain("qbench");
    expect(seatsFor(perms, "full").map((s) => s.key)).not.toContain("qbench");
    expect(seatsFor({ ...perms, hospital: ["lab.reports.print"] }, "quick").map((s) => s.key)).not.toContain("qbench");

    const on = server(BENCH, routes());
    const a = await mount(on.fetcher, <QuickBench />);
    expect(await screen.findByTestId("qb-scan")).toBeTruthy();
    await a.unmount();

    const off = server(BENCH, routes({ reading: false }));
    await mount(off.fetcher, <QuickBench />);
    await screen.findByTestId("qb-row-r1");
    await waitFor(() => expect(off.of("GET /lab/slips/setup").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("qb-scan")).toBeNull();
  });

  it("Scan slip opens the camera or the system gallery picker", async () => {
    const w = server(BENCH, routes());
    await mount(w.fetcher, <QuickBench />);
    fireEvent.press(await screen.findByTestId("qb-scan"));
    fireEvent.press(await screen.findByTestId("slip-src-camera"));
    expect(await screen.findByTestId("slip-camera")).toBeTruthy();
    fireEvent.press(screen.getByTestId("cam-cancel"));

    fireEvent.press(await screen.findByTestId("slip-src-gallery"));
    await waitFor(() => expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1));
  });

  it("uploads at most 1.5 MB, at the slip's 2400 px edge, and deletes the phone's copies afterwards", async () => {
    const w = server(BENCH, routes());
    await mount(w.fetcher, <QuickBench />);
    fireEvent.press(await screen.findByTestId("qb-scan"));
    fireEvent.press(await screen.findByTestId("slip-src-gallery"));
    fireEvent.press(await screen.findByTestId("slip-crop-use"));
    expect(await screen.findByTestId("slip-attached")).toBeTruthy();

    const [post] = w.of("POST /lab/slips");
    const body = post!.body as { image: string; mimeType: string; source: string; instrumentId: string; photoTakenAt: string | null };
    expect(Buffer.from(body.image, "base64").length).toBeLessThanOrEqual(1_500_000);
    expect([body.mimeType, body.source, body.instrumentId]).toEqual(["image/jpeg", "gallery", "i-1"]);
    expect(typeof body.photoTakenAt).toBe("string");
    expect(mockFlattenEdges).toEqual([2400]);
    expect(mockDeleted).toEqual(expect.arrayContaining(["file:///cache/pick.jpg", "file:///cache/norm.jpg"]));
  });

  it("an old gallery photo asks whether it is today's slip before anything is sent", async () => {
    mockPicked.exif = { DateTimeOriginal: exifDate(new Date(Date.now() - 3 * 86_400_000)) };
    const w = server(BENCH, routes());
    await mount(w.fetcher, <QuickBench />);
    fireEvent.press(await screen.findByTestId("qb-scan"));
    fireEvent.press(await screen.findByTestId("slip-src-gallery"));
    expect(await screen.findByTestId("slip-old-photo")).toBeTruthy();
    expect(w.of("POST /lab/slips")).toHaveLength(0);
    fireEvent.press(screen.getByTestId("slip-old-yes"));
    fireEvent.press(await screen.findByTestId("slip-crop-use"));
    await screen.findByTestId("slip-attached");
    expect(w.of("POST /lab/slips")).toHaveLength(1);
  });

  it("Fill from slip on another patient's report asks for an explicit Yes before it attaches", async () => {
    const waiting = scanView({
      status: "waiting", attached: null, requestedReportId: "r1", differences: ["name", "gender"],
      header: { name: "SITA DEVI", patientId: null, sampleId: "0023", gender: "F", age: "34Y", printedAt: null },
    });
    const w = server(BENCH, routes({
      post: (b) => ({ status: 200, body: (b as { quickReportId?: string }).quickReportId === "r1" ? waiting : scanView({}) }),
      extra: { "POST /lab/slips/scan-1/attach": () => ({ status: 200, body: scanView({}) }) },
    }));
    await mount(w.fetcher, <QuickBench />);
    fireEvent.press(await screen.findByTestId("qb-row-r1"));
    fireEvent.press(await screen.findByTestId("qb-fill-slip"));
    fireEvent.press(await screen.findByTestId("slip-src-gallery"));
    fireEvent.press(await screen.findByTestId("slip-crop-use"));

    expect(await screen.findByTestId("slip-differs")).toHaveTextContent(/SITA DEVI/);
    expect((w.of("POST /lab/slips")[0]!.body as { quickReportId: string }).quickReportId).toBe("r1");
    expect(w.of("POST /lab/slips/scan-1/attach")).toHaveLength(0);
    fireEvent.press(screen.getByTestId("slip-differs-yes"));
    await waitFor(() => expect(w.of("POST /lab/slips/scan-1/attach")).toHaveLength(1));
    expect(w.of("POST /lab/slips/scan-1/attach")[0]!.body).toEqual({ quickReportId: "r1", confirmed: true });
  });

  it("every slip string has a Hindi twin, and each fits one line at 390 px", async () => {
    const en = JSON.parse(readFileSync(join(__dirname, "../../src/locales/en.json"), "utf8")) as { labSlip: Record<string, unknown> };
    const hi = JSON.parse(readFileSync(join(__dirname, "../../src/locales/hi.json"), "utf8")) as { labSlip: Record<string, unknown> };
    const flat = (o: Record<string, unknown>, p = ""): [string, string][] => Object.entries(o).flatMap(([k, v]) =>
      typeof v === "string" ? [[`${p}${k}`, v] as [string, string]] : flat(v as Record<string, unknown>, `${p}${k}.`));
    const enKeys = flat(en.labSlip);
    const hiMap = new Map(flat(hi.labSlip));
    expect(enKeys.length).toBeGreaterThan(20);
    for (const [k, v] of enKeys) {
      expect([k, hiMap.get(k)?.trim().length ?? 0]).not.toEqual([k, 0]);
      // 48 characters at the bench's 14 px is ~330 px: one line inside 390 px less the screen's padding.
      expect([k, v.replace(/\{\{\w+\}\}/g, "XXXXXX").length <= 48]).toEqual([k, true]);
      expect([k, (hiMap.get(k) ?? "").replace(/\{\{\w+\}\}/g, "XXXXXX").length <= 48]).toEqual([k, true]);
    }

    const w = server(BENCH, routes());
    await mount(w.fetcher, <QuickBench />, "hi");
    expect(await screen.findByTestId("qb-scan")).toHaveTextContent(String((hi.labSlip as { scan: string }).scan));
  });
});

describe("spec #934 D12 — the Android build asks for no photo-library permission", () => {
  type Perm = { $: Record<string, string> };
  type Introspected = { _internal: { modResults: { android: { manifest: { manifest: { "uses-permission"?: Perm[] } } }; ios: { infoPlist: Record<string, unknown> } } } };
  const ROOT = join(__dirname, "..", "..");
  let c: Introspected;
  beforeAll(() => {
    const out = execFileSync(process.execPath, [require.resolve("expo/bin/cli"), "config", "--type", "introspect", "--json"], {
      cwd: ROOT, env: { ...process.env, APP_ENV: "production", EXPO_NO_TELEMETRY: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    c = JSON.parse(out.slice(out.indexOf("{"))) as Introspected;
  }, 120_000);

  it("the merged manifest carries no READ_MEDIA_IMAGES and no READ_EXTERNAL_STORAGE", () => {
    const perms = c._internal.modResults.android.manifest.manifest["uses-permission"] ?? [];
    for (const never of ["READ_MEDIA_IMAGES", "READ_EXTERNAL_STORAGE", "READ_MEDIA_VIDEO", "READ_MEDIA_VISUAL_USER_SELECTED"]) {
      const named = perms.filter((p) => p.$["android:name"] === `android.permission.${never}`);
      expect([never, named.every((p) => p.$["tools:node"] === "remove")]).toEqual([never, true]);
    }
    const app = readFileSync(join(ROOT, "app.config.ts"), "utf8");
    expect(app).not.toContain("no photo library (no screen picks from the gallery)");
  });
});
