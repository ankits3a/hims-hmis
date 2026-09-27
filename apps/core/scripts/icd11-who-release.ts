/**
 * `icd11:load --from-who YYYY-MM` — the download half.
 *
 * ═══ WHO'S ARCHIVE OFF THE INTERNET AT RUN TIME, NEVER IN THIS REPOSITORY ═══
 *
 * Owner ruling 2026-09-26: the licence question (WHO ICD-11 Terms §1.2.4, "mapping or producing
 * crosswalks") is settled, and WHO's ICD-10 → ICD-11 map may be loaded. The repository still holds
 * none of WHO's bytes. This file fetches the release's `mapping.zip` from WHO's CDN, refuses it
 * unless its sha256 is the one pinned below, and takes ONE entry — `10To11MapToOneCategory.txt` —
 * out of it in memory. Nothing is written to disk; `icd11-load.ts` hands the text to the same load
 * a local file goes through.
 *
 * ═══ THE PIN IS THE TRUST ═══
 *
 * A download is only as good as the check on it. `WHO_MAP_SHA256` holds each release's archive
 * checksum as MEASURED on the day it was added; a release not in it is refused until someone
 * downloads it, checks it against what WHO published, and adds the line (or passes `--sha256` once,
 * on the record of the shell they ran it in). An explicit `--sha256` may not contradict a pin.
 *
 * ═══ A ZIP READER OF ~100 LINES RATHER THAN A DEPENDENCY ═══
 *
 * The archive is read through its central directory (the authoritative list — a local header can
 * lie, and one written with a data descriptor carries no sizes at all). The reader refuses what it
 * does not need to understand: ZIP64, multi-disk, encryption, any method but stored (0) and deflate
 * (8), any entry name that would escape a directory if it were ever written out, a second entry of
 * the wanted name, and an entry over the cap — checked on the declared size AND on inflation, since
 * a declared size is only a claim. The bytes that come out must match the entry's size and CRC-32.
 */
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";

/** `YYYY-MM`, which is how WHO names ICD-11 releases — and the only shape allowed into a URL. */
export const RELEASE_SHAPE = /^[0-9]{4}-[0-9]{2}$/;

/**
 * sha256 of WHO's `mapping.zip`, per release, as measured when the line was added. 2026-01:
 * 6,809,366 bytes, measured 2026-09-26 against https://icdcdn.who.int/static/releasefiles/2026-01/mapping.zip.
 */
export const WHO_MAP_SHA256: Readonly<Record<string, string>> = {
  "2026-01": "2eb158cf2a0d53690d6e9baf0956f7617e1315e4f2a44dfc3db3be8f49193a1d",
};

/** The one-to-one file. The archive also holds `foundation_10To11MapToOneCategory.txt`: an EXACT name, not a suffix. */
export const WHO_ONE_TO_ONE_ENTRY = "10To11MapToOneCategory.txt";

/** 2026-01's archive is 6.8 MB and the entry 3.1 MB; 50 MB is room for growth, not for a mistake. */
export const WHO_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const WHO_DOWNLOAD_TIMEOUT_MS = 120_000;

export function whoMappingUrl(release: string): string {
  return `https://icdcdn.who.int/static/releasefiles/${release}/mapping.zip`;
}

/** Global `fetch`'s shape, narrowed to what is used — injected by the tests, so no test touches the network. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type WhoDownload = {
  release: string; url: string; zipBytes: number; zipSha256: string;
  /** Whether the checksum that passed was the pinned one or `--sha256`. */
  checksum: "pinned" | "given";
  entryName: string; entry: Buffer;
};

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

function refuse(message: string): never {
  throw new Error(`zip: ${message}`);
}

/** A name that, written out, would land outside the directory it was extracted into. */
function unsafeName(name: string): boolean {
  return name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)
    || name.includes("\0") || name.split(/[\\/]/).includes("..");
}

