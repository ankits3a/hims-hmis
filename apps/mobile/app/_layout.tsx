import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { SessionProvider } from "../src/session";

export default function RootLayout() {
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
