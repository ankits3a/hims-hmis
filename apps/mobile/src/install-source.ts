import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

/**
 * WAS THIS PHONE'S APP INSTALLED BY GOOGLE PLAY? (spec #1058, decision 0095)
 *
 * The same Android app reaches phones two ways: the hospital's download link and Google Play. Play bans an
 * app it distributes from updating itself any other way, so a Play phone is never offered the hospital's
 * APK (src/update.ts). The answer comes from Android itself, through the app's own small native module
 * (modules/install-source): the APK and the Play bundle are the same native app, so one over-the-air bundle
 * serves both. Anything that cannot be read — an older build without the module, the browser preview, an
 * error — is "not Play", which keeps every phone that has the app today exactly as it is.
 */
export const GOOGLE_PLAY = "com.android.vending";

type Native = { installer(): string | null };
let native: Native | null | undefined;

export function installer(): string | null {
  if (Platform.OS !== "android") return null;
  try {
    if (native === undefined) native = requireOptionalNativeModule<Native>("HmisInstallSource");
    const who = native?.installer();
    return typeof who === "string" && who !== "" ? who : null;
  } catch {
    return null;
  }
}

export function installedFromPlay(): boolean {
  return installer() === GOOGLE_PLAY;
}
