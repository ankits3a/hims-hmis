import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  placeAndCreateStudy, setupRadiologyFixture, studyTypeRow,
} from "../../../test/helpers/radiology";
import { PCPNDT_PERMISSIONS } from "../../../test/helpers/pcpndt";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import {
  events, imagingBillDecisions, imagingDefinitions, imagingStudies, orderItems, pcpndtFormF,
  resources,
} from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  addMachine, addPerson, createRegistration, deactivateRegistration, openFormF, recordFormF,
} from "../pcpndt";
import { abortAcquisition, recordAcquired, startAcquisition } from "./acquisition";
import { checkIn } from "./checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "./gates";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T7 — Assertion Book rows **A1, A2, A3, A5, A6 and A7**. A4 is `money.test.ts` (pure) and
 * A6's race is `acquisition.concurrency.test.ts`.
 *
 * ═══ THE ORDER OF OPERATIONS IS WHAT THIS SUITE IS ABOUT ═══
 *
 * Almost every assertion here is *"what is the state of the world after a REFUSAL"* rather than
 * *"was it refused"*. A1's mutant advances the order item before assigning the machine and is
 * detectable only by looking at the item afterwards; A2's moves the Form F check after the dose
 * write and is detectable only by looking at the row. A suite that asserted the refusals alone
 * would pass against both.
 */
