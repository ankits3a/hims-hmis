import { useEffect } from "react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FONT_FILES, setPlexReady } from "../src/fonts";
import { I18nProvider } from "../src/i18n";
import { SessionProvider } from "../src/session";

// The crest stays up until the typeface is registered, so no screen is first drawn in the system's.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const [loaded, error] = useFonts(FONT_FILES);
  // A face that fails to register must not keep the app shut: the system's face is drawn instead.
  const ready = loaded || error !== null;
  if (loaded) setPlexReady(true);
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => undefined); }, [ready]);
  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <SessionProvider>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false }} />
        </SessionProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
