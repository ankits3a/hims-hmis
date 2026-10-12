import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SessionProvider, useSession } from "../src/session";
import { SettingsScreen } from "../src/screens/settings";
import { Band } from "../src/ui";
import { _resetCopilotSettingForTests } from "../src/copilot/setting";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }), useLocalSearchParams: () => ({}) }));

/**
 * PHONE SETTINGS (owner 2026-10-11, spec /opt/hmis-context/SPEC-phone-settings-2026-10-11.md): the gear
 * replaces the language word and Log out; the copilot is OFF until turned on here, and the switch is the
 * account's (`PUT /copilot/setting`). Done-means 1, 2, 4 and 6 are here; 3 and 5 are in flow.test.tsx.
 */
function server(phone: boolean, putOk = true) {
  const calls: { key: string; body: unknown }[] = [];
  let on = phone;
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ key, body });
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u-asha" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } }), { status: 200 });
    if (key === "GET /copilot/setting") return new Response(JSON.stringify({ phone: on }), { status: 200 });
    if (key === "PUT /copilot/setting") {
      if (!putOk) throw new TypeError("Network request failed");
      on = (body as { phone: boolean }).phone;
      return new Response(JSON.stringify({ phone: on }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}
function Both() {
  const { state } = useSession();
  return state.status !== "signedIn" ? null : (<><Band /><SettingsScreen /></>);
}
const mount = async (fetcher: typeof fetch) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Both /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);

beforeEach(() => { mockPush.mockReset(); _resetCopilotSettingForTests(); });

describe("phone settings (owner 2026-10-11)", () => {
  it("signed in: the band has the gear and no language word, and no copilot icon while the copilot is off", async () => {
    const s = server(false);
    await mount(s.fetcher);
    const gears = await screen.findAllByTestId("band-settings");
    await fireEvent.press(gears[0]!);
    expect(mockPush).toHaveBeenCalledWith("/settings");
    expect(screen.queryByTestId("lang-toggle")).toBeNull();
    await waitFor(() => expect(s.calls.map((c) => c.key)).toContain("GET /copilot/setting"));
    expect(screen.queryByTestId("band-copilot")).toBeNull();
    expect(screen.getByTestId("settings-copilot-switch").props.value).toBe(false);
  });

  it("turning the copilot on saves it to the account and shows the icon at once; off hides it again", async () => {
    const s = server(false);
    await mount(s.fetcher);
    await screen.findByTestId("settings-copilot-switch");
    await fireEvent(screen.getByTestId("settings-copilot-switch"), "valueChange", true);
    expect(await screen.findAllByTestId("band-copilot")).toHaveLength(1);
    expect(s.calls.filter((c) => c.key === "PUT /copilot/setting").map((c) => c.body)).toEqual([{ phone: true }]);
    await fireEvent(screen.getByTestId("settings-copilot-switch"), "valueChange", false);
    await waitFor(() => expect(screen.queryByTestId("band-copilot")).toBeNull());
  });

  it("an account already turned on shows the icon after sign-in (another phone)", async () => {
    await mount(server(true).fetcher);
    expect((await screen.findAllByTestId("band-copilot")).length).toBeGreaterThan(0);
  });

  it("no signal: the switch goes back and says so", async () => {
    await mount(server(false, false).fetcher);
    await screen.findByTestId("settings-copilot-switch");
    await fireEvent(screen.getByTestId("settings-copilot-switch"), "valueChange", true);
    expect(await screen.findByTestId("settings-problem")).toHaveTextContent("No signal. Try again");
    expect(screen.getByTestId("settings-copilot-switch").props.value).toBe(false);
    expect(screen.queryByTestId("band-copilot")).toBeNull();
  });

  it("the language buttons switch the app, and every Settings word is in English and Hindi", async () => {
    await mount(server(false).fetcher);
    await fireEvent.press(await screen.findByTestId("settings-lang-hi"));
    expect(await screen.findByText("इस फ़ोन से लॉग आउट")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settings-lang-en"));
    expect(await screen.findByText("Log out of this phone")).toBeTruthy();
    expect(Object.keys((en as { settings: object }).settings)).toEqual(Object.keys((hi as { settings: object }).settings));
  });
});
