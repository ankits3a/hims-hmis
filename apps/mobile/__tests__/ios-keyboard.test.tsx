import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AppState, KeyboardAvoidingView, Platform, TextInput as RNTextInput } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { PrivacyCover } from "../src/privacy-cover";
import { coveredWhen } from "../src/privacy";
import { LoginScreen } from "../src/screens/login";
import { SessionProvider } from "../src/session";
import type { TextInput } from "../src/text";
import { Field, KeyboardModal, keyboardScroll, keyboardScrollInsets } from "../src/ui";

/*
  THE iPHONE'S KEYBOARD (owner 2026-10-09, TestFlight: "In the login screen, keyboard didn't popup
  when wanted to type in input field … the input should be modal responsive with keyboard").
  Platform.OS is "ios" unless a test says Android out loud; production config, so the switcher cover
  is live (the worst case for a cover over a field being typed in).
*/
jest.mock("../src/config", () => ({
  API_BASE: "https://hmis.crkmch.com/api", APP_ENV: "production", IS_PRODUCTION: true,
  APP_VERSION: "0.15.2", APP_VERSION_CODE: 1, UPDATE_FEED: "https://hmis.crkmch.com/app/hmis-staff-production-latest.json",
  PUSH_IN_BUILD: false,
}));
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined), deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

const realOS = Platform.OS;
const setOS = (os: string) => { (Platform as { OS: string }).OS = os; };
beforeEach(() => setOS("ios"));
afterAll(() => setOS(realOS));

async function login() {
  const fetcher = jest.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><LoginScreen /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
  return screen.findByTestId("username");
}

describe("Field — the whole bordered row raises the keyboard", () => {
  it("a tap on the row (not only on the text line) focuses its input", async () => {
    const ref = createRef<TextInput>();
    await render(<Field ref={ref} label="Username" value="" onChangeText={() => undefined} testID="u" />);
    expect(ref.current).not.toBeNull(); // the ref reaches the TextInput itself
    const focus = jest.spyOn(ref.current!, "focus");
    fireEvent.press(screen.getByTestId("u-row"));
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("the row is not a second screen-reader stop: the input keeps its label", async () => {
    await render(<Field label="Password" value="" onChangeText={() => undefined} testID="p" secure revealLabel="SHOW" hideLabel="HIDE" />);
    expect(screen.getByTestId("p-row").props.accessible).toBe(false);
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });
});

describe("Sign-in on an iPhone", () => {
  it("opens with the keyboard up on the username; 'next' moves to the password", async () => {
    const user = await login();
    expect(user.props.autoFocus).toBe(true);
    expect(user.props.returnKeyType).toBe("next");
    expect(user.props.submitBehavior).toBe("submit");
    const focus = jest.spyOn(RNTextInput.prototype as unknown as { focus: () => void }, "focus");
    await act(async () => { fireEvent(user, "submitEditing"); });
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });

  it("Android: no keyboard forced up on open (unchanged)", async () => {
    setOS("android");
    const user = await login();
    expect(user.props.autoFocus).toBe(false);
  });
});

describe("Sheets lift above the keyboard", () => {
  it("KeyboardModal pads for the keyboard on iOS and on Android (edge-to-edge: Android no longer resizes a Modal)", async () => {
    const seen = jest.spyOn(KeyboardAvoidingView.prototype, "render");
    const behaviour = () => (seen.mock.contexts.at(-1) as { props: { behavior?: string; style?: unknown } }).props;
    const ios = await render(<KeyboardModal visible><RNTextInput testID="in" /></KeyboardModal>);
    expect(behaviour().behavior).toBe("padding");
    expect(behaviour().style).toEqual({ flex: 1 });
    expect(screen.getByTestId("keyboard-sheet")).toContainElement(screen.getByTestId("in"));
    await ios.unmount();
    setOS("android");
    await render(<KeyboardModal visible><RNTextInput testID="in" /></KeyboardModal>);
    expect(behaviour().behavior).toBe("padding");
    expect(screen.getByTestId("keyboard-sheet")).toContainElement(screen.getByTestId("in"));
    seen.mockRestore();
  });

  it("scroll views: iOS drags the keyboard down and keeps taps; only a bare screen insets itself; Android gets nothing new", () => {
    expect(keyboardScroll()).toEqual({ keyboardShouldPersistTaps: "handled", keyboardDismissMode: "interactive" });
    expect(keyboardScrollInsets()).toEqual({ keyboardShouldPersistTaps: "handled", keyboardDismissMode: "interactive", automaticallyAdjustKeyboardInsets: true });
    setOS("android");
    expect(keyboardScroll()).toEqual({});
    expect(keyboardScrollInsets()).toEqual({});
  });

  it("no screen opens a bare Modal: every one in src/ and app/ goes through KeyboardModal", () => {
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk(join(root, "src"));
    walk(join(root, "app"));
    const bare = files.filter((f) => !f.endsWith(join("src", "ui.tsx"))).filter((f) => /<Modal[\s>]/.test(readFileSync(f, "utf8")));
    expect(bare).toEqual([]);
    const sheets = files.filter((f) => readFileSync(f, "utf8").includes("<KeyboardModal"));
    // The Aadhaar card, the approval and cover sheets, the doctor's skip/complete sheet, the consult drawers, …
    expect(sheets.length).toBeGreaterThanOrEqual(19);
    expect(sheets.some((f) => f.endsWith(join("attendance", "aadhaar-card.tsx")))).toBe(true);
  });
});

describe("The switcher cover never blanks a field being typed in", () => {
  it("'inactive' with an input focused (AutoFill / Face ID sheet) is not covered; 'background' always is", () => {
    expect(coveredWhen("inactive", true)).toBe(false);
    expect(coveredWhen("background", true)).toBe(true);
    expect(coveredWhen("inactive", false)).toBe(true);
    expect(coveredWhen("active", false)).toBe(false);
  });

  it("PrivacyCover reads the focused input when the app goes inactive", async () => {
    let change: ((s: string) => void) | null = null;
    const listen = jest.spyOn(AppState, "addEventListener").mockImplementation(((_e: string, cb: (s: string) => void) => { change = cb; return { remove: jest.fn() }; }) as never);
    const focused = jest.spyOn(RNTextInput.State, "currentlyFocusedInput").mockReturnValue({} as never);
    await render(<PrivacyCover />);
    await act(async () => { change!("inactive"); });
    expect(screen.queryByTestId("privacy-cover")).toBeNull();
    await act(async () => { change!("background"); });
    expect(screen.getByTestId("privacy-cover")).toBeTruthy();
    await act(async () => { change!("active"); });
    focused.mockReturnValue(null as never);
    await act(async () => { change!("inactive"); });
    expect(screen.getByTestId("privacy-cover")).toBeTruthy();
    focused.mockRestore();
    listen.mockRestore();
  });
});
