import { createHash } from "node:crypto";
import { syntheticWhoMap, syntheticWhoZip, syntheticZip } from "./helpers/icd11";
import {
  WHO_MAP_SHA256, WHO_ONE_TO_ONE_ENTRY, downloadWhoMap, extractZipEntry, whoMappingUrl,
} from "../scripts/icd11-who-release";
import type { FetchLike } from "../scripts/icd11-who-release";
import { USAGE, parseArgs } from "../scripts/icd11-load";

/**
 * ═══ `icd11:load --from-who` — WHO'S ARCHIVE OFF THE INTERNET, CHECKED, AND ONE FILE TAKEN OUT OF IT ═══
 *
 * No network and no WHO bytes: every archive here is built by `syntheticZip` from made-up rows, and
 * every download is an injected fetch. Importing the scripts is also what type-checks them — core's
 * tsconfig excludes `scripts/`.
 */
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const text = Buffer.from(syntheticWhoMap(), "utf8");
const MB = 1024 * 1024;

/** The offset of the first central-directory record, read from the 22-byte end record. */
const cdOffset = (zip: Buffer): number => zip.readUInt32LE(zip.length - 22 + 16);

describe("the ZIP reader — one named entry, in memory, or a refusal", () => {
  it("Z1: takes 10To11MapToOneCategory.txt out of a DEFLATED archive, byte for byte, past its look-alikes", () => {
    expect(extractZipEntry(syntheticWhoZip(), WHO_ONE_TO_ONE_ENTRY, MB).equals(text)).toBe(true);
  });

  it("Z2: and out of a STORED one", () => {
    expect(extractZipEntry(syntheticWhoZip(syntheticWhoMap(), 0), WHO_ONE_TO_ONE_ENTRY, MB).equals(text)).toBe(true);
  });

  it.each(["../10To11MapToOneCategory.txt", "a/../../etc/passwd", "/etc/passwd", "a\\..\\b.txt", "C:/Windows/x.txt"])(
    "Z3: refuses the whole archive when ANY entry's name escapes it — %s",
    (bad) => {
      const zip = syntheticZip([{ name: bad, data: Buffer.from("x") }, { name: WHO_ONE_TO_ONE_ENTRY, data: text }]);
      expect(() => extractZipEntry(zip, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/unsafe entry name/);
    },
  );

  it("Z4: refuses ZIP64 — in the end record, in an entry's sizes, and by its locator", () => {
    const counts = syntheticWhoZip();
    counts.writeUInt16LE(0xffff, counts.length - 22 + 10);
    expect(() => extractZipEntry(counts, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/ZIP64/);

    const sizes = syntheticWhoZip();
    sizes.writeUInt32LE(0xffffffff, cdOffset(sizes) + 24);
    expect(() => extractZipEntry(sizes, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/ZIP64/);

    const plain = syntheticWhoZip();
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const located = Buffer.concat([plain.subarray(0, plain.length - 22), locator, plain.subarray(plain.length - 22)]);
    expect(() => extractZipEntry(located, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/ZIP64/);
  });

  it("Z5: refuses an entry over the cap — whether its header says so or it only inflates past it", () => {
    expect(() => extractZipEntry(syntheticWhoZip(), WHO_ONE_TO_ONE_ENTRY, 100)).toThrow(/over the 100-byte cap/);

    /* A header that LIES (says 10 bytes) about an entry that inflates to 5,000: the cap still holds. */
    const big = Buffer.alloc(5000, 0x41);
    const liar = syntheticZip([{ name: WHO_ONE_TO_ONE_ENTRY, data: big }]);
    liar.writeUInt32LE(10, cdOffset(liar) + 24);
    expect(() => extractZipEntry(liar, WHO_ONE_TO_ONE_ENTRY, 100)).toThrow(/over the 100-byte cap/);
  });

  it("Z6: refuses an encrypted entry and a compression method it does not read", () => {
    const locked = syntheticZip([{ name: WHO_ONE_TO_ONE_ENTRY, data: text, method: 0, flags: 1 }]);
    expect(() => extractZipEntry(locked, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/encrypted/);
    const aes = syntheticZip([{ name: WHO_ONE_TO_ONE_ENTRY, data: text, method: 99 }]);
    expect(() => extractZipEntry(aes, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/encrypted/);
    const bzip2 = syntheticZip([{ name: WHO_ONE_TO_ONE_ENTRY, data: text, method: 12 }]);
    expect(() => extractZipEntry(bzip2, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/compression method 12/);
  });

  it("Z7: refuses a damaged entry (CRC), a missing one (naming what IS there), a twice-present one, and bytes that are no archive", () => {
    const stored = syntheticWhoZip(syntheticWhoMap(), 0);
    const at = stored.indexOf(Buffer.from("Synthetic title ZZ00", "utf8"));
    stored[at] = stored[at]! ^ 0x01;
    expect(() => extractZipEntry(stored, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/CRC/);

    expect(() => extractZipEntry(syntheticWhoZip(), "11To10MapToOneCategory.txt", MB))
      .toThrow(/no entry named 11To10MapToOneCategory\.txt.*foundation_10To11MapToOneCategory\.txt/);

    const twice = syntheticZip([{ name: WHO_ONE_TO_ONE_ENTRY, data: text }, { name: WHO_ONE_TO_ONE_ENTRY, data: Buffer.from("other") }]);
    expect(() => extractZipEntry(twice, WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/twice/);

    expect(() => extractZipEntry(Buffer.from("<html>not found</html>"), WHO_ONE_TO_ONE_ENTRY, MB)).toThrow(/not a ZIP archive/);
  });
});

describe("the download — WHO's URL, a pinned checksum, a cap and a clock", () => {
  /** A fetch that records what it was asked for and answers with `body`. */
  const serving = (body: Buffer, init: ResponseInit = {}) => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => { calls.push(url); return new Response(new Uint8Array(body), init); };
    return { fetch, calls };
  };
  const zip = syntheticWhoZip();

  it("D1: fetches WHO's URL for the release, checks the sha256 it was given, and returns the one file", async () => {
    const { fetch, calls } = serving(zip);
    const dl = await downloadWhoMap("2099-01", { fetch, sha256: sha(zip) });
    expect(calls).toEqual(["https://icdcdn.who.int/static/releasefiles/2099-01/mapping.zip"]);
    expect(dl).toMatchObject({
      release: "2099-01", url: whoMappingUrl("2099-01"), zipBytes: zip.length, zipSha256: sha(zip),
      checksum: "given", entryName: "10To11MapToOneCategory.txt",
    });
    expect(dl.entry.equals(text)).toBe(true);
    /* An upper-case checksum is the same checksum. */
    await expect(downloadWhoMap("2099-01", { fetch, sha256: sha(zip).toUpperCase() })).resolves.toMatchObject({ checksum: "given" });
  });

  it("D2: a TAMPERED archive is refused on its sha256 — and so is any archive that is not the pinned 2026-01 bytes", async () => {
    const tampered = Buffer.from(zip);
    tampered[40] = tampered[40]! ^ 0xff;
    await expect(downloadWhoMap("2099-01", { fetch: serving(tampered).fetch, sha256: sha(zip) }))
      .rejects.toThrow(new RegExp(`sha256 ${sha(tampered)}.*expected ${sha(zip)}`));
    await expect(downloadWhoMap("2026-01", { fetch: serving(zip).fetch }))
      .rejects.toThrow(new RegExp(`expected ${WHO_MAP_SHA256["2026-01"]!} \\(pinned\\)`));
  });

  it("D3: a release with no pinned checksum is refused WITHOUT --sha256, before anything is fetched", async () => {
    const { fetch, calls } = serving(zip);
    await expect(downloadWhoMap("2099-01", { fetch })).rejects.toThrow(/no pinned sha256 for release 2099-01.*WHO_MAP_SHA256.*--sha256/s);
    expect(calls).toEqual([]);
  });

  it("D4: the release must be YYYY-MM before it is put in a URL; --sha256 must be 64 hex and may not contradict a pin", async () => {
    const { fetch, calls } = serving(zip);
    await expect(downloadWhoMap("2026-1", { fetch, sha256: sha(zip) })).rejects.toThrow(/YYYY-MM/);
    await expect(downloadWhoMap("../../x", { fetch, sha256: sha(zip) })).rejects.toThrow(/YYYY-MM/);
    await expect(downloadWhoMap("2099-01", { fetch, sha256: "abc" })).rejects.toThrow(/64 hex/);
    await expect(downloadWhoMap("2026-01", { fetch, sha256: sha(zip) })).rejects.toThrow(/pinned/);
    expect(calls).toEqual([]);
  });

  it("D5: an HTTP error, a body over the cap (declared or streamed) and a server that never answers are all refused", async () => {
    await expect(downloadWhoMap("2099-01", { fetch: serving(Buffer.from("gone"), { status: 404 }).fetch, sha256: sha(zip) }))
      .rejects.toThrow(/HTTP 404/);
    const declared = serving(zip, { headers: { "content-length": String(zip.length) } });
    await expect(downloadWhoMap("2099-01", { fetch: declared.fetch, sha256: sha(zip), maxBytes: 100 }))
      .rejects.toThrow(/over the 100-byte cap/);
    /* No Content-Length: a stream the reader must stop counting itself. */
    const streamed: FetchLike = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(80)); c.enqueue(new Uint8Array(80)); c.close(); },
    }));
    await expect(downloadWhoMap("2099-01", { fetch: streamed, sha256: sha(zip), maxBytes: 100 })).rejects.toThrow(/over the 100-byte cap/);
    const silent: FetchLike = (_url, { signal }) => new Promise((_ok, fail) => {
      signal.addEventListener("abort", () => fail(signal.reason));
    });
    await expect(downloadWhoMap("2099-01", { fetch: silent, sha256: sha(zip), timeoutMs: 20 })).rejects.toThrow(/no answer .* in 0\.02 s/);
  });

  it("D6: the pinned table — 2026-01 is WHO's archive as measured, and every pin is a release and a lower-case sha256", () => {
    expect(WHO_MAP_SHA256["2026-01"]).toBe("2eb158cf2a0d53690d6e9baf0956f7617e1315e4f2a44dfc3db3be8f49193a1d");
    for (const [release, hex] of Object.entries(WHO_MAP_SHA256)) {
      expect(release).toMatch(/^[0-9]{4}-[0-9]{2}$/);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("the CLI's --from-who arguments", () => {
  it("A1: --from-who names the release; --sha256 and --by are optional", () => {
    expect(parseArgs(["--from-who", "2026-01"])).toEqual({ fromWho: "2026-01", sha256: null, by: null });
    expect(parseArgs(["--by", "dr.mrd", "--from-who", "2099-01", "--sha256", "ab"])).toEqual({ fromWho: "2099-01", sha256: "ab", by: "dr.mrd" });
    expect(parseArgs(["--from-who", "2026-01", "--release", "2026-01"])).toEqual({ fromWho: "2026-01", sha256: null, by: null });
  });

  it("A2: a path AND --from-who, two different releases, --sha256 on a local file, or a bare flag are refused", () => {
    expect(() => parseArgs(["f.txt", "--from-who", "2026-01"])).toThrow(/not both/);
    expect(() => parseArgs(["--from-who", "2026-01", "--release", "2027-01"])).toThrow(/2027-01.*2026-01|2026-01.*2027-01/);
    expect(() => parseArgs(["f.txt", "--release", "2026-01", "--sha256", "ab"])).toThrow(/--sha256/);
    expect(() => parseArgs(["--from-who"])).toThrow(/usage/);
    expect(() => parseArgs(["--from-who", "2099-01", "--sha256"])).toThrow(/usage/);
  });

  it("A3: --help names the command that runs in the production image — compiled, through compose", () => {
    expect(USAGE).toContain("--from-who YYYY-MM");
    expect(USAGE).toContain("run --rm api node dist/scripts/icd11-load.js --from-who 2026-01 --by");
    expect(USAGE).toContain("docker compose -p hmis-prod -f docker-compose.prod.yml --project-directory .");
  });
});
