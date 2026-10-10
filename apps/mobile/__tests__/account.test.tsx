import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { AccountScreen } from "../src/screens/account";
import { SessionProvider, useSession } from "../src/session";
import en from "../src/locales/en.json";

// THIS SUITE DESCRIBES THE ANDROID APP. jest-expo runs as an iPhone unless told otherwise, and on an
// iPhone the update feed and the word "fingerprint" do not exist (__tests__/ios.test.tsx has its answers).
const realOS = Platform.OS;
beforeAll(() => { (Platform as { OS: string }).OS = "android"; });
afterAll(() => { (Platform as { OS: string }).OS = realOS; });

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha.devi", since: "2026-10-06T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
    __get: (k: string) => store.get(k) ?? null,
    __set: (k: string, v: string) => { store.set(k, v); },
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } };
const FEED = "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json";

function server(feed: () => { status: number; body?: unknown }) {
  const calls: string[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    calls.push(key);
    if (key === "GET /auth/me") return new Response(JSON.stringify(ME), { status: 200 });
    if (key === "POST /auth/logout") return new Response(null, { status: 204 });
    if (key === `GET ${FEED}`) { const r = feed(); return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status }); }
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <AccountScreen /> : state.status === "signedOut" ? null : null;
}
async function mount(fetcher: typeof fetch) {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

describe("this phone and my account (M6a)", () => {
  it("says who is signed in on this phone and since when (IST), which build, which server — and what to do if the phone is lost", async () => {
    const { fetcher } = server(() => ({ status: 404 }));
    await mount(fetcher);
    expect(await screen.findByTestId("account-who")).toHaveTextContent("Signed in as asha.devi");
    // 03:30Z is 09:00 IST, Tuesday 6 October.
    expect(screen.getByTestId("account-since")).toHaveTextContent("since Tuesday 6 October, 09:00");
    expect(screen.getByTestId("account-app")).toHaveTextContent(/^HMIS \d+\.\d+\.\d+ \(build \d+\)$/);
    expect(screen.getByTestId("account-server")).toHaveTextContent("stagehmis.crkmch.com");
    expect(screen.getByTestId("account-lost")).toHaveTextContent(/they can sign this phone out without changing your password/);
  });

  it("'two phones' is the server's own number", () => {
    const core = readFileSync(join(__dirname, "../../core/src/kernel/auth/devices.ts"), "utf8");
    expect(/export const PHONES_PER_USER = (\d+);/.exec(core)?.[1]).toBe("2");
    expect(en.mobile.account.limit).toContain("two phones");
  });

  it("a session opened by an older build has no sign-in time, and says so instead of inventing one", async () => {
    const store = jest.requireMock("expo-secure-store") as { __set: (k: string, v: string) => void };
    store.__set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" }));
    const { fetcher } = server(() => ({ status: 404 }));
    await mount(fetcher);
    expect(await screen.findByTestId("account-since")).toHaveTextContent(/not kept by the older build/);
    store.__set("hmis.session", JSON.stringify({ token: "t1", username: "asha.devi", since: "2026-10-06T03:30:00.000Z" }));
  });

  it("checks for an update by hand, says the answer either way, and opens the download", async () => {
    let feed: { status: number; body?: unknown } = { status: 200, body: { versionCode: 0, versionName: "0.0.1", apk: "hmis-staff-staging-0.0.1-vc0-aaaaaaaa.apk", sha256: "a".repeat(64) } };
    const { fetcher } = server(() => feed);
    await mount(fetcher);
    await fireEvent.press(await screen.findByTestId("account-update-check"));
    expect(await screen.findByTestId("account-update-unknown")).toBeTruthy(); // versionCode 0 is not a build: the feed is not believed
    feed = { status: 200, body: { versionCode: 9999, versionName: "9.9.9", apk: "hmis-staff-staging-9.9.9-vc9999-aaaaaaaa.apk", sha256: "a".repeat(64), notes: "Phones can be signed out." } };
    await fireEvent.press(screen.getByTestId("account-update-check"));
    expect(await screen.findByTestId("account-update-offer")).toHaveTextContent(/Phones can be signed out\./);
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await fireEvent.press(screen.getByTestId("account-update-get"));
    expect(open).toHaveBeenCalledWith("https://stagehmis.crkmch.com/app/hmis-staff-staging-9.9.9-vc9999-aaaaaaaa.apk");
    open.mockRestore();
  });

  it("logs out of this phone: the server is told, the session leaves the phone", async () => {
    const { fetcher, calls } = server(() => ({ status: 404 }));
    await mount(fetcher);
    await fireEvent.press(await screen.findByTestId("account-logout"));
    await waitFor(() => expect(calls).toContain("POST /auth/logout"));
    const store = jest.requireMock("expo-secure-store") as { __get: (k: string) => string | null };
    await waitFor(() => expect(store.__get("hmis.session")).toBeNull());
  });
});
