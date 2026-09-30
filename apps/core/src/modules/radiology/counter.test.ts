import { newId } from "@hmis/contracts";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import { imagingSafetyScreenings, imagingStudies, patients, phiAccessLog, services } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { counterView } from "./counter";
import { prepFor } from "./prep";
import { deviceDiary, scheduleStudy } from "./schedule";
import { worklist } from "./read";
import { checkIn } from "./checkin";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18-S RS3 — **THE IMAGING COUNTER'S READ.** One study, everything the desk's four steps need:
 * the gates check-in WILL open (derived by the same `deriveGateSet` check-in runs, and opened by
 * nothing here), what the patient must do before the slot, who pays and whether the scan is
 * authorised (`authorisationOf`, the rule acquisition applies), and the film / CD add-ons ONLY when
 * the tariff actually has them.
 */
describe("the imaging counter read (18-S RS3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
  });
  afterEach(() => { fx.unregister(); });

  it("names the gates check-in WILL open for a woman of 30 on a CT, and opens none of them", async () => {
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "c1", NOW);
    const view = await counterView(db, fx.radiographer, study.studyId, NOW);

    expect(view.checks.gates).toEqual(["identity_two_factor", "pregnancy_screen"]);
    expect(view.checks.pregnancyReason).toBe("opened");
    /** Read-only: the study is still scheduled and no gate row exists (the desk never opens one). */
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.status).toBe("scheduled");
    expect(await db.select().from(imagingSafetyScreenings)).toHaveLength(0);
  });

  it("a man on the same CT opens no pregnancy screen, and the reason says why", async () => {
    await db.update(patients).set({ sex: "male", administrativeGender: "male" }).where(eq(patients.id, fx.patientId));
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "c2", NOW);
    const view = await counterView(db, fx.radiographer, study.studyId, NOW);
    expect(view.checks.gates).toEqual(["identity_two_factor"]);
    expect(view.checks.pregnancyReason).toBe("sex_not_female");
  });

  it("carries the booking, the service, the accession, the study type and the payer the bill step needs", async () => {
    const study = await placeAndCreateStudy(db, fx, "USG-ABDO", "c3", NOW);
    const slot = new Date("2026-08-31T09:00:00.000Z");
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: slot,
    }));
    const view = await counterView(db, fx.radiographer, study.studyId, NOW);
    expect(view).toMatchObject({
      studyId: study.studyId, accessionNo: study.accessionNo, status: "scheduled",
      serviceId: fx.services["USG-ABDO"], studyTypeCode: "USG-ABDO", modality: "usg",
      deviceResourceId: fx.devices.usg, scheduledAt: slot, invoiceLineId: null,
      encounterNo: fx.visitNo, patientId: fx.patientId, patientName: "Asha Devi", uhid: "HMS-00000001-5",
      intendedPayer: "self",
    });
  });

  it("authorisation is the acquisition rule's own answer: self-pay unbilled is null, STAT is `stat`", async () => {
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", "c4", NOW);
    expect((await counterView(db, fx.radiographer, study.studyId, NOW)).authorisation).toBeNull();
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    expect((await counterView(db, fx.radiographer, study.studyId, NOW)).authorisation).toBe("stat");
  });

  it("offers film and CD add-ons ONLY when the tariff carries RAD-FILM / RAD-CD (ruling 1), and never film on an X-ray", async () => {
    const usg = await placeAndCreateStudy(db, fx, "USG-ABDO", "c5", NOW);
    expect((await counterView(db, fx.radiographer, usg.studyId, NOW)).addOns).toEqual([]);

    const cdId = newId();
    const filmId = newId();
    await db.insert(services).values([
      { id: cdId, code: "RAD-CD", name: "Images on CD", category: "investigation", createdBy: "t", updatedBy: "t" },
      { id: filmId, code: "RAD-FILM", name: "Printed film, 1 sheet", category: "investigation", createdBy: "t", updatedBy: "t" },
    ]);
    expect((await counterView(db, fx.radiographer, usg.studyId, NOW)).addOns).toEqual([
      { kind: "film", serviceId: filmId, code: "RAD-FILM", name: "Printed film, 1 sheet" },
      { kind: "cd", serviceId: cdId, code: "RAD-CD", name: "Images on CD" },
    ]);

    const xray = await placeAndCreateStudy(db, fx, "XR-CHEST", "c6", new Date(NOW.getTime() + 25 * 3_600_000));
    expect((await counterView(db, fx.radiographer, xray.studyId, NOW)).addOns.map((a) => a.kind)).toEqual(["cd"]);
  });

  it("records one PHI access row for the patient it discloses", async () => {
    const study = await placeAndCreateStudy(db, fx, "USG-ABDO", "c7", NOW);
    await counterView(db, fx.radiographer, study.studyId, NOW);
    const rows = await db.select().from(phiAccessLog).where(eq(phiAccessLog.patientId, fx.patientId));
    expect(rows.map((r) => r.surface)).toEqual(["imaging.worklist"]);
  });

  it("an unknown study is `unknown_study`", async () => {
    await expect(counterView(db, fx.radiographer, "01NOSUCHSTUDY0000000000000", NOW))
      .rejects.toMatchObject({ code: "unknown_study" });
  });

  /**
   * The desk's two other reads, widened for RS3: the diary grid draws a block per booking (its
   * length, what it is and whose it is), and "Clocks running" needs when an order arrived and when
   * a patient was checked in.
   */
  it("the device diary carries each booking's length, study type, priority and patient name", async () => {
    const study = await placeAndCreateStudy(db, fx, "USG-ABDO", "c8", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: new Date("2026-08-31T09:00:00.000Z"),
    }));
    expect(await deviceDiary(db, fx.radiographer, fx.devices.usg!)).toEqual([expect.objectContaining({
      studyId: study.studyId, durationMin: 20, studyTypeCode: "USG-ABDO", priority: "routine", patientName: "Asha Devi",
    })]);
  });

  it("the worklist carries createdAt and checkedInAt, the two instants the desk's clocks run from", async () => {
    const study = await placeAndCreateStudy(db, fx, "USG-ABDO", "c9", NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: new Date("2026-08-31T09:00:00.000Z"),
    }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: ["radiology.worklist.read"], subscriptions: [] });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "radiographer", "radiology.worklist.read");
    const [row] = await worklist(db, fx.radiographer, { view: "floor" });
    expect(row!.checkedInAt).toEqual(NOW);
    expect(row!.createdAt).toBeInstanceOf(Date);
  });
});

