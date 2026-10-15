import { createContext, forwardRef, useContext } from "react";
import { StyleSheet, Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps, type TextStyle } from "react-native";
import { plexFamily, plexReady } from "./fonts";

/**
 * `Text` and `TextInput` in IBM Plex. React Native has no app-wide default face, so every screen
 * imports these two instead of the framework's. With the faces not registered (a test, or the first
 * frames before the root layout has loaded them) the style passes through untouched.
 */
const InsideText = createContext(false);

function plexed(style: TextProps["style"], inside: boolean): TextProps["style"] {
  if (!plexReady()) return style;
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  // A span inside another Text that sets no weight or family of its own keeps its parent's face.
  if (inside && flat.fontFamily === undefined && flat.fontWeight === undefined) return style;
  return [style, { fontFamily: plexFamily(flat), fontWeight: "normal" }];
}

export const Text = forwardRef<RNText, TextProps>(function Text({ style, children, ...rest }, ref) {
  const inside = useContext(InsideText);
  return (
    <RNText ref={ref} {...rest} style={plexed(style, inside)}>
      <InsideText.Provider value={true}>{children}</InsideText.Provider>
    </RNText>
  );
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...rest }, ref) {
  return <RNTextInput ref={ref} {...rest} style={plexed(style, false)} />;
});

/** Whether any text field holds the keyboard right now (React Native's own focus registry). */
export function anyInputFocused(): boolean {
  try {
    return RNTextInput.State?.currentlyFocusedInput?.() != null;
  } catch {
    return false;
  }
}

/** The instance types, so `useRef<TextInput>(null)` reads as it did with the framework's own. */
export type Text = RNText;
export type TextInput = RNTextInput;
