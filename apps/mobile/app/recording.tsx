import { Redirect } from "expo-router";
import { RecordingScreen } from "../src/screens/recording";
import { useSession } from "../src/session";

/** "Recorded today", by doctor (owner 2026-10-07). Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <RecordingScreen />;
}
