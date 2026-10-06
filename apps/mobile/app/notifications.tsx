import { Redirect } from "expo-router";
import { NotificationsScreen } from "../src/screens/notifications";
import { useSession } from "../src/session";

/** Notifications on this phone (plan M6b). Only for a signed-in session; every other state lives at "/". */
export default function Notifications() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <NotificationsScreen />;
}
