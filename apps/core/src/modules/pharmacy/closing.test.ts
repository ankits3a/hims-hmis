import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { closingFor } from "./closing";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * WHAT CLOSED — the board's three boxes. The done screen is the last moment a pharmacist can catch a
 * wrong batch or a register row that was never written, and it showed a name, a number and a total.
 * Every figure here is read back off the rows the acts wrote.
 */
describe("the closing of a ticket", () => {
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

  const at = (m: number) => new Date(MON2.getTime() + m * 60_000);

  it("names the ticket, the money as the invoice and receipt record it, and the registers the dispense wrote", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", mrpPaise: 12_000, qtyBase: 100 });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", mrpPaise: 15_000, qtyBase: 100 }); // Azee 500 is Schedule H1
    const { issued } = await issueRx(db, fx, [
      line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "1-0-1", durationDays: 5 }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
    ]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    const id = found.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, at(1));
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 3 }] }, at(2));
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at(3));
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, at(4));
    await billDispense(db, fx.pharmacist.actor, id, {
      tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise + 5_000 }], changeGivenPaise: 5_000,
    }, at(4));
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "phone_last4", value: "3210" } }, at(5));

    const closed = await closingFor(db, fx.pharmacist.actor, id);
    expect(closed.ticket).toMatchObject({ lines: 2, substituted: 0, declined: 0, claimedByName: "ph.mehta", handedOverAt: at(5) });
    expect(closed.ticket.dispenseNo).toMatch(/^P\d{6}\d+$/);
    expect(closed.money).toMatchObject({
      netPayablePaise: preview.totals.netPayablePaise, changeGivenPaise: 5_000,
      tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise + 5_000 }],
    });
    expect(closed.money!.invoiceNo).not.toBe("");
    expect(closed.money!.receiptNo).not.toBeNull();
    // the H1 register row the Act requires for Azee, and the two batches that left the shelf
    expect(closed.registers).toEqual({ h1Rows: 1, batches: 2 });
  });

  it("refuses to speak before anything has closed", async () => {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    await expect(closingFor(db, fx.pharmacist.actor, found.dispense.id))
      .rejects.toThrow(expect.objectContaining({ code: "dispense_not_in_state" }));
  });
});
