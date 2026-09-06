import { readFileSync } from "node:fs";
import { newId } from "@hmis/contracts";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  placeAndCreateStudy, setupRadiologyFixture, startStudyOnMachine, studyTypeRow,
} from "../../../test/helpers/radiology";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { ModuleRegistry } from "../../kernel/modules/loader";
import {
  doseRegister, events, imagingDefinitions, imagingOutsideStudies, imagingStudies, orderItems,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { scheduleStudy } from "./schedule";
import { registerOutsideStudy } from "./outside";
import { studyView } from "./read";
import { draftReport, proposeDraft, publishReport, signReport } from "./reports";
import { recordAcquired } from "./acquisition";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a-iii T4 — **the outside-study register (D5/D6), and the dose we must not log.**
 *
 * ═══ THE TEST THAT MATTERS IS THE NEGATIVE ONE ═══
 *
 * Before this task the only route to a reportable study was `recordAcquired`, and it accepted
 * `imageSource: "outside"`. For an ionising study type it then demanded a dose and wrote a
 * `radiation_dose_register` row naming OUR device — so a CT performed at another hospital and
 * reported by us would have entered that hospital's exposure into the statutory register an AERB
 * inspector reads. Nobody writes *"do not log another hospital's dose"* into a phase doc, exactly as
 * nobody wrote *"do not inject an expired vial"*, which is why the assertion is here rather than in
 * a contract pass.
 */
describe("the outside-study register (18a-iii T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    await db.update(imagingDefinitions).set({
      body: {
        types: [
          studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
          studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", ionising: true }),
          studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true }),
          studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
        ] satisfies StudyType[],
      },
    }).where(eq(imagingDefinitions.kind, "study_types"));

    const registry = new ModuleRegistry();
    registry.install({
      key: "radiology", title: "Rad", menu: [],
      permissions: ["radiology.worklist.read", "radiology.reports.write"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    for (const p of ["radiology.worklist.read", "radiology.reports.write"]) {
      await grantPermissionToRole(db, registry, "radiologist", p);
    }
  });
  afterEach(() => { fx.unregister(); });

  const placed = async (code = "CT-HEAD") => {
    seq += 1;
    return placeAndCreateStudy(db, fx, code, `o${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
  };
  const register = (studyId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => registerOutsideStudy(tx, fx.radiologist, fx.decls, {
      studyId, centreName: "Sunrise Diagnostics, Kanpur", studyDate: "2026-02-14",
      modality: "ct", arrival: "cd", now: NOW, ...over,
    }));
  const row = async (studyId: string) =>
    (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;
  const outsideRows = () => db.select().from(imagingOutsideStudies);

  /* ══════════════════ THE ONE THAT MATTERS ══════════════════ */

  /**
   * An IONISING study type, deliberately: `CT-HEAD` is the case that would have written the register
   * row. A non-ionising fixture would pass against the defect.
   */
  it("an outside CT writes NO row into the radiation dose register", async () => {
    const study = await placed("CT-HEAD");
    await register(study.studyId);

    expect(await db.select().from(doseRegister)).toHaveLength(0);
    expect((await row(study.studyId)).status).toBe("acquired");
  });

  /**
   * ═══ AND THE DOOR THAT COULD HAVE WRITTEN IT IS CLOSED ═══
   *
   * The refusal names the other door rather than the field, because the technologist is not early or
   * late — they are at the wrong counter.
   */
  it("the acquisition console refuses `outside` outright and names the register", async () => {
    const study = await startStudyOnMachine(db, fx, {
      serviceCode: "USG-ABDO", deviceKey: "usg", idemKey: "x1", now: NOW,
      slot: new Date(NOW.getTime() + 3 * 3_600_000),
    });
    await expect(withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, imageSource: "outside", now: NOW,
    }))).rejects.toMatchObject({ code: "outside_study_only" });

    /** And the study is untouched — the refusal is before every write, not after some of them. */
    expect((await row(study.studyId)).status).toBe("in_acquisition");
    expect(await db.select().from(doseRegister)).toHaveLength(0);
  });

  /* ══════════════════ THE RECORD ITSELF ══════════════════ */

  it("records the centre, THEIR date, and how the images arrived", async () => {
    const study = await placed();
    await register(study.studyId, { externalAccessionNo: "SD/CT/8891", notes: "two prior films on the CD" });

    const view = await studyView(db, fx.radiologist, study.studyId);
    expect(view?.outside).toEqual({
      centreName: "Sunrise Diagnostics, Kanpur", studyDate: "2026-02-14", modality: "ct",
      externalAccessionNo: "SD/CT/8891", arrival: "cd",
    });
    expect(view?.imageSource).toBe("outside");
  });

  /**
   * `acquired_at` is when the film reached US; `study_date` is when the other centre took it. They
   * are frequently years apart, and a design that stored one in the other's column would make every
   * turnaround-time report read as though we had sat on the case for two years.
   */
  it("distinguishes when THEY performed it from when it reached us", async () => {
    const study = await placed();
    await register(study.studyId, { studyDate: "2019-07-02" });
    expect((await row(study.studyId)).acquiredAt?.toISOString()).toBe(NOW.toISOString());
    const view = await studyView(db, fx.radiologist, study.studyId);
    expect(view?.outside?.studyDate).toBe("2019-07-02");
  });

  it("emits imaging.outside_study_registered carrying the centre", async () => {
    const study = await placed();
    const { outsideStudyId } = await register(study.studyId);
    const emitted = (await db.select().from(events))
      .filter((e) => e.name === "imaging.outside_study_registered");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      studyId: study.studyId, outsideStudyId, centreName: "Sunrise Diagnostics, Kanpur",
      studyDate: "2026-02-14", modality: "ct", arrival: "cd",
    });
  });

  /* ══════════════════ THE REPORT SAYS SO (D5) ══════════════════ */

  it("the drafted report's TECHNIQUE says it is not ours, and states no dose of ours", async () => {
    const study = await placed();
    await register(study.studyId, { arrival: "film" });

    const draft = await withTx(db, (tx) => proposeDraft(tx, fx.radiologist, {
      studyId: study.studyId, now: NOW,
    }));
    expect(draft.body.technique).toContain("OUTSIDE STUDY, performed at Sunrise Diagnostics, Kanpur");
    expect(draft.body.technique).toContain("on 2026-02-14");
    expect(draft.body.technique).toContain("reported here from film");
    /** We did not irradiate this patient; there is no dose of ours to print under our letterhead. */
    expect(draft.body.technique).not.toMatch(/CTDIvol|DLP|Dose:/);
  });

  /* ══════════════════ THE ORDER ENVELOPE REACHES ITS END ══════════════════ */

  /**
   * ═══ THE DEFECT THIS TEST WAS WRITTEN FOR, AND IT WAS FOUND BY READING ═══
   *
   * `placed → completed` is not a legal item transition; the arc is `placed → in_progress →
   * completed`. The ordinary path advances to `in_progress` inside `startAcquisition`, which this
   * door skips entirely — so without `advanceOrderItem` in `registerOutsideStudy` the item would sit
   * at `placed`, and `publishReport` would throw **at the last step, in front of the radiologist, on
   * a study that had already consumed a reporting slot.** Everything before that worked: register,
   * draft, sign. Only publish failed.
   *
   * No test of mine covered it, because the earlier report test stopped at the draft. The whole
   * lifecycle is the only fixture that could have caught it.
   */
  it("an outside study can be drafted, signed AND PUBLISHED — the envelope completes", async () => {
    const study = await placed();
    await register(study.studyId);

    const { reportId } = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: study.studyId,
      body: { findings: "No acute intracranial abnormality.", technique: "Outside CT, reviewed." },
      impression: "Normal study.",
    }));
    await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: study.studyId, reportId, secondFactorAt: NOW, now: NOW,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, {
      studyId: study.studyId, now: NOW,
    }));

    expect((await row(study.studyId)).status).toBe("published");
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("completed");
    /** And still no dose, at the end of the whole lifecycle rather than only at registration. */
    expect(await db.select().from(doseRegister)).toHaveLength(0);
  });

  it("registration moves the referring doctor's order to in_progress — the department has it", async () => {
    const study = await placed();
    await register(study.studyId);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("in_progress");
  });

  /* ══════════════════ THE DOOR IS NOT A WAY PAST ACQUISITION ══════════════════ */

  it("refuses a study that has been booked onto one of our machines", async () => {
    const study = await placed();
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.ct!,
      scheduledAt: new Date(NOW.getTime() + 3 * 3_600_000),
    }));
    await expect(register(study.studyId)).rejects.toMatchObject({ code: "bad_transition" });
    expect(await outsideRows()).toHaveLength(0);
  });

  /**
   * ═══ THE DEVICE ARM ALONE, AND WHY IT NEEDS A DIRECT COLUMN WRITE ═══
   *
   * The test above cannot distinguish the two guards: `scheduleStudy` sets `device_resource_id` AND
   * `scheduled_at` together — measured, and it is the only writer of that column along with
   * `rescheduleStudy`, which does the same. So the SLOT guard alone refuses that fixture, and a
   * mutant deleting the DEVICE guard survived it. The mutation had a real effect; the fixture
   * triggered a neighbouring guard that hid it.
   *
   * The state is therefore not reachable through any service today, and the guard is defence against
   * a path that does not exist yet — an "assign a machine without booking a slot" feature is an
   * entirely ordinary thing for a later phase to add. Keeping an unreachable guard is cheap;
   * discovering later that the outside-study door accepted a study holding a gantry is not. So the
   * column is written directly, which is the only instrument that can see this arm at all.
   */
  it("refuses a study holding one of our machines even with no slot on the diary", async () => {
    const study = await placed();
    await db.update(imagingStudies)
      .set({ deviceResourceId: fx.devices.ct! })
      .where(eq(imagingStudies.id, study.studyId));
    const before = await row(study.studyId);
    expect([before.deviceResourceId, before.scheduledAt]).toEqual([fx.devices.ct!, null]);

    await expect(register(study.studyId)).rejects.toMatchObject({ code: "bad_transition" });
    expect(await outsideRows()).toHaveLength(0);
  });

  it("refuses a film dated in the future, and writes nothing", async () => {
    const study = await placed();
    await expect(register(study.studyId, { studyDate: "2027-01-01" }))
      .rejects.toMatchObject({ code: "invalid_date" });
    expect(await outsideRows()).toHaveLength(0);
    expect((await row(study.studyId)).status).toBe("scheduled");
  });

  it("accepts a film years old — the comparison study is why this register is worth keeping", async () => {
    const study = await placed();
    await expect(register(study.studyId, { studyDate: "2019-07-02" })).resolves.toBeDefined();
  });

  /**
   * A CT film registered against an ultrasound referral would be reported under the wrong template,
   * priced under the wrong service, and would read as an ultrasound in every worklist in the
   * building.
   */
  it("refuses a film whose modality disagrees with the referral", async () => {
    const study = await placed("USG-ABDO");
    await expect(register(study.studyId, { modality: "ct" }))
      .rejects.toMatchObject({ code: "modality_mismatch" });
  });

  /**
   * The second call is refused by the STATUS, not by the unique index — the study is `acquired` by
   * then. The index is the backstop for a path that does not exist yet, so it is proved directly.
   */
  it("a second registration on the same study is refused, and the index says so too", async () => {
    const study = await placed();
    await register(study.studyId);
    await expect(register(study.studyId)).rejects.toMatchObject({ code: "bad_transition" });

    await expect(db.insert(imagingOutsideStudies).values({
      id: newId(), studyId: study.studyId, centreName: "Another Centre", studyDate: "2026-01-01",
      modality: "ct", arrival: "film", recordedBy: "t",
    })).rejects.toThrow(/imaging_outside_studies_study_ux/);
  });

  /**
   * ═══ THE GREP THAT PINS THE NEW WORKFLOW EDGE TO ONE CALLER ═══
   *
   * `scheduled → acquired` exists so an outside film can reach a reportable state without a machine,
   * a gate or a dose. It is also, by construction, a way past all three — and the workflow engine
   * cannot tell which caller is using it. The guard is that there is ONE caller, and this is the
   * same shape `materials`' append-only ledger uses: *"that is not a trigger; it is the absence of
   * code, and it is a grep as much as it is a test."*
   */
  it("only `registerOutsideStudy` transitions a study straight to `acquired`", () => {
    const dir = "src/modules/radiology";
    const files = ["acquisition.ts", "schedule.ts", "checkin.ts", "reports.ts", "gates.ts", "read.ts", "outside.ts"];
    const callers = files.filter((f) => /transition\([^)]*"acquired"/s.test(readFileSync(`${dir}/${f}`, "utf8")));
    expect(callers).toEqual(["acquisition.ts", "outside.ts"]);
  });
});
