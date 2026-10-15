import { Platform } from "react-native";
import { APP_VERSION_CODE, UPDATE_FEED } from "./config";

/**
 * IS THERE A NEWER BUILD? (owner 2026-10-05: no Play Store and no App Store, ever.)
 *
 * Without a store nothing tells a phone that a newer APK exists, so the app asks: a small JSON the
 * build script writes beside the APKs (`scripts/build-apk.sh` → `hmis-staff-<env>-latest.json`).
 * It carries a version, a file name and a checksum — never anything about a patient — and the app
 * only ever OFFERS the download: Android installs it, after the person taps the file, and only
 * because it is signed with the same key as the build already on the phone.
 *
 * A check that cannot be made (no signal, the feed not served yet) is "unknown", and unknown says
 * nothing on start-up. It is never an error on a clinical screen.
 *
 * iPHONE (owner 2026-10-08): the iPhone app comes from the App Store, and the App Store updates it.
 * An iPhone cannot install an APK, so on iOS the feed is never read, nothing is offered and the
 * "Check for update" rows are not drawn (`updatesFromFeed`).
 */
export type LatestBuild = { versionCode: number; versionName: string; apk: string; sha256: string; builtAt?: string; notes?: string };
export type UpdateAnswer =
  | { kind: "update"; latest: LatestBuild; url: string }
  | { kind: "latest" }
  | { kind: "unknown" }
  /** iPhone: the App Store keeps the app current; the app asks nobody. */
  | { kind: "store" };

/** Does THIS phone learn of a new build from the hospital's own folder? Android and the browser preview: yes. iPhone: no. */
export function updatesFromFeed(): boolean {
  return Platform.OS !== "ios";
}

/** The feed is read as untrusted text: a body that is not exactly this shape is "unknown", never half-believed. */
export function parseLatest(body: unknown): LatestBuild | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.versionCode !== "number" || !Number.isInteger(b.versionCode) || b.versionCode <= 0) return null;
  if (typeof b.versionName !== "string" || b.versionName === "") return null;
  // A bare file name beside the feed — never a path, never another host.
  if (typeof b.apk !== "string" || !/^[A-Za-z0-9._-]+\.apk$/.test(b.apk)) return null;
  if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return null;
  return {
    versionCode: b.versionCode, versionName: b.versionName, apk: b.apk, sha256: b.sha256,
    ...(typeof b.builtAt === "string" ? { builtAt: b.builtAt } : {}),
    ...(typeof b.notes === "string" && b.notes.trim() !== "" ? { notes: b.notes.trim().slice(0, 300) } : {}),
  };
}

/** The APK sits in the feed's own folder. */
export function apkUrl(feed: string, apk: string): string {
  return `${feed.slice(0, feed.lastIndexOf("/") + 1)}${apk}`;
}

export async function checkForUpdate(
  fetcher: typeof fetch = fetch, installed: number = APP_VERSION_CODE, feed: string = UPDATE_FEED,
): Promise<UpdateAnswer> {
  if (!updatesFromFeed()) return { kind: "store" };
  try {
    const res = await fetcher(feed, { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) return { kind: "unknown" };
    const latest = parseLatest(JSON.parse(await res.text()));
    if (latest === null) return { kind: "unknown" };
    return latest.versionCode > installed ? { kind: "update", latest, url: apkUrl(feed, latest.apk) } : { kind: "latest" };
  } catch {
    return { kind: "unknown" };
  }
}
