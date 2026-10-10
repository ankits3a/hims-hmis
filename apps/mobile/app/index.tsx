import { useEffect, useReducer } from "react";
import { ActivityIndicator, View } from "react-native";
import { useRouter } from "expo-router";
import { scanIsOwed, takeScanOwed } from "../src/return-to";
import { ChangePasswordScreen } from "../src/screens/change-password";
import { LoginScreen } from "../src/screens/login";
import { SeatHome } from "../src/screens/seat-home";
import { UnlockScreen } from "../src/screens/unlock";
import { useSession } from "../src/session";
import { color } from "../src/theme";

/** One entry, one state machine (src/session.tsx): every session state has exactly one screen. */
export default function Index() {
  const { state } = useSession();
  const router = useRouter();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // The scan widget reached "/scan" before sign-in (src/return-to.ts): once signed in, open it, not home.
  const owed = state.status === "signedIn" && scanIsOwed();
  useEffect(() => {
    if (owed && takeScanOwed()) { router.push("/scan"); redraw(); }
  }, [owed, router]);
  if (owed) return <Spinner />;
  switch (state.status) {
    case "loading":
      return <Spinner />;
    case "signedOut":
      return <LoginScreen expired={state.note === "expired"} />;
    case "locked":
      return <UnlockScreen />;
    case "mustChange":
      return <ChangePasswordScreen />;
    case "signedIn":
      return <SeatHome />;
  }
}

function Spinner() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.paper }}>
      <ActivityIndicator color={color.green} />
    </View>
  );
}