/** The prep the patient is told — derived from the study type, the ONE place it is derived. */
describe("prepFor (18-S RS3)", () => {
  const base = { code: "X", service_id: "s" };
  it("contrast required → nil by mouth 4 h and a creatinine report", () => {
    expect(prepFor(studyTypeRow({ ...base, modality: "ct", contrast_option: "required" })))
      .toEqual(["nil_by_mouth_4h", "creatinine_report"]);
  });
  it("optional contrast asks for nothing yet — the console decides (checkin.ts)", () => {
    expect(prepFor(studyTypeRow({ ...base, modality: "ct", contrast_option: "optional" }))).toEqual([]);
  });
  it("an abdominal ultrasound → fasting 6 h; a KUB or pelvic one → a full bladder", () => {
    expect(prepFor(studyTypeRow({ ...base, code: "USG-ABDO", modality: "usg", body_part: "abdomen" }))).toEqual(["fasting_6h"]);
    expect(prepFor(studyTypeRow({ ...base, code: "USG-KUB", modality: "usg", body_part: "abdomen" }))).toEqual(["full_bladder"]);
    expect(prepFor(studyTypeRow({ ...base, code: "USG-PELVIS", modality: "usg", body_part: "pelvis" }))).toEqual(["full_bladder"]);
    expect(prepFor(studyTypeRow({ ...base, code: "USG-THYROID", modality: "usg", body_part: "neck" }))).toEqual([]);
  });
  it("MRI → the metal and implants question; a PCPNDT study → ID proof and the referral slip", () => {
    expect(prepFor(studyTypeRow({ ...base, modality: "mri", body_part: "head" }))).toEqual(["metal_and_implants"]);
    expect(prepFor(studyTypeRow({ ...base, code: "USG-OBS-EARLY", modality: "usg", body_part: "obstetric", pcpndt_applicable: true })))
      .toEqual(["full_bladder", "id_and_referral"]);
  });
});
