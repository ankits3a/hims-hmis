import { Redirect } from "expo-router";
import { PaperConsultsScreen } from "../src/screens/paper-consults";
import { useSession } from "../src/session";

/** My paper consultations, on the phone (decision 0043). Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <PaperConsultsScreen />;
}
