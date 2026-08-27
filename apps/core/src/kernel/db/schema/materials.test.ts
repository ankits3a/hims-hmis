import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  ITEM_CLASS_VALUES, LEDGER_REASON_VALUES, OWNERSHIP_VALUES, consignmentLots, formularyMedicines,
  items, resources, stockBalances, stockBatches, stockLedger, vendorDocuments, vendors,
} from "./index";
import type { Db } from "../client";

/**
 * PLAN 14 T1 — the sixteen materials tables, pinned by EXECUTION against the real migration.
 *
 * Every leg below reads `information_schema` / `pg_constraint` or exercises the constraint against
 * Postgres, rather than comparing the schema file to itself — `resources.test.ts`'s discipline and
 * §2.88's: an assertion built from the drizzle objects passes for ANY migration at all, including
 * one that was never generated and one that was generated and never applied. What is asserted here
 * is what POSTGRES HAS.
 *
 * ═══ WHY THE FIVE CHECKS ARE READ OUT BY NAME AND *ALSO* EXERCISED ═══
 *
 * DD17 ships `0034` as generated output, hand-authored nowhere, and Plan 13's lesson 4 is that the
 * generator's default can be the dangerous form. Here the specific risk the plan names is **a CHECK
 * it fails to emit**: drizzle's `check()` helper is newer than most of this schema, a dropped
 * constraint changes no TypeScript and no query, and the first thing that would notice is a negative
 * balance on a live shelf. So the five semantic CHECKs are asserted TWICE, and the two legs catch
 * different failures:
 *
 *   · `pg_get_constraintdef` BY NAME catches a constraint that was never emitted, or was emitted
 *     under a name a later migration can drop without this file noticing.
 *   · An INSERT that must be REFUSED catches a constraint that exists with the wrong PREDICATE —
 *     `>= 0` written as `> 0`, `<=` written as `<`, an `or` where an `and` belongs. A definition
 *     read back as text cannot tell you that; only Postgres refusing the row can.
 *
 * The five, and what each one is the last line of defence for: `items_class_formulary_ck` (a drug
 * with no medicine, or a glove with one — DD3), `stock_balances_non_negative_ck` (the invariant
 * DD6 exists for, defended against raw SQL in a future migration), `stock_batches_ownership_ck`
 * (DD5), `stock_ledger_qty_delta_ck` (a movement of zero, which is a bug that would sit in the
 * history looking like an event), `consignment_lots_qty_ck` (T7's A20 as a DATABASE property and
 * not only a consumer property).
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };

/**
 * The tables this phase owns, and the columns each must have, in `order by column_name asc`.
 * A DROP in a later migration fails here, and so does a column added without a plan.
 */
