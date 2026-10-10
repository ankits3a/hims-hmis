import { Redirect } from "expo-router";
import { CopilotScreen } from "../src/screens/copilot";
import { useSession } from "../src/session";

/** E1.3 — the copilot on the phone (decision 0064). Only for a signed-in session; a signed-out person is sent to sign in at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <CopilotScreen />;
}
