import { Redirect } from "expo-router";
import { CopilotScreen } from "../src/screens/copilot";
import { useSession } from "../src/session";
import { useCopilotOn } from "../src/copilot/setting";

/** E1.3 — the copilot on the phone (decision 0064). Only for a signed-in session; a signed-out person is sent to sign in at "/". */
export default function Page() {
  const { state } = useSession();
  const { on } = useCopilotOn();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  // PHONE SETTINGS (owner 2026-10-11) — off (the default): Settings, where it is turned on.
  if (!on) return <Redirect href="/settings" />;
  return <CopilotScreen />;
}
