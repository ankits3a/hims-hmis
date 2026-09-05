import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  placeAndCreateStudy, setupRadiologyFixture, studyTypeRow,
} from "../../../test/helpers/radiology";
import { PCPNDT_PERMISSIONS } from "../../../test/helpers/pcpndt";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { imagingDefinitions, imagingStudies } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { createResource } from "../../kernel/resources/registry";
import { withTx } from "../../kernel/db/client";
import {
  addMachine, addPerson, createRegistration, openFormF, recordFormF,
} from "../pcpndt";
import { RADIOLOGY_RESOURCE_KINDS } from "./kinds";
import { checkIn } from "./checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "./gates";
import { rescheduleStudy, scheduleStudy } from "./schedule";
import { recordAcquired, startAcquisition } from "./acquisition";
import { studyView } from "./read";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a-iii T3 — **the portable / bedside study (D4).**
 *
 * *"A portable study is the SAME study with a place, not a second kind."* There is no
 * `portable_studies` table here and no second workflow definition, so most of what this suite proves
 * is that nothing changed: the gate set, the statutory form and the acquisition path are the ones a
 * department study takes. The phase doc says the Form F and chaperone rules "MUST be shown to" apply
 * unchanged, and the demonstration is the last describe block.
 *
 * The one new rule is `resolveBedside`, and the test that matters for it is **the reschedule**: a
 * guard on `scheduleStudy` alone would let a ward study be moved onto the CT with its bedside place
 * intact, and the row would then claim a fixed gantry went to bed 12.
 */