const CENSUS: Record<string, string[]> = {
  items: [
    "abc_class", "active", "base_uom", "batch_tracked", "class", "code", "created_at", "created_by",
    "formulary_medicine_id", "gst_rate_bps", "hsn_code", "id", "name", "serial_tracked",
    "shelf_life_days", "storage_class", "updated_at", "updated_by", "ved_class",
  ],
  item_uoms: ["id", "is_issue_uom", "is_purchase_uom", "item_id", "to_base_multiplier", "uom"],
  item_barcodes: ["code", "id", "item_id", "pack_uom", "vendor_id"],
  item_price_regulations: [
    "ceiling_paise", "created_at", "created_by", "effective_from", "gazette_ref", "id", "item_id",
    "mrp_default_paise", "mrp_uom", "seq",
  ],
  vendors: [
    "bank", "blacklist_reason", "blacklist_until", "class_flags", "code", "created_at", "created_by",
    "first_payment_allowed_at", "gstin", "gstin_verified_at", "id", "legal_name", "msme_class",
    "msme_udyam_no", "pan", "payment_terms_days", "status", "trade_name", "updated_at", "updated_by",
  ],
  vendor_documents: [
    "created_at", "created_by", "file_ref", "id", "number", "type", "valid_from", "valid_to",
    "vendor_id", "verified_at", "verified_by",
  ],
  vendor_bank_changes: [
    "applied_at", "approval_id", "cooling_off_until", "created_at", "id", "new_bank", "new_masked",
    "old_masked", "requested_by", "status", "vendor_id",
  ],
  stock_batches: [
    "batch_no", "consignment_lot_id", "created_at", "created_by", "expiry_date",
    "expiry_notified_thresholds", "grn_line_id", "id", "item_id", "landed_cost_paise", "mfg_date",
    "mrp_paise", "mrp_uom", "ownership", "recall_status", "vendor_id",
  ],
  consignment_lots: [
    "agreement_document_id", "batch_id", "challan_date", "challan_no", "created_at", "created_by",
    "deemed_supply_deadline", "id", "item_id", "qty_deployed", "qty_received", "qty_returned",
    "status", "store_resource_id", "vendor_id",
  ],
  stock_ledger: [
    "actor_id", "batch_id", "cost_center", "encounter_id", "event_id", "id", "item_id",
    "occurred_at", "patient_id", "qty_delta", "reason", "recorded_at", "ref_id", "ref_type",
    "resource_id", "seq",
  ],
  stock_balances: [
    "batch_id", "item_id", "qty_frozen", "qty_on_hand", "qty_reserved", "resource_id", "updated_at",
  ],
  stock_reservations: [
    "batch_id", "created_at", "created_by", "expires_at", "id", "qty", "ref_id", "ref_type",
    "resource_id", "status",
  ],
  transfers: [
    "from_resource_id", "id", "issued_at", "issued_by", "note", "received_at", "received_by",
    "status", "to_resource_id",
  ],
  transfer_lines: [
    "batch_id", "discrepancy_reason", "id", "qty_issued", "qty_received", "transfer_id",
  ],
  grns: [
    "approval_id", "captured_by", "challan_date", "challan_no", "created_at", "created_by", "grn_no",
    "id", "invoice_no", "po_ref", "posted_at", "qc_by", "source", "status", "store_resource_id",
    "updated_at", "updated_by", "vendor_id",
  ],
  grn_lines: [
    "batch_id", "batch_no", "expiry_date", "free_goods", "grn_id", "id", "item_id", "mfg_date",
    "mrp_paise", "mrp_uom", "near_expiry", "qty_accepted_base", "qty_base", "qty_in_uom",
    "qty_rejected_base", "reject_reason", "temp_log_ref", "unit_cost_paise", "uom",
  ],
};

