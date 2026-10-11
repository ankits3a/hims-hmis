import { Redirect } from "expo-router";
import { OpenLoopsScreen } from "../src/screens/open-loops";
import { useSession } from "../src/session";

/** E1.4 — Open loops: what is waiting for me (decision 0064). Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <OpenLoopsScreen />;
}
