import { Redirect } from "expo-router";
import { MyLeaveScreen } from "../src/screens/my-leave";
import { useSession } from "../src/session";

/** E2.2 — a person's own leave, and a department head's "to decide" (decision 0069). Signed-in only. */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <MyLeaveScreen />;
}
