import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../../src/i18n";
import { SessionProvider, useSession } from "../../src/session";
import { SettingsScreen } from "../../src/screens/settings";
import { API_BASE } from "../../src/config";
import en from "../../src/locales/en.json";
import hi from "../../src/locales/hi.json";

/**
 * SPEC #629 D5 — docs/specs/629-privacy-page.md (owner APPROVED 2026-10-23): phone Settings carries a
 * "Privacy policy" row, worded in English and Hindi, that opens the page on the app's own server.
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha", since: new Date().toISOString() })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }), useLocalSearchParams: () => ({}) }));

const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
  const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
  if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u-asha" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200 });
  if (key === "GET /copilot/setting") return new Response(JSON.stringify({ phone: false }), { status: 200 });
  return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
}) as unknown as typeof fetch;

function Signed() {
  const { state } = useSession();
  return state.status !== "signedIn" ? null : <SettingsScreen />;
}

it("spec #629 D5: Settings shows Privacy policy in both languages and opens <server>/privacy.html", async () => {
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Signed /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
  const row = await screen.findByTestId("settings-privacy");
  expect(screen.getByText("Privacy policy")).toBeTruthy();
  const label = (hi as { settings: Record<string, string> }).settings.privacy;
  expect(typeof label).toBe("string");
  expect(label).not.toBe((en as { settings: Record<string, string> }).settings.privacy);
  await fireEvent.press(row);
  const server = API_BASE.replace(/\/api\/?$/, "");
  expect(open).toHaveBeenCalledWith(`${server}/privacy.html`);
});
