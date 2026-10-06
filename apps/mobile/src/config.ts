import Constants from "expo-constants";

type Extra = { apiBase?: string; appEnv?: string; updateFeed?: string; version?: string; versionCode?: number };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/** The API this build talks to — fixed at build time by the eas.json profile (app.config.ts). */
export const API_BASE: string = extra.apiBase ?? "https://stagehmis.crkmch.com/api";
export const APP_ENV: string = extra.appEnv ?? "development";
export const IS_PRODUCTION = APP_ENV === "production";

/** This build, and where it asks whether a newer one exists (src/update.ts). */
export const APP_VERSION: string = extra.version ?? "0.0.0";
export const APP_VERSION_CODE: number = typeof extra.versionCode === "number" ? extra.versionCode : 0;
export const UPDATE_FEED: string = extra.updateFeed ?? "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json";
