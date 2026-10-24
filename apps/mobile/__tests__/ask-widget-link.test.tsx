import { Stack } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as LocalAuthentication from "expo-local-authentication";
import Index from "../app/index";
import CopilotPage from "../app/copilot";
import { unstable_settings } from "../app/_layout";
import { _resetCopilotSettingForTests } from "../src/copilot/setting";
import { VOICE_ASK } from "../src/copilot/voice";
import { I18nProvider } from "../src/i18n";
import { SessionProvider } from "../src/session";

/**
 * #590 (plan E1.7) — THE ASK WIDGET'S LINK, `hmis://copilot?keyboard=1`, which expo-router reads as
 * "/copilot" with `keyboard=1`. These run the REAL router over the app's own "/" and "/copilot" routes
 * (and a stand-in "/settings"), started at the widget's link as a cold start from the widget is.
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

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.queue.read", "roster.read"], scoped: { department: {}, floor: {} } } };
/** The copilot setting's answer; `hold` keeps it in flight until released. */
const setting = { phone: true, hold: null as Promise<void> | null };
const fetcher = (async (url: string, init?: RequestInit) => {
  const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
  if (key === "GET /auth/me") return new Response(JSON.stringify(ME), { status: 200 });
  if (key === "POST /auth/login") return new Response(JSON.stringify({ token: "t2" }), { status: 200 });
  if (key === "GET /copilot/setting") {
    if (setting.hold !== null) await setting.hold;
    return new Response(JSON.stringify({ phone: setting.phone }), { status: 200 });
  }
  if (key === "GET /copilot/notice") return new Response(JSON.stringify({ seen: true }), { status: 200 });
  return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
}) as unknown as typeof fetch;

function Layout() {
  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Stack screenOptions={{ headerShown: false }} /></SessionProvider></I18nProvider>
    </SafeAreaProvider>
  );
}
const SettingsStandIn = () => <Text testID="settings-page">settings</Text>;
// RNTL 14's render is a promise; renderRouter hangs its readers on that promise, so keep it and await it separately.
const at = async (initialUrl: string) => {
  const r = renderRouter({ _layout: { default: Layout, unstable_settings }, index: Index, copilot: CopilotPage, settings: SettingsStandIn }, { initialUrl });
  await r;
  // The app's Stack sits under expo-router's own "__root".
  return { pathname: () => r.getPathname(), stack: () => (r.getRouterState()?.routes[0]?.state?.routes ?? []).map((x) => x.name) };
};
const fromWidget = () => at("/copilot?keyboard=1");
const signedIn = () => { mockStore.set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" })); };

beforeEach(() => {
  mockStore.clear();
  mockBio.on = false;
  setting.phone = true;
  setting.hold = null;
  _resetCopilotSettingForTests();
  (LocalAuthentication.authenticateAsync as jest.Mock).mockClear();
});

describe("the Ask widget's link, hmis://copilot?keyboard=1", () => {
  it("signed out: sign-in first, then the copilot with the keyboard up — not the home screen", async () => {
    const r = await fromWidget();
    await screen.findByTestId("username");
    await fireEvent.changeText(screen.getByTestId("username"), "asha.devi");
    await fireEvent.changeText(screen.getByTestId("password"), "correct horse");
    await fireEvent.press(screen.getByTestId("sign-in"));
    await screen.findByTestId("copilot-chips");
    expect(screen.getByTestId("copilot-input").props.autoFocus).toBe(true);
    expect(r.pathname()).toBe("/copilot");
    // Home is under it: Back from the copilot lands on the home screen, not out of the app.
    expect(r.stack()).toEqual(["index", "copilot"]);
  });

  it("cold start behind the fingerprint: one unlock, then the copilot", async () => {
    signedIn();
    mockBio.on = true;
    const r = await fromWidget();
    await screen.findByTestId("copilot-chips");
    expect(screen.getByTestId("copilot-input").props.autoFocus).toBe(true);
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(r.pathname()).toBe("/copilot");
    expect(r.stack()).toEqual(["index", "copilot"]);
  });

  it("signed in: straight to the copilot — not bounced to Settings while the copilot setting is still being read", async () => {
    signedIn();
    let release!: () => void;
    setting.hold = new Promise<void>((done) => { release = done; });
    const r = await fromWidget();
    await waitFor(() => expect(r.pathname()).toBe("/copilot"));
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(screen.queryByTestId("copilot-chips")).toBeNull();
    await act(async () => { release(); });
    await screen.findByTestId("copilot-chips");
    expect(screen.getByTestId("copilot-input").props.autoFocus).toBe(true);
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(r.stack()).toEqual(["index", "copilot"]);
  });

  it("the copilot turned off for this person: Settings, where it is turned on", async () => {
    signedIn();
    setting.phone = false;
    await fromWidget();
    await screen.findByTestId("settings-page");
    expect(screen.queryByTestId("copilot-input")).toBeNull();
  });

  it("the app already open on home: the link goes straight to the copilot", async () => {
    signedIn();
    const r = await at("/");
    await screen.findByTestId("band-scan");
    const { router } = require("expo-router") as typeof import("expo-router");
    await act(async () => { router.push("/copilot?keyboard=1"); });
    await screen.findByTestId("copilot-chips");
    expect(screen.getByTestId("copilot-input").props.autoFocus).toBe(true);
    expect(r.pathname()).toBe("/copilot");
    await waitFor(() => expect(r.stack()).toEqual(["index", "copilot"]));
  });

  it("opened from inside the app (the header's copilot mark), the keyboard waits for a tap", async () => {
    signedIn();
    await at("/copilot");
    await screen.findByTestId("copilot-chips");
    expect(screen.getByTestId("copilot-input").props.autoFocus).toBe(false);
  });
});

describe("without ruling R-2, no microphone is drawn", () => {
  it("is off in this build", () => {
    expect(VOICE_ASK).toBe(false);
  });

  it("even a mic link (hmis://copilot?mic=1) gets no mic: the box with the keyboard up instead", async () => {
    signedIn();
    const r = await at("/copilot?mic=1");
    await screen.findByTestId("copilot-chips");
    expect(screen.queryByTestId("copilot-voice-start")).toBeNull();
    expect(screen.queryByTestId("copilot-voice-stop")).toBeNull();
    expect(screen.getByTestId("copilot-input").props.autoFocus).toBe(true);
    expect(r.pathname()).toBe("/copilot");
  });
});
