import Constants from "expo-constants";

type Extra = { apiBase?: string; appEnv?: string };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/** The API this build talks to — fixed at build time by the eas.json profile (app.config.ts). */
export const API_BASE: string = extra.apiBase ?? "https://stagehmis.crkmch.com/api";
export const APP_ENV: string = extra.appEnv ?? "development";
export const IS_PRODUCTION = APP_ENV === "production";
