import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { APP_VERSION, APP_VERSION_CODE } from "./config";

/**
 * THIS PHONE, AS THE SERVER KNOWS IT (plan M6a; owner 2026-10-06: staff use personal phones).
 *
 * The app sends a small claim with its sign-in — an id it makes up ONCE per install, and what the
 * phone says it is — so an administrator can see which phones hold a session for a person and sign
 * a lost one out (`/admin/users` → Phones). The id is a LABEL, not a secret and not a credential:
 * the server grants nothing for it, a session is still a password. It is kept in the secure store
 * under its own key so that logging out (which clears the session) does not make the phone look new.
 *
 * Nothing here identifies the handset itself — no IMEI, no advertising id, no phone number: an
 * uninstall forgets the id, and a reinstall is, correctly, a phone the administrator has not seen.
 */
const KEY = "hmis.device";
const VALID = /^[A-Za-z0-9_-]{16,64}$/;
let memory: string | null = null;

/** 32 hex characters. An identifier, not a secret — `Math.random` is enough to tell two phones apart. */
function mint(): string {
  let out = "";
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export async function deviceId(): Promise<string> {
  if (memory !== null) return memory;
  let stored: string | null = null;
  if (Platform.OS !== "web") {
    try { stored = await SecureStore.getItemAsync(KEY); } catch { stored = null; }
  }
  if (stored !== null && VALID.test(stored)) { memory = stored; return stored; }
  const fresh = mint();
  memory = fresh;
  if (Platform.OS !== "web") {
    try { await SecureStore.setItemAsync(KEY, fresh, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }); } catch { /* the id then lasts until the app is closed */ }
  }
  return fresh;
}

const cut = (s: string, max: number): string | undefined => {
  const t = s.replace(/\s+/g, " ").trim().slice(0, max);
  return t === "" ? undefined : t;
};

/**
 * What the phone says it is: "Xiaomi Redmi Note 12" and "Android 14". Read from the platform, no extra module.
 * An iPhone tells JavaScript its system and version ("iOS 18.1") but not which iPhone it is, and the
 * name its owner gave it ("Asha's iPhone") is personal and is not read: the model is "iPhone".
 */
export function describePhone(): { model?: string; os?: string } {
  const c = (Platform.constants ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof c[k] === "string" ? (c[k] as string) : "");
  if (Platform.OS === "android") {
    const maker = str("Manufacturer"), model = str("Model");
    const named = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker} ${model}`;
    return { model: cut(named, 80), os: cut(`Android ${str("Release")}`, 40) };
  }
  if (Platform.OS === "ios") return { model: "iPhone", os: cut(`iOS ${String(Platform.Version)}`, 40) };
  return { model: cut("Browser preview", 80) };
}

export type DeviceClaim = { deviceId: string; model?: string; os?: string; appVersion?: string };

/** The claim the sign-in carries. `null` in the browser preview, which is not a phone and keeps no id. */
export async function deviceClaim(): Promise<DeviceClaim | null> {
  if (Platform.OS === "web") return null;
  const said = describePhone();
  return {
    deviceId: await deviceId(),
    ...(said.model === undefined ? {} : { model: said.model }),
    ...(said.os === undefined ? {} : { os: said.os }),
    appVersion: `${APP_VERSION} (${APP_VERSION_CODE})`.slice(0, 40),
  };
}

/** Tests only: forget the cached id. */
export function _forgetDeviceForTests(): void { memory = null; }
