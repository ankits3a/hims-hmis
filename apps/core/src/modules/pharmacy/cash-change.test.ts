import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { receipts } from "../../kernel/db/schema";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * CASH WITH CHANGE — the seam between the desk and billing, pinned where billing decides it.
 *
 * Walked on the demo preview 2026-09-20: a ₹103 bill paid with a ₹200 note was REFUSED
 * (`change_exceeds_surplus`). The desk sent the BILL as the cash tendered and ₹97 as change; billing
 * reads a cash tender as the money HANDED OVER and lets change come only out of the surplus above the
 * bill (`invoices.ts`, RC-1 M4). Both ends had green suites — the desk's pinned its own shape and its
 * render tests mock the server. This is the contract the desk's `tendersFor` must meet.
 */
describe("a cash bill paid with a bigger note", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-12-31", qtyBase: 100 });
  });
  afterEach(() => { fx.unregister(); });

  const at = (m: number) => new Date(MON2.getTime() + m * 60_000);

  async function pickedTicket(): Promise<{ id: string; payable: number }> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, at(0));
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    const id = found.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, at(1));
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, at(2));
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(3));
    return { id, payable: (await previewDispenseBill(db, fx.pharmacist.actor, id, at(4))).totals.netPayablePaise };
  }

  it("the tender is the note handed over, the change comes out of it, and the receipt records both", async () => {
    const { id, payable } = await pickedTicket();
    const note = 50_000; // a ₹500 note
    expect(note).toBeGreaterThan(payable);
    const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: note }], changeGivenPaise: note - payable }, at(4));
    expect(billed.status).toBe("billed");
    const [r] = await db.select({ changeGivenPaise: receipts.changeGivenPaise }).from(receipts).where(eq(receipts.patientId, fx.patient.id));
    expect(r!.changeGivenPaise).toBe(note - payable);
  });

  it("the shape the desk used to send — the bill as the tender, and change on top — is refused", async () => {
    const { id, payable } = await pickedTicket();
    await expect(billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: payable }], changeGivenPaise: 9_700 }, at(4)))
      .rejects.toThrow(expect.objectContaining({ code: "change_exceeds_surplus" }));
  });
});
