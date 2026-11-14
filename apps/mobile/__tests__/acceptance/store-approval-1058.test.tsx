import { readFileSync } from "fs";
import { join } from "path";
import { render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ExpoConfig } from "expo/config";
import { I18nProvider } from "../../src/i18n";
import { SeatHome } from "../../src/screens/seat-home";
import { SessionProvider, useSession } from "../../src/session";
import { checkForUpdate, updatesFromFeed } from "../../src/update";
import en from "../../src/locales/en.json";
import hi from "../../src/locales/hi.json";

/**
 * SPEC #1058 — docs/specs/1058-store-approval.md (owner APPROVED 2026-11-14): the staff app on the App Store
 * and Google Play, named CRKMCH; the staging iPhone app stays in TestFlight.
 */
let mockFromPlay = false;
jest.mock("../../src/install-source", () => ({ installedFromPlay: () => mockFromPlay }));
const mockStore = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" })]]);
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

const realOS = Platform.OS;
function onPhone(os: "android" | "ios", fromPlay: boolean) { (Platform as { OS: string }).OS = os; mockFromPlay = fromPlay; }
afterEach(() => { (Platform as { OS: string }).OS = realOS; mockFromPlay = false; });

const FEED = "https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json";
const NEWER = { versionCode: 99999, versionName: "9.9.9", apk: "hmis-staff-staging-9.9.9-vc99999-abc12345.apk", sha256: "a".repeat(64) };
function feedFetcher(asked: string[]) {
  return jest.fn(async (url: string) => {
    asked.push(url);
    if (url === FEED || url.endsWith("-latest.json")) return new Response(JSON.stringify(NEWER), { status: 200 });
    if (url.endsWith("/api/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "01J" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } }), { status: 200 });
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  }) as unknown as typeof fetch;
}
async function seatHome(fetcher: typeof fetch) {
  function Gate() {
    const { state } = useSession();
    return state.status === "signedIn" ? <SeatHome /> : null;
  }
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
  expect(await screen.findByTestId("app-version")).toBeTruthy();
}

it("spec #1058 D1: a phone Google Play installed answers 'store', reads no feed and draws no 'Check for update'", async () => {
  onPhone("android", true);
  const asked: string[] = [];
  const fetcher = feedFetcher(asked);
  expect(updatesFromFeed()).toBe(false);
  expect(await checkForUpdate(fetcher, 1, FEED)).toEqual({ kind: "store" });
  expect(asked).toEqual([]);
  await seatHome(fetcher);
  expect(screen.queryByTestId("update-check")).toBeNull();
  expect(screen.queryByTestId("update-offer")).toBeNull();
  expect(asked.some((u) => u.endsWith(".json") || u.endsWith(".apk"))).toBe(false);
});

it("spec #1058 D2: a phone any other installer installed (or an unknown one) reads the feed and offers the newer APK", async () => {
  onPhone("android", false);
  const asked: string[] = [];
  const fetcher = feedFetcher(asked);
  expect(updatesFromFeed()).toBe(true);
  const answer = await checkForUpdate(fetcher, 1, FEED);
  expect(answer.kind).toBe("update");
  expect(asked).toEqual([FEED]);
  await seatHome(feedFetcher([]));
  expect(screen.getByTestId("update-check")).toBeTruthy();
});

it("spec #1058 D3: on iPhone nothing changes — 'store', no feed read", async () => {
  for (const fromPlay of [false, true]) {
    onPhone("ios", fromPlay);
    const asked: string[] = [];
    expect(updatesFromFeed()).toBe(false);
    expect(await checkForUpdate(feedFetcher(asked), 1, FEED)).toEqual({ kind: "store" });
    expect(asked).toEqual([]);
  }
});

/* ---- D4: the bundle check scripts/build-apk.sh runs on every Play bundle before it is kept ---- */
type Checks = { checkPlayBundle: (b: { manifest: string; libs: { path: string; bytes: Uint8Array }[] }) => string[] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadChecks = (): Checks => require("../../scripts/play-checks") as Checks;

function manifest(opts: { perms?: string[]; target?: number | null } = {}): string {
  const perms = (opts.perms ?? ["android.permission.INTERNET", "android.permission.CAMERA", "android.permission.RECORD_AUDIO", "android.permission.ACCESS_FINE_LOCATION"])
    .map((p) => `    <uses-permission android:name="${p}" />`).join("\n");
  const sdk = opts.target === null ? "" : `    <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="${opts.target ?? 36}" />\n`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.crkmch.hmis">\n${sdk}${perms}\n    <application android:label="@string/app_name" />\n</manifest>\n`;
}
/** A minimal 64-bit (or 32-bit) little-endian ELF with two PT_LOAD segments of the given alignment. */
function elf(bits: 64 | 32, align: number): Uint8Array {
  const ph = bits === 64 ? 56 : 32, phoff = bits === 64 ? 64 : 52, n = 2;
  const b = Buffer.alloc(phoff + ph * n);
  b.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, 1, 1], 0);
  if (bits === 64) { b.writeBigUInt64LE(BigInt(phoff), 0x20); b.writeUInt16LE(ph, 0x36); b.writeUInt16LE(n, 0x38); }
  else { b.writeUInt32LE(phoff, 0x1c); b.writeUInt16LE(ph, 0x2a); b.writeUInt16LE(n, 0x2c); }
  for (let i = 0; i < n; i++) {
    const at = phoff + i * ph;
    b.writeUInt32LE(1, at); // PT_LOAD
    if (bits === 64) b.writeBigUInt64LE(BigInt(align), at + 48); else b.writeUInt32LE(align, at + 28);
  }
  return b;
}
const CLEAN_LIBS = [
  { path: "base/lib/arm64-v8a/libhermes.so", bytes: elf(64, 0x4000) },
  { path: "base/lib/armeabi-v7a/libhermes.so", bytes: elf(32, 0x1000) },
];

it("spec #1058 D4: the Play bundle check refuses what Play refuses, and passes a clean bundle", () => {
  const checks = loadChecks();
  expect(checks.checkPlayBundle({ manifest: manifest(), libs: CLEAN_LIBS })).toEqual([]);
  for (const p of ["android.permission.REQUEST_INSTALL_PACKAGES", "android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_EXTERNAL_STORAGE"]) {
    const refused = checks.checkPlayBundle({ manifest: manifest({ perms: ["android.permission.INTERNET", p] }), libs: CLEAN_LIBS });
    expect(refused.join("\n")).toContain(p);
  }
  expect(checks.checkPlayBundle({ manifest: manifest({ target: 34 }), libs: CLEAN_LIBS }).join("\n")).toMatch(/targetSdkVersion/);
  expect(checks.checkPlayBundle({ manifest: manifest({ target: null }), libs: CLEAN_LIBS }).join("\n")).toMatch(/targetSdkVersion/);
  const badLib = { path: "base/lib/arm64-v8a/libold.so", bytes: elf(64, 0x1000) };
  expect(checks.checkPlayBundle({ manifest: manifest(), libs: [...CLEAN_LIBS, badLib] }).join("\n")).toContain("libold.so");
});

/* ---- D5..D7: the app config and eas.json ---- */
function configFor(env: Record<string, string>): ExpoConfig {
  const before = { ...process.env };
  let out!: ExpoConfig;
  try {
    for (const k of ["APP_ENV", "HMIS_VERSION_CODE", "HMIS_PUSH_IN_BUILD", "EXPO_PUBLIC_API_BASE", "EXPO_PUBLIC_UPDATE_FEED"]) delete process.env[k];
    Object.assign(process.env, env);
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      out = (require("../../app.config") as { default: ExpoConfig }).default;
    });
  } finally {
    process.env = before;
  }
  return out;
}
function iosSentences(c: ExpoConfig): string[] {
  const said: string[] = [];
  for (const p of c.plugins ?? []) {
    if (!Array.isArray(p)) continue;
    for (const [k, v] of Object.entries((p[1] ?? {}) as Record<string, unknown>)) if (/Permission$/.test(k) && typeof v === "string") said.push(v);
  }
  return said;
}
function widgetLabel(c: ExpoConfig): string {
  const p = (c.plugins ?? []).find((x) => Array.isArray(x) && x[0] === "./plugins/with-scan-widget") as [string, { label: string }];
  return p[1].label;
}

