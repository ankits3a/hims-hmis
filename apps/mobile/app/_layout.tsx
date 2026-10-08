import { useEffect } from "react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FONT_FILES, setPlexReady } from "../src/fonts";
import { I18nProvider } from "../src/i18n";
import { NotificationsProvider } from "../src/notifications";
import { guardScreen } from "../src/privacy";
import { PrivacyCover } from "../src/privacy-cover";
import { SessionProvider } from "../src/session";

// The crest stays up until the typeface is registered, so no screen is first drawn in the system's.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [loaded, error] = useFonts(FONT_FILES);
  // A face that fails to register must not keep the app shut: the system's face is drawn instead.
  const ready = loaded || error !== null;
  if (loaded) setPlexReady(true);
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => undefined); }, [ready]);
  // M6b — the production app shows no patient in a screenshot, a recording or the recent-apps strip
  // (Android); on an iPhone it hides the app in the app switcher (src/privacy.ts).
  useEffect(() => { void guardScreen(); }, []);
  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <SessionProvider>
          <NotificationsProvider>
            <StatusBar style="light" />
            <Stack screenOptions={{ headerShown: false }} />
            <PrivacyCover />
          </NotificationsProvider>
        </SessionProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
