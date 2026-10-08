import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { SWITCHER_BLANKED, coveredWhen } from "./privacy";
import { color } from "./theme";

/**
 * iPHONE, PRODUCTION BUILD ONLY: a blank sheet over the app while it is not in front, so the card
 * iOS keeps in the app switcher shows paper and no patient (src/privacy.ts says what it cannot
 * cover). It takes no touches and draws nothing at all on Android, on staging or in the browser.
 */
export function PrivacyCover() {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    if (!SWITCHER_BLANKED) return undefined;
    const sub = AppState.addEventListener("change", (next) => setCovered(coveredWhen(next)));
    return () => sub.remove();
  }, []);
  if (!covered) return null;
  return <View testID="privacy-cover" pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color.paper, zIndex: 1000, elevation: 1000 }]} />;
}
