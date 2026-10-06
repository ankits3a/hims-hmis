import { Redirect } from "expo-router";
import { AccountScreen } from "../src/screens/account";
import { useSession } from "../src/session";

/** This phone and my account (plan M6a). Only for a signed-in session; every other state lives at "/". */
export default function Account() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <AccountScreen />;
}
