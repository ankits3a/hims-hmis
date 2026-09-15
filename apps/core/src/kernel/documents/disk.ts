import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { assertStorageKey, DocumentStoreError } from "./store";
import type { DocumentStore } from "./store";

/**
 * ═══ THE DISK ADAPTER — WHAT THE OWNER RULED FOR NOW ═══
 *
 * Bytes under a configured root, laid out `YYYY/MM/<id>.<ext>` so a year's slips are not one
 * directory with fifty thousand entries in it — which is a real operational difference on ext4 and
 * costs nothing to get right at the start.
 *
 * ═══ THE ROOT IS RE-CHECKED AFTER RESOLUTION, NOT ONLY BEFORE ═══
 *
 * `assertStorageKey` refuses a traversal in the key. This then resolves the absolute path and
 * refuses anything that did not land under the root anyway. Two checks for one property looks
 * redundant and is not: the first is about the key's SHAPE and the second is about where the
 * filesystem actually put it, and a symlinked root is the case where those two answers differ.
 */
export class DiskDocumentStore implements DocumentStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    assertStorageKey(key);
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new DocumentStoreError("bad_key", "a storage key resolved outside the document root");
    }
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const full = this.pathFor(key);
    try {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, bytes);
    } catch (e) {
      /* The caller cannot fix a full disk or a bad mount, but it MUST NOT record a row claiming
         bytes that are not there — so this throws and the transaction rolls back. */
      throw new DocumentStoreError("unwritable", `could not write ${key}: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e) {
      if (e instanceof DocumentStoreError) throw e;
      throw new DocumentStoreError("not_found", `no document at ${key}`);
    }
  }

  async remove(key: string): Promise<void> {
    /* `force` so removing something already gone is a success: the retention sweep must be safe to
       re-run, and a half-finished sweep that cannot be resumed is worse than one that repeats. */
    await rm(this.pathFor(key), { force: true });
  }
}