describe("acquisition: the patient is on the table (18a T7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let sonologist: Actor;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
    /** The PCPNDT permissions, so the register's guards can answer at all (its manifest is separate). */
    const registry = new ModuleRegistry();
    registry.install({
      key: "pcpndt", title: "PCPNDT", menu: [], permissions: [...PCPNDT_PERMISSIONS], subscriptions: [],
    });
    await syncPermissions(db, registry);
    await ensureRole(db, "pcpndt_incharge");
    for (const p of PCPNDT_PERMISSIONS) await grantPermissionToRole(db, registry, "pcpndt_incharge", p);
    for (const p of ["pcpndt.form_f.write", "pcpndt.form_f.read"]) {
      await grantPermissionToRole(db, registry, "radiographer", p);
    }
    ({ actor: sonologist } = await mkUser(db, "dr.sono", ["pcpndt_incharge"]));
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;

  const rewriteBook = async (types: StudyType[]) => {
    await db.update(imagingDefinitions).set({ body: { types } })
      .where(eq(imagingDefinitions.kind, "study_types"));
  };
  const bookRow = (code: string, over: Partial<StudyType>) =>
    studyTypeRow({ code, service_id: fx.services[code]!, ...over });

  /**
   * The evidence each kind this suite opens will accept.
   *
   * `form_f` takes NONE — T5's gate reads the PCPNDT register and refuses to be satisfied by
   * anything a caller types, so `readyStudy` opens a form first. That is the two-controls design
   * working as written: the GATE passes on an `open` form (the sonologist has started the
   * paperwork), and T7's `assertFormFRecorded` demands a RECORDED one before the exposure.
   */
  const consentFor = (code: string) => ({
    procedureCode: code, templateVersion: "rad-contrast-v3", language: "hi",
    signer: "patient" as const, conversionCovered: false, laterality: null,
    signedAt: NOW.toISOString(),
  });
  const evidenceFor = (kind: string, code: string): unknown => ({
    identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
    pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
    contrast_consent: consentFor(code),
    renal_function: { creatinineUmolL: 72, sampledAt: NOW.toISOString(), source: "internal" },
    prior_contrast_reaction: {},
    chaperone_present: { chaperoneUserId: fx.doctor.id },
  }[kind] ?? {});

  /** Places, books, checks in, clears every opened gate, and evaluates — a study on `ready`. */
  const readyStudy = async (code: string, deviceKey: string) => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, code, `a${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    if (checked.gates.includes("form_f")) {
      /** The gate reads the register, so the register must have a row. OPEN only — see the note above. */
      await withTx(db, (tx) => openFormF(tx, fx.radiographer, {
        studyId: study.studyId, patientId: fx.patientId,
        deviceResourceId: fx.devices[deviceKey]!, personUserId: fx.radiographer.id,
        indicationCode: "obstetric", applicability: "pregnant", onDate: DAY,
      }));
    }
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidenceFor(kind, code), NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    return study;
  };

  /** A live §19 registration covering every fixture device, with the radiographer registered on it. */
  const registerDevices = async () => {
    const { registrationId } = await withTx(db, (tx) => createRegistration(tx, sonologist, {
      site: "Main", registrationNo: "PNDT/2026/1", validFrom: "2026-01-01", validTo: "2027-12-31",
    }));
    for (const deviceId of new Set(Object.values(fx.devices))) {
      await withTx(db, (tx) => addMachine(tx, sonologist, {
        registrationId, deviceResourceId: deviceId, make: "GE", model: "V", serial: `SN-${deviceId.slice(-4)}`,
      }));
    }
    await withTx(db, (tx) => addPerson(tx, sonologist, {
      registrationId, userId: fx.radiographer.id, qualification: "DMRT",
    }));
    return registrationId;
  };

  const start = (studyId: string, actor: Actor = fx.radiographer) =>
    withTx(db, (tx) => startAcquisition(tx, actor, fx.decls, { studyId, onDate: DAY, now: NOW }));
  const acquired = (studyId: string, over: Record<string, unknown> = {}, actor: Actor = fx.radiographer) =>
    withTx(db, (tx) => recordAcquired(tx, actor, fx.decls, {
      studyId, onDate: DAY, imageSource: "pacs", now: NOW, ...over,
    }));

  /* ═══════════════════════ A1 — THE ORDER OF OPERATIONS ═══════════════════════ */

  it("starts a stat study: the device is occupied, the item is in_progress, the study says WHY", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));

    const result = await start(study.studyId);
    expect([result.status, result.authorisedBy]).toEqual(["in_acquisition", "stat"]);

    const [device] = await db.select().from(resources).where(eq(resources.id, fx.devices.usg!));
    expect([device!.status, device!.occupantRef]).toEqual(["in_use", study.studyId]);
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("in_progress");
  });

  /**
   * ═══ A1's NAMED MUTANT, AND IT IS ONLY VISIBLE IN THE AFTERMATH ═══
   *
   * The mutant advances the order item BEFORE assigning the machine. Both shipped and mutant refuse
   * a start on an occupied device — so the refusal proves nothing. What separates them is the
   * ORDER ITEM afterwards: shipped leaves it `placed` (one transaction, rolled back), the mutant
   * leaves it `in_progress` for a scan nobody is doing, and T4's `cancelStudy` then demands a reason
   * to cancel it because `in_acquisition` is the band where film was spent.
   */
  it("A1: a start on an OCCUPIED device is refused, and the envelope item is STILL `placed`", async () => {
    const first = await readyStudy("USG-ABDO", "usg");
    const second = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" })
      .where(eq(imagingStudies.id, first.studyId));
    await db.update(imagingStudies).set({ priority: "stat" })
      .where(eq(imagingStudies.id, second.studyId));

    await start(first.studyId);
    await expect(start(second.studyId)).rejects.toMatchObject({ code: "already_occupied" });

    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, second.itemId));
    expect(item!.status).toBe("placed");
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, second.studyId));
    expect([row!.status, row!.acquisitionStartedAt]).toEqual(["ready", null]);
  });

  it("a study that is not READY cannot start, and names the gates holding it", async () => {
    seq += 1;
    const study = await placeAndCreateStudy(db, fx, "USG-ABDO", `n${String(seq)}`, new Date(NOW.getTime() + 90 * 3_600_000));
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: SLOT,
    }));
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    const e = await start(study.studyId).catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("not_ready");
    expect(String(e)).toMatch(/identity_two_factor/);
  });

  /* ═══════════════════════ A4's DB leg — the authorisation refusal ═══════════════════════ */

  it("A4: a self-pay routine study is refused `payment_required`, and nothing is written", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await expect(start(study.studyId)).rejects.toMatchObject({ code: "payment_required" });
    const [device] = await db.select().from(resources).where(eq(resources.id, fx.devices.usg!));
    expect(device!.status).toBe("available");
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("placed");
  });

  /* ═══════════════════════ A2 — THE REGISTER ANSWERS FIRST ═══════════════════════ */

  /**
   * A2's mutant moves `assertFormFRecorded` after the dose write. Asserting the refusal alone would
   * pass against it; what discriminates is that the ROW is untouched — no accession consumed, no
   * dose, no event, no released device.
   */
  it("A2: a form_f_required study with NO recorded form is refused, and NOTHING is written", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    await registerDevices();
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);

    const e = await acquired(study.studyId).catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("form_f_missing");

    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect([row!.status, row!.acquiredAt, row!.imageSource]).toEqual(["in_acquisition", null, null]);
    expect((await db.select().from(events)).filter((e2) => e2.name === "imaging.study_acquired")).toEqual([]);
    const [device] = await db.select().from(resources).where(eq(resources.id, fx.devices.usg!));
    expect(device!.status).toBe("in_use");
  });

  it("A2: the same call lands once the Form F is RECORDED", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    await registerDevices();
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);

    const [openForm] = await db.select().from(pcpndtFormF).where(eq(pcpndtFormF.studyId, study.studyId));
    const formFId = openForm!.id;
    await withTx(db, (tx) => recordFormF(tx, fx.radiographer, {
      formFId, sections: { F: "anomaly" }, declaration: { signature_kind: "signature" },
      referral: { self_referral: false },
    }));

    const done = await acquired(study.studyId, { imageSource: "no_pacs_images" });
    expect(done.accessionNo).toBe(study.accessionNo);
  });

  /**
   * The registration LAPSES between the paperwork and the exposure — which is the case A2's
   * re-evaluation exists for. Reaching `ready` needs a registration (the `form_f` gate opens a form,
   * which needs one), so the withdrawal has to happen after that and before the start.
   */
  it("A2: a registration withdrawn before the START refuses the exposure", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const registrationId = await registerDevices();
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));

    await withTx(db, (tx) => deactivateRegistration(tx, sonologist, registrationId, "suspended"));
    await expect(start(study.studyId)).rejects.toMatchObject({ code: "machine_not_registered" });
  });

  /* ═══════════════════════ A3 — THE DOSE ═══════════════════════ */

  /**
   * A3's mutant drops the CHECK. **Finding F18 is why this row is worth more than it looks**: until
   * this task, `imaging_studies.ionising` was NEVER WRITTEN, so the CHECK read a column that was
   * always `false` and could not fire at all. The first assertion below is that the column is now
   * TRUE for an ionising type — without it the rest of A3 is vacuous.
   */
  it("A3/F18: an ionising study is SNAPSHOTTED as ionising, and is refused with no dose", async () => {
    const study = await readyStudy("XR-CHEST", "xray");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);

    await expect(acquired(study.studyId)).rejects.toMatchObject({ code: "dose_required" });
    /** `doseManual` is PROVENANCE and not an excuse — the plan's own word. */
    await expect(acquired(study.studyId, { doseManual: true })).rejects.toMatchObject({ code: "dose_required" });

    await acquired(study.studyId, { doseDap: 1.42, doseManual: true });
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.ionising).toBe(true);
    expect([row!.doseDap, row!.doseManual]).toEqual(["1.420", true]);
  });

  it("A3: a USG with no dose lands — the rule is about ionising radiation, not about paperwork", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await acquired(study.studyId, { imageSource: "no_pacs_images" });
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect([row!.ionising, row!.status]).toEqual([false, "acquired"]);
  });

  /* ═══════════════════════ A6 — ONCE, AND ONLY ONCE ═══════════════════════ */

  it("A6: `imaging.study_acquired` is emitted ONCE, and a second call is `already_acquired`", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await acquired(study.studyId, { imageSource: "no_pacs_images" });

    await expect(acquired(study.studyId)).rejects.toMatchObject({ code: "already_acquired" });
    const emitted = (await db.select().from(events)).filter((e) => e.name === "imaging.study_acquired");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      studyId: study.studyId, accessionNo: study.accessionNo, contrastGiven: false,
      imageSource: "no_pacs_images", deviceResourceId: fx.devices.usg,
    });
  });

  /* ═══════════════════════ A7 — THE MACHINE GOES BACK ═══════════════════════ */

  it("A7: after `recordAcquired` the device is `available` again with no occupant", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await acquired(study.studyId, { imageSource: "no_pacs_images" });

    const [device] = await db.select().from(resources).where(eq(resources.id, fx.devices.usg!));
    expect([device!.status, device!.occupantRef]).toEqual(["available", null]);
    /**
     * ═══ AND THE ENVELOPE ITEM IS STILL `in_progress`, WHICH IS DD4 AND §6.2 ═══
     *
     * `workflow-def.ts`: *"`in_acquisition` is where `advanceOrderItem('in_progress')` fires…
     * `published` is where `'completed'` does (a signed report is visible in the app)."* This
     * assertion read `completed` in its first draft — encoding a deviation in which the doctor's
     * order closed the moment the images existed and before anybody had read them. Caught by T9's
     * §6 confirmation pass; the assertion is corrected rather than the contract.
     */
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("in_progress");
  });

  it("aborting an acquisition releases the machine and puts the study back on `ready`", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await withTx(db, (tx) => abortAcquisition(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, reason: "patient could not tolerate the position", now: NOW,
    }));

    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect([row!.status, row!.acquisitionStartedAt]).toEqual(["ready", null]);
    const [device] = await db.select().from(resources).where(eq(resources.id, fx.devices.usg!));
    expect(device!.status).toBe("available");
    /** It keeps its accession — a patient told a number on Monday still quotes it after an abort. */
    expect(row!.accessionNo).toBe(study.accessionNo);

    /**
     * ═══ THE ENVELOPE STAYS `in_progress`, AND THE KERNEL IS WHY ═══
     *
     * The item machine has no `in_progress → placed` edge (`advance.test.ts` pins the four legal
     * ones), and that refusal is the right answer rather than an obstacle: an abort is not the
     * department giving the order back. The patient is still on the list, the slot is still held,
     * and the scan is about to be retried — so *"the department is working on this order"* has been
     * true throughout. Abandoning it for good is `cancelStudy`, which carries a reason.
     */
    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("in_progress");
  });

  /** …and the retry works, which is the half that would break if the envelope were advanced twice. */
  it("a study RE-STARTED after an abort acquires normally, and the item moves only once", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await withTx(db, (tx) => abortAcquisition(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, reason: "machine faulted mid-series", now: NOW,
    }));

    await start(study.studyId);
    await acquired(study.studyId, { imageSource: "no_pacs_images" });

    const [item] = await db.select().from(orderItems).where(eq(orderItems.id, study.itemId));
    expect(item!.status).toBe("in_progress"); // completed at PUBLISH, not here — DD4 / §6.2
    const [device] = await db.select().from(resources).where(eq(resources.id, fx.devices.usg!));
    expect(device!.status).toBe("available");
  });

  it("an abort with no reason is refused", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await expect(withTx(db, (tx) => abortAcquisition(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, reason: "  ", now: NOW,
    }))).rejects.toMatchObject({ code: "reason_required" });
  });

  /* ═══════════════════════ CONTRAST — T5's OWED HALF ═══════════════════════ */

  /**
   * T5 opens the contrast gates only for `contrast_option: 'required'`, and recorded the obligation
   * that T7 must refuse contrast given on a study whose consent gate is not terminal. This is that.
   */
  it("contrast on a study whose consent gate was never opened is refused (T5's seam)", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    const e = await acquired(study.studyId, {
      contrastGiven: true, contrastAgent: "Iohexol", imageSource: "no_pacs_images",
    }).catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("contrast_mismatch");
  });

  it("a contrast AGENT named on a study where contrast was not given is refused", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await expect(acquired(study.studyId, { contrastAgent: "Iohexol", imageSource: "no_pacs_images" }))
      .rejects.toMatchObject({ code: "contrast_mismatch" });
  });

  /* ═══════════════════════ A5 — THE BILL DECISIONS ═══════════════════════ */

  /**
   * A5's mutant raises on EVERY acquisition. The discriminating half is the negative: an ordinary
   * billed scan with no divergence raises NOTHING, because a queue that is the whole worklist stops
   * being read.
   */
  it("A5: a repeat exposure raises exactly one `repeat_no_charge`, and an ordinary scan raises none", async () => {
    const first = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat", invoiceLineId: null })
      .where(eq(imagingStudies.id, first.studyId));
    await start(first.studyId);
    await acquired(first.studyId, { imageSource: "no_pacs_images" });

    const repeat = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, repeat.studyId));
    await start(repeat.studyId);
    const done = await acquired(repeat.studyId, {
      imageSource: "no_pacs_images", repeatOfStudyId: first.studyId, repeatReason: "patient moved",
    });

    const kinds = (await db.select().from(imagingBillDecisions)
      .where(eq(imagingBillDecisions.studyId, repeat.studyId))).map((d) => d.kind).sort();
    expect(kinds).toEqual(["acquired_unbilled", "repeat_no_charge"]);
    expect(done.billDecisionIds).toHaveLength(2);
  });

  it("A5: `contrast_not_given` is raised when a with-contrast service produced no contrast", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg" }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await readyStudy("CT-HEAD", "ct");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await acquired(study.studyId, { doseCtdivol: 6.4 });

    const kinds = (await db.select().from(imagingBillDecisions)).map((d) => d.kind).sort();
    expect(kinds).toContain("contrast_not_given");
  });

  it("A5: a DAY-CARE study raises no `acquired_unbilled` — its discharge bill composes the scan", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ encounterNo: "D2608310001" })
      .where(eq(imagingStudies.id, study.studyId));
    const result = await start(study.studyId);
    expect(result.authorisedBy).toBe("daycare");
    await acquired(study.studyId, { imageSource: "no_pacs_images" });
    expect(await db.select().from(imagingBillDecisions)).toEqual([]);
  });

  /** D6's CHECK, named at the field rather than at the constraint. */
  it("a repeat pointer with no reason is refused, and a reason with no pointer likewise", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await expect(acquired(study.studyId, { repeatOfStudyId: study.studyId, imageSource: "no_pacs_images" }))
      .rejects.toMatchObject({ code: "reason_required" });
    await expect(acquired(study.studyId, { repeatReason: "moved", imageSource: "no_pacs_images" }))
      .rejects.toMatchObject({ code: "reason_required" });
  });

  /* ═══════════════════════ E11 — the downtime backfill ═══════════════════════ */

  it("E11: a backfilled acquisition carries the PAPER instant and DERIVES `lateEntry`", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    const paper = new Date(NOW.getTime() - 4 * 3_600_000);
    await acquired(study.studyId, { imageSource: "outside", acquiredAt: paper });

    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect([row!.acquiredAt?.toISOString(), row!.lateEntry]).toEqual([paper.toISOString(), true]);
  });

  it("an acquisition recorded at the console is NOT a late entry", async () => {
    const study = await readyStudy("USG-ABDO", "usg");
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await start(study.studyId);
    await acquired(study.studyId, { imageSource: "no_pacs_images" });
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect(row!.lateEntry).toBe(false);
  });
});
