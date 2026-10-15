import { Redirect } from "expo-router";
import { AlertsScreen } from "../src/screens/alerts";
import { useSession } from "../src/session";

/** The bell's rows (app home round 2). Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <AlertsScreen />;
}