/** The bytes of the ONE entry named `name`, or a refusal. Pure: bytes in, bytes out. */
export function extractZipEntry(zip: Buffer, name: string, maxBytes: number): Buffer {
  /* The end record is the last 22 bytes plus a comment of up to 65,535. Its comment length must reach the end exactly. */
  let end = -1;
  for (let p = zip.length - 22; p >= 0 && p >= zip.length - 22 - U16_MAX; p -= 1) {
    if (zip.readUInt32LE(p) === SIG_END && p + 22 + zip.readUInt16LE(p + 20) === zip.length) { end = p; break; }
  }
  if (end === -1) refuse("not a ZIP archive (no end-of-central-directory record)");
  if (end >= 20 && zip.readUInt32LE(end - 20) === SIG_ZIP64_LOCATOR) refuse("ZIP64 archive (locator present) — not supported");
  const disk = zip.readUInt16LE(end + 4);
  const cdDisk = zip.readUInt16LE(end + 6);
  const onDisk = zip.readUInt16LE(end + 8);
  const total = zip.readUInt16LE(end + 10);
  const cdSize = zip.readUInt32LE(end + 12);
  const cdStart = zip.readUInt32LE(end + 16);
  if (total === U16_MAX || onDisk === U16_MAX || cdSize === U32_MAX || cdStart === U32_MAX) refuse("ZIP64 archive — not supported");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) refuse("multi-disk archive — not supported");
  if (cdStart + cdSize > end) refuse("central directory runs past its end record");

  const names: string[] = [];
  let found: { flags: number; method: number; crc: number; compSize: number; size: number; local: number } | null = null;
  let p = cdStart;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > cdStart + cdSize || zip.readUInt32LE(p) !== SIG_CENTRAL) refuse(`central directory record ${String(i + 1)} is damaged`);
    const nameLen = zip.readUInt16LE(p + 28);
    const entryName = zip.toString("utf8", p + 46, p + 46 + nameLen);
    const entry = {
      flags: zip.readUInt16LE(p + 8), method: zip.readUInt16LE(p + 10), crc: zip.readUInt32LE(p + 16),
      compSize: zip.readUInt32LE(p + 20), size: zip.readUInt32LE(p + 24), local: zip.readUInt32LE(p + 42),
    };
    if (unsafeName(entryName)) refuse(`unsafe entry name "${entryName}" — the archive is refused whole`);
    if (entry.compSize === U32_MAX || entry.size === U32_MAX || entry.local === U32_MAX) refuse(`ZIP64 entry "${entryName}" — not supported`);
    if (entryName === name) {
      if (found !== null) refuse(`"${name}" is in the archive twice`);
      found = entry;
    }
    names.push(entryName);
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  if (found === null) refuse(`no entry named ${name}; the archive holds ${names.join(", ")}`);

  /* Bit 0 is traditional encryption, bit 6 strong encryption; method 99 is WinZip AES. */
  if ((found.flags & 0x41) !== 0 || found.method === 99) refuse(`"${name}" is encrypted`);
  if (found.method !== 0 && found.method !== 8) refuse(`"${name}" uses compression method ${String(found.method)} — only stored (0) and deflate (8) are read`);
  const cap = `over the ${String(maxBytes)}-byte cap`;
  if (found.size > maxBytes) refuse(`"${name}" is ${String(found.size)} bytes, ${cap}`);

  const l = found.local;
  if (l + 30 > cdStart || zip.readUInt32LE(l) !== SIG_LOCAL) refuse(`"${name}"'s local header is missing`);
  const localNameLen = zip.readUInt16LE(l + 26);
  if (zip.toString("utf8", l + 30, l + 30 + localNameLen) !== name) refuse(`"${name}"'s local header names a different file`);
  const start = l + 30 + localNameLen + zip.readUInt16LE(l + 28);
  if (start + found.compSize > cdStart) refuse(`"${name}"'s data runs into the central directory`);
  const raw = zip.subarray(start, start + found.compSize);

  let out: Buffer;
  if (found.method === 0) {
    if (found.compSize !== found.size) refuse(`"${name}" is stored but its two sizes differ`);
    out = Buffer.from(raw);
  } else {
    try {
      out = inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") refuse(`"${name}" inflates ${cap}`);
      refuse(`"${name}" does not inflate: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (out.length !== found.size) refuse(`"${name}" inflated to ${String(out.length)} bytes; its header says ${String(found.size)}`);
  if (crc32(out) !== found.crc) refuse(`"${name}" fails its CRC-32 check — the archive is damaged`);
  return out;
}

/** The body, counted as it arrives: a declared length over the cap is refused unread, an undeclared one when it passes it. */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  const cap = `over the ${String(maxBytes)}-byte cap`;
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new Error(`${url} declares ${declared} bytes, ${cap}`);
  if (res.body === null) throw new Error(`${url} answered with no body`);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${url} sent more than ${String(maxBytes)} bytes, ${cap}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Download `release`'s mapping.zip, check it, and return the one-to-one file. Every refusal that
 * needs no network — the release's shape, a missing or malformed checksum — happens before the fetch.
 */
export async function downloadWhoMap(
  release: string,
  opts: { fetch?: FetchLike; sha256?: string | null; timeoutMs?: number; maxBytes?: number } = {},
): Promise<WhoDownload> {
  if (!RELEASE_SHAPE.test(release)) throw new Error(`the release must be YYYY-MM (got "${release}")`);
  const pinned = WHO_MAP_SHA256[release];
  const given = opts.sha256 ?? null;
  if (given !== null && !/^[0-9a-fA-F]{64}$/.test(given)) throw new Error(`--sha256 must be 64 hex characters (got "${given}")`);
  if (given !== null && pinned !== undefined && given.toLowerCase() !== pinned) {
    throw new Error(`--sha256 ${given.toLowerCase()} contradicts the checksum pinned for ${release} (${pinned}) — the pin stands`);
  }
  if (given === null && pinned === undefined) {
    throw new Error(
      `no pinned sha256 for release ${release}. Download ${whoMappingUrl(release)}, check its sha256 against the `
      + `release WHO published, and add it to WHO_MAP_SHA256 in scripts/icd11-who-release.ts — or pass --sha256 <hex> `
      + "for this one run.",
    );
  }
  const expected = pinned ?? given!.toLowerCase();
  const checksum: WhoDownload["checksum"] = pinned !== undefined ? "pinned" : "given";

  const url = whoMappingUrl(release);
  const timeoutMs = opts.timeoutMs ?? WHO_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? WHO_DOWNLOAD_MAX_BYTES;
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  let zip: Buffer;
  try {
    /* One signal for the whole exchange: the headers AND the body must arrive inside the budget. */
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await doFetch(url, { signal });
    if (!res.ok) throw new Error(`${url} answered HTTP ${String(res.status)}`);
    zip = await readCapped(res, maxBytes, url);
  } catch (e: unknown) {
    /* By NAME, not instanceof: the abort reason is a DOMException, which need not share this realm's Error. */
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`no answer from ${url} in ${String(timeoutMs / 1000)} s`);
    }
    throw e;
  }

  const zipSha256 = createHash("sha256").update(zip).digest("hex");
  if (zipSha256 !== expected) {
    throw new Error(`REFUSED: ${url} has sha256 ${zipSha256}, expected ${expected} (${checksum}) — nothing was loaded`);
  }
  const entry = extractZipEntry(zip, WHO_ONE_TO_ONE_ENTRY, maxBytes);
  return { release, url, zipBytes: zip.length, zipSha256, checksum, entryName: WHO_ONE_TO_ONE_ENTRY, entry };
}
