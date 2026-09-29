import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantOwnerCredit } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { invoices, pharmacyDispenses } from "../../kernel/db/schema";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * GAP CLOSURE A3b — owner ruling 2026-09-28: "nobody can issue credit except owner", whole hospital.
 *
 * The pharmacy's rule is money before the drug. The one way medicine leaves unpaid is a bill billing
 * issued on the OWNER's granted `billing_credit_owner` approval for that exact amount on this dispense:
 * without the grant the bill is refused; with it, the bill carries the credit and the hand-over accepts it.
 */
describe("pharmacy credit, only on the owner's yes (A3b)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const at = (m: number): Date => new Date(MON2.getTime() + m * 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    // A3b's grant: the pharmacist may ASK the owner (seed-roles gives `pharmacy` this string).
    await grantPermissionToRole(db, fx.registry, "pharmacy", "billing.credit.extend");
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", mrpPaise: 12_000, qtyBase: 200 });
  });
  afterEach(() => { fx.unregister(); });

  async function picked(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "TDS", durationDays: 5 })]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    const id = found.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, at(1));
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, at(2));
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(3));
    return id;
  }

  it("no tender and no owner grant: the bill is refused; nothing is billed", async () => {
    const id = await picked();
    await expect(billDispense(db, fx.pharmacist.actor, id, { tenders: [], credit: { reason: "pays Friday", approvalId: "01JNOSUCHAPPROVAL0000000000" } }, at(4)))
      .rejects.toMatchObject({ code: "approval_not_granted" });
    await expect(billDispense(db, fx.pharmacist.actor, id, { tenders: [] }, at(4)))
      .rejects.toMatchObject({ code: "unsettled_issue_refused" });
    const [d] = await db.select({ status: pharmacyDispenses.status }).from(pharmacyDispenses).where(eq(pharmacyDispenses.id, id));
    expect(d!.status).toBe("picked");
  });

  it("the owner grants the exact bill: it is billed on credit with no tender, and the medicine is handed over unpaid", async () => {
    const id = await picked();
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, at(4));
    const amount = preview.totals.netPayablePaise;
    // A grant for a different amount does not cover this bill.
    const wrong = await grantOwnerCredit(db, fx.pharmacist.actor, fx.base.owner, { draftId: id, patientId: fx.patient.id, amountPaise: amount - 100 });
    await expect(billDispense(db, fx.pharmacist.actor, id, { tenders: [], credit: { reason: "pays Friday", approvalId: wrong } }, at(4)))
      .rejects.toMatchObject({ code: "approval_subject_mismatch" });

    const approvalId = await grantOwnerCredit(db, fx.pharmacist.actor, fx.base.owner, { draftId: id, patientId: fx.patient.id, amountPaise: amount });
    const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [], credit: { reason: "pays Friday", approvalId } }, at(4));
    expect(billed.status).toBe("billed");
    const [inv] = await db.select({ creditExtended: invoices.creditExtended, creditApprovalId: invoices.creditApprovalId }).from(invoices).where(eq(invoices.id, billed.invoiceId!));
    expect(inv).toEqual({ creditExtended: true, creditApprovalId: approvalId });

    const handed = await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: "3210" } }, at(5));
    expect(handed.status).toBe("handed_over");
  });
});
