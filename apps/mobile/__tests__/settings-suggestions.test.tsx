import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SessionProvider, useSession } from "../src/session";
import { SettingsScreen } from "../src/screens/settings";
import { _resetCopilotSettingForTests } from "../src/copilot/setting";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "dr.rao", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }), useLocalSearchParams: () => ({}) }));

/**
 * #620 item 4 — the doctor's own suggestions switch on the phone: the SAME server switch the web consult
 * flips (`GET` / `PUT /opd/consult/suggestions`, `opd.consult`). Shown only to a doctor; when the hospital
 * has suggestions off, the switch cannot be turned on and says so in a few words.
 */
function server(opts: { perms: string[]; on?: boolean; hospitalOn?: boolean; putFails?: boolean }) {
  const calls: { key: string; body: unknown }[] = [];
  let on = opts.on ?? true;
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ key, body });
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (key === "GET /auth/me") return ok({ actor: { type: "user", id: "u1" }, permissions: { hospital: opts.perms, scoped: { department: {}, floor: {} } } });
    if (key === "GET /copilot/setting") return ok({ phone: false });
    if (key === "GET /opd/consult/suggestions") return ok({ on, hospitalOn: opts.hospitalOn ?? true, hidden: [] });
    if (key === "PUT /opd/consult/suggestions") {
      if (opts.putFails === true) throw new TypeError("Network request failed");
      on = (body as { suggestionsOn: boolean }).suggestionsOn;
      return ok({ on });
    }
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}
function Gate() { const { state } = useSession(); return state.status !== "signedIn" ? null : <SettingsScreen />; }
const mount = async (fetcher: typeof fetch) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);

beforeEach(() => { _resetCopilotSettingForTests(); });

describe("#620 item 4 — the doctor's suggestions switch on the phone", () => {
  it("a doctor sees the switch as the server holds it, and turning it off saves it on the server", async () => {
    const s = server({ perms: ["opd.consult"], on: true });
    await mount(s.fetcher);
    const sw = await screen.findByTestId("settings-suggestions-switch");
    await waitFor(() => expect(screen.getByTestId("settings-suggestions-switch").props.value).toBe(true));
    expect(screen.getByTestId("settings-suggestions-note")).toHaveTextContent(en.settings.suggestionsOn);
    await fireEvent(sw, "valueChange", false);
    await waitFor(() => expect(screen.getByTestId("settings-suggestions-switch").props.value).toBe(false));
    expect(s.calls.filter((c) => c.key === "PUT /opd/consult/suggestions").map((c) => c.body)).toEqual([{ suggestionsOn: false }]);
    expect(screen.getByTestId("settings-suggestions-note")).toHaveTextContent(en.settings.suggestionsOff);
  });

  it("no signal: the switch goes back and says so", async () => {
    const s = server({ perms: ["opd.consult"], on: true, putFails: true });
    await mount(s.fetcher);
    await waitFor(() => expect(screen.getByTestId("settings-suggestions-switch").props.value).toBe(true));
    await fireEvent(screen.getByTestId("settings-suggestions-switch"), "valueChange", false);
    expect(await screen.findByTestId("settings-problem")).toHaveTextContent(en.settings.offline);
    expect(screen.getByTestId("settings-suggestions-switch").props.value).toBe(true);
  });

  it("the hospital has suggestions off: the switch is off, cannot be turned on, and says why", async () => {
    const s = server({ perms: ["opd.consult"], on: true, hospitalOn: false });
    await mount(s.fetcher);
    await waitFor(() => expect(screen.getByTestId("settings-suggestions-note")).toHaveTextContent(en.settings.suggestionsHospitalOff));
    expect(screen.getByTestId("settings-suggestions-switch").props.value).toBe(false);
    expect(screen.getByTestId("settings-suggestions-switch").props.disabled).toBe(true);
  });

  it("someone who is not a doctor sees no switch and the phone never asks", async () => {
    const s = server({ perms: ["opd.vitals.record"] });
    await mount(s.fetcher);
    await screen.findByTestId("settings-copilot-switch");
    expect(screen.queryByTestId("settings-suggestions-switch")).toBeNull();
    expect(s.calls.map((c) => c.key)).not.toContain("GET /opd/consult/suggestions");
  });

  it("its words are one short line in both languages", () => {
    for (const k of ["suggestions", "suggestionsOn", "suggestionsOff", "suggestionsHospitalOff"] as const) {
      for (const w of [en.settings[k], hi.settings[k]]) {
        expect([w, w.length <= 32]).toEqual([w, true]);
        expect([w, /[.।!]/.test(w)]).toEqual([w, false]);
      }
    }
  });
});
