import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SlipDesk } from "../src/screens/slip-desk";
import { SessionProvider, useSession } from "../src/session";
import type { Quad } from "../src/slips/rules";

jest.mock("expo-secure-store", () => {
  let v: string | null = JSON.stringify({ token: "t1", username: "asha.devi" });
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async () => v),
    setItemAsync: jest.fn(async (_k: string, val: string) => { v = val; }),
    deleteItemAsync: jest.fn(async () => { v = null; }),
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
// The camera, reduced to what the desk uses of it: a granted permission, one read, one picture.
jest.mock("expo-camera", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  const CameraView = React.forwardRef(({ onBarcodeScanned }: { onBarcodeScanned?: (r: { data: string }) => void }, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({ takePictureAsync: async () => ({ uri: "file:///shot.jpg", width: 3000, height: 4000 }) }));
    return React.createElement(Pressable, { testID: "fake-camera", onPress: () => onBarcodeScanned?.({ data: (globalThis as { __scan?: string }).__scan ?? "" }) },
      React.createElement(Text, null, "camera"));
  });
  return { useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()], CameraView };
});
// Pixels are the phone's engine's job; the desk's flow is what is under test here.
const mockImaging = {
  found: { score: 0.9, quad: [{ x: 300, y: 400 }, { x: 2200, y: 380 }, { x: 2300, y: 3000 }, { x: 250, y: 3050 }] as Quad } as { score: number; quad: Quad } | null,
  flattenCalls: [] as { quad: Quad | null; maxEdge: number }[],
  flat: { base64: "QUJD".repeat(2000), width: 1131, height: 1600, straightened: true } as { base64: string; width: number; height: number; straightened: boolean } | null,
};
jest.mock("../src/slips/imaging", () => ({
  WORK_EDGE: 2560,
  normalize: jest.fn(async () => ({ uri: "file:///work.jpg", width: 1920, height: 2560 })),
  findPage: jest.fn(async () => mockImaging.found),
  flatten: jest.fn(async (_p: unknown, quad: Quad | null, maxEdge: number) => { mockImaging.flattenCalls.push({ quad, maxEdge }); return mockImaging.flat; }),
}));

