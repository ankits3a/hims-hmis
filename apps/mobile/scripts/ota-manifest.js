/**
 * The over-the-air update, as the files a phone fetches (scripts/publish-ota.sh; BUILDING.md).
 *
 * `expo export` leaves a bundle and its assets in a folder. This turns that folder into what
 * expo-updates asks a server for (the Expo Updates protocol, v1) — as STATIC files, because the
 * hospital's caddy serves a folder and runs no code:
 *
 *   <out>/files/<sha256>.<ext>   every asset and the bundle, named by its own checksum
 *   <out>/manifest               one multipart body: the manifest, and its signature beside it
 *
 * The phone trusts nothing here by position: it checks the signature against the certificate
 * baked into its APK, then checks every file against the checksum the signed manifest names.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** caddy answers the manifest with exactly this boundary (docker/prod/Caddyfile, `@ota_manifest`). */
const BOUNDARY = "hmis-ota";
const KEY_ID = "main";
const ALG = "rsa-v1_5-sha256";

const base64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();

const CONTENT_TYPE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ttf: "font/ttf", otf: "font/otf", json: "application/json" };

/** One exported file → where it is stored and how the manifest names it. */
function describe(file, ext, filesUrl) {
  const body = fs.readFileSync(file);
  const digest = sha256(body);
  const name = `${digest.toString("hex")}.${ext}`;
  return {
    body, name,
    entry: {
      hash: base64url(digest),
      key: crypto.createHash("md5").update(body).digest("hex"),
      contentType: CONTENT_TYPE[ext] ?? "application/octet-stream",
      fileExtension: `.${ext}`,
      url: `${filesUrl}/${name}`,
    },
  };
}

/**
 * @param {{ exportDir: string, runtimeVersion: string, filesUrl: string, expoClient: object, id?: string, createdAt?: string }} input
 * @returns {{ manifest: object, files: { name: string, body: Buffer }[] }}
 */
function buildManifest({ exportDir, runtimeVersion, filesUrl, expoClient, id, createdAt }) {
  const metadata = JSON.parse(fs.readFileSync(path.join(exportDir, "metadata.json"), "utf8"));
  const android = metadata.fileMetadata && metadata.fileMetadata.android;
  if (!android || typeof android.bundle !== "string") throw new Error("the export holds no android bundle (metadata.json)");
  const bundle = describe(path.join(exportDir, android.bundle), "bundle", filesUrl);
  const assets = (android.assets ?? []).map((a) => {
    if (!/^[A-Za-z0-9]+$/.test(a.ext)) throw new Error(`an asset has an extension no file name may carry: ${JSON.stringify(a.ext)}`);
    return describe(path.join(exportDir, a.path), a.ext, filesUrl);
  });
  const manifest = {
    id: id ?? crypto.randomUUID(),
    createdAt: createdAt ?? new Date().toISOString(),
    runtimeVersion,
    launchAsset: { hash: bundle.entry.hash, key: bundle.entry.key, contentType: "application/javascript", url: bundle.entry.url },
    assets: assets.map((a) => a.entry),
    metadata: {},
    // What `Constants.expoConfig` reads once the app runs this bundle: the API address and the rest of `extra`.
    extra: { expoClient },
  };
  return { manifest, files: [bundle, ...assets].map(({ name, body }) => ({ name, body })) };
}

/** The exact bytes that are signed are the exact bytes that are served — the manifest is serialised ONCE. */
function multipart(manifestText, privateKeyPem) {
  const sig = crypto.createSign("RSA-SHA256").update(manifestText, "utf8").sign(privateKeyPem, "base64");
  return [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="manifest"',
    "Content-Type: application/json; charset=utf-8",
    `expo-signature: sig="${sig}", keyid="${KEY_ID}", alg="${ALG}"`,
    "",
    manifestText,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

/** Reads a served manifest the way a phone does: the part named "manifest" and the signature in its headers. */
function readMultipart(body) {
  const parts = body.split(`--${BOUNDARY}`).slice(1, -1);
  for (const part of parts) {
    const cut = part.indexOf("\r\n\r\n");
    const head = part.slice(0, cut);
    if (!/name="manifest"/.test(head)) continue;
    const sig = /expo-signature: sig="([^"]+)"/.exec(head);
    return { manifestText: part.slice(cut + 4).replace(/\r\n$/, ""), signature: sig ? sig[1] : null };
  }
  return null;
}

function verify(body, certificatePem) {
  const read = readMultipart(body);
  if (read === null || read.signature === null) return null;
  const ok = crypto.createVerify("RSA-SHA256").update(read.manifestText, "utf8").verify(new crypto.X509Certificate(certificatePem).publicKey, read.signature, "base64");
  return ok ? JSON.parse(read.manifestText) : null;
}

/** Files first, the manifest LAST and through a rename: a phone never reads of a bundle that is not yet in place. */
function publish({ outDir, manifest, files, privateKeyPem, certificatePem }) {
  const filesDir = path.join(outDir, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  for (const f of files) {
    const to = path.join(filesDir, f.name);
    if (fs.existsSync(to)) continue; // named by checksum: the same name is the same bytes
    fs.writeFileSync(`${to}.tmp`, f.body);
    fs.renameSync(`${to}.tmp`, to);
  }
  const body = multipart(JSON.stringify(manifest), privateKeyPem);
  const back = verify(body, certificatePem);
  if (back === null) throw new Error("REFUSED: the signature does not verify against the certificate the APK carries — wrong private key?");
  for (const a of [back.launchAsset, ...back.assets]) {
    const stored = fs.readFileSync(path.join(filesDir, path.basename(a.url)));
    if (base64url(sha256(stored)) !== a.hash) throw new Error(`REFUSED: ${path.basename(a.url)} on disk is not the file the manifest names`);
  }
  const to = path.join(outDir, "manifest");
  fs.writeFileSync(`${to}.tmp`, body);
  fs.renameSync(`${to}.tmp`, to);
  return back;
}

module.exports = { BOUNDARY, buildManifest, multipart, readMultipart, verify, publish };

if (require.main === module) {
  const [exportDir, outDir, runtimeVersion, filesUrl, configFile, keyFile, certFile] = process.argv.slice(2);
  const expoClient = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const built = buildManifest({ exportDir, runtimeVersion, filesUrl, expoClient });
  const done = publish({ outDir, ...built, privateKeyPem: fs.readFileSync(keyFile, "utf8"), certificatePem: fs.readFileSync(certFile, "utf8") });
  console.log(`published update ${done.id} (${done.createdAt}) — 1 bundle, ${done.assets.length} assets`);
}
