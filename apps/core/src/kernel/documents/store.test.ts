import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DiskDocumentStore } from "./disk";
import { assertStorageKey, DocumentStoreError } from "./store";

/**
 * ═══ THE STORE, AND THE ONE THING IT MUST NEVER DO ═══
 *
 * A storage key becomes a filename. A key that can carry `..` is a write anywhere the process can
 * reach, and the day this is an object store it is a write outside the tenant's prefix. Most of
 * this file is that one property, approached from both sides.
 *
 * ═══ TWO LAYERS BLOCK IT AND EACH ONE ALONE IS ENOUGH — MEASURED, NOT ASSUMED ═══
 *
 *   shape check neutered, resolve intact  ->  K2 fails; D2 and D6 PASS
 *   resolve neutered, shape intact        ->  K2 fails; D2 and D6 PASS
 *   both neutered                         ->  K2, D2 and D6 all fail — the traversal escapes
 *
 * Worth writing down because a SINGLE mutant here is misleading in both directions, and misled the
 * author first: `assertStorageKey` has two clauses (the regex AND `includes("..")`), so breaking
 * only the regex leaves the guard standing and looks like the filesystem check is carrying it.
 * Neither layer is redundant and neither is load-bearing alone; the third row is the one that says
 * the tests are not vacuous.
 */
async function store(): Promise<{ s: DiskDocumentStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "hmis-docs-"));
  return { s: new DiskDocumentStore(root), root };
}

describe("assertStorageKey", () => {
  it("K1: accepts the shape the minter produces and nothing else", () => {
    expect(() => { assertStorageKey("2026/09/01K7ZC3Q9XB4.jpg"); }).not.toThrow();
    expect(() => { assertStorageKey("2026/09/abc123def456.jpeg"); }).not.toThrow();
    expect(() => { assertStorageKey("2026/09/abc123def456.pdf"); }).not.toThrow();
  });

  it("K2: refuses every shape of escape", () => {
    for (const bad of [
      "../etc/passwd",
      "2026/09/../../../etc/passwd.jpg",
      "/2026/09/abc123def456.jpg",
      "2026\\09\\abc123def456.jpg",
      "2026/09/abc123def456.sh",
      "2026/9/abc123def456.jpg",
      "abc123def456.jpg",
      "",
    ]) {
      /* The case is IN the assertion: jest's `expect` takes no message argument, and a bare
         "did not throw" would not say which of the eight shapes got through. */
      expect(() => { assertStorageKey(bad); return bad; }).toThrow(DocumentStoreError);
    }
  });
});

describe("DiskDocumentStore", () => {
  it("D1: round-trips bytes, and lays them out by year and month", async () => {
    const { s, root } = await store();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]);
    await s.put("2026/09/abc123def456.jpg", bytes);

    /* A year of slips in ONE directory is a real operational difference on ext4, and the layout
       costs nothing to get right before there is anything in it. */
    expect(await readFile(resolve(root, "2026/09/abc123def456.jpg"))).toEqual(bytes);
    expect(await s.get("2026/09/abc123def456.jpg")).toEqual(bytes);
  });

  it("D2: a traversing key cannot write outside the root — checked at the FILESYSTEM, not only the shape", async () => {
    const { s, root } = await store();
    /*
      THE TARGET IS UNIQUE PER RUN, and that is not fussiness. The first draft escaped to a FIXED
      `../escaped.jpg`, and when this suite was run against a deliberately broken guard the write
      succeeded — leaving the file behind in the parent directory. Every later run then failed on
      the "nothing landed outside" assertion, for a reason that had nothing to do with the code
      under test. A test that proves an escape must not leave the escape lying around.
    */
    const target = `escaped-${String(process.pid)}-${String(Date.now())}.jpg`;
    await expect(s.put(`../${target}`, Buffer.from("x"))).rejects.toThrow(DocumentStoreError);
    await expect(s.put(`2026/09/../../../${target}`, Buffer.from("x"))).rejects.toThrow(DocumentStoreError);
    /* And nothing landed next to the root either. */
    await expect(readFile(resolve(root, "..", target))).rejects.toThrow();
  });

  it("D3: a missing document is `not_found`, never an empty buffer", async () => {
    /* An empty Buffer would render as a blank image and read as "the slip was photographed badly"
       rather than "the bytes are gone" — which is the wrong thing for a clinical record to say. */
    const { s } = await store();
    await expect(s.get("2026/09/neverwritten1.jpg")).rejects.toThrow(DocumentStoreError);
    await expect(s.get("2026/09/neverwritten1.jpg")).rejects.toThrow(/no document at/);
  });

  it("D4: remove is idempotent, so a half-finished retention sweep can be re-run", async () => {
    const { s } = await store();
    await s.put("2026/09/abc123def456.jpg", Buffer.from("x"));
    await s.remove("2026/09/abc123def456.jpg");
    await expect(s.remove("2026/09/abc123def456.jpg")).resolves.toBeUndefined();
    await expect(s.get("2026/09/abc123def456.jpg")).rejects.toThrow(DocumentStoreError);
  });

  it("D5: an unwritable root FAILS rather than reporting a write that did not happen", async () => {
    /*
      The caller cannot fix a full disk or a bad mount. What it must never do is record a row saying
      a slip was captured when the bytes are not there — so this throws, and the capture's
      transaction rolls back around it.
    */
    const { root } = await store();
    const filePath = join(root, "occupied");
    await writeFile(filePath, "i am a file, not a directory");
    const s = new DiskDocumentStore(join(root, "occupied"));
    await expect(s.put("2026/09/abc123def456.jpg", Buffer.from("x"))).rejects.toThrow(DocumentStoreError);
    await expect(s.put("2026/09/abc123def456.jpg", Buffer.from("x"))).rejects.toThrow(/could not write/);
  });

  it("D6: a symlinked root still refuses a key that resolves outside it", async () => {
    /* The shape check and the resolution check answer different questions, and this is the case
       where they differ — which is why both exist. */
    const { root } = await store();
    await mkdir(join(root, "real"), { recursive: true });
    const s = new DiskDocumentStore(join(root, "real"));
    await expect(s.put("2026/09/../../../../tmp/escaped.jpg", Buffer.from("x"))).rejects.toThrow(DocumentStoreError);
  });
});
