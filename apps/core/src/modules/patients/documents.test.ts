import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkPatient, mkUser, seedOpdBase } from "../../../test/helpers/opd";
import { patientDocuments } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import {
  captureDocument, DOCUMENT_MAX_BYTES, listDocuments, markDocumentEnteredInError, readDocument,
} from "./documents";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE SLIP THE DESK PHOTOGRAPHS ═══
 *
 * Owner, 2026-09-14: the desk outside the room photographs the paper prescription, and the doctor
 * sees it in the patient's history.
 *
 * The store is a fake here on purpose — the real one is proved in `kernel/documents/store.test.ts`,
 * including the two independent traversal guards. What these rows are about is the ORDER of the
 * two writes, the PHI gate, and the integrity check.
 */
class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  failNextPut = false;
  async put(key: string, bytes: Buffer): Promise<void> {
    if (this.failNextPut) { this.failNextPut = false; throw new Error("disk full"); }
    this.files.set(key, bytes);
  }
  async get(key: string): Promise<Buffer> {
    const b = this.files.get(key);
    if (b === undefined) throw new Error("not found");
    return b;
  }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}

const NOW = new Date("2026-09-14T06:00:00.000Z");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

describe("the document a desk photographs", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let store: FakeStore;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let patientId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    store = new FakeStore();
    clerk = await mkUser(db, "desk1", ["front_office"]);
    patientId = (await mkPatient(db, clerk.actor, { name: "Asha Devi", phone: "9876540111" })).id;
  });

  const capture = (over: Record<string, unknown> = {}) => withTx(db, (tx) => captureDocument(
    tx, store, clerk.actor, patientId,
    { kind: "outside_prescription", mimeType: "image/jpeg", bytes: JPEG, ...over } as never, NOW,
  ));

  it("G1: the bytes land behind the store and the ROW carries only a key", async () => {
    const { documentId } = await capture();
    const [row] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));

    /* No `bytea` column exists to check — that is the owner's ruling made structural. */
    expect(row!.storageKey).toBe(`2026/09/${documentId}.jpg`);
    expect(store.files.get(row!.storageKey)).toEqual(JPEG);
    expect(row!.byteSize).toBe(JPEG.length);
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("G2: a store that FAILS leaves no row — a document the doctor cannot open is worse than none", async () => {
    store.failNextPut = true;
    await expect(capture()).rejects.toThrow(/disk full/);
    expect(await db.select().from(patientDocuments)).toHaveLength(0);
    /*
      The TRANSACTION is what makes this true, not the write order — reversing the two lines leaves
      this row green, which is how the first draft's stated reasoning was caught being wrong. What
      the order decides is orphans; G2b is the row that can tell.
    */
  });

  it("G2b: a failed ROW leaves no orphan file — the ordering's real job", async () => {
    /*
      A foreign key that cannot resolve fails the INSERT, after the row has been attempted and
      before the bytes would have been written. Row-first therefore leaves nothing at all; bytes
      first would have left a file on disk that no row will ever name, and nothing sweeps it today.
    */
    await expect(capture({ encounterId: "enc-that-does-not-exist" })).rejects.toThrow();
    expect(await db.select().from(patientDocuments)).toHaveLength(0);
    expect(store.files.size).toBe(0);
  });

  it("G3: an oversize capture is refused rather than re-encoded", async () => {
    /* The photo's rule — the client downscales. A server that silently re-encodes a clinical image
       is a server deciding how legible a prescription is. */
    await expect(capture({ bytes: Buffer.alloc(DOCUMENT_MAX_BYTES + 1) })).rejects.toMatchObject({ code: "document_too_large" });
    await expect(capture({ bytes: Buffer.alloc(0) })).rejects.toMatchObject({ code: "document_empty" });
    await expect(capture({ mimeType: "image/gif" })).rejects.toMatchObject({ code: "unsupported_document_type" });
    expect(store.files.size).toBe(0);
  });

  it("G4: many documents per encounter — the thing patient_photos cannot do", async () => {
    await capture({ note: "page 1" });
    await capture({ note: "page 2" });
    const items = await listDocuments(db, clerk.actor, patientId);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.note).sort()).toEqual(["page 1", "page 2"]);
  });

  it("G5: an outside slip with NO encounter is legal — it is the commonest reason to photograph paper", async () => {
    /* A patient arrives at a first consultation holding a prescription from another hospital.
       Requiring an encounter would make that case the one that cannot be recorded. */
    const { documentId } = await capture({ encounterId: null });
    const [row] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));
    expect(row!.encounterId).toBeNull();
  });

  it("G6: reading the bytes checks them against the hash taken at capture", async () => {
    const { documentId } = await capture();
    const [row] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));

    expect((await readDocument(db, store, clerk.actor, documentId)).bytes).toEqual(JPEG);

    /* A store that silently truncates or swaps a file would otherwise reach the doctor as a blank
       image, which reads as a bad photograph rather than as a broken record. */
    store.files.set(row!.storageKey, Buffer.from([0x00]));
    await expect(readDocument(db, store, clerk.actor, documentId)).rejects.toMatchObject({ code: "document_corrupt" });
  });

  it("G7: a correction hides it from every reader and keeps the trail — the bytes stay", async () => {
    const { documentId } = await capture();
    const [before] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));

    await withTx(db, (tx) => markDocumentEnteredInError(tx, clerk.actor, documentId, "wrong patient", NOW));

    expect(await listDocuments(db, clerk.actor, patientId)).toHaveLength(0);
    await expect(readDocument(db, store, clerk.actor, documentId)).rejects.toMatchObject({ code: "document_not_found" });
    const [after] = await db.select().from(patientDocuments).where(eq(patientDocuments.id, documentId));
    expect(after).toMatchObject({ status: "entered_in_error", correctionReason: "wrong patient", correctedBy: clerk.actor.id });
    /* The row explains why a doctor saw what they saw last Tuesday; the retention sweep reclaims
       the disk, not the correction. */
    expect(store.files.get(before!.storageKey)).toEqual(JPEG);
  });

  it("G8: a correction needs a reason, and cannot be applied twice", async () => {
    const { documentId } = await capture();
    await expect(withTx(db, (tx) => markDocumentEnteredInError(tx, clerk.actor, documentId, "   ", NOW)))
      .rejects.toMatchObject({ code: "reason_required" });
    await withTx(db, (tx) => markDocumentEnteredInError(tx, clerk.actor, documentId, "wrong patient", NOW));
    await expect(withTx(db, (tx) => markDocumentEnteredInError(tx, clerk.actor, documentId, "again", NOW)))
      .rejects.toMatchObject({ code: "document_not_found" });
  });

  it("G9: both reads write an ACCESS-LOG row, and they are different surfaces", async () => {
    const { documentId } = await capture();
    await listDocuments(db, clerk.actor, patientId);
    await readDocument(db, store, clerk.actor, documentId);

    const rows = await db.execute(
      sql`select surface from phi_access_log where patient_id = ${patientId} order by surface`,
    );
    const surfaces = (rows.rows as { surface: string }[]).map((r) => r.surface);
    /* Scrolling past a list and OPENING the prescription are different acts, and the log is kept to
       answer which one happened. */
    expect(surfaces).toContain("patient.documents");
    expect(surfaces).toContain("patient.document.image");
  });
});
