import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkPatient, mkUser, seedOpdBase } from "../../../test/helpers/opd";
import { signedCreatinine } from "../../../test/helpers/lab-creatinine";
import { ckdEpi2021, latestEgfr } from "./index";
import type { Db } from "../../kernel/db/client";

/**
 * #621 — THE LATEST eGFR, FROM THE LAB'S OWN SIGNED CREATININE. CKD-EPI 2021 (moved here from
 * radiology, which now reads it from the lab), on the patient master's sex and the age ON THE DAY
 * THE SAMPLE WAS DRAWN. The caller decides what is recent; this says how old it is.
 */
describe("#621 latestEgfr — the lab's latest signed creatinine as an eGFR", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const NOW = new Date("2030-03-01T06:00:00.000Z");
  const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
  const DOB_60 = new Date(Date.UTC(1970, 0, 15)); // 60 in early 2030

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); await seedOpdBase(db); });

  const patient = async (over: { sex?: "female" | "male" | "other"; dob?: Date; minor?: boolean }) => {
    const clerk = await mkUser(db, `clerk${String(Math.random()).slice(2, 8)}`, ["front_office"]);
    return mkPatient(db, clerk.actor, {
      sex: over.sex ?? "female", ageYears: undefined, dob: over.dob ?? DOB_60,
      ...(over.minor === true ? { guardian: { name: "Sunita", relationship: "mother" as const } } : {}),
    });
  };

  it("computes CKD-EPI 2021 from the LATEST signed creatinine, and says how old the sample is", async () => {
    const p = await patient({});
    await signedCreatinine(db, p.id, "0.9", daysAgo(200));
    await signedCreatinine(db, p.id, "2.0", daysAgo(10));
    await signedCreatinine(db, p.id, "0.6", daysAgo(1), "unverified"); // unsigned: not a result yet
    const got = await latestEgfr(db, p.id, NOW);
    expect(got).toMatchObject({ computed: true, egfr: Math.round(ckdEpi2021(2.0, 60, "female")), ageDays: 10 });
    expect(got!.sampledAt.toISOString()).toBe(daysAgo(10).toISOString());
  });

  it("says why when no eGFR can be computed, and nothing when there is no creatinine at all", async () => {
    const child = await patient({ dob: new Date(Date.UTC(2020, 0, 1)), minor: true });
    await signedCreatinine(db, child.id, "0.4", daysAgo(3));
    expect(await latestEgfr(db, child.id, NOW)).toMatchObject({ computed: false, reason: "under_18", ageDays: 3 });

    const other = await patient({ sex: "other" });
    await signedCreatinine(db, other.id, "1.0", daysAgo(3));
    expect(await latestEgfr(db, other.id, NOW)).toMatchObject({ computed: false, reason: "sex_not_binary" });

    const none = await patient({});
    expect(await latestEgfr(db, none.id, NOW)).toBeNull();
  });
});
