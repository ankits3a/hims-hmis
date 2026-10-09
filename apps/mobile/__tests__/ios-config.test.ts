import { readFileSync } from "fs";
import { join } from "path";
import type { ExpoConfig } from "expo/config";

/*
  THE iPHONE CONFIGURATION, AND THE ANDROID ONE IT MUST NOT MOVE (owner 2026-10-08).
  app.config.ts is evaluated here exactly as `expo config` evaluates it, once per build profile.
*/
function configFor(env: Record<string, string>): ExpoConfig & { mods?: { ios?: Record<string, unknown>; android?: Record<string, unknown> } } {
  const before = { ...process.env };
  let out!: ExpoConfig;
  try {
    for (const k of ["APP_ENV", "HMIS_VERSION_CODE", "HMIS_PUSH_IN_BUILD", "EXPO_PUBLIC_API_BASE", "EXPO_PUBLIC_UPDATE_FEED"]) delete process.env[k];
    Object.assign(process.env, env);
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      out = (require("../app.config") as { default: ExpoConfig }).default;
    });
  } finally {
    process.env = before;
  }
  return out;
}

const ICON = { backgroundColor: "#FFFFFF", foregroundImage: "./assets/android-icon-foreground.png", backgroundImage: "./assets/android-icon-background.png" };

describe("app.config.ts — the Android half is what it was before the iPhone was added", () => {
  it("is, key for key, the block the APK has always been built from", () => {
    expect(configFor({ APP_ENV: "production", HMIS_VERSION_CODE: "41" }).android).toEqual({ package: "com.crkmch.hmis", versionCode: 41, adaptiveIcon: ICON, predictiveBackGestureEnabled: false });
    expect(configFor({ APP_ENV: "preview", HMIS_VERSION_CODE: "7" }).android).toEqual({ package: "com.crkmch.hmis.staging", versionCode: 7, adaptiveIcon: ICON, predictiveBackGestureEnabled: false });
    expect(configFor({}).android).toEqual({ package: "com.crkmch.hmis.staging", versionCode: 1, adaptiveIcon: ICON, predictiveBackGestureEnabled: false });
  });

  it("adds no Android-side mod: the one mod this file registers is iOS's entitlements", () => {
    const c = configFor({ APP_ENV: "production" });
    expect(Object.keys(c.mods?.android ?? {})).toEqual([]);
    expect(Object.keys(c.mods?.ios ?? {})).toEqual(["entitlements"]);
  });
});

describe("app.config.ts — the iPhone half", () => {
  it("carries OUR bundle ids — the same two strings as Android — and is an iPhone app, not an iPad one", () => {
    const prod = configFor({ APP_ENV: "production" }), stage = configFor({ APP_ENV: "preview" }), dev = configFor({});
    expect(prod.ios?.bundleIdentifier).toBe("com.crkmch.hmis");
    expect(stage.ios?.bundleIdentifier).toBe("com.crkmch.hmis.staging");
    expect(dev.ios?.bundleIdentifier).toBe("com.crkmch.hmis.staging");
    expect(prod.ios?.supportsTablet).toBe(false);
    // EAS counts the build number (eas.json: appVersionSource remote); a number here would fight it.
    expect(prod.ios?.buildNumber).toBeUndefined();
    expect(prod.ios?.infoPlist).toEqual({ ITSAppUsesNonExemptEncryption: false });
    expect(prod.extra?.eas).toEqual({ projectId: "4b8df892-c208-45a4-ad76-52a4551f7188" });
    expect(JSON.stringify(prod)).not.toContain("ankits3a");
  });

  it("asks for the camera, the microphone and Face ID in plain words — and for nothing else", () => {
    const plugins = (configFor({ APP_ENV: "production" }).plugins ?? []) as (string | [string, Record<string, unknown>])[];
    const of = (name: string): Record<string, unknown> => { const p = plugins.find((x) => Array.isArray(x) && x[0] === name); return Array.isArray(p) ? p[1] : {}; };
    expect(of("expo-camera").cameraPermission).toBe("HMIS uses the camera to photograph prescription slips and scan patient codes.");
    expect(of("expo-audio").microphonePermission).toBe("HMIS uses the microphone to record a doctor's spoken note. The recording is sent through the hospital's server to a speech-to-text service to be typed, and is not stored.");
    expect(of("expo-local-authentication").faceIDPermission).toBe("HMIS uses Face ID to unlock the app.");
    expect(of("expo-secure-store").faceIDPermission).toBe("HMIS uses Face ID to unlock the app.");
    expect(of("expo-audio")).toMatchObject({ enableBackgroundRecording: false, enableBackgroundPlayback: false });
    const all = JSON.stringify(configFor({ APP_ENV: "production" }));
    for (const never of ["NSPhotoLibrary", "NSLocation", "NSUserTracking", "UIBackgroundModes", "expo-location", "expo-image-picker", "expo-media-library", "expo-tracking-transparency", "aps-environment"]) {
      expect(all).not.toContain(never);
    }
  });

  it("no screen picks from the photo gallery — which is why the photo library is not declared", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    for (const picker of ["expo-image-picker", "expo-media-library", "expo-document-picker", "react-native-image-picker"]) expect(pkg.dependencies[picker]).toBeUndefined();
  });
});

