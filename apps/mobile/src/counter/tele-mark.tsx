import { Image } from "react-native";
import { color } from "../theme";

/**
 * TELE-CALL (owner 2026-10-09): *"use icon for telecall and not the text as we have limited screen
 * size."* The web's handset (`components/tele-mark.tsx`), as one small image tinted by the theme —
 * the app carries no icon library. With a `label` it is an image a screen reader names
 * ("Tele-call"); without one it is decoration beside a control that already says the word.
 */
const HANDSET = require("../../assets/tele-call.png") as number;

export function TeleMark({ label, size = 18, tint = color.blue, testID }: { label?: string; size?: number; tint?: string; testID?: string }) {
  return (
    <Image
      testID={testID} source={HANDSET} resizeMode="contain"
      accessible={label !== undefined} accessibilityRole={label === undefined ? undefined : "image"} accessibilityLabel={label}
      style={{ width: size, height: size, tintColor: tint }}
    />
  );
}
