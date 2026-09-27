import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { getApproval } from "../../kernel/approvals/worklist";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { controlledStockRegister, stockAdjustments, stockBalances, stockBatches, stockLedger } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { postAdjustments } from "./adjustments";
import { registerMaterialsApprovalTypes } from "./approval-types";
import { controlledBalance, controlledChecksOn, openControlledDiscrepancies, recordControlledCheck } from "./controlled-check";
import { registerItem } from "./items";
import { postMovement } from "./ledger";
import { createStore } from "./stores";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { Custody } from "./controlled";

/**
 * ═══ PHARMACY P6 — THE CABINET AT THE LEDGER (`controlled.ts`, `controlled-check.ts`) ═══
 *
 * Every movement at a controlled store is two people and one register row, written in the ledger's own
 * transaction; a narcotic-cabinet item never enters an open store and nothing else enters the cabinet; the
 * register refuses UPDATE and DELETE in the database; and the balance a range shows from the register
 * (opening + received − issued − destroyed ± adjusted) is the closing the stock ledger holds — asserted,
 * and shown to FAIL when a ledger row at the cabinet has no register row.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

describe("the controlled-drug cabinet at the ledger (pharmacy P6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let holder: { id: string; actor: Actor };
  let witness: { id: string; actor: Actor };
  let head: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  let cabinet: string;
  let shelf: string;
  let narcotic: string;
  let plain: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "pharmacy", "medical_superintendent"]) await ensureRole(db, role);
    for (const p of ["materials.counts.manage", "materials.stock.read", "approvals.requests.read"]) await grantPermissionToRole(db, registry, "materials_head", p);
    for (const p of ["approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, registry, "medical_superintendent", p);
    holder = await mkUser(db, "cab.holder", ["pharmacy"]);
    witness = await mkUser(db, "cab.witness", ["pharmacy"]);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    ({ resourceId: cabinet } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-NDPS", name: "Controlled-drug cabinet", attributes: { controlled: true } })));
    ({ resourceId: shelf } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD shelf" })));
    narcotic = await anItem("MORPH", "narcotic");
    plain = await anItem("CROC", "ambient");
  });

  async function anItem(code: string, storageClass: string): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name: `Item ${code}`, class: "consumable", baseUom: "tablet", batchTracked: true, storageClass,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    return itemId;
  }

  async function aBatch(itemId: string, batchNo: string): Promise<string> {
    const id = newId();
    await db.insert(stockBatches).values({ id, itemId, batchNo, expiryDate: "2028-06-30", landedCostPaise: 700, ownership: "owned", createdBy: head.id });
    return id;
  }

  const keys = (w: string = witness.id, more: Partial<Custody> = {}): Custody => ({ witnessId: w, counterparty: "ACME Pharma", documentRef: "INV-1", ...more });

  it("a movement at the cabinet without a witness is refused, and nothing is written", async () => {
    const batch = await aBatch(narcotic, "M-1");
    await expect(withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: 20, reason: "grn", occurredAt: at(0) })))
      .rejects.toMatchObject({ code: "custody_required" });
    expect(await db.select().from(stockLedger)).toEqual([]);
    expect(await db.select().from(controlledStockRegister)).toEqual([]);
  });

  it("one person cannot be both keys — as holder and witness, or as the witness twice", async () => {
    const batch = await aBatch(narcotic, "M-1");
    await expect(withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: 20, reason: "grn", occurredAt: at(0), custody: keys(holder.id) })))
      .rejects.toMatchObject({ code: "custody_same_person" });
    await expect(withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: 20, reason: "grn", occurredAt: at(0), custody: keys(witness.id, { extraWitnessIds: [witness.id] }) })))
      .rejects.toMatchObject({ code: "custody_same_person" });
    // And the database says so too: a ledger row whose witness is its actor fails the CHECK.
    await expect(db.execute(sql`insert into stock_ledger (id, resource_id, batch_id, item_id, qty_delta, reason, actor_id, witness_id, occurred_at)
      values (${newId()}, ${cabinet}, ${batch}, ${narcotic}, 1, 'grn', ${holder.id}, ${holder.id}, now())`)).rejects.toThrow(/stock_ledger_witness_ck/);
  });

  it("a witness who is not an active member of staff is refused", async () => {
    const batch = await aBatch(narcotic, "M-1");
    await expect(withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: 20, reason: "grn", occurredAt: at(0), custody: keys("01NOSUCHUSER000000000000000") })))
      .rejects.toMatchObject({ code: "custody_witness_unknown" });
  });

  it("the cabinet or nowhere: a narcotic-cabinet item never enters an open store, and nothing else enters the cabinet", async () => {
    const m = await aBatch(narcotic, "M-1");
    const c = await aBatch(plain, "C-1");
    await expect(withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: shelf, batchId: m, qtyDelta: 20, reason: "grn", occurredAt: at(0) })))
      .rejects.toMatchObject({ code: "controlled_outside_custody" });
    await expect(withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: c, qtyDelta: 20, reason: "grn", occurredAt: at(0), custody: keys() })))
      .rejects.toMatchObject({ code: "not_a_controlled_item" });
    // An ordinary item onto an open shelf is untouched by any of it.
    await withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: shelf, batchId: c, qtyDelta: 20, reason: "grn", occurredAt: at(0) }));
    expect(await db.select().from(controlledStockRegister)).toEqual([]);
  });

  it("a witnessed movement writes the ledger row with its witness and ONE register row with the batch's balance after it", async () => {
    const batch = await aBatch(narcotic, "M-1");
    await withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: 30, reason: "grn", refType: "grn", occurredAt: at(0), custody: keys(witness.id, { counterpartyLicence: "20B-1, 21B-2" }) }));
    await withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: -4, reason: "consume", refType: "pharmacy_dispense", occurredAt: at(5), custody: keys(witness.id, { counterparty: "Asha Devi", documentRef: "INV/1", prescriberRegNo: "BMC/12345", collectedBy: "Asha Devi (self)", collectedIdProof: "Aadhaar ••1234" }) }));
    const ledger = await db.select().from(stockLedger).where(eq(stockLedger.resourceId, cabinet));
    expect(ledger.map((l) => [l.qtyDelta, l.actorId, l.witnessId])).toEqual([[30, holder.id, witness.id], [-4, holder.id, witness.id]]);
    const reg = await db.select().from(controlledStockRegister).orderBy(controlledStockRegister.seq);
    expect(reg.map((r) => [r.movement, r.direction, r.qtyBase, r.balanceAfter, r.holderName, r.witnessName])).toEqual([
      ["grn", "in", 30, 30, "cab.holder", "cab.witness"],
      ["consume", "out", 4, 26, "cab.holder", "cab.witness"],
    ]);
    expect(reg[0]).toMatchObject({ counterparty: "ACME Pharma", counterpartyLicence: "20B-1, 21B-2", documentRef: "INV-1", drugName: "Item MORPH", batchNo: "M-1", unit: "tablet" });
    expect(reg[1]).toMatchObject({ counterparty: "Asha Devi", prescriberRegNo: "BMC/12345", collectedBy: "Asha Devi (self)", collectedIdProof: "Aadhaar ••1234" });
    expect(new Set(reg.map((r) => r.ledgerEntryId))).toEqual(new Set(ledger.map((l) => l.id)));
    const [bal] = await db.select().from(stockBalances).where(eq(stockBalances.resourceId, cabinet));
    expect(bal?.qtyOnHand).toBe(reg.at(-1)!.balanceAfter);
  });

  it("the register refuses UPDATE and DELETE in the database — a wrong entry is corrected by a further entry", async () => {
    const batch = await aBatch(narcotic, "M-1");
    await withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: 30, reason: "grn", occurredAt: at(0), custody: keys() }));
    const [row] = await db.select().from(controlledStockRegister);
    await expect(db.execute(sql`update controlled_stock_register set qty_base = 3 where id = ${row!.id}`)).rejects.toThrow(/controlled_stock_register_immutable/);
    await expect(db.execute(sql`delete from controlled_stock_register where id = ${row!.id}`)).rejects.toThrow(/controlled_stock_register_immutable/);
    expect((await db.select().from(controlledStockRegister))[0]?.qtyBase).toBe(30);
  });

  it("the balance identity: opening + received − issued − destroyed ± adjusted = closing = the stock ledger's, per batch — and a ledger row the register never saw breaks it", async () => {
    const a = await aBatch(narcotic, "M-A");
    const b = await aBatch(narcotic, "M-B");
    const move = (batchId: string, qtyDelta: number, reason: "grn" | "consume" | "adjust", refType: string, when: Date) =>
      withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId, qtyDelta, reason, refType, occurredAt: when, custody: keys() }));
    await move(a, 50, "grn", "grn", new Date("2026-09-20T05:00:00Z")); // before the range: the opening
    await move(a, -6, "consume", "pharmacy_dispense", new Date("2026-09-21T05:00:00Z"));
    await move(a, 20, "grn", "grn", at(0)); // in the range
    await move(a, -9, "consume", "pharmacy_dispense", at(10));
    await move(a, -3, "adjust", "stock_write_off", at(20)); // destroyed
    await move(a, -2, "adjust", "stock_adjustment", at(30)); // a check's shortfall, booked
    await move(b, 12, "grn", "grn", at(40));
    await move(b, 1, "adjust", "stock_adjustment", at(50)); // a check's excess, booked
    const bal = await controlledBalance(db, { storeResourceId: cabinet, fromDay: "2026-09-24", toDay: "2026-09-24" });
    const rowA = bal.rows.find((r) => r.batchNo === "M-A")!;
    expect(rowA).toMatchObject({ opening: 44, received: 20, issued: 9, destroyed: 3, adjusted: -2, closing: 50, ledgerClosing: 50, registerRows: 4, ledgerRows: 4, reconciled: true });
    expect(bal.rows.find((r) => r.batchNo === "M-B")).toMatchObject({ opening: 0, received: 12, issued: 0, destroyed: 0, adjusted: 1, closing: 13, ledgerClosing: 13, reconciled: true });
    for (const r of bal.rows) expect(r.opening + r.received - r.issued - r.destroyed + r.adjusted).toBe(r.ledgerClosing);
    expect(bal.reconciled).toBe(true);

    // A movement written straight into the ledger, around the register (raw SQL — no code path does it):
    await db.execute(sql`insert into stock_ledger (id, resource_id, batch_id, item_id, qty_delta, reason, actor_id, occurred_at)
      values (${newId()}, ${cabinet}, ${a}, ${narcotic}, -1, 'consume', ${holder.id}, ${at(60)})`);
    const broken = await controlledBalance(db, { storeResourceId: cabinet, fromDay: "2026-09-24", toDay: "2026-09-24" });
    expect(broken.rows.find((r) => r.batchNo === "M-A")).toMatchObject({ closing: 50, ledgerClosing: 49, registerRows: 4, ledgerRows: 5, reconciled: false });
    expect(broken.reconciled).toBe(false);
  });

  it("the daily check: counted by the holder with a witness; balanced closes it, a shortfall goes to the medical superintendent and is booked only under two keys", async () => {
    const batch = await aBatch(narcotic, "M-1");
    await withTx(db, (tx) => postMovement(tx, holder.actor, { resourceId: cabinet, batchId: batch, qtyDelta: 30, reason: "grn", occurredAt: at(0), custody: keys() }));
    await expect(recordControlledCheck(db, holder.actor, { storeResourceId: cabinet, witnessId: witness.id, lines: [] }, at(10)))
      .rejects.toMatchObject({ code: "controlled_check_invalid" }); // every batch counted
    await expect(recordControlledCheck(db, holder.actor, { storeResourceId: cabinet, witnessId: holder.id, lines: [{ batchId: batch, countedQty: 30 }] }, at(10)))
      .rejects.toMatchObject({ code: "custody_same_person" });
    const ok = await recordControlledCheck(db, holder.actor, { storeResourceId: cabinet, witnessId: witness.id, lines: [{ batchId: batch, countedQty: 30 }] }, at(10));
    expect(ok).toMatchObject({ balanced: true, approvalId: null });
    expect(await controlledChecksOn(db, cabinet, "2026-09-24")).toHaveLength(1);

    const short = await recordControlledCheck(db, holder.actor, { storeResourceId: cabinet, witnessId: witness.id, lines: [{ batchId: batch, countedQty: 28 }] }, at(20));
    expect(short).toMatchObject({ balanced: false, lines: [{ expected: 30, counted: 28, variance: -2 }] });
    expect((await getApproval(db, short.approvalId!))).toMatchObject({ status: "pending", approverRole: "medical_superintendent" });
    expect(await openControlledDiscrepancies(db, cabinet)).toEqual([{ countId: short.countId, checkedAt: at(20).toISOString() }]);

    await approveRequest(db, ms.actor, { approvalId: short.approvalId!, note: "two tablets broken, witnessed" });
    // The head books a cycle count's variance; at the cabinet the ledger still wants the witness.
    await expect(postAdjustments(db, head.actor, short.approvalId!, at(30))).rejects.toMatchObject({ code: "custody_required" });
    // A person without the counts grant books it only as the cabinet's custodian, with a witness.
    await expect(postAdjustments(db, holder.actor, short.approvalId!, at(30))).rejects.toMatchObject({ code: "permission_denied" });
    await postAdjustments(db, holder.actor, short.approvalId!, at(30), { custody: keys() });
    const [adj] = await db.select().from(stockAdjustments).where(eq(stockAdjustments.approvalId, short.approvalId!));
    expect(adj).toMatchObject({ status: "posted", qtyDelta: -2, reasonCode: "shrinkage" });
    const reg = await db.select().from(controlledStockRegister).orderBy(controlledStockRegister.seq);
    expect(reg.at(-1)).toMatchObject({ movement: "adjust", direction: "out", qtyBase: 2, balanceAfter: 28, witnessId: witness.id });
    expect(await openControlledDiscrepancies(db, cabinet)).toEqual([]);
  });
});
