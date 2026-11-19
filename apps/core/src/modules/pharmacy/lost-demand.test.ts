import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, pharmacyDemand, pharmacyShortBook } from "../../kernel/db/schema";
import { balances, createStore, registerItem } from "../materials";
import { claimDispense, findAtCounter } from "./claim";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { pickDispense } from "./pick";
import { addShortBookEntry, listOpenShortBook, noteAskedFor } from "./short-book";
import { declineLine, verifyDispense } from "./verify";
import { PharmacyCounterController } from "./pharmacy-counter.controller";
import { PharmacyRetailController } from "./pharmacy-retail.controller";
import type { DocumentStore } from "../../kernel/documents/store";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DispenseView } from "./queue";
import type { RxLine } from "../opd";

/**
 * Spec #1064 — the edges of lost demand the acceptance tests (`acceptance/lost-demand-1064.test.ts`) do not walk: the
 * last line declined at the bill cancels the ticket and still records the demand; a line the catalogue cannot place is
 * a typed name; a typed name that IS an item's name is the catalogue's; a hand-noted shortage is raised, not doubled;
 * and the counter's note is gated like a sale.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const docs: DocumentStore = { put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} };

describe("lost demand — the edges (spec #1064)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let A: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); A = fx.pharmacist.actor; });
  afterEach(() => { fx.unregister(); });

  async function ticket(lines: RxLine[]): Promise<DispenseView> {
    const { issued } = await issueRx(db, fx, lines, { at: MON });
    const found = await findAtCounter(db, testCfg, A, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("no dispense");
    return claimDispense(db, A, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);
  }
  const retail = async (): Promise<string> =>
    (await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }))).resourceId;

  it("declining the last line at the bill as not in stock cancels the ticket, releases its stock and records the demand", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 30, expiryDate: "2027-12-31" });
    const t = await ticket([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await verifyDispense(db, A, fx.decls, t.id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON2);
    await pickDispense(db, A, fx.decls, t.id, {}, MON2);
    const view = await declineLine(db, A, fx.decls, t.id, 0, "not in stock", MON2, { reasonCode: "not_in_stock" });
    expect(view.status).toBe("cancelled");
    expect((await balances(db, { resourceId: fx.storeId, itemId: fx.item.crocin })).reduce((n, b) => n + b.qtyReserved, 0)).toBe(0);
    expect(await db.select().from(pharmacyDemand)).toEqual([expect.objectContaining({ source: "desk_decline", itemId: fx.item.crocin, qtyAskedBase: 20, dispenseId: t.id })]);
    expect(await listOpenShortBook(db)).toEqual([expect.objectContaining({ itemId: fx.item.crocin, source: "counter", askedCount: 1, askedQtyBase: 20 })]);
  });

  it("a line the catalogue cannot place, declined as not in stock, is a typed name: a demand and no short-book entry", async () => {
    const t = await ticket([line({ drug: "Ascoril  LS syrup" })]);
    expect(t.lines[0]).toMatchObject({ item: null });
    await declineLine(db, A, fx.decls, t.id, 0, "not in stock", MON2, { reasonCode: "not_in_stock" });
    // The quantity is the line's own (prefilled from the dose at the claim), the name as the doctor wrote it, spaces tidied.
    expect(await db.select().from(pharmacyDemand)).toEqual([expect.objectContaining({
      source: "desk_decline", itemId: null, typedName: "Ascoril LS syrup", qtyAskedBase: t.lines[0]!.qtyBase ?? 1, shortBookEntryId: null,
    })]);
    expect(await listOpenShortBook(db)).toEqual([]);
    const [declined] = await db.select().from(events).where(eq(events.name, "dispense.line_declined"));
    expect(declined!.payload).toMatchObject({ reasonCode: "not_in_stock" });
  });

  it("a typed name that is an item's own name (not on sale) is the catalogue's: the short book is raised", async () => {
    await retail();
    // Brufen 400 is in the item master but not on sale: the counter's search cannot find it, the name still can.
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "BRUF400", name: "Brufen 400 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.ibuprofen, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 15, isPurchaseUom: true, isIssueUom: true }],
    }));
    const r = await noteAskedFor(db, A, { source: "counter_search", typedName: "brufen 400 TABLET", qtyBase: 15 }, MON);
    expect(r.demand).toMatchObject({ itemId, medicineId: fx.med.ibuprofen, typedName: null, qtyAskedBase: 15 });
    expect(r.shortBook).toMatchObject({ created: true, entry: { itemId, drugName: "Brufen 400 tablet", source: "counter" } });
    const noted = await db.select().from(events).where(eq(events.name, "short_book.noted"));
    expect(noted.map((e) => (e.payload as { source: string }).source)).toEqual(["counter"]);
  });

  it("a shortage noted by hand is raised by the next ask, not doubled, and keeps its source", async () => {
    await retail();
    const hand = await addShortBookEntry(db, A, { itemId: fx.item.calpol, drugName: "Calpol", qtyWanted: 100, source: "desk", storeCode: RETAIL_PHARMACY_STORE_CODE }, MON);
    expect(hand.entry).toMatchObject({ askedCount: 0, askedQtyBase: 0 });
    const r = await noteAskedFor(db, A, { source: "counter_search", itemId: fx.item.calpol, qtyBase: 10 }, MON2);
    expect(r.shortBook).toMatchObject({ created: false, entry: { id: hand.entry.id, source: "desk", qtyWanted: 100, askedCount: 1, askedQtyBase: 10 } });
    expect(await db.select().from(pharmacyShortBook)).toHaveLength(1);
    // The counter's door never opens a `counter` row by hand.
    expect((await addShortBookEntry(db, A, { itemId: fx.item.calpol, drugName: "Calpol", source: "desk", storeCode: RETAIL_PHARMACY_STORE_CODE }, MON2)).created).toBe(false);
  });

  it("the counter's note is gated like a sale, at a counter's store, for a quantity above zero and a name", async () => {
    await retail();
    await expect(noteAskedFor(db, fx.clerk.actor, { source: "counter_search", itemId: fx.item.calpol }, MON)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(noteAskedFor(db, A, { source: "counter_search", itemId: fx.item.calpol, storeCode: "IN-TRANSIT" }, MON)).rejects.toMatchObject({ code: "store_missing" });
    await expect(noteAskedFor(db, A, { source: "counter_search", itemId: fx.item.calpol, qtyBase: 0 }, MON)).rejects.toMatchObject({ code: "qty_required" });
    await expect(noteAskedFor(db, A, { source: "counter_search", typedName: " x " }, MON)).rejects.toMatchObject({ code: "invalid_short_book_entry" });
    await expect(noteAskedFor(db, A, { source: "counter_search", itemId: "01HNOSUCHITEM0000000000000" }, MON)).rejects.toMatchObject({ code: "unknown_item" });
    expect(await db.select().from(pharmacyDemand)).toEqual([]);
  });

  /* Follow-up on #1064 — a double tap (or a retry after a lost answer) of "Note as asked for" counts once. */
  it("the counter's note under one idempotency key is recorded once: one demand row, asked count 1", async () => {
    await retail();
    const controller = new PharmacyRetailController(db, docs);
    const body = { source: "counter_search", itemId: fx.item.calpol, qtyBase: 10 };
    const first = await controller.askedFor(A, body, "ask-key-1");
    const again = await controller.askedFor(A, body, "ask-key-1");
    expect(again.demand.id).toBe(first.demand.id);
    expect(await db.select().from(pharmacyDemand)).toHaveLength(1);
    expect(await listOpenShortBook(db, RETAIL_PHARMACY_STORE_CODE)).toEqual([expect.objectContaining({ askedCount: 1, askedQtyBase: 10 })]);
    // A new press is a new key, and counts.
    await controller.askedFor(A, body, "ask-key-2");
    expect(await db.select().from(pharmacyDemand)).toHaveLength(2);
  });

  /* Follow-up on #1064 — one pharmacy buys for both counters: the short book's read lists both, each with its store. */
  it("the short book read with no store lists the OPD and the walk-in counters' open rows together, each with its store", async () => {
    const retailId = await retail();
    await addShortBookEntry(db, A, { drugName: "Pan 40", source: "desk" }, MON);
    await noteAskedFor(db, A, { source: "counter_search", itemId: fx.item.calpol, qtyBase: 10 }, MON2);
    const controller = new PharmacyCounterController(db, testCfg, fx.registry, docs);
    const both = (await controller.shortBook()).entries;
    expect(both.map((e) => [e.drugName, e.storeCode])).toEqual([["Pan 40", "PHARM-OPD"], ["Calpol 500 tablet", RETAIL_PHARMACY_STORE_CODE]]);
    expect(both[1]!.storeResourceId).toBe(retailId);
    // A store named still reads that store alone.
    expect((await controller.shortBook(RETAIL_PHARMACY_STORE_CODE)).entries.map((e) => e.drugName)).toEqual(["Calpol 500 tablet"]);
    expect((await controller.shortBook("PHARM-OPD")).entries.map((e) => e.drugName)).toEqual(["Pan 40"]);
  });

  /* Follow-up on #1064 — a line dropped at the bill as not in stock (picked, not the last line) records the demand. */
  it("a line dropped at the bill as not in stock records a demand row and keeps the ticket picked", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 30, expiryDate: "2027-12-31" });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30, expiryDate: "2027-12-31" });
    const t = await ticket([line({ drug: "Crocin 500", medicineId: fx.med.crocin }), line({ drug: "Azee 500", medicineId: fx.med.azithro })]);
    await verifyDispense(db, A, fx.decls, t.id, { lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 3 }] }, MON2);
    await pickDispense(db, A, fx.decls, t.id, {}, MON2);
    const view = await declineLine(db, A, fx.decls, t.id, 1, "not in stock", MON2, { reasonCode: "not_in_stock" });
    expect(view.status).toBe("picked");
    expect(await db.select().from(pharmacyDemand)).toEqual([expect.objectContaining({ source: "desk_decline", itemId: fx.item.azithro, qtyAskedBase: 3, dispenseId: t.id })]);
  });
});
