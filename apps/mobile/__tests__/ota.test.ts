import { generateKeyPairSync, X509Certificate } from "crypto";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ASK_EVERY_MS, createOta, type OtaPort } from "../src/ota";

jest.mock("expo-router", () => ({ useFocusEffect: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildManifest, publish, verify, readMultipart, BOUNDARY } = require("../scripts/ota-manifest.js");

function port(over: Partial<OtaPort> = {}) {
  return {
    isEnabled: true,
    checkForUpdateAsync: jest.fn(async () => ({ isAvailable: true })),
    fetchUpdateAsync: jest.fn(async () => ({ isNew: true })),
    reloadAsync: jest.fn(async () => undefined),
    ...over,
  } as unknown as OtaPort & { checkForUpdateAsync: jest.Mock; fetchUpdateAsync: jest.Mock; reloadAsync: jest.Mock };
}

describe("a bundle that arrives over the air is run only where nothing is half-typed", () => {
  it("fetches and restarts when the person is at rest on the home screen", async () => {
    const p = port();
    expect(await createOta(p).settle(() => true)).toBe(true);
    expect(p.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("fetches but does NOT restart when the person left the home screen while it downloaded — and takes it on their return, without asking the server again", async () => {
    const p = port();
    const o = createOta(p);
    expect(await o.settle(() => false)).toBe(false);
    expect(p.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(p.reloadAsync).not.toHaveBeenCalled();
    expect(await o.settle(() => true)).toBe(true);
    expect(p.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(p.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("asks the server at most once in fifteen minutes, unless asked by hand", async () => {
    let t = 1_000_000;
    const p = port({ checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false })) as never });
    const o = createOta(p, () => t);
    await o.settle(() => true);
    t += ASK_EVERY_MS - 1;
    await o.settle(() => true);
    expect(p.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    await o.settle(() => true, true);
    expect(p.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    t += ASK_EVERY_MS;
    await o.settle(() => true);
    expect(p.checkForUpdateAsync).toHaveBeenCalledTimes(3);
    expect(p.reloadAsync).not.toHaveBeenCalled();
  });

  it("says nothing and changes nothing with no signal, and in a build that carries no over-the-air updates", async () => {
    const down = port({ checkForUpdateAsync: jest.fn(async () => { throw new Error("no network"); }) as never });
    expect(await createOta(down).settle(() => true)).toBe(false);
    expect(down.reloadAsync).not.toHaveBeenCalled();
    const off = port({ isEnabled: false });
    expect(await createOta(off).settle(() => true)).toBe(false);
    expect(off.checkForUpdateAsync).not.toHaveBeenCalled();
  });
});

describe("what the phones fetch — a signed manifest and files named by their own checksum", () => {
  const dir = mkdtempSync(join(tmpdir(), "hmis-ota-"));
  const key = (name: string) => {
    // A self-signed certificate made by openssl, as `expo-updates codesigning:generate` makes one.
    const k = join(dir, `${name}.key`), c = join(dir, `${name}.pem`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", k, "-out", c, "-days", "2", "-subj", `/CN=${name}`], { stdio: "ignore" });
    return { privateKeyPem: readFileSync(k, "utf8"), certificatePem: readFileSync(c, "utf8") };
  };
  const ours = key("ours");
  const exportDir = join(dir, "export");
  mkdirSync(join(exportDir, "_expo/static/js/android"), { recursive: true });
  mkdirSync(join(exportDir, "assets"), { recursive: true });
  writeFileSync(join(exportDir, "_expo/static/js/android/entry-abc.hbc"), "BUNDLE-BYTES");
  writeFileSync(join(exportDir, "assets/0123abcd"), "PNG-BYTES");
  writeFileSync(join(exportDir, "metadata.json"), JSON.stringify({ version: 0, bundler: "metro", fileMetadata: { android: { bundle: "_expo/static/js/android/entry-abc.hbc", assets: [{ path: "assets/0123abcd", ext: "png" }] } } }));
  const RUNTIME = "a".repeat(40);
  const FILES = `https://stagehmis.crkmch.com/app/ota/staging/${RUNTIME}/files`;
  const built = () => buildManifest({ exportDir, runtimeVersion: RUNTIME, filesUrl: FILES, expoClient: { extra: { apiBase: "https://stagehmis.crkmch.com/api" } } });

  it("publishes a manifest the APK's certificate verifies, naming every file by a URL caddy serves", () => {
    const out = join(dir, "out1");
    const done = publish({ outDir: out, ...built(), ...ours });
    const served = readFileSync(join(out, "manifest"), "utf8");
    expect(served.startsWith(`--${BOUNDARY}\r\n`)).toBe(true);
    expect(served.endsWith(`\r\n--${BOUNDARY}--\r\n`)).toBe(true);
    expect(verify(served, ours.certificatePem)).toEqual(done);
    expect(done.runtimeVersion).toBe(RUNTIME);
    expect(done.extra.expoClient.extra.apiBase).toBe("https://stagehmis.crkmch.com/api");
    for (const a of [done.launchAsset, ...done.assets]) {
      // docker/prod/Caddyfile `@ota_file` — a URL outside this shape is a 404 on the phone.
      expect(a.url).toMatch(/^https:\/\/stagehmis\.crkmch\.com\/app\/ota\/staging\/[a-f0-9]{40}\/files\/[a-f0-9]{64}\.[A-Za-z0-9]+$/);
      expect(a.key).toMatch(/^[a-f0-9]{32}$/);
    }
    expect(readFileSync(join(out, "files", done.launchAsset.url.split("/").pop()), "utf8")).toBe("BUNDLE-BYTES");
  });

  it("a manifest altered after signing, or signed by another key, verifies as NOTHING", () => {
    const out = join(dir, "out2");
    publish({ outDir: out, ...built(), ...ours });
    const served = readFileSync(join(out, "manifest"), "utf8");
    expect(verify(served.replace("stagehmis.crkmch.com/api", "evil.example/api"), ours.certificatePem)).toBeNull();
    expect(verify(served, key("theirs").certificatePem)).toBeNull();
    expect(readMultipart(served)?.signature).not.toBeNull();
  });

  it("refuses to publish with a private key that is not the certificate's — the phones would refuse it one by one", () => {
    const out = join(dir, "out3");
    const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => publish({ outDir: out, ...built(), privateKeyPem: wrong, certificatePem: ours.certificatePem })).toThrow(/REFUSED/);
    expect(() => readFileSync(join(out, "manifest"))).toThrow();
    expect(new X509Certificate(ours.certificatePem).subject).toContain("ours");
  });
});
