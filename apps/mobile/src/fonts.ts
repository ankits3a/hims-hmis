import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular";
import { IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono/500Medium";
import { IBMPlexMono_700Bold } from "@expo-google-fonts/ibm-plex-mono/700Bold";
import { IBMPlexSans_400Regular } from "@expo-google-fonts/ibm-plex-sans/400Regular";
import { IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans/500Medium";
import { IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans/600SemiBold";
import { IBMPlexSans_700Bold } from "@expo-google-fonts/ibm-plex-sans/700Bold";
import type { TextStyle } from "react-native";

/**
 * IBM Plex — the web's typeface (apps/web: `IBM Plex Sans`, `IBM Plex Mono`), bundled in the app so
 * a ward with no signal still draws it. One file per weight, imported by sub-path: the package's
 * index would pull all fourteen faces into the APK.
 *
 * A custom face on Android is ONE weight per family name, so the weight is chosen by NAME here and
 * `fontWeight` is set back to normal — leaving both would have Android thicken an already-bold face.
 * Hindi is drawn by the phone's own Devanagari face: Plex Sans carries no Devanagari, and Android
 * falls back glyph by glyph (the web's Plex Sans Devanagari is a later addition).
 */
export const FONT_FILES = {
  IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold, IBMPlexSans_700Bold,
  IBMPlexMono_400Regular, IBMPlexMono_500Medium, IBMPlexMono_700Bold,
} as const;

let ready = false;
/** Called once by the root layout when the faces are registered. Until then (and in tests) text is the system's. */
export function setPlexReady(v: boolean): void { ready = v; }
export function plexReady(): boolean { return ready; }

const MONO_HINT = /mono|menlo|courier/i;

export function weightOf(w: TextStyle["fontWeight"]): number {
  if (w === undefined || w === "normal") return 400;
  if (w === "bold") return 700;
  const n = Number(w);
  return Number.isFinite(n) ? n : 400;
}

/** The face for a style: mono when the style asked for a monospace family, else sans; the nearest bundled weight. */
export function plexFamily(style: Pick<TextStyle, "fontFamily" | "fontWeight">): keyof typeof FONT_FILES {
  const w = weightOf(style.fontWeight);
  if (typeof style.fontFamily === "string" && MONO_HINT.test(style.fontFamily)) {
    return w >= 600 ? "IBMPlexMono_700Bold" : w >= 500 ? "IBMPlexMono_500Medium" : "IBMPlexMono_400Regular";
  }
  return w >= 700 ? "IBMPlexSans_700Bold" : w >= 600 ? "IBMPlexSans_600SemiBold" : w >= 500 ? "IBMPlexSans_500Medium" : "IBMPlexSans_400Regular";
}
