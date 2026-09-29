import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture } from "../../../test/helpers/radiology";
import { imagingStudies } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { AerbError } from "../aerb";
import { RadiologyError } from "./errors";
import { setImagingDeviceStatus } from "./machines";
import { autoSlotWalkIn, rescheduleStudy, scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS4 T2 — **the refusals move to the counter.** Until RS4 a CT with no AERB licence was
 * refused at the console, after the patient had been booked, billed and prepped; and a machine set
 * down at Setup had to be refused by the diary. Both are now refused at BOOKING (and re-booking),
 * naming the machine the way the counter knows it — never a ULID — and the person who fixes it.
 */
describe("booking-time refusals (18-S RS4 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date(`${DAY}T06:00:00.000Z`);
  const SLOT = new Date(`${DAY}T09:00:00.000Z`);
  const LATER = new Date(`${DAY}T10:00:00.000Z`);
  const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  afterEach(() => { fx.unregister(); });

  const refusal = async (p: Promise<unknown>): Promise<AerbError | RadiologyError> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof AerbError || e instanceof RadiologyError) return e;
      throw e;
    }
    throw new Error("expected a refusal, the booking succeeded");
  };

  describe("an ionising machine with no AERB licence", () => {
    beforeEach(async () => {
      await truncateAll(db);
      fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW, unlicensedModalities: ["ct"] });
    });

    it("refuses the booking device_not_licensed, naming the machine and the RSO, and books nothing", async () => {
      const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "k1", NOW);
      const e = await refusal(withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
        studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: SLOT,
      })));
      expect(e.code).toBe("device_not_licensed");
      expect(e.message).toContain("DEV-CT (ct machine)");
      expect(e.message).toMatch(/radiation safety officer/i);
      expect(e.message).not.toMatch(ULID);
      const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
      expect(row!.deviceResourceId).toBeNull();
    });

    it("a walk-in passes the unlicensed machine over and answers with the licence refusal", async () => {
      const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "k5", NOW);
      const e = await refusal(withTx(db, (tx) => autoSlotWalkIn(tx, fx.radiographer, { studyId: study.studyId, now: SLOT })));
      expect(e.code).toBe("device_not_licensed");
      const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
      expect(row!.deviceResourceId).toBeNull();
    });

    it("a non-ionising machine books without any licence", async () => {
      const study = await placeAndCreateStudy(db, fx, "MRI-BRAIN", "k2", NOW);
      await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
        studyId: study.studyId, deviceResourceId: fx.devices.mri!, scheduledAt: SLOT,
      }));
    });
  });

  describe("a licensed machine", () => {
    beforeEach(async () => {
      await truncateAll(db);
      fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    });

    it("books; and a re-booking onto a machine set down at Setup is refused device_unavailable", async () => {
      const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "k3", NOW);
      await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
        studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: SLOT,
      }));
      await withTx(db, (tx) => setImagingDeviceStatus(tx, fx.radiologist, fx.devices.ct!, { status: "maintenance", reason: "planned service" }));
      const e = await refusal(withTx(db, (tx) => rescheduleStudy(tx, fx.radiographer, {
        studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: LATER, reason: "patient asked",
      })));
      expect(e.code).toBe("device_unavailable");
      expect(e.message).toContain("DEV-CT (ct machine) is maintenance");
    });
  });

  describe("a licence lapsed after booking", () => {
    beforeEach(async () => {
      await truncateAll(db);
      fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW, unlicensedModalities: ["xray"] });
    });

    it("re-booking an X-ray onto its unlicensed machine is refused at the counter too", async () => {
      const study = await placeAndCreateStudy(db, fx, "XR-CHEST", "k4", NOW);
      // booked on the X-ray before this phase (the rule is new): write the booking directly
      await db.update(imagingStudies).set({ deviceResourceId: fx.devices.xray!, scheduledAt: SLOT })
        .where(eq(imagingStudies.id, study.studyId));
      const e = await refusal(withTx(db, (tx) => rescheduleStudy(tx, fx.radiographer, {
        studyId: study.studyId, deviceResourceId: fx.devices.xray!, scheduledAt: LATER, reason: "patient asked",
      })));
      expect(e.code).toBe("device_not_licensed");
    });
  });
});
