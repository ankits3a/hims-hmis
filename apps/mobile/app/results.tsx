import { Redirect } from "expo-router";
import { ResultsScreen } from "../src/screens/results";
import { useSession } from "../src/session";

/** #681 — lab and imaging reports, read-only, from Open loops. Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <ResultsScreen />;
}
