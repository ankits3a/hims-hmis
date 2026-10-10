import { execFileSync } from "child_process";
import { join } from "path";
import { readFileSync } from "fs";

/*
  "MARK ATTENDANCE" (decision 0061): location, ONLY while the app is in use, on both platforms.
  The plugins are RUN here (`expo config --type introspect` applies every config plugin the way a
  build does, offline), so this reads the Info.plist and AndroidManifest the build would get — not
  the options we hoped would produce them. expo-location's plugin adds the "Always" keys unless told
  `false`; this is what catches it if anybody drops one.
*/
type Perm = { $: Record<string, string> };
type Introspected = {
  _internal: { modResults: { ios: { infoPlist: Record<string, unknown> }; android: { manifest: { manifest: { "uses-permission"?: Perm[] } } } } };
};
const ROOT = join(__dirname, "..");
const SENTENCE = "HMIS checks your location once when you mark attendance, to confirm you are on hospital premises.";

function introspect(appEnv: string): Introspected {
  const out = execFileSync(process.execPath, [require.resolve("expo/bin/cli"), "config", "--type", "introspect", "--json"], {
    cwd: ROOT, env: { ...process.env, APP_ENV: appEnv, EXPO_NO_TELEMETRY: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.slice(out.indexOf("{"))) as Introspected;
}

describe.each(["production", "preview"])("the %s build's location permissions", (env) => {
  let c: Introspected;
  beforeAll(() => { c = introspect(env); }, 120_000);

  it("iPhone: ONLY 'when in use', in the owner's sentence — no Always, no background mode, no motion", () => {
    const plist = c._internal.modResults.ios.infoPlist;
    const keys = Object.keys(plist).filter((k) => /Location|Motion/.test(k));
    expect(keys).toEqual(["NSLocationWhenInUseUsageDescription"]);
    expect(plist.NSLocationWhenInUseUsageDescription).toBe(SENTENCE);
    expect(JSON.stringify(plist.UIBackgroundModes ?? [])).not.toContain("location");
  });

  it("Android: fine and coarse only — background location and the location foreground service are removed", () => {
    const perms = c._internal.modResults.android.manifest.manifest["uses-permission"] ?? [];
    const named = (n: string) => perms.filter((p) => p.$["android:name"] === `android.permission.${n}`);
    expect(named("ACCESS_FINE_LOCATION")).toHaveLength(1);
    expect(named("ACCESS_COARSE_LOCATION")).toHaveLength(1);
    for (const never of ["ACCESS_BACKGROUND_LOCATION", "FOREGROUND_SERVICE_LOCATION"]) {
      expect(named(never).map((p) => p.$["tools:node"])).toEqual(["remove"]);
    }
    expect(perms.filter((p) => /ACTIVITY_RECOGNITION/.test(p.$["android:name"] ?? ""))).toEqual([]);
  });
});

it("the app's own explanation (Android, before the system prompt) is the same sentence, word for word", () => {
  const en = JSON.parse(readFileSync(join(ROOT, "src/locales/en.json"), "utf8")) as { mobile: { location: { why: string } } };
  expect(en.mobile.location.why).toBe(SENTENCE);
});