type Reply = { status: number; body?: unknown } | "offline";
type Route = (init: RequestInit | undefined) => Reply;
function server(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    calls.push({ key, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(init);
    if (reply === "offline") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

const ME = { actor: { type: "user", id: "01J" }, permissions: { hospital: ["patients.update", "opd.visits.read"], scoped: { department: {}, floor: {} } } };
const GEETA = { uhid: "U00110049", name: "Geeta Devi", alias: null, administrativeGender: "female", dob: "1984-03-02" };
const BACK = { encounterId: "e4", patientId: "p4", visitNo: "V2610060004", serviceDate: "2026-10-06", patient: GEETA, doctorCode: "DR-0031", departmentName: "General Medicine", roomName: "R2", filed: [] };
const ROW = (over: Record<string, unknown>) => ({
  encounterId: "e4", patientId: "p4", visitNo: "V2610060004", patient: GEETA, doctorCode: "DR-0031", roomName: "R2", state: "waiting",
  tokenNo: 4, departmentCode: "MED", consultDoneAt: new Date(Date.now() - 7 * 60_000).toISOString(), filedAt: null, pages: 0, kinds: [],
  retakeRequestedAt: null, retakeReason: null, ...over,
});
const DAY = { serviceDate: "2026-10-06", items: [ROW({}), ROW({ encounterId: "e7", patientId: "p7", visitNo: "V2610060007", tokenNo: 7, departmentCode: "PED", patient: { ...GEETA, uhid: "U00110060", name: "Aarav Kumar" } })], counts: { waiting: 2, retake: 0, filed: 0 } };

function base(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/slips/today": () => ({ status: 200, body: DAY }),
    "GET /opd/visits/by-number/V2610060004": () => ({ status: 200, body: BACK }),
    "GET /opd/visits/by-number/V2610060007": () => ({ status: 200, body: { ...BACK, encounterId: "e7", patientId: "p7", visitNo: "V2610060007", patient: { ...GEETA, uhid: "U00110060", name: "Aarav Kumar" } } }),
    ...extra,
  };
}
function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <SlipDesk /> : null;
}
async function mount(fetcher: typeof fetch, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
async function find(textTyped: string) {
  await fireEvent.changeText(await screen.findByTestId("slip-visit"), textTyped);
  await fireEvent.press(screen.getByTestId("slip-find"));
}
async function photograph() {
  await fireEvent.press(await screen.findByTestId("slip-camera-open"));
  await fireEvent.press(await screen.findByTestId("cam-shoot"));
  await screen.findByTestId("crop");
}

describe("the slip desk on a phone", () => {
  beforeEach(() => {
    mockImaging.found = { score: 0.9, quad: [{ x: 300, y: 400 }, { x: 2200, y: 380 }, { x: 2300, y: 3000 }, { x: 250, y: 3050 }] };
    mockImaging.flat = { base64: "QUJD".repeat(2000), width: 1131, height: 1600, straightened: true };
    mockImaging.flattenCalls = [];
    (jest.requireMock("../src/slips/imaging") as { normalize: jest.Mock }).normalize.mockClear();
  });

  it("lists who is waiting to be photographed, with the count in the header", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    expect(await screen.findByTestId("slip-row-V2610060004")).toHaveTextContent(/Geeta Devi/);
    expect(screen.getByTestId("slip-list-toggle")).toHaveTextContent("2 waiting · List");
    expect(screen.getByTestId("step-1")).toBeTruthy();
  });

  it("reads the visit back from the SERVER before the camera can open — by visit number, any case", async () => {
    const s = server(base());
    await mount(s.fetcher);
    await find("v2610060004");
    expect(await screen.findByTestId("slip-name")).toHaveTextContent("Geeta Devi");
    expect(screen.getByTestId("slip-readback")).toHaveTextContent(/U00110049 · V2610060004 · 06-Oct-2026/);
    expect(screen.getByTestId("slip-readback")).toHaveTextContent(/Check this is the person whose slip you are holding/);
    expect(screen.getByTestId("slip-readback")).toHaveTextContent(/Doctor ID DR-0031/);
    expect(s.of("GET /opd/visits/by-number/V2610060004")).toHaveLength(1);
    expect(screen.queryByTestId("slip-camera")).toBeNull();
  });

  it.each([["MED-4", "Geeta Devi"], ["#7", "Aarav Kumar"], ["u00110060", "Aarav Kumar"], ["rx1.RX9.e4.1.sig", "Geeta Devi"]])(
    "finds the visit from %s — the token as the slip prints it, a UHID, a printed prescription's code", async (typed, name) => {
      const { fetcher } = server(base());
      await mount(fetcher);
      await screen.findByTestId("slip-row-V2610060004");
      await find(typed);
      expect(await screen.findByTestId("slip-name")).toHaveTextContent(name);
    });

  it("takes a scanned prescription QR — the bare visit number — to the read-back", async () => {
    (globalThis as { __scan?: string }).__scan = "V2610060007";
    const { fetcher } = server(base());
    await mount(fetcher);
    await fireEvent.press(await screen.findByTestId("slip-scan"));
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    expect(await screen.findByTestId("slip-name")).toHaveTextContent("Aarav Kumar");
  });

  it("a number the server does not know — or a record this desk may not see — is refused the same way, and the name search opens", async () => {
    const s = server(base({ "GET /opd/slips/find": () => ({ status: 200, body: { items: [] } }) }));
    await mount(s.fetcher);
    await find("V2610069999");
    expect(await screen.findByTestId("slip-error")).toHaveTextContent(/No visit numbered V2610069999\./);
    expect(await screen.findByTestId("slip-find-none")).toBeTruthy();
    expect(screen.queryByTestId("slip-readback")).toBeNull();
  });

  it("a torn slip: a name finds today's visit, marked as found by name", async () => {
    const s = server(base({ "GET /opd/slips/find": () => ({ status: 200, body: { items: [BACK] } }) }));
    await mount(s.fetcher);
    await find("Geeta");
    await fireEvent.press(await screen.findByTestId("slip-hit-V2610060004"));
    expect(await screen.findByTestId("slip-readback")).toHaveTextContent(/found by name — check the person/);
  });

  it("'Not this person' clears the desk without a photograph", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await find("V2610060004");
    await fireEvent.press(await screen.findByTestId("slip-not-this"));
    expect(await screen.findByTestId("slip-visit")).toBeTruthy();
    expect(screen.queryByTestId("slip-readback")).toBeNull();
  });

  it("photographs, shows the page's corners where it was found, and straightens it on 'Use this'", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await find("V2610060004");
    await photograph();
    expect(await screen.findByText("Page found — drag a corner if it is off the page's corner")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    expect(await screen.findByTestId("slip-preview")).toBeTruthy();
    expect(mockImaging.flattenCalls).toEqual([{ quad: mockImaging.found!.quad, maxEdge: 1600 }]);
    expect(screen.getByTestId("slip-page-info")).toHaveTextContent("1131 × 1600 · 6 KB");
  });

  it("says so when the edges were not found, and 'Reset to full photo' files the photo as taken", async () => {
    mockImaging.found = null;
    const { fetcher } = server(base());
    await mount(fetcher);
    await find("V2610060004");
    await photograph();
    expect(await screen.findByText("Couldn't find the edges — drag the four corners onto the page's corners")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("slip-crop-reset"));
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    await screen.findByTestId("slip-preview");
    expect(mockImaging.flattenCalls).toEqual([{ quad: null, maxEdge: 1600 }]);
  });

  it("a dragged corner moves the crop: the page is straightened from where the thumb left it", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await find("V2610060004");
    await photograph();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent(screen.getByTestId("crop"), "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 400 } } });
    const handle = await screen.findByTestId("crop-handle-tl");
    const touch = (x: number, y: number) => ({ nativeEvent: { touches: [{ pageX: x, pageY: y }], changedTouches: [{ pageX: x, pageY: y }], identifier: 1, pageX: x, pageY: y, timestamp: Date.now() }, touchHistory: { mostRecentTimeStamp: 1, numberActiveTouches: 1, indexOfSingleActiveTouch: 0, touchBank: [{ touchActive: true, startPageX: 100, startPageY: 100, startTimeStamp: 1, currentPageX: x, currentPageY: y, currentTimeStamp: 1, previousPageX: 100, previousPageY: 100, previousTimeStamp: 1 }] } });
    await fireEvent(handle, "responderGrant", touch(100, 100));
    expect(await screen.findByTestId("crop-glass")).toBeTruthy(); // the loupe shows while the corner is held
    await fireEvent(handle, "responderMove", touch(130, 140));
    await fireEvent(handle, "responderRelease", touch(130, 140));
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    await screen.findByTestId("slip-preview");
    const used = mockImaging.flattenCalls[0]!.quad!;
    expect(used[0]!.x).toBeGreaterThan(mockImaging.found!.quad[0]!.x);
    expect(used[0]!.y).toBeGreaterThan(mockImaging.found!.quad[0]!.y);
    expect(used.slice(1)).toEqual(mockImaging.found!.quad.slice(1));
  });

  it("files the page against the visit with what it is, names who it landed on, and offers the next slip", async () => {
    const s = server(base({ "POST /patients/p4/documents": () => ({ status: 201, body: { documentId: "d1" } }) }));
    await mount(s.fetcher);
    await find("V2610060004");
    await photograph();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    await fireEvent.press(await screen.findByTestId("slip-kind-outside_report"));
    await fireEvent.changeText(screen.getByTestId("slip-note"), "  brought from Patna  ");
    await fireEvent.press(screen.getByTestId("slip-file-it"));
    expect(await screen.findByTestId("slip-filed")).toHaveTextContent(/Filed against Geeta Devi/);
    expect(screen.getByTestId("slip-filed")).toHaveTextContent(/U00110049 · V2610060004/);
    expect(s.of("POST /patients/p4/documents")[0]!.body).toEqual({
      imageBase64: mockImaging.flat!.base64, mimeType: "image/jpeg", kind: "outside_report", encounterId: "e4", note: "brought from Patna",
    });
    expect((jest.requireMock("expo-haptics") as { notificationAsync: jest.Mock }).notificationAsync).toHaveBeenCalledWith("success");
    await fireEvent.press(screen.getByTestId("slip-next"));
    expect(screen.queryByTestId("slip-filed")).toBeNull();
    expect(screen.getByTestId("slip-visit")).toBeTruthy();
  });

  it("never queues: with no network the photo and the crop stay, the line says nothing was sent, and Try again files it", async () => {
    let online = false;
    const s = server(base({ "POST /patients/p4/documents": () => (online ? { status: 201, body: { documentId: "d1" } } : "offline") }));
    await mount(s.fetcher);
    await find("V2610060004");
    await photograph();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    await fireEvent.press(await screen.findByTestId("slip-file-it"));
    expect(await screen.findByTestId("slip-error")).toHaveTextContent(/Not filed — the server could not be reached\. Nothing was sent\./);
    expect(screen.getByTestId("slip-preview")).toBeTruthy();
    expect(screen.getByTestId("slip-crop-adjust")).toBeTruthy();
    expect(screen.queryByTestId("slip-filed")).toBeNull();
    expect(screen.getByTestId("slip-file-it")).toHaveTextContent("Try again");
    online = true;
    await fireEvent.press(screen.getByTestId("slip-file-it"));
    expect(await screen.findByTestId("slip-filed")).toBeTruthy();
    expect(s.of("POST /patients/p4/documents")).toHaveLength(2);
  });

  it("shows the server's refusal and keeps the page", async () => {
    const s = server(base({ "POST /patients/p4/documents": () => ({ status: 413, body: { code: "document_too_large", message: "document exceeds 1500000 bytes — the client must downscale" } }) }));
    await mount(s.fetcher);
    await find("V2610060004");
    await photograph();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    await fireEvent.press(await screen.findByTestId("slip-file-it"));
    expect(await screen.findByTestId("slip-error")).toHaveTextContent(/Not filed — document exceeds 1500000 bytes/);
    expect(screen.getByTestId("slip-preview")).toBeTruthy();
  });

  it("refuses a page that cannot be brought inside the server's size, before asking the server", async () => {
    mockImaging.flat = null;
    const s = server(base());
    await mount(s.fetcher);
    await find("V2610060004");
    await photograph();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    expect(await screen.findByTestId("slip-error")).toHaveTextContent(/too large even after downscaling/);
    expect(s.of("POST /patients/p4/documents")).toEqual([]);
  });

  it("'Adjust the crop' goes back to the same photo, and a second page says it is page 2", async () => {
    const s = server(base({
      "GET /opd/visits/by-number/V2610060004": () => ({ status: 200, body: { ...BACK, filed: [{ id: "d0", kind: "consult_prescription", capturedAt: "2026-10-06T05:00:00.000Z", retakeRequestedAt: null }] } }),
    }));
    await mount(s.fetcher);
    await find("V2610060004");
    expect(await screen.findByTestId("slip-onfile")).toHaveTextContent(/Already on file — this adds page 2/);
    await photograph();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    await fireEvent.press(await screen.findByTestId("slip-crop-adjust"));
    expect(await screen.findByTestId("crop")).toBeTruthy();
    expect((jest.requireMock("../src/slips/imaging") as { normalize: jest.Mock }).normalize).toHaveBeenCalledTimes(1);
  });

  it("says when the page could only be cut, not straightened, on this phone", async () => {
    mockImaging.flat = { base64: "QUJD".repeat(100), width: 900, height: 1200, straightened: false };
    const { fetcher } = server(base());
    await mount(fetcher);
    await find("V2610060004");
    await photograph();
    await waitFor(() => expect(screen.getByTestId("slip-crop-use")).not.toBeDisabled());
    await fireEvent.press(screen.getByTestId("slip-crop-use"));
    expect(await screen.findByTestId("slip-flat-only")).toBeTruthy();
  });

  it("speaks Hindi", async () => {
    const { fetcher } = server(base());
    await mount(fetcher, "hi");
    expect(await screen.findByText("पर्ची डेस्क")).toBeTruthy();
  });
});
