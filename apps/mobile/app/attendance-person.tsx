import { Redirect, useLocalSearchParams } from "expo-router";
import { AttendancePerson } from "../src/screens/attendance-person";
import { useSession } from "../src/session";

/** One person's attendance for a manager. The server decides whether this caller may open this pin. */
export default function Page() {
  const { pin, name } = useLocalSearchParams<{ pin?: string; name?: string }>();
  const { state } = useSession();
  if (state.status !== "signedIn" || typeof pin !== "string" || pin === "") return <Redirect href="/" />;
  return <AttendancePerson pin={pin} name={typeof name === "string" ? name : undefined} />;
}
