import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { CopilotScreen } from "../src/screens/copilot";
import { holdReturn, type WidgetRoute } from "../src/return-to";
import { useSession } from "../src/session";
import { useCopilotOn } from "../src/copilot/setting";
import { color } from "../src/theme";

/**
 * E1.3 — the copilot on the phone (decision 0064), and the Ask widget's `hmis://copilot?keyboard=1`
 * (#590, E1.7). Only for a signed-in session; every other state lives at "/". A cold start from the
 * widget arrives while the session is still being read: it waits, and if the phone must first be
 * unlocked or signed in, "/" does that and then comes back here (src/return-to.ts), as for the scan widget.
 */
export default function Page() {
  const { state } = useSession();
  const { on, known } = useCopilotOn();
  const router = useRouter();
  const { keyboard, mic } = useLocalSearchParams<{ keyboard?: string; mic?: string }>();
  const via: WidgetRoute | null = mic === "1" ? "/copilot?mic=1" : keyboard === "1" ? "/copilot?keyboard=1" : null;
  const gate = state.status !== "signedIn" && state.status !== "loading";
  useEffect(() => {
    if (!gate) return;
    if (via !== null) holdReturn(via);
    // "/" is anchored under this route (app/_layout.tsx), so this returns to it rather than stacking a second one.
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [gate, via, router]);
  // PHONE SETTINGS (owner 2026-10-11) — off (the default): Settings, where it is turned on. Not before
  // the server has said so: until then "off" only means "not read yet".
  if (state.status === "signedIn" && known && !on) return <Redirect href="/settings" />;
  if (state.status === "signedIn" && on) return <CopilotScreen keyboard={keyboard === "1"} listen={mic === "1"} />;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.paper }}>
      <ActivityIndicator color={color.green} />
    </View>
  );
}
