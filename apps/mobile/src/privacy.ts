import { Platform } from "react-native";
import { IS_PRODUCTION } from "./config";

/**
 * ═══ M6b — NO SCREENSHOTS OF PATIENTS ON A PERSONAL PHONE (owner 2026-10-06, delegated) ═══
 *
 * ANDROID. The production app sets FLAG_SECURE on its window: a screenshot comes out black, a
 * screen recording records nothing, and the app is blank in the recent-apps strip. Staff use their
 * own phones for some months; a screenshot of a queue in a family chat group is the leak this stops.
 *
 * iPHONE (owner 2026-10-08). There is no FLAG_SECURE, and none is called. What the production app
 * does instead is hide its content in the APP SWITCHER — the row of cards a person swipes through,
 * which iOS photographs the moment the app stops being in front:
 *   · `PrivacyCover` (src/privacy-cover.tsx) draws a blank sheet over the app's own screens while
 *     the app is not active;
 *   · a sheet drawn by the app cannot cover a panel iOS presents above it (every `Modal`: the
 *     consult drawers, the camera, the booking panel), so the installed screen-capture module's
 *     own switcher cover is asked for as well. It is a guard, not a gate: where it is missing or
 *     fails the app still opens.
 * A screenshot taken on an iPhone is NOT blocked, and the Account screen says so.
 *
 * The STAGING build leaves everything allowed on purpose — it holds test data only, and a
 * screenshot is how somebody shows what went wrong. The Account screen says which this build is.
 */
export const SCREENSHOTS_BLOCKED: boolean = IS_PRODUCTION && Platform.OS === "android";
export const SWITCHER_BLANKED: boolean = IS_PRODUCTION && Platform.OS === "ios";

/** iOS reports "inactive" as the switcher opens and "background" once the app is behind another: both are covered. */
export function coveredWhen(appState: string): boolean {
  return SWITCHER_BLANKED && appState !== "active";
}

type ScreenCapture = { preventScreenCaptureAsync(key?: string): Promise<void>; enableAppSwitcherProtectionAsync?(blurIntensity?: number): Promise<void> };

export async function guardScreen(): Promise<void> {
  if (!SCREENSHOTS_BLOCKED && !SWITCHER_BLANKED) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ScreenCapture = require("expo-screen-capture") as ScreenCapture;
    if (SCREENSHOTS_BLOCKED) await ScreenCapture.preventScreenCaptureAsync("hmis");
    else await ScreenCapture.enableAppSwitcherProtectionAsync?.(1);
  } catch {
    // A phone on which the native call fails still opens the app; the flag is a guard, not a gate.
  }
}
