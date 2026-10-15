import { Redirect } from "expo-router";
import { MyPaceScreen } from "../src/screens/my-pace";
import { useSession } from "../src/session";

/** "My pace" (owner 2026-10-09). Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <MyPaceScreen />;
}
