import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { approvals, events } from "../../kernel/db/schema";
import { looseTraysOf } from "./loose-trays";
import { listCreditNotes } from "../billing";
import { availableQty, planSupplierReturns, updateItem } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { acceptReturn } from "./returns";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P6 — A SEALED STRIP COMES BACK: RESTOCKED, CREDITED, REFUND REQUESTED ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p6-sales-returns.md`; doc 16 O-7:
 * within 7 days, sealed and intact, against the bill, never cold-chain, a narcotic or a cut strip.
 */
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number): Date => new Date(MON3.getTime() + days * DAY);
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

describe("sales returns at the counter (pharmacy P6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
  });
  afterEach(() => { fx.unregister(); });

  /** Twenty Crocin tablets, paid and handed over at MON3. */
  async function handedOver(): Promise<{ id: string; paid: number }> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    return { id, paid: preview.totals.netPayablePaise };
  }

  const ret = (id: string, qtyBase: number, at: Date, over: Partial<Parameters<typeof acceptReturn>[4]> = {}, who = fx.pharmacist.actor) =>
    acceptReturn(db, who, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase }], sealedIntact: true, reason: "the doctor changed the medicine", reasonClass: "genuine", ...over,
    }, at);

  it("restocks a sealed strip, credits it, requests its refund, and never takes back more than was dispensed", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000, at: MON });
    const { id, paid } = await handedOver();
    expect(await availableQty(db, fx.storeId, fx.item.crocin, later(2))).toBe(80);

    const first = await ret(id, 10, later(2));

    expect(await availableQty(db, fx.storeId, fx.item.crocin, later(2))).toBe(90);
    const notes = await listCreditNotes(db);
    expect(notes.map((n) => [n.id, n.kind, n.netPaise])).toEqual([[first.creditNoteId, "refund", paid / 2]]);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, first.refundApprovalId ?? ""));
    expect(approval).toMatchObject({ typeKey: "billing_refund", amountPaise: paid / 2 });
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.line_returned"));
    expect(ev?.payload).toMatchObject({
      dispenseId: id, sealedIntact: true, reason: "the doctor changed the medicine",
      lines: [{ lineIdx: 0, qtyBase: 10 }], creditNoteId: first.creditNoteId, refundApprovalId: first.refundApprovalId,
    });

    await ret(id, 10, later(3));
    await expect(ret(id, 10, later(3))).rejects.toMatchObject({ code: "return_exceeds_dispensed" });
    expect(await availableQty(db, fx.storeId, fx.item.crocin, later(3))).toBe(100);
  });

  it("refuses what O-7 refuses, and writes nothing when it does", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000, at: MON });
    const { id } = await handedOver();
    await expect(ret(id, 10, later(2), { sealedIntact: false })).rejects.toMatchObject({ code: "return_not_sealed" });
    await expect(ret(id, 10, later(8))).rejects.toMatchObject({ code: "return_window_closed" });
    await expect(ret(id, 5, later(2))).rejects.toMatchObject({ code: "return_cut_strip" });
    await expect(ret(id, 10, later(2), { reason: " " })).rejects.toMatchObject({ code: "reason_required" });
    await expect(ret(id, 10, later(2), {}, fx.incharge.actor)).rejects.toMatchObject({ code: "pharmacist_not_registered" });
    await withTx(db, (tx) => updateItem(tx, HEAD, fx.item.crocin, { storageClass: "cold_2_8" }));
    await expect(ret(id, 10, later(2))).rejects.toMatchObject({ code: "return_not_accepted" });

    expect(await listCreditNotes(db)).toHaveLength(0);
    expect(await availableQty(db, fx.storeId, fx.item.crocin, later(2))).toBe(80);
  });

  /* Owner ruling 2026-10-03 — loose tablets go to a tray: "can be given" (sealed in the pocket) or damage (our mistake). */
  it("loose tablets: sealed ones go to the loose tray for any reason, unfit ones to the damage tray only for our mistake", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000, at: MON });
    const { id, paid } = await handedOver();
    await expect(ret(id, 15, later(2))).rejects.toMatchObject({ code: "return_cut_strip" }); // loose, and no tray named
    await expect(ret(id, 15, later(2), { looseTo: "damage" })).rejects.toMatchObject({ code: "return_cut_strip" }); // the patient's reason: only fit tablets
    expect(await looseTraysOf(db, fx.storeId)).toEqual({});

    const r = await ret(id, 15, later(2), { looseTo: "loose" });

    // The strip back on the shelf, the five loose ones in the loose tray, the fifteen refunded.
    const trays = await looseTraysOf(db, fx.storeId);
    expect(await availableQty(db, fx.storeId, fx.item.crocin, later(2))).toBe(90);
    expect(await availableQty(db, trays.loose!, fx.item.crocin, later(2))).toBe(5);
    const [note] = await listCreditNotes(db);
    expect(note).toMatchObject({ id: r.creditNoteId, netPaise: (paid * 3) / 4 });
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.line_returned"));
    expect(ev?.payload).toMatchObject({ lines: [{ lineIdx: 0, qtyBase: 15, looseQty: 5, looseTo: "loose" }] });

    // Our mistake, nothing named: the loose ones go to the damage tray, which nothing is picked from.
    await ret(id, 5, later(3), { reasonClass: "mistake", reason: "wrong medicine given" });
    const after = await looseTraysOf(db, fx.storeId);
    expect(await availableQty(db, after.damage!, fx.item.crocin, later(3))).toBe(5);
    // The damage tray is on the office's destruction list, whatever its expiry.
    expect((await planSupplierReturns(db, later(3))).toDestroy.map((x) => [x.storeResourceId, x.qtyBase, x.why])).toEqual([[after.damage, 5, "damage_tray"]]);
    await expect(ret(id, 1, later(3), { reasonClass: "mistake", reason: "wrong medicine given" })).rejects.toMatchObject({ code: "return_exceeds_dispensed" });
  });

  it("a loose quantity is picked from the loose tray first, and only the whole strips come off the shelf", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000, at: MON });
    const { id } = await handedOver();
    await ret(id, 15, later(2), { looseTo: "loose" });
    const trays = await looseTraysOf(db, fx.storeId);

    // A new patient needs 15: five from the tray, ten (one strip) off the shelf — no strip is cut.
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, later(2));
    if (found.kind !== "dispense") throw new Error("no dispense");
    const next = found.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: next, door: "rx_qr" }, later(2));
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, next, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, later(2));
    const view = await pickDispense(db, fx.pharmacist.actor, fx.decls, next, {}, later(2));

    expect(view.lines.map((l) => [l.qtyBase, l.fromLooseTray])).toEqual([[5, true], [10, false]]);
    expect(await availableQty(db, trays.loose!, fx.item.crocin, later(2))).toBe(0);
    expect(await availableQty(db, fx.storeId, fx.item.crocin, later(2))).toBe(80);
  });

  it("does not restock a batch that is about to expire, nor anything not yet handed over", async () => {
    // The only batch expires 20 days after the hand-over: too short to go back on the shelf.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-SHORT", qtyBase: 100, expiryDate: "2026-09-06", mrpPaise: 12000, at: MON });
    const { id } = await handedOver();
    await expect(ret(id, 10, later(2))).rejects.toMatchObject({ code: "return_short_expiry" });

    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await expect(ret(r.dispense.id, 10, later(2))).rejects.toMatchObject({ code: "dispense_not_in_state" });
  });
});
