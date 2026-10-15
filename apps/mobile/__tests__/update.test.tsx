import { readFileSync } from "fs";
import { join } from "path";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SeatHome } from "../src/screens/seat-home";
import { SessionProvider, useSession } from "../src/session";
import { apkUrl, checkForUpdate, parseLatest } from "../src/update";

// THIS SUITE DESCRIBES THE ANDROID APP. jest-expo runs as an iPhone unless told otherwise, and on an
// iPhone the update feed and the word "fingerprint" do not exist (__tests__/ios.test.tsx has its answers).
const realOS = Platform.OS;
beforeAll(() => { (Platform as { OS: string }).OS = "android"; });
afterAll(() => { (Platform as { OS: string }).OS = realOS; });

jest.mock("expo-secure-store", () => {
  const v: string | null = JSON.stringify({ token: "t1", username: "asha.devi" });
  return { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0, getItemAsync: jest.fn(async () => v), setItemAsync: jest.fn(async () => undefined), deleteItemAsync: jest.fn(async () => undefined) };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
// This build is versionCode 4 of 0.3.0 (what `extra` carries once app.config.ts has run).
jest.mock("../src/config", () => ({
  API_BASE: "https://stagehmis.crkmch.com/api", APP_ENV: "preview", IS_PRODUCTION: false,
  APP_VERSION: "0.3.0", APP_VERSION_CODE: 4, UPDATE_FEED: "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json",
}));

const FEED = "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json";
const SHA = "a".repeat(64);
const LATEST = { versionCode: 5, versionName: "0.4.0", apk: "hmis-staff-staging-0.4.0-vc5-abc12345.apk", sha256: SHA, builtAt: "2026-10-06T11:00:00.000Z", notes: "Doctor's OPD line" };
const feedOf = (reply: () => Response | Promise<Response>) => jest.fn(async (url: string) => {
  if (url === FEED) return reply();
  if (url.endsWith("/api/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "01J" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } }), { status: 200 });
  return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
}) as unknown as typeof fetch;

describe("is there a newer build? — no app store, so the app asks the hospital's own folder", () => {
  it("believes only a well-formed feed: a bare .apk file name, a 64-hex checksum, a whole positive versionCode", () => {
    expect(parseLatest(LATEST)).toEqual(LATEST);
    expect(parseLatest({ ...LATEST, apk: "../../etc/passwd" })).toBeNull();
    expect(parseLatest({ ...LATEST, apk: "https://evil.example/x.apk" })).toBeNull();
    expect(parseLatest({ ...LATEST, sha256: "abc" })).toBeNull();
    expect(parseLatest({ ...LATEST, versionCode: "5" })).toBeNull();
    expect(parseLatest({ ...LATEST, versionCode: 4.5 })).toBeNull();
    expect(parseLatest("<html>login</html>")).toBeNull();
    expect(parseLatest(null)).toBeNull();
    expect(apkUrl(FEED, LATEST.apk)).toBe("https://stagehmis.crkmch.com/app/hmis-staff-staging-0.4.0-vc5-abc12345.apk");
  });

  it("offers a build only when its versionCode is HIGHER than the one installed", async () => {
    const ok = feedOf(() => new Response(JSON.stringify(LATEST), { status: 200 }));
    expect(await checkForUpdate(ok, 4, FEED)).toEqual({ kind: "update", latest: LATEST, url: apkUrl(FEED, LATEST.apk) });
    expect(await checkForUpdate(ok, 5, FEED)).toEqual({ kind: "latest" });
    expect(await checkForUpdate(ok, 6, FEED)).toEqual({ kind: "latest" });
  });

  it("answers 'unknown' — never an error — when the feed cannot be read or is not a feed", async () => {
    expect(await checkForUpdate(feedOf(() => { throw new TypeError("Network request failed"); }), 4, FEED)).toEqual({ kind: "unknown" });
    expect(await checkForUpdate(feedOf(() => new Response("unauthorized", { status: 401 })), 4, FEED)).toEqual({ kind: "unknown" });
    expect(await checkForUpdate(feedOf(() => new Response("<html>", { status: 200 })), 4, FEED)).toEqual({ kind: "unknown" });
  });

  /**
   * The feed is the ONE thing under /app/ that staging serves without its password — an installed app
   * cannot answer a browser's prompt. The APK and the folder listing must stay behind it. Read off
   * the shipped Caddyfile, and the build script, as text.
   */
  it("staging serves only the feed file without the password; the APK and the listing stay behind it", () => {
    const caddy = readFileSync(join(__dirname, "../../../docker/prod/Caddyfile.uat"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const open = /@app_latest path_regexp (\S+)\n\s*handle @app_latest \{([\s\S]*?)\n\t\}/.exec(caddy);
    expect(open).not.toBeNull();
    const re = new RegExp(open![1]!);
    expect(re.test("/app/hmis-staff-staging-latest.json")).toBe(true);
    expect(re.test("/app/hmis-staff-staging-latest.apk")).toBe(false);
    expect(re.test("/app/hmis-staff-staging-0.4.0-vc5-abc.apk")).toBe(false);
    expect(re.test("/app/")).toBe(false);
    expect(re.test("/app/../etc/hmis-staff-x-latest.json")).toBe(false);
    expect(open![2]).not.toMatch(/browse/);
    expect(open![2]).not.toMatch(/basic_auth/);
    const rest = /handle_path \/app\/\* \{([\s\S]*?)\n\t\}/.exec(caddy);
    expect(rest?.[1]).toMatch(/basic_auth/);
    // …and the feed's file name is the one the build script writes and the staging app asks for.
    const build = readFileSync(join(__dirname, "../scripts/build-apk.sh"), "utf8");
    expect(build).toContain('"$OUT_DIR/hmis-staff-$ENV_NAME-latest.json"');
    expect(readFileSync(join(__dirname, "../app.config.ts"), "utf8")).toContain("https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json");
  });

  function Gate() {
    const { state } = useSession();
    return state.status === "signedIn" ? <SeatHome /> : null;
  }
  const mount = async (fetcher: typeof fetch) => await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );

  it("the home screen offers the update with its notes, opens the download, and can be put off", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await mount(feedOf(() => new Response(JSON.stringify(LATEST), { status: 200 })));
    expect(await screen.findByTestId("update-offer")).toHaveTextContent(/Version 0\.4\.0 is ready\. This phone has 0\.3\.0\./);
    expect(screen.getByTestId("update-notes")).toHaveTextContent("Doctor's OPD line");
    expect(screen.getByTestId("app-version")).toHaveTextContent("Version 0.3.0 · build 4");
    await fireEvent.press(screen.getByTestId("update-get"));
    expect(open).toHaveBeenCalledWith(apkUrl(FEED, LATEST.apk));
    await fireEvent.press(screen.getByTestId("update-later"));
    expect(screen.queryByTestId("update-offer")).toBeNull();
    open.mockRestore();
  });

  it("says nothing on start-up when the check cannot be made, and says so only when asked by hand", async () => {
    await mount(feedOf(() => { throw new TypeError("Network request failed"); }));
    await screen.findByTestId("app-version");
    expect(screen.queryByTestId("update-offer")).toBeNull();
    expect(screen.queryByTestId("update-unknown")).toBeNull();
    await fireEvent.press(screen.getByTestId("update-check"));
    expect(await screen.findByTestId("update-unknown")).toHaveTextContent("Could not check for an update just now.");
  });

  it("asked by hand on the newest build, says it is the latest", async () => {
    await mount(feedOf(() => new Response(JSON.stringify({ ...LATEST, versionCode: 4, versionName: "0.3.0" }), { status: 200 })));
    await screen.findByTestId("app-version");
    expect(screen.queryByTestId("update-offer")).toBeNull();
    await fireEvent.press(screen.getByTestId("update-check"));
    expect(await screen.findByTestId("update-latest")).toHaveTextContent("This is the latest version (0.3.0).");
  });
});
