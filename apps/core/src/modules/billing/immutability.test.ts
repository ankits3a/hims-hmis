import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  allocations, cashierSessions, creditNoteLines, creditNotes, invoiceLines, invoices, patients, receipts,
} from "../../kernel/db/schema";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 D-Immutability — migration 0012s `billing_forbid_mutation()` triggers.
 *
 * The ledger is append-only STRUCTURALLY, not by convention: six tables carry a
 * BEFORE UPDATE OR DELETE row trigger that raises `billing_immutable`. Grant revocation
 * would not bind (the app role owns its tables) and drizzle-kit cannot emit triggers, so
 * the custom migration is the only provable mechanism — and "the trigger exists in
 * pg_trigger" proves nothing, so every assertion below EXECUTES a real UPDATE or DELETE
 * and observes the raise. Six UPDATEs (one per protected table) + two DELETE samples.
 *
 * Settlement state is derived, never stored (D1) — that is exactly what lets these
 * triggers be total: no lifecycle column on any protected table ever needs to move.
 */

const AT = new Date("2026-08-18T04:30:00.000Z"); // IST 2026-08-18 10:00
const DAY = "2026-08-18";
const IMMUTABLE = /billing_immutable/;

let db: Db;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ db, teardown } = await setupTestDb());
});
afterAll(async () => teardown());
beforeEach(async () => {
  await truncateAll(db);
  await seedLedger();
});

/** One row in each protected table, plus a childless invoice for the DELETE sample. */
async function seedLedger(): Promise<void> {
  // `invoices` and `receipts` FK into `patients` (ruling R5) — the patient exists first.
  await db.insert(patients).values({ id: "p1", uhid: "UH-p1", name: "Test Patient", sex: "female", administrativeGender: "female", createdBy: "t", updatedBy: "t" });
  await db.insert(cashierSessions).values({ id: "cs1", cashierUserId: "u-cashier", openedAt: AT, openingFloatPaise: 0 });
  await db.insert(invoices).values({
    id: "inv1", invoiceNo: "INV/26-27/000001", patientId: "p1", tariffVersionId: "v1",
    grossPaise: 60_000, discountPaise: 0, taxableBasePaise: 60_000, cgstPaise: 3600, sgstPaise: 3600,
    rawTotalPaise: 67_200, roundingPaise: 0, netPayablePaise: 67_200,
    issuedBy: "u-cashier", issuedAt: AT, serviceDay: DAY,
  });
  await db.insert(invoices).values({
    id: "inv2", invoiceNo: "INV/26-27/000002", patientId: "p1", tariffVersionId: "v1",
    grossPaise: 100, discountPaise: 0, taxableBasePaise: 100, cgstPaise: 0, sgstPaise: 0,
    rawTotalPaise: 100, roundingPaise: 0, netPayablePaise: 100,
    issuedBy: "u-cashier", issuedAt: AT, serviceDay: DAY,
  });
  await db.insert(invoiceLines).values({
    id: "il1", invoiceId: "inv1", lineNo: 1, serviceId: "s1", serviceName: "OPD consultation",
    category: "consultation", qty: 1, unitPaise: 60_000, grossPaise: 60_000, candidates: [],
    discountPaise: 0, taxableBasePaise: 60_000, sacCode: "9993", rateBps: 1200, exempt: false,
    cgstPaise: 3600, sgstPaise: 3600, netPaise: 67_200,
  });
  await db.insert(creditNotes).values({
    id: "cn1", creditNoteNo: "CN/26-27/000001", invoiceId: "inv1", kind: "refund", reason: "billed twice",
    issuedBy: "u-cashier", issuedAt: AT, grossPaise: 60_000, discountPaise: 0, taxableBasePaise: 60_000,
    cgstPaise: 3600, sgstPaise: 3600, roundingPaise: 0, netPaise: 67_200,
  });
  await db.insert(creditNoteLines).values({
    id: "cnl1", creditNoteId: "cn1", invoiceLineId: "il1", qty: 1,
    grossPaise: 60_000, discountPaise: 0, taxableBasePaise: 60_000, cgstPaise: 3600, sgstPaise: 3600,
  });
  await db.insert(receipts).values({
    id: "rcp1", receiptNo: "RCP/26-27/000001", patientId: "p1", cashierSessionId: "cs1",
    receivedBy: "u-cashier", receivedAt: AT, serviceDay: DAY, totalPaise: 67_200,
  });
  await db.insert(allocations).values({
    id: "al1", receiptId: "rcp1", invoiceId: "inv1", amountPaise: 67_200, kind: "apply",
    actorId: "u-cashier", at: AT,
  });
}

test("invoices refuse UPDATE — the money on an issued bill never moves", async () => {
  await expect(
    db.update(invoices).set({ netPayablePaise: 1 }).where(eq(invoices.id, "inv1")).execute(),
  ).rejects.toThrow(IMMUTABLE);
  expect((await db.select().from(invoices).where(eq(invoices.id, "inv1")))[0]?.netPayablePaise).toBe(67_200);
});

test("invoice_lines refuse UPDATE — the persisted PricedLine is the record", async () => {
  await expect(
    db.update(invoiceLines).set({ cgstPaise: 0 }).where(eq(invoiceLines.id, "il1")).execute(),
  ).rejects.toThrow(IMMUTABLE);
});

test("credit_notes refuse UPDATE — the only instrument that shrinks a receivable cannot be edited", async () => {
  await expect(
    db.update(creditNotes).set({ netPaise: 0 }).where(eq(creditNotes.id, "cn1")).execute(),
  ).rejects.toThrow(IMMUTABLE);
});

test("credit_note_lines refuse UPDATE — the pro-rated shares are final once written", async () => {
  await expect(
    db.update(creditNoteLines).set({ qty: 99 }).where(eq(creditNoteLines.id, "cnl1")).execute(),
  ).rejects.toThrow(IMMUTABLE);
});

test("receipts refuse UPDATE — money received is never restated", async () => {
  await expect(
    db.update(receipts).set({ totalPaise: 0 }).where(eq(receipts.id, "rcp1")).execute(),
  ).rejects.toThrow(IMMUTABLE);
});

test("allocations refuse UPDATE — a misallocation is reversed by a new row, never edited", async () => {
  await expect(
    db.update(allocations).set({ amountPaise: 1 }).where(eq(allocations.id, "al1")).execute(),
  ).rejects.toThrow(IMMUTABLE);
});

test("invoices refuse DELETE — even a childless one; entered-in-error is a MARK, not a deletion", async () => {
  await expect(db.delete(invoices).where(eq(invoices.id, "inv2")).execute()).rejects.toThrow(IMMUTABLE);
  expect((await db.select().from(invoices).where(eq(invoices.id, "inv2"))).length).toBe(1);
});

test("allocations refuse DELETE — the ledger only ever grows", async () => {
  await expect(db.delete(allocations).where(eq(allocations.id, "al1")).execute()).rejects.toThrow(IMMUTABLE);
  expect((await db.select().from(allocations).where(eq(allocations.id, "al1"))).length).toBe(1);
});
