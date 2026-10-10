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
const VERSION = "0.16.0";
/**
 * "MARK ATTENDANCE" (decision 0061) — the ONE location sentence, iPhone and Android. The app reads the
 * position once, in the foreground, when a person taps the button; never in the background.
 */
export const LOCATION_SENTENCE = "HMIS checks your location once when you mark attendance, to confirm you are on hospital premises.";

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
    // Location is foreground-only: never the background permission, never a location foreground service.
    blockedPermissions: ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE_LOCATION"],
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
      // The vitals bay's scan door reads a patient card or slip. The camera records no sound (the microphone is expo-audio's, below).
      "expo-camera",
      { cameraPermission: "HMIS uses the camera to scan a patient card or slip, and to photograph a slip.", recordAudioAndroid: false },
    ],
    // Phone consult (decision 0048) — the microphone, for the doctor's spoken note ONLY. The clip is sent
    // to the hospital's server and on to the speech service; nothing is recorded in the background.
    ["expo-audio", { microphonePermission: "HMIS uses the microphone when a doctor chooses to speak a consultation note.", enableBackgroundRecording: false, enableBackgroundPlayback: false }],
    // Decision 0061 — "Mark attendance" reads the position once, while the app is open. ONLY "when in use":
    // `false` REMOVES the plugin's default Always / motion keys from the iPhone build; nothing in the background.
    ["expo-location", {
      locationWhenInUsePermission: LOCATION_SENTENCE, locationAlwaysAndWhenInUsePermission: false, locationAlwaysPermission: false, motionUsagePermission: false,
      isIosBackgroundLocationEnabled: false, isAndroidBackgroundLocationEnabled: false, isAndroidForegroundServiceEnabled: false, isAndroidMotionActivityEnabled: false,
    }],
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
    eas: { projectId: "4b8df892-c208-45a4-ad76-52a4551f7188" },
  },
};

export default config;
