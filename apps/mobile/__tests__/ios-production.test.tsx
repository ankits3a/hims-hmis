import { act, render, screen } from "@testing-library/react-native";
import { AppState, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { statusOf } from "../src/notifications";
import { PrivacyCover } from "../src/privacy-cover";
import { SCREENSHOTS_BLOCKED, SWITCHER_BLANKED, coveredWhen, guardScreen } from "../src/privacy";
import { devicePush } from "../src/push-phone";
import { AccountScreen } from "../src/screens/account";
import { SessionProvider, useSession } from "../src/session";

/*
  THE iPHONE'S PRODUCTION BUILD. `Platform.OS` is "ios" and the build says it is production AND that
  Firebase was in it — the worst case for the two guards here: nothing of Android's may run.
*/
jest.mock("../src/config", () => ({
  API_BASE: "https://hmis.crkmch.com/api", APP_ENV: "production", IS_PRODUCTION: true,
  APP_VERSION: "0.13.0", APP_VERSION_CODE: 1, UPDATE_FEED: "https://hmis.crkmch.com/app/hmis-staff-production-latest.json",
  PUSH_IN_BUILD: true,
}));
const mockPrevent = jest.fn(async () => undefined), mockCover = jest.fn(async (_blur?: number) => undefined);
jest.mock("expo-screen-capture", () => ({ preventScreenCaptureAsync: () => mockPrevent(), enableAppSwitcherProtectionAsync: (b?: number) => mockCover(b) }));
const mockNotificationsLoaded = jest.fn();
jest.mock("expo-notifications", () => { mockNotificationsLoaded(); return { getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), getDevicePushTokenAsync: jest.fn(), setNotificationHandler: jest.fn() }; });
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha.devi", since: "2026-10-06T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

const realOS = Platform.OS;
beforeAll(() => { (Platform as { OS: string }).OS = "ios"; });
afterAll(() => { (Platform as { OS: string }).OS = realOS; });

describe("iPhone, production — the app is hidden in the app switcher; Android's screenshot flag is never set", () => {
  it("calls no FLAG_SECURE; asks the installed module for its switcher cover; a phone where that fails still opens", async () => {
    expect(SCREENSHOTS_BLOCKED).toBe(false);
    expect(SWITCHER_BLANKED).toBe(true);
    await guardScreen();
    expect(mockPrevent).not.toHaveBeenCalled();
    expect(mockCover).toHaveBeenCalledTimes(1);
    mockCover.mockRejectedValueOnce(new Error("native module missing"));
    await expect(guardScreen()).resolves.toBeUndefined();
    expect(mockPrevent).not.toHaveBeenCalled();
  });

  it("covers on 'inactive' and on 'background', and only uncovers on 'active'", () => {
    expect(coveredWhen("inactive")).toBe(true);
    expect(coveredWhen("background")).toBe(true);
    expect(coveredWhen("active")).toBe(false);
  });

  it("draws a blank sheet over the app the moment it stops being in front, and lifts it when it is back", async () => {
    let change: ((s: string) => void) | null = null;
    const remove = jest.fn();
    const listen = jest.spyOn(AppState, "addEventListener").mockImplementation(((_e: string, cb: (s: string) => void) => { change = cb; return { remove }; }) as never);
    const view = await render(<PrivacyCover />);
    expect(listen).toHaveBeenCalledWith("change", expect.any(Function));
    expect(screen.queryByTestId("privacy-cover")).toBeNull();
    await act(async () => { change!("inactive"); });
    expect(screen.getByTestId("privacy-cover")).toBeTruthy();
    // It must never swallow a touch: a cover that outlives its moment cannot lock the nurse out.
    expect(screen.getByTestId("privacy-cover").props.pointerEvents).toBe("none");
    await act(async () => { change!("background"); });
    expect(screen.getByTestId("privacy-cover")).toBeTruthy();
    await act(async () => { change!("active"); });
    expect(screen.queryByTestId("privacy-cover")).toBeNull();
    await view.unmount();
    expect(remove).toHaveBeenCalled();
    listen.mockRestore();
  });

  it("the Account screen says what an iPhone really does — not 'blocked', not 'staging' — and offers no update check", async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.endsWith("/api/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } }), { status: 200 });
      return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    }) as unknown as typeof fetch;
    function Gate() {
      const { state } = useSession();
      return state.status === "signedIn" ? <AccountScreen /> : null;
    }
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
      </SafeAreaProvider>,
    );
    expect(await screen.findByTestId("account-screenshots")).toHaveTextContent("Not blocked on iPhone. The app is hidden in the app switcher.");
    expect(screen.queryByTestId("account-update-check")).toBeNull();
    expect(screen.getByTestId("back")).toBeTruthy(); // an iPhone has no Back key: the screen carries its own
  });
});

describe("iPhone — notifications are dormant in this version, even in a build that carries Firebase's flag", () => {
  it("is 'not in this build': nothing asks for permission, no address is fetched, the notification module is never loaded", async () => {
    const phone = devicePush();
    expect(phone.inBuild).toBe(false);
    expect(await phone.ask()).toBe("denied");
    expect(await phone.token()).toBeNull();
    expect(await phone.permission()).toBe("undetermined");
    expect(mockNotificationsLoaded).not.toHaveBeenCalled();
    expect(statusOf(phone.inBuild, "ok" as never, null, "undetermined")).toBe("notInBuild");
  });
});
