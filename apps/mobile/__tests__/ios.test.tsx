import { act, render, screen } from "@testing-library/react-native";
import { AppState, Platform, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { biometricWord, fineMoneyKey, useBiometricWord } from "../src/biometric";
import { _forgetDeviceForTests, describePhone, deviceClaim } from "../src/device";
import { I18nProvider, translate, useI18n } from "../src/i18n";
import { PrivacyCover } from "../src/privacy-cover";
import { SCREENSHOTS_BLOCKED, SWITCHER_BLANKED, guardScreen } from "../src/privacy";
import { SeatHome } from "../src/screens/seat-home";
import { SessionProvider, useSession } from "../src/session";
import { checkForUpdate, updatesFromFeed } from "../src/update";
import { bpKeyboard } from "../src/vitals/capture";

/*
  THE iPHONE'S ANSWERS (owner 2026-10-08: about 100 iPhone users). Every test here runs the iOS
  branch: `Platform.OS` is "ios" for the whole file, said out loud rather than left to the preset.
  This file is the STAGING configuration; the production-only guards are in ios-production.test.tsx.
*/
const mockStore = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" })]]);
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));
const mockSupported = jest.fn(async (): Promise<number[]> => [2]);
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })),
  supportedAuthenticationTypesAsync: () => mockSupported(),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
const mockPrevent = jest.fn(async () => undefined), mockCover = jest.fn(async () => undefined);
jest.mock("expo-screen-capture", () => ({ preventScreenCaptureAsync: () => mockPrevent(), enableAppSwitcherProtectionAsync: () => mockCover() }));

const realOS = Platform.OS;
beforeAll(() => { (Platform as { OS: string }).OS = "ios"; });
afterAll(() => { (Platform as { OS: string }).OS = realOS; });

const FEED = "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json";
const NEWER = { versionCode: 99999, versionName: "9.9.9", apk: "hmis-staff-staging-9.9.9-vc99999-abc12345.apk", sha256: "a".repeat(64), notes: "A newer Android build" };

