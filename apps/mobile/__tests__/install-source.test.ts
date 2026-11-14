import { Platform } from "react-native";

/*
  WHICH APP INSTALLED THIS ONE (spec #1058). Only Google Play's own name counts as Play; anything the
  phone cannot say — no native module in an older build, an error, an empty answer — is "not Play",
  so every phone that has the app from the download link today keeps its update prompt.
*/
let mockNative: { installer: () => string | null } | null = null;
const mockRequire = jest.fn((name: string) => (name === "HmisInstallSource" ? mockNative : null));
jest.mock("expo", () => ({ requireOptionalNativeModule: (name: string) => mockRequire(name) }));

const realOS = Platform.OS;
afterEach(() => { (Platform as { OS: string }).OS = realOS; mockRequire.mockClear(); });

function fresh(os: string, native: typeof mockNative) {
  (Platform as { OS: string }).OS = os;
  mockNative = native;
  let mod!: typeof import("../src/install-source");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { mod = require("../src/install-source"); });
  return mod;
}

describe("installedFromPlay", () => {
  it("is true only when Android names Google Play", () => {
    expect(fresh("android", { installer: () => "com.android.vending" }).installedFromPlay()).toBe(true);
    expect(fresh("android", { installer: () => "com.google.android.packageinstaller" }).installedFromPlay()).toBe(false);
    expect(fresh("android", { installer: () => "com.android.chrome" }).installedFromPlay()).toBe(false);
  });

  it("is false when the phone cannot say: no module (an older build), an error, or no answer", () => {
    expect(fresh("android", null).installedFromPlay()).toBe(false);
    expect(fresh("android", { installer: () => { throw new Error("native failed"); } }).installedFromPlay()).toBe(false);
    expect(fresh("android", { installer: () => null }).installedFromPlay()).toBe(false);
    expect(fresh("android", { installer: () => "" }).installer()).toBeNull();
  });

  it("never asks off Android (iPhone, the browser preview)", () => {
    for (const os of ["ios", "web"]) {
      expect(fresh(os, { installer: () => "com.android.vending" }).installedFromPlay()).toBe(false);
    }
    expect(mockRequire).not.toHaveBeenCalled();
  });
});
