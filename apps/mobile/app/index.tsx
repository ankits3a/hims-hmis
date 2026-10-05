import { ActivityIndicator, View } from "react-native";
import { ChangePasswordScreen } from "../src/screens/change-password";
import { LoginScreen } from "../src/screens/login";
import { SeatHome } from "../src/screens/seat-home";
import { UnlockScreen } from "../src/screens/unlock";
import { useSession } from "../src/session";
import { color } from "../src/theme";

/** One entry, one state machine (src/session.tsx): every session state has exactly one screen. */
export default function Index() {
  const { state } = useSession();
  switch (state.status) {
    case "loading":
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.paper }}>
          <ActivityIndicator color={color.green} />
        </View>
      );
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
