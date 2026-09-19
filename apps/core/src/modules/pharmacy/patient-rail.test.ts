import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, MON2, issueRx, line, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { claimDispense, findAtCounter } from "./claim";
import { patientRail } from "./patient-rail";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * THE LEFT RAIL IS WHO IS AT THE WINDOW (the approved board): age and sex, the last visits, and what
 * the patient is ALREADY TAKING. A pharmacist handing over a fifth medicine must see the other four.
 * The shipped rail had a name, a UHID and one allergy pill.
 */
describe("the patient rail", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  it("carries the age and sex, the EARLIER visits, and the courses still running — never this ticket's own lines", async () => {
    /* A month ago: a long course (Glycomet, 30 days) and a short one (Azee, 3 days). */
    const earlier = new Date(MON.getTime() - 20 * 24 * 60 * 60_000);
    await issueRx(db, fx, [
      line({ drug: "Brufen 400", medicineId: fx.med.ibuprofen, frequency: "1-0-1", durationDays: 30 }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
    ], { at: earlier });

    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);

    const rail = await patientRail(db, fx.pharmacist.actor, found.dispense.id, MON2);
    expect(rail).toMatchObject({ ageYears: 30, sex: "female" });
    // the earlier visit is on the rail; the visit this ticket belongs to is not
    expect(rail.visits).toHaveLength(1);
    expect(rail.visits[0]).toMatchObject({ prescriptionLineCount: 2, departmentName: expect.any(String) });
    // the 30-day course is still running 20 days on; the 3-day one finished; this ticket's own line is not "already taking"
    expect(rail.alreadyTaking.map((m) => m.drug)).toEqual(["Brufen 400"]);
    expect(rail.alreadyTaking[0]).toMatchObject({ sig: "1-0-1 × 30d" });
  });
});
