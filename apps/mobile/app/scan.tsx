import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { useRouter } from "expo-router";
import { holdScan } from "../src/return-to";
import { ScanScreen } from "../src/screens/scan";
import { useSession } from "../src/session";
import { color } from "../src/theme";

/**
 * Scan a patient — the header's scan button (owner 2026-10-08) and the home-screen widget's
 * `hmis://scan` (owner 2026-10-10, decision 0064). Only for a signed-in session; every other state
 * lives at "/". A cold start from the widget arrives while the session is still being read: it waits,
 * and if the phone must first be unlocked or signed in, "/" does that and then comes back here
 * (src/return-to.ts) — never the home screen first.
 */
export default function Page() {
  const { state } = useSession();
  const router = useRouter();
  const gate = state.status !== "signedIn" && state.status !== "loading";
  useEffect(() => {
    if (!gate) return;
    holdScan();
    // "/" is anchored under this route (app/_layout.tsx), so this returns to it rather than stacking a second one.
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [gate, router]);
  if (state.status === "signedIn") return <ScanScreen />;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.paper }}>
      <ActivityIndicator color={color.green} />
    </View>
  );
}
