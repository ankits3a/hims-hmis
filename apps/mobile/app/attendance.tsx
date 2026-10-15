import { Redirect, useLocalSearchParams } from "expo-router";
import { MyAttendance } from "../src/screens/my-attendance";
import { useSession } from "../src/session";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** My attendance. `?confirm=<date>` opens that day's Confirm sheet; `?request=<id>` the day a closed request was about. */
export default function Page() {
  const { confirm, request } = useLocalSearchParams<{ confirm?: string; request?: string }>();
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <MyAttendance openDay={typeof confirm === "string" && ISO.test(confirm) ? confirm : undefined} openRequest={typeof request === "string" && request !== "" ? request : undefined} />;
}
