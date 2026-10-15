import { Redirect, useLocalSearchParams } from "expo-router";
import { ALL_READ } from "../src/attendance/api";
import { AttendanceManage, type ManageTab } from "../src/screens/attendance-manage";
import { useSession } from "../src/session";

/** Staff attendance for those who may see it. Without `attendance.all.read` it is "My team" only, and only when home said the person leads one. */
export default function Page() {
  const { tab, lead } = useLocalSearchParams<{ tab?: string; lead?: string }>();
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  const all = state.me.permissions.hospital.includes(ALL_READ);
  if (!all && lead !== "1") return <Redirect href="/" />;
  return <AttendanceManage lead={lead === "1"} tab={tab === "today" || tab === "team" || tab === "requests" ? (tab as ManageTab) : undefined} />;
}
