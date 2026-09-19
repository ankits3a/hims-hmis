import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { newId } from "@hmis/contracts";
import { stockBatches } from "../../kernel/db/schema";
import { claimDispense, findAtCounter } from "./claim";
import { writtenQuoteFor } from "./quote";
import { checkedAlternativesFor } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * THE CO-PILOT NAMES ITS OFFER IN RUPEES (owner, 2026-09-20: "the demo seems pathetic … it does not even
 * work the way I approved"). The approved Desk board's agent says *"Pan 40 is out. Pantop 40 is the same
 * salt, strength, form and route — 240 on the shelf, saves ₹6.50 a strip, and I have run it against his
 * allergy and his current medicines — clean."* Every figure in that sentence must be the server's:
 * each equivalent carries a QUOTE from its first-to-expire sellable batch, priced by the bill's own
 * `priceBatchLine`, and the line as written carries its own — the last printed MRP when the shelf is
 * empty — so the saving is a subtraction of two server numbers, never a guess on the screen.
 */
describe("the co-pilot's offer carries the bill's own prices", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  async function claimedCrocin(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("expected a dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    return r.dispense.id;
  }

  it("each equivalent is quoted from its first-to-expire batch, per tablet and per strip", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CAL-LATE", expiryDate: "2028-03-31", mrpPaise: 9_500, qtyBase: 50 });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CAL-SOON", expiryDate: "2027-09-30", mrpPaise: 9_000, qtyBase: 40 });
    const id = await claimedCrocin();
    const [calpol] = await checkedAlternativesFor(db, fx.pharmacist.actor, id, 0, MON2);
    expect(calpol).toMatchObject({
      brandName: "Calpol 500", available: 90,
      quote: { batchNo: "CAL-SOON", expiryDate: "2027-09-30", unitPaise: 900, pack: { uom: "strip", multiplier: 10, paise: 9_000 } },
    });
  });

  it("the line as written is quoted too — from the shelf, or from its last printed MRP when the shelf is empty", async () => {
    const id = await claimedCrocin();
    // nothing of Crocin anywhere: no price to speak of
    expect(await writtenQuoteFor(db, id, 0, MON2)).toBeNull();
    // a batch that was received and has all gone: its printed MRP is still the last price the patient saw
    await db.insert(stockBatches).values({
      id: newId(), itemId: fx.item.crocin, batchNo: "CR-GONE", expiryDate: "2027-06-30", mrpPaise: 12_000, mrpUom: "strip",
      landedCostPaise: 500, ownership: "owned", createdBy: "01HMATERIALSHEAD00000000001",
    });
    expect(await writtenQuoteFor(db, id, 0, MON2)).toMatchObject({ lastKnown: true, batchNo: "CR-GONE", unitPaise: 1_200, pack: { uom: "strip", paise: 12_000 } });
    // stock on the shelf is the current price, not the last one
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-NOW", mrpPaise: 12_500, qtyBase: 5 });
    expect(await writtenQuoteFor(db, id, 0, MON2)).toMatchObject({ lastKnown: false, batchNo: "CR-NOW", unitPaise: 1_250 });
  });
});
