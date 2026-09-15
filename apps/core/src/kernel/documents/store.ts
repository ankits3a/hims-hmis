/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DOCUMENT STORE — ONE SEAM, SO THE BYTES CAN MOVE WITHOUT THE CALLERS MOVING
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner ruling, 2026-09-14: *"downscale the image and save it to disk for now, I will then add
 * Cloudflare R2 or AWS S3 later."*
 *
 * The whole point of this file is that the second half of that sentence costs one adapter and no
 * caller. So the interface exists from the FIRST commit, before there is a second implementation to
 * justify it — which is usually a bad reason to write an interface and is the right one here,
 * because the owner has already named the migration.
 *
 * ═══ WHAT THIS FORECLOSES, DELIBERATELY ═══
 *
 * `bytea`. `patient_photos` keeps its bytes in the row and that was right for one 512 KB face photo
 * per patient; a prescription slip is a different animal. Measured for the owner before the ruling:
 * at 200 OPD patients a day with one page each, raw phone photos are ~400 MB/day — **~145 GB a
 * year** — living inside every `pg_dump`, every restore and every replica. Downscaled to ~300 KB it
 * is ~22 GB a year, which is survivable on disk and trivial in object storage, and either way it
 * has no business making the database bigger than the hospital's entire clinical record.
 *
 * So the ROW holds the metadata and a `storage_key`; the BYTES live wherever the store puts them.
 */
export type DocumentStore = {
  /** Writes the bytes under `key`. Overwrites, because a key is minted per document and never reused. */
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Used by the retention sweep, and by the one case where a row is written and the bytes are not. */
  remove(key: string): Promise<void>;
};

export class DocumentStoreError extends Error {
  constructor(readonly reason: "not_found" | "unwritable" | "bad_key", message: string) {
    super(message);
    this.name = "DocumentStoreError";
  }
}

/**
 * ═══ A KEY IS A PATH, AND A PATH FROM A CALLER IS A TRAVERSAL WAITING TO HAPPEN ═══
 *
 * Every key this store accepts must be shaped `YYYY/MM/<id>.<ext>` with no `..`, no leading slash
 * and no backslash. The store is the only thing that can enforce it, because it is the only thing
 * that knows the key becomes a filename — and the day an object-store adapter replaces the disk one,
 * the same rule keeps a key from escaping its prefix there too.
 *
 * Checked rather than sanitised: a key that does not match is a BUG at the mint site, and quietly
 * rewriting it would hide the bug and still write a file somewhere nobody expects.
 */
const KEY = /^\d{4}\/\d{2}\/[A-Za-z0-9_-]{6,64}\.(jpg|jpeg|png|pdf)$/;

export function assertStorageKey(key: string): void {
  if (!KEY.test(key) || key.includes("..")) {
    throw new DocumentStoreError("bad_key", `refusing a storage key that is not YYYY/MM/<id>.<ext>: ${key}`);
  }
}
