import { useEffect, useState } from "react";
import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";

/**
 * WHAT THE PHONE'S OWN LOCK IS CALLED. An Android phone says "fingerprint"; an iPhone says
 * "Face ID" or "Touch ID", and a sentence that names the wrong one reads as a mistake. Read from
 * what the phone says it has (`supportedAuthenticationTypesAsync`); an iPhone that will not say is
 * "Touch ID / Face ID". Words only: which check runs is the phone's business (src/session.tsx).
 */
export type BiometricWord = "fingerprint" | "faceId" | "touchId" | "apple";

const FINGERPRINT = 1, FACE = 2; // LocalAuthentication.AuthenticationType

export function biometricWord(os: string, types: readonly number[] | null): BiometricWord {
  if (os !== "ios") return "fingerprint";
  const face = types?.includes(FACE) === true, touch = types?.includes(FINGERPRINT) === true;
  if (face && !touch) return "faceId";
  if (touch && !face) return "touchId";
  return "apple";
}

/** The i18n key of the line under a money approval. Android keeps the sentence it always had. */
export function fineMoneyKey(word: BiometricWord): string {
  return word === "fingerprint" ? "home.sheet.fineMoney" : `mobile.fineMoney.${word}`;
}

export function useBiometricWord(): BiometricWord {
  const [word, setWord] = useState<BiometricWord>(() => biometricWord(Platform.OS, null));
  useEffect(() => {
    if (Platform.OS !== "ios") return undefined;
    let gone = false;
    void (async () => {
      try {
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (!gone) setWord(biometricWord("ios", types));
      } catch { /* the phone would not say: "Touch ID / Face ID" stands */ }
    })();
    return () => { gone = true; };
  }, []);
  return word;
}
