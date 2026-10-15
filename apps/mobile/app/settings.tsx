import { Redirect } from "expo-router";
import { SettingsScreen } from "../src/screens/settings";
import { useSession } from "../src/session";

/** PHONE SETTINGS (owner 2026-10-11) — behind the gear. Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <SettingsScreen />;
}
