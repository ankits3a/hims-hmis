import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { claimDispense, findAtCounter } from "./claim";
import { myRegistration } from "./pharmacists";
import { getDispense } from "./queue";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * THE PHARMACY DESK BOARD'S TWO READS — what the doctor's column and the header need that the view
 * did not carry: the SALT under the brand the doctor wrote, and the acting pharmacist's own
 * registration (the header's "registered · PCI <no>"). Both are additive; nothing is gated by them.
 */
describe("the desk board's reads", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  it("a line carries the salt of the medicine the doctor wrote, under its brand", async () => {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("expected a dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    const view = await getDispense(db, fx.pharmacist.actor, r.dispense.id, MON2);
    expect(view.lines[0]!.salt).toBe("Paracetamol");
  });

  it("the pharmacist at the desk reads their own registration; a login without one reads null", async () => {
    expect(await myRegistration(db, fx.pharmacist.actor, MON2)).toMatchObject({ registrationNo: "MSPC-123456" });
    expect(await myRegistration(db, fx.incharge.actor, MON2)).toBeNull();
    expect(await myRegistration(db, { type: "system", id: "sweep" } as never, MON2)).toBeNull();
  });
});
