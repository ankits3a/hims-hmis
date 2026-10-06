import { Platform } from "react-native";
import { IS_PRODUCTION } from "./config";

/**
 * ═══ M6b — NO SCREENSHOTS OF PATIENTS ON A PERSONAL PHONE (owner 2026-10-06, delegated) ═══
 *
 * The production app sets Android's FLAG_SECURE on its window: a screenshot comes out black, a
 * screen recording records nothing, and the app is blank in the recent-apps strip. Staff use their
 * own phones for some months; a screenshot of a queue in a family chat group is the leak this stops.
 *
 * The STAGING build leaves screenshots allowed on purpose — it holds test data only, and a
 * screenshot is how somebody shows what went wrong. The Account screen says which this build is.
 */
export const SCREENSHOTS_BLOCKED: boolean = IS_PRODUCTION && Platform.OS !== "web";

export async function guardScreen(): Promise<void> {
  if (!SCREENSHOTS_BLOCKED) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ScreenCapture = require("expo-screen-capture") as { preventScreenCaptureAsync(key?: string): Promise<void> };
    await ScreenCapture.preventScreenCaptureAsync("hmis");
  } catch {
    // A phone on which the native call fails still opens the app; the flag is a guard, not a gate.
  }
}
