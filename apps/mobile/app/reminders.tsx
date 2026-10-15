import { Redirect } from "expo-router";
import { RemindersScreen } from "../src/screens/reminders";
import { useSession } from "../src/session";

/** E1.2 — a person's own reminders (decision 0064). Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <RemindersScreen />;
}
