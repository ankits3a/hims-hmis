import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";

/**
 * One app, three builds (eas.json profiles). APP_ENV picks the API the build talks to; nothing
 * else differs. A staging build can never reach production data because its base URL is baked
 * in at build time, and the two builds carry different application ids so both install side by
 * side on one phone.
 */
const ENV = (process.env.APP_ENV ?? "development") as "development" | "preview" | "production";

const API_BASE: Record<typeof ENV, string> = {
  development: process.env.EXPO_PUBLIC_API_BASE ?? "https://stagehmis.crkmch.com/api",
  preview: "https://stagehmis.crkmch.com/api",
  production: "https://hmis.crkmch.com/api",
};

/** Where the installed app asks whether a newer build exists (src/update.ts). No app store: the hospital's own download folder. */
const UPDATE_FEED: Record<typeof ENV, string> = {
  development: process.env.EXPO_PUBLIC_UPDATE_FEED ?? "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json",
  preview: "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json",
  // Served by production's caddy since 2026-10-06 (docker/prod/Caddyfile, `@app_file`; plan §7).
  production: "https://hmis.crkmch.com/app/hmis-staff-production-latest.json",
};
/**
 * OVER-THE-AIR UPDATES (owner 2026-10-06: "it should happen automatically").
 * A change to screens, words or rules is JavaScript, and JavaScript reaches a phone without a new
 * APK: the app asks this address at start-up, takes the signed bundle `scripts/publish-ota.sh` put
 * there, and runs it from the next start (src/ota.ts). No expo.dev cloud — the hospital's own
 * caddy serves the folder, beside the APKs (BUILDING.md, "Over-the-air updates").
 *
 * One address per environment; caddy picks the folder from the `expo-runtime-version` header the
 * app sends, so a bundle only ever reaches an APK whose NATIVE code it was built against.
 */
const OTA_URL: Record<typeof ENV, string> = {
  development: process.env.EXPO_PUBLIC_OTA_URL ?? "https://stagehmis.crkmch.com/app/ota/staging/manifest",
  preview: "https://stagehmis.crkmch.com/app/ota/staging/manifest",
  production: "https://hmis.crkmch.com/app/ota/production/manifest",
};
/**
 * The phone runs a bundle only when it is signed by the key whose PUBLIC certificate is baked into
 * the APK (the private half lives outside the repo, beside the APK keystores). A build made before
 * the certificate exists carries no over-the-air updates at all — never unsigned ones.
 */
const OTA_CERTIFICATE = `./ota/certificate-${ENV === "production" ? "production" : "staging"}.pem`;
const OTA_IN_BUILD = existsSync(join(__dirname, OTA_CERTIFICATE));
const VERSION = "0.9.0";
/**
 * M6b — NOTIFICATIONS ARE IN A BUILD ONLY WHEN THE HOSPITAL'S FIREBASE PROJECT IS.
 * `scripts/build-apk.sh` copies the owner's `google-services.json` beside this file when it exists
 * and names this app id (BUILDING.md, "Notifications"). Without it the build is the same app with
 * notifications dormant: `extra.pushInBuild` is false and the app asks the person for nothing.
 */
const GOOGLE_SERVICES = "./google-services.json";
const PUSH_IN_BUILD = process.env.HMIS_PUSH_IN_BUILD === "1" && existsSync(join(__dirname, GOOGLE_SERVICES));
const VERSION_CODE = Number(process.env.HMIS_VERSION_CODE ?? "1");

const config: ExpoConfig = {
  name: ENV === "production" ? "HMIS" : "HMIS Staging",
  // `slug` must match the EAS project the owner created (projectId below); the stray app.json
  // that held this id was written by `eas init` run from /opt/hmis, whose package name is "hmis".
  slug: "hmis",
  scheme: "hmis",
  version: VERSION,
  orientation: "portrait",
  // The native fingerprint: it changes exactly when the native side of the app does (a new native
  // module, a permission, an Expo upgrade) and never for a JavaScript change or a versionCode.
  runtimeVersion: { policy: "fingerprint" },
  updates: OTA_IN_BUILD
    ? {
        enabled: true,
        url: OTA_URL[ENV],
        // Ask at every cold start, never wait for the answer: a ward with no signal opens the app as fast as before.
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        codeSigningCertificate: OTA_CERTIFICATE,
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      }
    : { enabled: false },
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  android: {
    package: ENV === "production" ? "com.crkmch.hmis" : "com.crkmch.hmis.staging",
    // Sideloaded (no Play Store, owner 2026-10-05): a phone only accepts an update whose versionCode
    // is HIGHER than the installed one. scripts/build-apk.sh passes a counter that only goes up.
    versionCode: VERSION_CODE,
    adaptiveIcon: {
      backgroundColor: "#FFFFFF",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
    },
    predictiveBackGestureEnabled: false,
    ...(PUSH_IN_BUILD ? { googleServicesFile: GOOGLE_SERVICES } : {}),
  },
  web: { favicon: "./assets/favicon.png", output: "single" },
  plugins: [
    "expo-router",
    "expo-font",
    // The crest on paper while the app starts — the same mark the token slip and the prescription print.
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 140, resizeMode: "contain", backgroundColor: "#F4F7F4" }],
    "expo-secure-store",
    [
      "expo-local-authentication",
      { faceIDPermission: "Unlock HMIS with your face or fingerprint." },
    ],
    [
      // The vitals bay's scan door reads a patient card or slip. No microphone, no recording.
      "expo-camera",
      { cameraPermission: "HMIS uses the camera to scan a patient card or slip, and to photograph a slip.", recordAudioAndroid: false },
    ],
    // M6b — the small icon in the tray is the HMIS diamond (alpha only), tinted pine.
    ["expo-notifications", { icon: "./assets/notification-icon.png", color: "#0E6B4E" }],
  ],
  extra: {
    apiBase: API_BASE[ENV],
    appEnv: ENV,
    updateFeed: UPDATE_FEED[ENV],
    version: VERSION,
    versionCode: VERSION_CODE,
    pushInBuild: PUSH_IN_BUILD,
    otaInBuild: OTA_IN_BUILD,
    eas: { projectId: "4b8df892-c208-45a4-ad76-52a4551f7188" },
  },
};

export default config;