describe("eas.json — the iPhone profiles, with Android's left as they were", () => {
  type Profile = { distribution?: string; env?: Record<string, string>; autoIncrement?: boolean; developmentClient?: boolean; android?: Record<string, unknown>; ios?: Record<string, unknown> };
  const eas = JSON.parse(readFileSync(join(__dirname, "../eas.json"), "utf8")) as { cli: Record<string, unknown>; build: Record<string, Profile>; submit: { production: { ios?: Record<string, unknown>; android?: unknown } } };

  it("keeps the three profiles and every Android line", () => {
    expect(Object.keys(eas.build)).toEqual(["development", "preview", "production"]);
    expect(eas.cli).toEqual({ version: ">= 16.0.0", appVersionSource: "remote" });
    expect(eas.build.development).toEqual({ developmentClient: false, distribution: "internal", env: { APP_ENV: "development" }, android: { buildType: "apk" } });
    const { ios: _p, ...preview } = eas.build.preview!;
    expect(preview).toEqual({ distribution: "internal", env: { APP_ENV: "preview" }, android: { buildType: "apk" } });
    const { ios: _q, ...production } = eas.build.production!;
    expect(production).toEqual({ env: { APP_ENV: "production" }, autoIncrement: true, android: { buildType: "app-bundle" } });
    expect(eas.submit.production.android).toBeUndefined();
  });

  it("production is a store build, preview a real-phone internal build, both on the repository's Node", () => {
    const major = readFileSync(join(__dirname, "../../../.nvmrc"), "utf8").trim().replace(/^v/, "").split(".")[0];
    expect(eas.build.production!.ios?.distribution).toBe("store");
    expect(eas.build.production!.ios?.resourceClass).toBeUndefined();
    expect(eas.build.preview!.ios?.simulator).toBe(false);
    expect(eas.build.preview!.distribution).toBe("internal");
    for (const p of ["preview", "production"]) expect(String(eas.build[p]!.ios?.node).split(".")[0]).toBe(major);
  });

  // 2026-10-08: `eas submit` read the app config with no APP_ENV, took the STAGING id and prepared an
  // "HMIS Staging" app on App Store Connect for a production build. The submit profile names the app.
  it("names the production app, so a submit can never fall on the staging id; no made-up App Store number", () => {
    expect(eas.submit.production.ios).toEqual({ bundleIdentifier: "com.crkmch.hmis", appName: "HMIS Staff" });
    expect(JSON.stringify(eas)).not.toMatch(/ascAppId|appleId|appleTeamId|PLACEHOLDER|YOUR_|<[^>]+>/);
  });
});
