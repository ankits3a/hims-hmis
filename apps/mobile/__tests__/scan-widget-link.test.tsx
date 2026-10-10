import { Stack } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as LocalAuthentication from "expo-local-authentication";
import Index from "../app/index";
import ScanPage from "../app/scan";
import { unstable_settings } from "../app/_layout";
import { I18nProvider } from "../src/i18n";
import { SessionProvider } from "../src/session";

/**
 * HOME-SCREEN SCAN WIDGET (owner 2026-10-10, decision 0064 E1.1; spec Part A checks 2–4). The widget
 * opens `hmis://scan`, which expo-router reads as the path "/scan". These run the REAL router over
 * the app's own "/" and "/scan" routes, started at "/scan" as a cold start from the widget is.
 */
const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));
const mockBio = { on: false };
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => mockBio.on),
  isEnrolledAsync: jest.fn(async () => mockBio.on),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
jest.mock("expo-camera", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
    CameraView: () => React.createElement(View, { testID: "fake-camera" }),
  };
});

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.visits.read", "opd.queue.read", "opd.vitals.record"], scoped: { department: {}, floor: {} } } };
const fetcher = (async (url: string, init?: RequestInit) => {
  const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
  if (key === "GET /auth/me") return new Response(JSON.stringify(ME), { status: 200 });
  if (key === "POST /auth/login") return new Response(JSON.stringify({ token: "t2" }), { status: 200 });
  return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
}) as unknown as typeof fetch;

function Layout() {
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Stack screenOptions={{ headerShown: false }} /></SessionProvider></I18nProvider>
    </SafeAreaProvider>
  );
}
// RNTL 14's render is a promise; renderRouter hangs its readers on that promise, so keep it and await it separately.
const at = async (initialUrl: string) => {
  const r = renderRouter({ _layout: { default: Layout, unstable_settings }, index: Index, scan: ScanPage }, { initialUrl });
  await r;
  // The app's Stack sits under expo-router's own "__root".
  return { pathname: () => r.getPathname(), stack: () => (r.getRouterState()?.routes[0]?.state?.routes ?? []).map((x) => x.name) };
};
const fromWidget = () => at("/scan");

beforeEach(() => {
  mockStore.clear();
  mockBio.on = false;
  (LocalAuthentication.authenticateAsync as jest.Mock).mockClear();
});

describe("the scan widget's link, hmis://scan", () => {
  it("signed out: sign-in first, then the scan screen with the camera — not the home screen", async () => {
    const r = await fromWidget();
    await screen.findByTestId("username");
    await fireEvent.changeText(screen.getByTestId("username"), "asha.devi");
    await fireEvent.changeText(screen.getByTestId("password"), "correct horse");
    await fireEvent.press(screen.getByTestId("sign-in"));
    await screen.findByTestId("scan-screen");
    expect(screen.getByTestId("fake-camera")).toBeTruthy();
    expect(r.pathname()).toBe("/scan");
    // Home is under it: Back from the scan screen lands on the home screen, not out of the app.
    expect(r.stack()).toEqual(["index", "scan"]);
  });

  it("cold start behind the fingerprint: one unlock, then the scan screen", async () => {
    mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" }));
    mockBio.on = true;
    const r = await fromWidget();
    await screen.findByTestId("scan-screen");
    expect(r.pathname()).toBe("/scan");
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(r.stack()).toEqual(["index", "scan"]);
  });

  it("signed in, no fingerprint: straight to the scan screen, home under it", async () => {
    mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" }));
    const r = await fromWidget();
    await screen.findByTestId("scan-screen");
    expect(r.pathname()).toBe("/scan");
    expect(r.stack()).toEqual(["index", "scan"]);
  });

  it("the app already open on home: the link goes straight to the scan screen", async () => {
    mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" }));
    const r = await at("/");
    await screen.findByTestId("band-scan");
    const { router } = require("expo-router") as typeof import("expo-router");
    await act(async () => { router.push("/scan"); });
    await screen.findByTestId("scan-screen");
    expect(r.pathname()).toBe("/scan");
    await waitFor(() => expect(r.stack()).toEqual(["index", "scan"]));
  });
});
