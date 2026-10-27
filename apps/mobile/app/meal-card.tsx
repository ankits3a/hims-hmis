import { Redirect } from "expo-router";
import { MealCardScreen } from "../src/canteen/meal-card";
import { useSession } from "../src/session";

/** CN-1 (#977) — the staff meal card's QR. Only for a signed-in session; every other state lives at "/". */
export default function Page() {
  const { state } = useSession();
  if (state.status !== "signedIn") return <Redirect href="/" />;
  return <MealCardScreen />;
}
