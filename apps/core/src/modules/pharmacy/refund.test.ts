import { and, eq, inArray } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { approvals, events, orderItems, rolePermissions } from "../../kernel/db/schema";
import { invoiceSettlement, listCreditNotes } from "../billing";
import { availableQty } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { cancelBilledDispense } from "./refund";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P5 — A PAID DISPENSE THAT CANNOT BE COLLECTED HAS A WAY OUT ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p5-billed-cancel-refund.md`. Hand-over
 * refuses a batch that expired after the bill (`batch_expired_before_collection`), and
 * `cancelDispense` refused a billed dispense: the patient had paid, could not collect, and the
 * stock stayed reserved for ever. The counter now cancels it, credits the bill, and files the refund
 * request that billing's approval-gated voucher pays.
 */
describe("cancelling a billed dispense with a refund (pharmacy P5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let paid: number;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 30, mrpPaise: 15000 });
  });
  afterEach(() => { fx.unregister(); });

  async function billed(): Promise<{ id: string; invoiceId: string; tokenNo: number | null; qr: string }> {
    const { issued, tokenNo } = await issueRx(db, fx, [line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    paid = preview.totals.netPayablePaise;
    const b = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: paid }] }, MON2);
    if (b.invoiceId === null) throw new Error("no invoice");
    return { id, invoiceId: b.invoiceId, tokenNo, qr: issued.qrPayload };
  }

  it("cancels the dispense, frees its stock, credits the bill in full and files the refund request", async () => {
    const { id, invoiceId, tokenNo, qr } = await billed();
    expect(await availableQty(db, fx.storeId, fx.item.azithro, MON3)).toBe(27);

    const out = await cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, id, {
      reason: "batch expired before the patient came back", reasonClass: "genuine",
    }, MON3);

    expect(out.dispense.status).toBe("cancelled");
    expect(await availableQty(db, fx.storeId, fx.item.azithro, MON3)).toBe(30);
    const items = await db.select({ status: orderItems.status }).from(orderItems);
    expect(items.map((i) => i.status)).toEqual(["cancelled"]);

    const notes = await listCreditNotes(db, { invoiceId });
    expect(notes.map((n) => [n.id, n.kind, n.netPaise])).toEqual([[out.creditNoteId, "refund", paid]]);
    expect((await invoiceSettlement(db, invoiceId)).outstandingPaise).toBe(0);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, out.refundApprovalId));
    expect(approval).toMatchObject({ typeKey: "billing_refund", amountPaise: paid, patientId: fx.patient.id });

    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.cancelled"));
    expect(ev?.payload).toMatchObject({
      dispenseId: id, fromStatus: "billed", reservationsReleased: 1,
      creditNoteId: out.creditNoteId, refundApprovalId: out.refundApprovalId,
    });
    // The runbook's promise: scanning the prescription again starts a FRESH dispense.
    const again = await findAtCounter(db, testCfg, fx.pharmacist.actor, qr, MON3);
    expect(again.kind === "dispense" ? [again.dispense.id !== id, again.dispense.status] : again.kind).toEqual([true, "queued"]);
    // Nothing is handed over after it.
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) } }, MON3))
      .rejects.toMatchObject({ code: "dispense_not_in_state" });
  });

  it("is a registered pharmacist's act, on a billed dispense only, with a reason, and writes nothing when refused", async () => {
    const { id, invoiceId } = await billed();
    const input = { reason: "batch expired before the patient came back", reasonClass: "genuine" as const };
    await expect(cancelBilledDispense(db, fx.incharge.actor, fx.decls, id, input, MON3))
      .rejects.toMatchObject({ code: "pharmacist_not_registered" });
    await expect(cancelBilledDispense(db, fx.aide.actor, fx.decls, id, input, MON3))
      .rejects.toMatchObject({ code: "pharmacist_not_registered" });
    await expect(cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, id, { ...input, reason: " x " }, MON3))
      .rejects.toMatchObject({ code: "reason_required" });
    // The billing grants are asserted inside the act, whatever the route checked.
    await db.delete(rolePermissions).where(and(
      eq(rolePermissions.roleKey, "pharmacy"),
      inArray(rolePermissions.permission, ["billing.credit_note.issue", "billing.refund.request"]),
    ));
    await expect(cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, id, input, MON3))
      .rejects.toMatchObject({ code: "permission_denied" });

    expect(await listCreditNotes(db, { invoiceId })).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.typeKey, "billing_refund"))).toHaveLength(0);
    expect(await availableQty(db, fx.storeId, fx.item.azithro, MON3)).toBe(27);
  });

  it("refuses a dispense that is not billed: a picked one is cancelled the ordinary way, a handed-over one is a return", async () => {
    const { issued } = await issueRx(db, fx, [line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await expect(cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { reason: "not billed yet", reasonClass: "mistake" }, MON3))
      .rejects.toMatchObject({ code: "dispense_not_in_state" });
  });
});
