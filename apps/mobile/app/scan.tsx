import { Redirect } from "expo-router";
import { ScanScreen } from "../src/screens/scan";
import { useSession } from "../src/session";

/** Scan a patient — the header's scan button (owner 2026-10-08). Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <ScanScreen />;
}
