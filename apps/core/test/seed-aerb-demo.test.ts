import { setupTestDb, truncateAll } from "./helpers/db";
import { setupRadiologyFixture } from "./helpers/radiology";
import { licenceRegister, unlicensedDevices } from "../src/modules/aerb";
import { seedAerbDemo } from "../scripts/seed-aerb-demo";
import type { Db } from "../src/kernel/db/client";

/**
 * PHASE 11i T5 — `seed:aerb-demo`, the four DEMO certificates behind the synthetic-data door.
 *
 * It exists for ONE rehearsal: 18c's licence gate is the single behaviour-changing step in the
 * catch-up deploy, and the act radiology performs in the declared window is filing certificates
 * until `GET /aerb/licences/gaps` is EMPTY. Watching the refusal proves a guard exists; watching
 * the gaps list empty proves the window can be closed.
 *
 * The assertions that matter are therefore: the gaps go to zero, and **every number it writes says
 * DEMO** — because an AERB register is a statutory document an inspector reads, and a synthetic row
 * in it without that mark is a false statement to a regulator.
 */
const SERVICE_DATE = "2026-09-06";

describe("seed:aerb-demo (11i T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("closes the gaps list, and every certificate it writes carries DEMO", async () => {
    // `unlicensedModalities` leaves the X-ray and CT machines DARK — the state production is in
    // the moment 0060–0065 land, and the state the window exists to close.
    await setupRadiologyFixture(db, {
      serviceDate: SERVICE_DATE, now: new Date(`${SERVICE_DATE}T04:00:00Z`),
      unlicensedModalities: ["xray", "ct"],
    });
    const before = await unlicensedDevices(db, SERVICE_DATE);
    expect(before.length).toBeGreaterThan(0); // non-vacuous: there is something to close

    const report = await seedAerbDemo(db);

    expect(report.gapsBefore).toBe(before.length);
    expect(report.gapsAfter).toBe(0);
    expect(report.filed).toHaveLength(before.length);
    expect(report.appointed).toContain("rso");
    for (const licenceNo of report.filed) expect(licenceNo).toContain("DEMO");

    // read back out of the REGISTER, not out of the report the script returned
    const register = await licenceRegister(db, {});
    expect(register.length).toBeGreaterThanOrEqual(before.length);
    const written = register.filter((r) => report.filed.includes(r.licenceNo));
    expect(written).toHaveLength(before.length);
    for (const row of written) {
      expect(row.licenceNo).toContain("DEMO");
      expect(row.eloraRef ?? "").toContain("DEMO");
      expect(row.remarks ?? "").toContain("never a real filing");
    }
    expect(await unlicensedDevices(db, SERVICE_DATE)).toEqual([]);
  });

  it("files NOTHING for a machine no regulator licenses, even when asked twice", async () => {
    await setupRadiologyFixture(db, {
      serviceDate: SERVICE_DATE, now: new Date(`${SERVICE_DATE}T04:00:00Z`),
      unlicensedModalities: ["xray", "ct"],
    });
    const first = await seedAerbDemo(db);
    // USG and MRI emit nothing ionising; a certificate for one would be an invented filing.
    const register = await licenceRegister(db, {});
    const modalities = new Set(register.map((r) => r.modality?.toLowerCase() ?? ""));
    expect(modalities.has("usg")).toBe(false);
    expect(modalities.has("mri")).toBe(false);
    expect(first.gapsAfter).toBe(0);

    // A second run has no gaps to close, so it files nothing — and does not throw on the overlap
    // guard, which is what a blind re-file would hit.
    const second = await seedAerbDemo(db);
    expect(second.filed).toEqual([]);
    expect(second.gapsAfter).toBe(0);
    // and it appoints nobody a second time — `aerb_persons_user_role_active_ux` refuses a second
    // ACTIVE appointment of one person to one role, which is how this was found.
    expect(second.appointed).toEqual([]);
    expect(second.alreadyAppointed).toContain("rso");
  });

  it("REFUSES when nobody on the database may write the register", async () => {
    // No fixture: no users, no permissions. The RSO is a person, and a script that invented one
    // would be putting a writer with no control behind a statutory register.
    await expect(seedAerbDemo(db)).rejects.toThrow(/aerb\.registers\.manage/);
  });
});