describe("the portable study (18a-iii T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let sonologist: Actor;
  /** A second USG unit, of the same modality as the fixture's, that CAN leave the department. */
  let trolley: string;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  const WARD = "Ward 3, Bed 12";
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;

    ({ resourceId: trolley } = await withTx(db, (tx) => createResource(
      tx, fx.radiographer, RADIOLOGY_RESOURCE_KINDS,
      {
        kind: "device", code: "DEV-USG-PORTABLE", name: "ward ultrasound trolley",
        /** The whole of what makes a machine portable: one jsonb key, no migration. */
        attributes: { modality: "usg", portable: true },
      },
    )));

    /** The USG becomes a covered, chaperoned examination so the ward case has something to prove. */
    await db.update(imagingDefinitions).set({
      body: {
        types: [
          studyTypeRow({
            code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg",
            body_part: "obstetric", pcpndt_applicable: true, chaperone_required: true,
          }),
          studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", ionising: true }),
          studyTypeRow({ code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true }),
          studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
        ] satisfies StudyType[],
      },
    }).where(eq(imagingDefinitions.kind, "study_types"));

    /**
     * The shared fixture grants the ORDER-PLACING permissions and no more, so a suite that reads a
     * study through `studyView` has to grant the worklist clearance itself — `read.test.ts` does the
     * same. `syncPermissions` is additive and prunes nothing, so installing PCPNDT beside radiology
     * here takes nothing away from what the fixture already registered.
     */
    const registry = new ModuleRegistry();
    registry.install({
      key: "pcpndt", title: "PCPNDT", menu: [], permissions: [...PCPNDT_PERMISSIONS], subscriptions: [],
    });
    registry.install({
      key: "radiology", title: "Rad", menu: [], permissions: ["radiology.worklist.read"], subscriptions: [],
    });
    await syncPermissions(db, registry);
    await grantPermissionToRole(db, registry, "radiographer", "radiology.worklist.read");
    await ensureRole(db, "pcpndt_incharge");
    for (const p of PCPNDT_PERMISSIONS) await grantPermissionToRole(db, registry, "pcpndt_incharge", p);
    for (const p of ["pcpndt.form_f.write", "pcpndt.form_f.read"]) {
      await grantPermissionToRole(db, registry, "radiographer", p);
    }
    ({ actor: sonologist } = await mkUser(db, "dr.sono", ["pcpndt_incharge"]));
  });
  afterEach(() => { fx.unregister(); });

  const placed = async () => {
    seq += 1;
    return placeAndCreateStudy(
      db, fx, "USG-ABDO", `p${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
  };
  const book = (studyId: string, deviceResourceId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId, deviceResourceId, scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000), ...over,
    }));
  const rebook = (studyId: string, deviceResourceId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => rescheduleStudy(tx, fx.radiographer, {
      studyId, deviceResourceId, scheduledAt: new Date(SLOT.getTime() + (seq + 10) * 3_600_000), ...over,
    }));
  /** The evidence each gate a covered ward USG opens will accept. */
  const EVIDENCE: Record<string, unknown> = {
    identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
    chaperone_present: { chaperoneUserId: "" },
  };
  const evidenceFor = (kind: string): unknown =>
    kind === "chaperone_present" ? { chaperoneUserId: fx.doctor.id } : (EVIDENCE[kind] ?? {});

  const row = async (studyId: string) =>
    (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;

  /* ═══════════════════════ THE PLACE, AND THE MACHINE THAT MAY HAVE ONE ═══════════════════════ */

  it("books a ward study on the trolley and the row carries the bed", async () => {
    const study = await placed();
    await book(study.studyId, trolley, { bedsideLocation: WARD });

    const after = await row(study.studyId);
    expect([after.deviceResourceId, after.bedsideLocation]).toEqual([trolley, WARD]);
  });

  it("the console can see where to take the machine", async () => {
    const study = await placed();
    await book(study.studyId, trolley, { bedsideLocation: WARD });
    const view = await studyView(db, fx.radiographer, study.studyId);
    expect(view?.bedsideLocation).toBe(WARD);
  });

  /**
   * The refusal names the MACHINE, and the aftermath is what separates a guard placed before the
   * write from one placed after it: the study must still be unbooked.
   */
  it("refuses a bedside on a machine that does not leave the department, and books nothing", async () => {
    const study = await placed();
    await expect(book(study.studyId, fx.devices.usg!, { bedsideLocation: WARD }))
      .rejects.toMatchObject({ code: "device_not_portable" });

    const after = await row(study.studyId);
    expect([after.deviceResourceId, after.scheduledAt, after.bedsideLocation]).toEqual([null, null, null]);
  });

  /**
   * ═══ THE RULE IS ONE-DIRECTIONAL, AND THIS IS THE TEST THAT SAYS SO ═══
   *
   * A mutant that makes it a biconditional — "a portable device must have a bedside location" —
   * passes every other test in this file and fails here. A mobile unit wheeled into a department
   * room is an ordinary thing, and a rule that refused it would be false on a real case.
   */
  it("a portable machine used IN the department needs no bedside location", async () => {
    const study = await placed();
    await expect(book(study.studyId, trolley)).resolves.toBeDefined();
    expect((await row(study.studyId)).bedsideLocation).toBeNull();
  });

  /* ═════════════ THE HOLE A GUARD ON `scheduleStudy` ALONE WOULD HAVE LEFT ═════════════ */

  /**
   * ═══ THE RESCHEDULE IS WHERE THIS RULE IS ACTUALLY LOAD-BEARING ═══
   *
   * `rescheduleStudy` is a near-duplicate of `scheduleStudy` with its own update block. Guarding
   * only the first would let a ward study booked on the trolley be moved onto the fixed unit with
   * `bedside_location` untouched — no error anywhere, and a row that says a machine which cannot
   * leave the department was at bed 12. The caller says nothing about the field in this test, which
   * is exactly how it would happen: a desk rebooking a patient into the department does not think
   * to clear a column it never set.
   */
  it("refuses a rebook onto a fixed machine while the bed is still on the row", async () => {
    const study = await placed();
    await book(study.studyId, trolley, { bedsideLocation: WARD });

    await expect(rebook(study.studyId, fx.devices.usg!))
      .rejects.toMatchObject({ code: "device_not_portable" });

    const after = await row(study.studyId);
    expect([after.deviceResourceId, after.bedsideLocation]).toEqual([trolley, WARD]);
  });

  it("and the rebook succeeds once the bed is explicitly cleared — the patient is coming down", async () => {
    const study = await placed();
    await book(study.studyId, trolley, { bedsideLocation: WARD });

    await rebook(study.studyId, fx.devices.usg!, { bedsideLocation: null });

    const after = await row(study.studyId);
    expect([after.deviceResourceId, after.bedsideLocation]).toEqual([fx.devices.usg!, null]);
  });

  it("a rebook that says nothing keeps the bed when the machine is still the trolley", async () => {
    const study = await placed();
    await book(study.studyId, trolley, { bedsideLocation: WARD });
    await rebook(study.studyId, trolley);
    expect((await row(study.studyId)).bedsideLocation).toBe(WARD);
  });

  /* ══════ WHAT DID NOT CHANGE, WHICH IS THE POINT OF D4 AND THE PHASE DOC'S "MUST BE SHOWN" ══════ */

  /**
   * ═══ §11.19-C-6 — A PORTABLE USG ON A WARD IS EXACTLY THE CASE FORM F WAS WIDENED TO COVER ═══
   *
   * `deriveGateSet` takes `study: { formFRequired: boolean }` and a study TYPE. It is structurally
   * incapable of seeing where the examination happens, which is why D4's "same study with a place"
   * holds by construction rather than by a second rule. This is the end-to-end demonstration the
   * phase doc asks for: the ward study opens the same gates, and the register still refuses the
   * exposure without a RECORDED form.
   */
  describe("the ward study is gated exactly like the department one", () => {
    const registerMachines = async () => {
      const { registrationId } = await withTx(db, (tx) => createRegistration(tx, sonologist, {
        site: "Main", registrationNo: "PNDT/2026/1", validFrom: "2026-01-01", validTo: "2027-12-31",
      }));
      for (const deviceId of [...new Set(Object.values(fx.devices)), trolley]) {
        await withTx(db, (tx) => addMachine(tx, sonologist, {
          registrationId, deviceResourceId: deviceId, make: "GE", model: "V",
          serial: `SN-${deviceId.slice(-4)}`,
        }));
      }
      await withTx(db, (tx) => addPerson(tx, sonologist, {
        registrationId, userId: fx.radiographer.id, qualification: "DMRT",
      }));
      return registrationId;
    };

    it("opens form_f and chaperone_present at the bedside, the same two as in the department", async () => {
      const ward = await placed();
      await book(ward.studyId, trolley, { bedsideLocation: WARD });
      const atBed = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: ward.studyId, now: NOW }));

      const dept = await placed();
      await book(dept.studyId, fx.devices.usg!);
      const inDept = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: dept.studyId, now: NOW }));

      expect(atBed.gates).toEqual(inDept.gates);
      expect(atBed.gates).toEqual(expect.arrayContaining(["form_f", "chaperone_present"]));
    });

    it("and the register still refuses the exposure at the bedside without a RECORDED form", async () => {
      await registerMachines();
      const ward = await placed();
      await book(ward.studyId, trolley, { bedsideLocation: WARD });
      const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: ward.studyId, now: NOW }));

      /** OPEN only — the gate passes on a started form; the register demands a completed one. */
      await withTx(db, (tx) => openFormF(tx, fx.radiographer, {
        studyId: ward.studyId, patientId: fx.patientId, deviceResourceId: trolley,
        personUserId: fx.radiographer.id, indicationCode: "obstetric", applicability: "pregnant",
        onDate: DAY,
      }));
      for (const kind of checked.gates) {
        const gate = await requireStudyGate(db, ward.studyId, kind);
        await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidenceFor(kind), NOW));
      }
      await withTx(db, (tx) => evaluateReadiness(tx, ward.studyId));
      await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, ward.studyId));
      await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, {
        studyId: ward.studyId, now: NOW,
      }));

      await expect(withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
        studyId: ward.studyId, imageSource: "no_pacs_images", now: NOW,
      }))).rejects.toMatchObject({ code: "form_f_missing" });
    });

    it("a bedside study acquires normally once the form is recorded — the place blocks nothing", async () => {
      await registerMachines();
      const ward = await placed();
      await book(ward.studyId, trolley, { bedsideLocation: WARD });
      const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: ward.studyId, now: NOW }));

      const { formFId } = await withTx(db, (tx) => openFormF(tx, fx.radiographer, {
        studyId: ward.studyId, patientId: fx.patientId, deviceResourceId: trolley,
        personUserId: fx.radiographer.id, indicationCode: "obstetric", applicability: "pregnant",
        onDate: DAY,
      }));
      await withTx(db, (tx) => recordFormF(tx, fx.radiographer, {
        formFId, sections: { F: "anomaly" }, declaration: { signature_kind: "signature" },
        referral: { self_referral: false },
      }));
      for (const kind of checked.gates) {
        const gate = await requireStudyGate(db, ward.studyId, kind);
        await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidenceFor(kind), NOW));
      }
      await withTx(db, (tx) => evaluateReadiness(tx, ward.studyId));
      await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, ward.studyId));
      await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, {
        studyId: ward.studyId, now: NOW,
      }));
      await withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
        studyId: ward.studyId, imageSource: "no_pacs_images", now: NOW,
      }));

      const after = await row(ward.studyId);
      expect([after.status, after.bedsideLocation]).toEqual(["acquired", WARD]);
    });
  });
});