describe("iPhone — updates come from the App Store, never from the hospital's APK folder", () => {
  it("does not read the feed at all, and offers nothing", async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify(NEWER), { status: 200 })) as unknown as typeof fetch;
    expect(updatesFromFeed()).toBe(false);
    expect(await checkForUpdate(fetcher, 1, FEED)).toEqual({ kind: "store" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("the home screen shows its version, no update prompt and no 'Check for update' — even when the folder holds a newer APK", async () => {
    const asked: string[] = [];
    const fetcher = jest.fn(async (url: string) => {
      asked.push(url);
      if (url === FEED) return new Response(JSON.stringify(NEWER), { status: 200 });
      if (url.endsWith("/api/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "01J" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } }), { status: 200 });
      return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    }) as unknown as typeof fetch;
    function Gate() {
      const { state } = useSession();
      return state.status === "signedIn" ? <SeatHome /> : null;
    }
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
      </SafeAreaProvider>,
    );
    expect(await screen.findByTestId("app-version")).toBeTruthy();
    expect(screen.queryByTestId("update-check")).toBeNull();
    expect(screen.queryByTestId("update-offer")).toBeNull();
    expect(asked).not.toContain(FEED);
    expect(asked.some((u) => u.endsWith(".json") || u.endsWith(".apk"))).toBe(false);
  });
});

describe("iPhone — what the phone says it is", () => {
  it("names itself an iPhone with its iOS version, and never the owner's own name for it", () => {
    const said = describePhone();
    expect(said.model).toBe("iPhone");
    expect(said.os).toMatch(/^iOS \S+/);
    expect(said.os).not.toMatch(/Android/);
  });

  it("the id it makes up once is kept in the secure store, under its own key", async () => {
    _forgetDeviceForTests();
    mockStore.delete("hmis.device");
    const first = await deviceClaim();
    expect(first?.deviceId).toMatch(/^[0-9a-f]{32}$/);
    expect(mockStore.get("hmis.device")).toBe(first?.deviceId);
    _forgetDeviceForTests();
    expect((await deviceClaim())?.deviceId).toBe(first?.deviceId);
    expect(first?.model).toBe("iPhone");
  });
});

describe("iPhone — the phone's own lock is Face ID or Touch ID, never 'fingerprint'", () => {
  it("picks the word from what the phone says it has; Android keeps 'fingerprint' whatever it has", () => {
    expect(biometricWord("ios", [2])).toBe("faceId");
    expect(biometricWord("ios", [1])).toBe("touchId");
    expect(biometricWord("ios", [])).toBe("apple");
    expect(biometricWord("ios", null)).toBe("apple");
    expect(biometricWord("ios", [1, 2])).toBe("apple");
    expect(biometricWord("android", [2])).toBe("fingerprint");
    expect(fineMoneyKey("fingerprint")).toBe("home.sheet.fineMoney");
  });

  it("says so in English and in Hindi, and no iPhone sentence says fingerprint", () => {
    expect(translate("en", fineMoneyKey("faceId"))).toBe("Face ID is asked before a money approval. Recorded with your name, time and note.");
    expect(translate("en", fineMoneyKey("apple"))).toMatch(/^Touch ID \/ Face ID is asked/);
    expect(translate("hi", fineMoneyKey("faceId"))).toContain("Face ID माँगा जाता है");
    expect(translate("hi", fineMoneyKey("apple"))).toContain("Touch ID / Face ID");
    for (const lang of ["en", "hi"] as const) for (const w of ["faceId", "touchId", "apple"] as const) {
      expect(translate(lang, fineMoneyKey(w))).not.toMatch(/fingerprint|फ़िंगरप्रिंट/i);
    }
  });

  function Probe() {
    const { t } = useI18n();
    return <Text testID="fine">{t(fineMoneyKey(useBiometricWord()))}</Text>;
  }
  it("a Face ID phone reads 'Face ID'; a phone that will not say reads 'Touch ID / Face ID'", async () => {
    mockSupported.mockResolvedValueOnce([2]);
    const first = await render(<I18nProvider><Probe /></I18nProvider>);
    expect(await screen.findByText(/^Face ID is asked before a money approval/)).toBeTruthy();
    await first.unmount();
    mockSupported.mockRejectedValueOnce(new Error("no answer"));
    await render(<I18nProvider><Probe /></I18nProvider>);
    expect(await screen.findByText(/^Touch ID \/ Face ID is asked before a money approval/)).toBeTruthy();
  });
});

describe("iPhone — the BP box's keyboard", () => {
  it("is 'numbers and punctuation', the one iPhone pad that carries the separators a BP is typed with; Android keeps its phone pad", () => {
    expect(bpKeyboard("ios")).toBe("numbers-and-punctuation");
    expect(bpKeyboard("android")).toBe("phone-pad");
    expect(bpKeyboard("web")).toBe("phone-pad");
  });
});

describe("iPhone — the staging build hides nothing, like Android's", () => {
  it("no screenshot flag, no switcher cover, and going to the background draws nothing", async () => {
    const listen = jest.spyOn(AppState, "addEventListener");
    expect(SCREENSHOTS_BLOCKED).toBe(false);
    expect(SWITCHER_BLANKED).toBe(false);
    await guardScreen();
    expect(mockPrevent).not.toHaveBeenCalled();
    expect(mockCover).not.toHaveBeenCalled();
    await render(<PrivacyCover />);
    // Whoever else listens to the app's state, nothing that hears "inactive" draws a cover here.
    for (const [event, heard] of listen.mock.calls) if (event === "change") await act(async () => { (heard as (s: string) => void)("inactive"); });
    expect(screen.queryByTestId("privacy-cover")).toBeNull();
    listen.mockRestore();
  });
});
