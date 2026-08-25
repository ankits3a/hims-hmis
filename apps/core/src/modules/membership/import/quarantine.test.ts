import { asc } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { importQuarantine } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { QUARANTINE_REASONS, listQuarantine, primaryReason, quarantineRows } from "./quarantine";
import type { QuarantineReason } from "./quarantine";
import type { Db } from "../../../kernel/db/client";

/**
 * PLAN 09 T5 — the quarantine lane on its own: the writer, the reader, and the precedence rule
 * that decides which of several defects a row's single `reason` column carries.
 *
 * Every batch id, line and person below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const BATCH = "01HBATCH000000000000T5Q1";

describe("import quarantine", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => truncateAll(db));

  it("keeps the source line VERBATIM, with its batch and its 1-indexed row number", async () => {
    const line = "S-1001,KM-70,PL-INV-SOLO,Vasanti Kher,9820100101,2026-01-01,2026-12-31,";
    await withTx(db, (tx) =>
      quarantineRows(tx, [{ source: "holder_book", batchId: BATCH, rowNo: 2, reason: "duplicate_key", line }]));

    const rows = await db.select().from(importQuarantine);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "holder_book", batchId: BATCH, rowNo: 2, reason: "duplicate_key" });
    // NOT a parsed object: a stray comma or an empty-versus-absent cell is exactly the defect that
    // put the row here, and a parse would have hidden it.
    expect(rows[0]!.raw).toEqual({ line });
  });

  it("writes the whole batch in ONE statement and reads it back in the file's own row order", async () => {
    await withTx(db, (tx) =>
      quarantineRows(tx, [
        { source: "holder_book", batchId: BATCH, rowNo: 9, reason: "bad_date", line: "nine" },
        { source: "holder_book", batchId: BATCH, rowNo: 3, reason: "duplicate_key", line: "three" },
        { source: "holder_book", batchId: BATCH, rowNo: 2, reason: "duplicate_key", line: "two" },
      ]));
    const read = await listQuarantine(db, BATCH);
    expect(read.map((r) => ({ rowNo: r.rowNo, reason: r.reason, line: r.line }))).toEqual([
      { rowNo: 2, reason: "duplicate_key", line: "two" },
      { rowNo: 3, reason: "duplicate_key", line: "three" },
      { rowNo: 9, reason: "bad_date", line: "nine" },
    ]);
  });

  it("an empty batch writes nothing rather than issuing an INSERT with no values", async () => {
    await withTx(db, (tx) => quarantineRows(tx, []));
    expect(await db.select().from(importQuarantine)).toEqual([]);
  });

  it("reads only its own batch — T7 will name a partner statement in the same column", async () => {
    await withTx(db, (tx) =>
      quarantineRows(tx, [
        { source: "holder_book", batchId: BATCH, rowNo: 2, reason: "short_row", line: "mine" },
        { source: "partner_statement", batchId: "STMT-INV-0001", rowNo: 2, reason: "bad_date", line: "theirs" },
      ]));
    expect((await listQuarantine(db, BATCH)).map((r) => r.line)).toEqual(["mine"]);
    expect((await listQuarantine(db, "STMT-INV-0001")).map((r) => r.line)).toEqual(["theirs"]);
  });

  it("a row that is wrong in several ways carries DUPLICATE_KEY, because that reason binds a second row", async () => {
    // The other half of a duplicate pair may be perfectly well-formed. If the defective half were
    // filed under its own defect instead, a human reading the batch would see one quarantined row
    // and one that had silently vanished.
    expect(primaryReason(["inverted_validity", "duplicate_key", "bad_date"])).toBe("duplicate_key");
    expect(primaryReason(["unknown_plan", "inverted_validity"])).toBe("inverted_validity");
    expect(primaryReason(["bad_date", "short_row"])).toBe("short_row");
    expect(() => primaryReason([])).toThrow(/the caller has a bug/);
  });

  it("every declared reason is orderable, so precedence is total rather than incidental", async () => {
    // §2.49 — a rank table that had lost an entry would make `primaryReason` return `undefined`
    // for that reason and this leg is what says so.
    const shuffled = [...QUARANTINE_REASONS].reverse() as QuarantineReason[];
    expect(QUARANTINE_REASONS.length).toBeGreaterThanOrEqual(6);
    expect(primaryReason(shuffled)).toBe("duplicate_key");
    for (const reason of QUARANTINE_REASONS) expect(primaryReason([reason])).toBe(reason);
  });

  it("the reader survives a raw payload that is not the shape this writer produces", async () => {
    // `raw` is jsonb: another writer (T7's statement import) puts its own shape there, and a
    // reader that threw on it would take the holder-book worklist down with it.
    await db.insert(importQuarantine).values({
      id: "01HQROW0000000000000T5Q1", source: "partner_statement", batchId: BATCH, rowNo: 4,
      reason: "bad_date", raw: { columns: ["not", "a", "line"] },
    });
    const read = await listQuarantine(db, BATCH);
    expect(read.map((r) => ({ rowNo: r.rowNo, line: r.line }))).toEqual([{ rowNo: 4, line: "" }]);
  });

  it("orders two quarantine rows from the SAME line by arrival, never by id", async () => {
    // §3.26 — a ULID cannot carry arrival order; `seq` does, and `truncateAll` does not restart it
    // for this table, so the assertion is over ORDER and never over a sequence VALUE.
    await withTx(db, (tx) =>
      quarantineRows(tx, [
        { source: "holder_book", batchId: BATCH, rowNo: 5, reason: "bad_date", line: "first" },
        { source: "holder_book", batchId: BATCH, rowNo: 5, reason: "unknown_plan", line: "second" },
      ]));
    const seqs = await db
      .select({ seq: importQuarantine.seq, reason: importQuarantine.reason })
      .from(importQuarantine)
      .orderBy(asc(importQuarantine.seq));
    expect(seqs.map((s) => s.reason)).toEqual(["bad_date", "unknown_plan"]);
    expect(seqs[0]!.seq).toBeLessThan(seqs[1]!.seq);
  });
});
