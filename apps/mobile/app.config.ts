import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";
import { withEntitlementsPlist } from "expo/config-plugins";

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
const VERSION = "0.23.0";
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

/**
 * iPHONE (owner 2026-10-08: about 100 iPhone users; built by EAS, distributed as an Unlisted app).
 * What iOS shows the person the FIRST time the app reaches for each of these. Exactly what the app
 * uses and nothing else: no photo-library PERMISSION (the lab bench picks one analyser-slip photo
 * through the system picker, which needs none — spec #934), no location, no tracking, no background
 * mode. Each sentence is handed to the config plugin that owns its key.
 */
const IOS_CAMERA = "HMIS uses the camera to photograph prescription slips and scan patient codes.";
const IOS_MICROPHONE = "HMIS uses the microphone to record a doctor's spoken note. The recording is sent through the hospital's server to a speech-to-text service to be typed, and is not stored.";
const IOS_FACE_ID = "HMIS uses Face ID to unlock the app.";

/**
 * #590 (plan E1.7) — SPEAKING A QUESTION TO THE COPILOT waits for ruling R-2 (staff voice to the cloud
 * speech service, decision 0064). While this is false no microphone is drawn: not on the "HMIS Ask"
 * widget, not on the copilot screen. Turning it on is a new APK (the widget is native).
 */
const VOICE_ASK = false;

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
    // #934 — the slip picker is the SYSTEM photo picker, which needs no storage or media permission:
    // whatever a library brings for the photo library is taken back out of the merged manifest.
    blockedPermissions: [
      "android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
      "android.permission.READ_EXTERNAL_STORAGE",
    ],
    ...(PUSH_IN_BUILD ? { googleServicesFile: GOOGLE_SERVICES } : {}),
  },
  ios: {
    // The same two ids as Android, so the staging and the production app install side by side.
    bundleIdentifier: ENV === "production" ? "com.crkmch.hmis" : "com.crkmch.hmis.staging",
    supportsTablet: false,
    // `buildNumber` is EAS's to count (eas.json: appVersionSource remote + autoIncrement).
    // The app speaks HTTPS only and carries no cryptography of its own: no export paperwork per build.
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  web: { favicon: "./assets/favicon.png", output: "single" },
  plugins: [
    "expo-router",
    "expo-font",
    // The crest on paper while the app starts — the same mark the token slip and the prescription print.
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 140, resizeMode: "contain", backgroundColor: "#F4F7F4" }],
    ["expo-secure-store", { faceIDPermission: IOS_FACE_ID }],
    ["expo-local-authentication", { faceIDPermission: IOS_FACE_ID }],
    [
      // The vitals bay's scan door reads a patient card or slip. The camera records no sound (the microphone is expo-audio's, below).
      "expo-camera",
      { cameraPermission: IOS_CAMERA, recordAudioAndroid: false },
    ],
    // Phone consult (decision 0048) — the microphone, for the doctor's spoken note ONLY. The clip is sent
    // to the hospital's server and on to the speech service; nothing is recorded in the background.
    ["expo-audio", { microphonePermission: IOS_MICROPHONE, enableBackgroundRecording: false, enableBackgroundPlayback: false }],
    // Decision 0062 — "Mark attendance" reads the position once, while the app is open. ONLY "when in use":
    // `false` REMOVES the plugin's default Always / motion keys from the iPhone build; nothing in the background.
    ["expo-location", {
      locationWhenInUsePermission: LOCATION_SENTENCE, locationAlwaysAndWhenInUsePermission: false, locationAlwaysPermission: false, motionUsagePermission: false,
      isIosBackgroundLocationEnabled: false, isAndroidBackgroundLocationEnabled: false, isAndroidForegroundServiceEnabled: false, isAndroidMotionActivityEnabled: false,
    }],
    // M6b — the small icon in the tray is the HMIS diamond (alpha only), tinted pine. Android only in
    // this version: see `withoutApplePush` at the foot of this file.
    ["expo-notifications", { icon: "./assets/notification-icon.png", color: "#0E6B4E" }],
    // Spec #934 — Quick Bench's "Choose from gallery": ONE photo of an analyser slip through the system picker.
    // `photosPermission: false`: no photo-library permission, on either platform. The camera and microphone
    // keys repeat expo-camera's and expo-audio's own sentences: `false` there would BLOCK the camera and the
    // microphone the scan door and the spoken note need (the plugin blocks a permission set to `false`).
    ["expo-image-picker", { photosPermission: false, cameraPermission: IOS_CAMERA, microphonePermission: IOS_MICROPHONE }],
    // Decision 0064 (E1.1) — the "HMIS Scan" home-screen widget, Android only: one tap opens hmis://scan.
    // It draws a fixed icon and runs no JavaScript, so it never shows a patient (plugins/with-scan-widget.js).
    ["./plugins/with-scan-widget", { label: ENV === "production" ? "HMIS Scan" : "HMIS Scan (staging)" }],
    // #590 (E1.7) — the "HMIS Ask" widget, Android only: one tap opens the copilot with the keyboard up.
    // Fixed words, no JavaScript, never a patient or an answer on it (plugins/with-ask-widget.js).
    ["./plugins/with-ask-widget", { label: ENV === "production" ? "HMIS Ask" : "HMIS Ask (staging)", mic: VOICE_ASK }],
  ],
  extra: {
    apiBase: API_BASE[ENV],
    appEnv: ENV,
    updateFeed: UPDATE_FEED[ENV],
    voiceAsk: VOICE_ASK,
    version: VERSION,
    versionCode: VERSION_CODE,
    pushInBuild: PUSH_IN_BUILD,
    eas: { projectId: "4b8df892-c208-45a4-ad76-52a4551f7188" },
  },
};

/**
 * NOTIFICATIONS ON iPHONE ARE DORMANT IN THIS VERSION. The expo-notifications plugin writes the
 * `aps-environment` entitlement into every iPhone build, which makes Apple demand a push key before
 * the first build can be signed. The server sends through Firebase only and no iPhone is ever given
 * an address (src/push-phone.ts returns "not in this build" off Android), so the entitlement is
 * taken back out. A mod registered here runs AFTER the plugins' own, so it sees what they wrote.
 * Android is untouched: this is an iOS-only mod.
 */
const withoutApplePush = (c: ExpoConfig): ExpoConfig =>
  withEntitlementsPlist(c, (m) => {
    delete m.modResults["aps-environment"];
    return m;
  });

export default withoutApplePush(config);