it("spec #1058 D5: the app is named CRKMCH (CRKMCH Staging on staging); every iPhone sentence and the widget say CRKMCH; ids unchanged", () => {
  const prod = configFor({ APP_ENV: "production" }), stage = configFor({ APP_ENV: "preview" });
  expect(prod.name).toBe("CRKMCH");
  expect(stage.name).toBe("CRKMCH Staging");
  for (const c of [prod, stage]) {
    const said = iosSentences(c);
    expect(said.length).toBeGreaterThanOrEqual(5);
    for (const s of said) { expect(s).toMatch(/^CRKMCH /); expect(s).not.toMatch(/HMIS/); }
  }
  expect(widgetLabel(prod)).toBe("CRKMCH Scan");
  expect(widgetLabel(stage)).toBe("CRKMCH Scan (staging)");
  expect([prod.ios?.bundleIdentifier, prod.android?.package]).toEqual(["com.crkmch.hmis", "com.crkmch.hmis"]);
  expect([stage.ios?.bundleIdentifier, stage.android?.package]).toEqual(["com.crkmch.hmis.staging", "com.crkmch.hmis.staging"]);
});

it("spec #1058 D6: no phone string that sends a person to the phone's own lists still says HMIS (English and Hindi)", () => {
  // The account password is the hospital system's; the push line quotes the server's sentence until it changes
  // (#1059); "app.title" is the web's own title, which the phone no longer shows (it shows mobile.brand).
  const KEEP = new Set(["home.sheet.password", "mobile.push.promise", "app.title"]);
  const walk = (o: Record<string, unknown>, at: string, out: string[]): string[] => {
    for (const [k, v] of Object.entries(o)) {
      const path = at ? `${at}.${k}` : k;
      if (typeof v === "string") { if (v.includes("HMIS") && !KEEP.has(path)) out.push(path); }
      else if (v !== null && typeof v === "object") walk(v as Record<string, unknown>, path, out);
    }
    return out;
  };
  expect(walk(en, "", [])).toEqual([]);
  expect(walk(hi, "", [])).toEqual([]);
  expect((en as { mobile: { brand: string } }).mobile.brand).toBe("CRKMCH");
  expect((hi as { mobile: { brand: string } }).mobile.brand).toBe("CRKMCH");
  expect((en as { home: { sheet: { password: string } } }).home.sheet.password).toMatch(/HMIS/);
});

it("spec #1058 D7: the staging iPhone build is a store build of the staging id, sent only by its own submit profile", () => {
  type Profile = { env?: Record<string, string>; ios?: Record<string, unknown> };
  const eas = JSON.parse(readFileSync(join(__dirname, "../../eas.json"), "utf8")) as { build: Record<string, Profile>; submit: Record<string, { ios?: Record<string, unknown> }> };
  expect(eas.build.preview!.env).toEqual({ APP_ENV: "preview" });
  expect(eas.build.preview!.ios?.distribution).toBe("store");
  expect(eas.build.preview!.ios?.autoIncrement).toBe(true);
  expect(eas.submit.preview?.ios?.bundleIdentifier).toBe("com.crkmch.hmis.staging");
  expect(JSON.stringify(eas.submit.preview)).not.toMatch(/"com\.crkmch\.hmis"/);
  expect(eas.submit.production?.ios?.bundleIdentifier).toBe("com.crkmch.hmis");
});