describe("the materials tables (Plan 14 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function columnsOf(table: string): Promise<string[]> {
    const rows = (await db.execute(sql`
      select column_name as "columnName" from information_schema.columns
      where table_schema = 'public' and table_name = ${table} order by column_name asc
    `)).rows as { columnName: string }[];
    return rows.map((r) => r.columnName);
  }

  async function constraintDef(name: string): Promise<string | undefined> {
    const rows = (await db.execute(sql`
      select pg_get_constraintdef(oid) as "def" from pg_constraint where conname = ${name}
    `)).rows as { def: string }[];
    return rows[0]?.def;
  }

  // ─────────────────────────── the census: sixteen tables ───────────────────────────

  it("all sixteen tables exist with exactly the columns the plan names", async () => {
    for (const [table, expected] of Object.entries(CENSUS)) {
      expect({ table, columns: await columnsOf(table) }).toEqual({ table, columns: expected });
    }
  });

  /**
   * THE COUNT ITSELF, because the plan said FIFTEEN and it is SIXTEEN (finding F2). The plan's own
   * "Produces" list bundles `transfers`/`transfer_lines` and `grns`/`grn_lines` onto one bullet
   * each, and the prose count followed the bullets rather than the tables. Recorded here as a
   * number rather than only in CLOSE, so the next phase that reads this family counts what exists.
   */
  it("there are exactly SIXTEEN of them — the plan's prose said fifteen (F2)", () => {
    expect(Object.keys(CENSUS)).toHaveLength(16);
  });

  // ───────────────────── the five semantic CHECKs, read out BY NAME ─────────────────────

  it("the five CHECKs that carry semantics exist by name — the generator did not drop one", async () => {
    const defs = {
      items_class_formulary_ck: await constraintDef("items_class_formulary_ck"),
      stock_balances_non_negative_ck: await constraintDef("stock_balances_non_negative_ck"),
      stock_batches_ownership_ck: await constraintDef("stock_batches_ownership_ck"),
      stock_ledger_qty_delta_ck: await constraintDef("stock_ledger_qty_delta_ck"),
      consignment_lots_qty_ck: await constraintDef("consignment_lots_qty_ck"),
    };
    // Present at all — the failure DD17 names in as many words.
    expect(Object.entries(defs).filter(([, d]) => d === undefined).map(([n]) => n)).toEqual([]);
    // And each one is about what its name claims it is about.
    expect(defs.items_class_formulary_ck).toContain("formulary_medicine_id");
    expect(defs.items_class_formulary_ck).toContain("'drug'");
    expect(defs.stock_balances_non_negative_ck).toContain("qty_on_hand");
    expect(defs.stock_balances_non_negative_ck).toContain("qty_reserved");
    expect(defs.stock_balances_non_negative_ck).toContain("qty_frozen");
    expect(defs.stock_batches_ownership_ck).toContain("'consignment'");
    expect(defs.stock_ledger_qty_delta_ck).toContain("qty_delta");
    expect(defs.consignment_lots_qty_ck).toContain("qty_deployed");
    expect(defs.consignment_lots_qty_ck).toContain("qty_received");
  });

  /**
   * The closed sets that ship as CHECKs (16a F3), compared to the arrays the module reads. Two
   * copies of one list is §2.54's mechanism, so it ships with §2.54's approved remedy: the
   * constraint's own text, read back out of Postgres, against the exported array.
   */
  it("the exported value arrays and the CHECKs Postgres holds are the same lists", async () => {
    const classDef = await constraintDef("items_class_ck");
    for (const v of ITEM_CLASS_VALUES) expect({ v, in: classDef?.includes(`'${v}'`) }).toEqual({ v, in: true });
    const ownDef = await constraintDef("stock_batches_ownership_ck");
    for (const v of OWNERSHIP_VALUES) expect({ v, in: ownDef?.includes(`'${v}'`) }).toEqual({ v, in: true });
    const reasonDef = await constraintDef("stock_ledger_reason_ck");
    for (const v of LEDGER_REASON_VALUES) expect({ v, in: reasonDef?.includes(`'${v}'`) }).toEqual({ v, in: true });
    // And the constraints admit NOTHING ELSE: the count of quoted literals equals the array length,
    // so a CHECK carrying an eleventh class the union does not know fails here.
    expect((classDef?.match(/'[a-z0-9_]+'::text/g) ?? []).length).toBe(ITEM_CLASS_VALUES.length);
    expect((ownDef?.match(/'[a-z0-9_]+'::text/g) ?? []).length).toBe(OWNERSHIP_VALUES.length);
    expect((reasonDef?.match(/'[a-z0-9_]+'::text/g) ?? []).length).toBe(LEDGER_REASON_VALUES.length);
  });

  // ────────────── the same five CHECKs, EXERCISED: a wrong predicate is caught here ──────────────

  /** A medicine, an item, a store, a vendor, a document and a batch — the smallest graph that lets
   *  every one of the five refusals below be attempted. Deliberately NOT built through the module's
   *  write paths: T1 has none yet, and the point of this file is what the DATABASE refuses. */
  async function fixture(): Promise<{ itemId: string; storeId: string; vendorId: string; batchId: string; docId: string }> {
    await db.insert(formularyMedicines).values({ id: "med1", brandName: "Crocin 500", form: "tablet", ...AUDIT });
    await db.insert(items).values({
      id: "it1", code: "CROC500", name: "Crocin 500mg tablet", class: "drug",
      formularyMedicineId: "med1", baseUom: "tablet", batchTracked: true, ...AUDIT,
    });
    await db.insert(resources).values({
      id: "st1", kind: "store", code: "MAIN", name: "Main store", status: "available", ...AUDIT,
    });
    await db.insert(vendors).values({ id: "vn1", code: "ACME", legalName: "Acme Pharma Pvt Ltd", ...AUDIT });
    await db.insert(vendorDocuments).values({
      id: "doc1", vendorId: "vn1", type: "consignment_agreement", number: "CA/1",
      validFrom: "2026-01-01", validTo: "2027-01-01", createdBy: "t",
    });
    await db.insert(stockBatches).values({
      id: "b1", itemId: "it1", batchNo: "B-001", expiryDate: "2027-06-30", landedCostPaise: 100,
      ownership: "owned", createdBy: "t",
    });
    return { itemId: "it1", storeId: "st1", vendorId: "vn1", batchId: "b1", docId: "doc1" };
  }

  it("REFUSES a drug-class item with no medicine, and a non-drug item WITH one (DD3)", async () => {
    await fixture();
    await expect(db.insert(items).values({
      id: "bad1", code: "X1", name: "a drug with no medicine", class: "drug",
      formularyMedicineId: null, baseUom: "tablet", batchTracked: true, ...AUDIT,
    })).rejects.toThrow(/items_class_formulary_ck/);
    // The OTHER direction, which is the one a one-sided validator lets through (T3's A1 mutant).
    await expect(db.insert(items).values({
      id: "bad2", code: "X2", name: "a glove that points at a medicine", class: "consumable",
      formularyMedicineId: "med1", baseUom: "each", batchTracked: false, ...AUDIT,
    })).rejects.toThrow(/items_class_formulary_ck/);
    // And the legal pair inserts — a constraint that refused everything would pass both legs above.
    await db.insert(items).values({
      id: "ok1", code: "GLV", name: "Nitrile glove M", class: "consumable",
      baseUom: "each", batchTracked: false, ...AUDIT,
    });
  });

  it("REFUSES a negative on-hand, and a reservation or freeze exceeding it (DD6)", async () => {
    const f = await fixture();
    const base = { resourceId: f.storeId, batchId: f.batchId, itemId: f.itemId };
    await expect(db.insert(stockBalances).values({ ...base, qtyOnHand: -1 }))
      .rejects.toThrow(/stock_balances_non_negative_ck/);
    await expect(db.insert(stockBalances).values({ ...base, qtyOnHand: 5, qtyReserved: 6 }))
      .rejects.toThrow(/stock_balances_non_negative_ck/);
    await expect(db.insert(stockBalances).values({ ...base, qtyOnHand: 5, qtyFrozen: 6 }))
      .rejects.toThrow(/stock_balances_non_negative_ck/);
    // ZERO IS LEGAL, and this leg is why the CHECK reads `>= 0` and not `> 0`: a balance row whose
    // last unit has just been issued is a row that must survive at zero, or the next receipt has
    // nowhere to land.
    await db.insert(stockBalances).values({ ...base, qtyOnHand: 0 });
    // …and the boundary in the other direction: reserved EQUAL to on-hand is legal (everything on
    // the shelf is spoken for), which a `<` would refuse.
    await db.update(stockBalances).set({ qtyOnHand: 5, qtyReserved: 5, qtyFrozen: 5 });
  });

  it("REFUSES an ownership outside DD5's four, and a recall status outside its two", async () => {
    const f = await fixture();
    await expect(db.insert(stockBatches).values({
      id: "b2", itemId: f.itemId, batchNo: "B-002", landedCostPaise: 1, ownership: "rented",
      createdBy: "t",
    })).rejects.toThrow(/stock_batches_ownership_ck/);
    await expect(db.insert(stockBatches).values({
      id: "b3", itemId: f.itemId, batchNo: "B-003", landedCostPaise: 1, ownership: "owned",
      recallStatus: "quarantined", createdBy: "t",
    })).rejects.toThrow(/stock_batches_recall_status_ck/);
  });

  it("REFUSES a ledger row of zero delta, and a reason outside the five", async () => {
    const f = await fixture();
    const base = {
      resourceId: f.storeId, batchId: f.batchId, itemId: f.itemId, actorId: "t",
      occurredAt: new Date("2026-08-27T06:00:00Z"),
    };
    await expect(db.insert(stockLedger).values({ ...base, id: "l1", qtyDelta: 0, reason: "grn" }))
      .rejects.toThrow(/stock_ledger_qty_delta_ck/);
    await expect(db.insert(stockLedger).values({ ...base, id: "l2", qtyDelta: 5, reason: "adjust" }))
      .rejects.toThrow(/stock_ledger_reason_ck/);
    // BOTH SIGNS are legal and the CHECK is `<> 0` rather than `> 0`: an issue is a NEGATIVE delta,
    // and a constraint written the obvious way would refuse every outbound movement in the system.
    await db.insert(stockLedger).values({ ...base, id: "l3", qtyDelta: 10, reason: "grn" });
    await db.insert(stockLedger).values({ ...base, id: "l4", qtyDelta: -4, reason: "issue" });
  });

  it("REFUSES a consignment lot whose deployed + returned exceeds received (T7's A20, in the DB)", async () => {
    const f = await fixture();
    const base = {
      vendorId: f.vendorId, agreementDocumentId: f.docId, challanNo: "CH/1",
      challanDate: "2026-08-27", itemId: f.itemId, batchId: f.batchId, storeResourceId: f.storeId,
      deemedSupplyDeadline: "2027-02-23", createdBy: "t",
    };
    await expect(db.insert(consignmentLots).values({ ...base, id: "lot1", qtyReceived: 2, qtyDeployed: 3 }))
      .rejects.toThrow(/consignment_lots_qty_ck/);
    // The SPLIT case, which a check written only against `qty_deployed` would let through: neither
    // counter alone exceeds the receipt, their SUM does.
    await expect(db.insert(consignmentLots).values({ ...base, id: "lot2", qtyReceived: 4, qtyDeployed: 3, qtyReturned: 2 }))
      .rejects.toThrow(/consignment_lots_qty_ck/);
    // EQUALITY is legal — a fully deployed lot is the normal end state, and `<` would refuse it.
    await db.insert(consignmentLots).values({ ...base, id: "lot3", qtyReceived: 4, qtyDeployed: 3, qtyReturned: 1 });
  });

  // ───────────────────────────── the keys that carry meaning ─────────────────────────────

  /**
   * DD5's unique key, and OWNERSHIP is the third element. The same physical batch number can arrive
   * twice — once on a purchase challan and once on a consignment challan — and those are two piles
   * of stock with two owners and two money consequences. A key of `(item, batch_no)` alone would
   * merge them, silently, at the moment T6's find-or-create runs.
   */
  it("one batch number can exist twice under two ownerships, and not twice under one (DD5)", async () => {
    const f = await fixture();
    await db.insert(stockBatches).values({
      id: "b-cons", itemId: f.itemId, batchNo: "B-001", expiryDate: "2027-06-30",
      landedCostPaise: 100, ownership: "consignment", createdBy: "t",
    });
    // …and the SAME (item, batch, ownership) triple is refused. `B-001`/`owned` is in the fixture.
    await expect(db.insert(stockBatches).values({
      id: "b-dup", itemId: f.itemId, batchNo: "b-001", expiryDate: "2027-06-30",
      landedCostPaise: 100, ownership: "owned", createdBy: "t",
    })).rejects.toThrow(/stock_batches_item_batch_ownership_ux/);
  });

  /** `stock_balances` is keyed `(resource, batch)` — the PK is also T5's lock order (A9). */
  it("stock_balances is keyed on (resource_id, batch_id), which is also the lock order", async () => {
    const rows = (await db.execute(sql`
      select a.attname as "col"
      from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      where t.relname = 'stock_balances' and c.contype = 'p'
      order by k.ord
    `)).rows as { col: string }[];
    expect(rows.map((r) => r.col)).toEqual(["resource_id", "batch_id"]);
  });

  /**
   * `seq` IS the ordering key on the ledger and `id` is a ULID (`ids.ts` WARNING, ledger §3.26).
   * This leg pins that `seq` is a real sequence rather than a plain integer somebody must supply —
   * the difference between "two rows minted in one millisecond sort by their random tail" and
   * "they sort by arrival", which is the whole of what an append-only history is for.
   */
  it("stock_ledger.seq is database-allocated and monotone in insert order", async () => {
    const f = await fixture();
    const base = {
      resourceId: f.storeId, batchId: f.batchId, itemId: f.itemId, actorId: "t",
      occurredAt: new Date("2026-08-27T06:00:00Z"), reason: "grn" as const,
    };
    // ids DESCENDING, so a reader that sorted by `id` would return these in the opposite order.
    await db.insert(stockLedger).values({ ...base, id: "zzz", qtyDelta: 1 });
    await db.insert(stockLedger).values({ ...base, id: "aaa", qtyDelta: 2 });
    const rows = (await db.execute(sql`select id, seq from stock_ledger order by seq asc`))
      .rows as { id: string; seq: string }[];
    expect(rows.map((r) => r.id)).toEqual(["zzz", "aaa"]);
    expect(Number(rows[1]!.seq)).toBeGreaterThan(Number(rows[0]!.seq));
  });

  /**
   * `occurred_at` MAY precede `recorded_at` — the downtime-kit convention (DD6), and the column pair
   * exists for exactly that. This leg is what stops a future "tidy-up" collapsing the two into one:
   * a single timestamp cannot express a dispense that HAPPENED at 02:00 during a power cut and was
   * RECORDED at 09:00 when the system came back.
   */
  it("occurred_at may precede recorded_at, and both are stored", async () => {
    const f = await fixture();
    await db.insert(stockLedger).values({
      id: "late", resourceId: f.storeId, batchId: f.batchId, itemId: f.itemId, actorId: "t",
      qtyDelta: 1, reason: "grn",
      occurredAt: new Date("2026-08-20T02:00:00Z"),
      recordedAt: new Date("2026-08-27T09:00:00Z"),
    });
    const rows = (await db.execute(sql`
      select occurred_at < recorded_at as "backdated" from stock_ledger where id = 'late'
    `)).rows as { backdated: boolean }[];
    expect(rows[0]?.backdated).toBe(true);
  });

  // ───────────────────────────── the absences that are decisions ─────────────────────────────

  /**
   * `items.base_uom` IS NOT A FOREIGN KEY and cannot be: `item_uoms` rows reference the item, so an
   * FK the other way is a cycle. The invariant that matters — exactly one UoM row per item has
   * multiplier 1 and its name is `base_uom` — is not expressible as a foreign key in EITHER
   * direction, and lives at the write path (T3, A3). Named here so the next reader does not "fix"
   * it into a constraint that cannot exist.
   */
  it("base_uom carries no foreign key — the invariant it stands for is not expressible as one", async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as "n" from pg_constraint c join pg_class t on t.oid = c.conrelid
      where t.relname = 'items' and c.contype = 'f'
    `)).rows as { n: number }[];
    // Exactly ONE foreign key on `items`, and it is `formulary_medicine_id`.
    expect(rows[0]?.n).toBe(1);
  });

  /**
   * `stock_batches.grn_line_id` and `.consignment_lot_id` carry no FK, and that is a CYCLE rather
   * than an oversight: `grn_lines.batch_id` and `consignment_lots.batch_id` both point HERE, so an
   * FK in the other direction would make two mutually-referencing pairs no single INSERT order can
   * satisfy. Asserted rather than commented, because the "missing" FK is the first thing a reviewer
   * offers to add.
   */
  it("the two back-references on stock_batches carry no FK — they would be cycles", async () => {
    const rows = (await db.execute(sql`
      select a.attname as "col"
      from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
        join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
      where t.relname = 'stock_batches' and c.contype = 'f'
      order by a.attname
    `)).rows as { col: string }[];
    expect(rows.map((r) => r.col)).toEqual(["item_id", "vendor_id"]);
  });
});
