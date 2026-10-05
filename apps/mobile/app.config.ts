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

const config: ExpoConfig = {
  name: ENV === "production" ? "HMIS" : "HMIS Staging",
  // `slug` must match the EAS project the owner created (projectId below); the stray app.json
  // that held this id was written by `eas init` run from /opt/hmis, whose package name is "hmis".
  slug: "hmis",
  scheme: "hmis",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  android: {
    package: ENV === "production" ? "com.crkmch.hmis" : "com.crkmch.hmis.staging",
    adaptiveIcon: {
      backgroundColor: "#0E6B4E",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: { favicon: "./assets/favicon.png", output: "single" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-local-authentication",
      { faceIDPermission: "Unlock HMIS with your face or fingerprint." },
    ],
  ],
  extra: {
    apiBase: API_BASE[ENV],
    appEnv: ENV,
    eas: { projectId: "4b8df892-c208-45a4-ad76-52a4551f7188" },
  },
};

export default config;
