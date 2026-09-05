import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import {
  events, imagingContrastAdministrations, imagingDefinitions, imagingStudies, patientAllergies,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { checkIn } from "./checkin";
import { evaluateReadiness, requireStudyGate, satisfyGate } from "./gates";
import { cancelStudy, scheduleStudy } from "./schedule";
import { startAcquisition } from "./acquisition";
import { contrastAdministrationsFor, recordContrastAdministration, summariseContrast } from "./contrast";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a-iii T1 — **the contrast administration record.**
 *
 * ═══ WHAT THIS SUITE IS ACTUALLY FOR ═══
 *
 * Two things, and the second is the one a green run hides. The first is the ordinary contract: a
 * dose goes in, a row exists, the study's summary agrees with it. The second is the set of cases
 * the record must be able to hold and the ones it must refuse — an ABANDONED scan whose only
 * injection is the one that mattered, and an EXPIRED vial, which no plan writes down and which the
 * contract pass therefore cannot find.
 *
 * Every refusal here asserts the AFTERMATH as well as the code (`acquisition.test.ts`'s discipline):
 * a guard that throws after writing the row and a guard that throws before it are the same test
 * otherwise.
 */
describe("contrast administration (18a-iii T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  const bookRow = (code: string, over: Partial<StudyType>) =>
    studyTypeRow({ code, service_id: fx.services[code]!, ...over });

  /** Rewrites the active book so a CT can actually be a CONTRAST examination. */
  const rewriteBook = async (types: StudyType[]) => {
    await db.update(imagingDefinitions).set({ body: { types } })
      .where(eq(imagingDefinitions.kind, "study_types"));
  };

  const contrastBook = (ctOption: StudyType["contrast_option"]) => rewriteBook([
    bookRow("USG-ABDO", { modality: "usg" }),
    bookRow("XR-CHEST", { modality: "xray", ionising: true }),
    bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: ctOption }),
    bookRow("MRI-BRAIN", { modality: "mri" }),
  ]);

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
    laterality_confirm: { patientStated: "na" },
  }[kind] ?? {});

  /** A CT on the machine: booked, checked in, every opened gate cleared, `startAcquisition` run. */
  const onTheTable = async (code = "CT-HEAD", deviceKey = "ct") => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, code, `c${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    for (const kind of checked.gates) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidenceFor(kind, code), NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, now: NOW,
    }));
    return study;
  };

  const give = (studyId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => recordContrastAdministration(tx, fx.radiographer, {
      studyId, agent: "Omnipaque 350", volumeMl: 90, route: "intravenous",
      givenBy: fx.radiographer.id, givenAt: NOW, now: NOW, ...over,
    }));

  const studyRow = async (studyId: string) =>
    (await db.select().from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;

  /* ═════════════════ THE SUMMARY RULE — PURE, AND IT IS A DECISION ═════════════════ */

  describe("summariseContrast", () => {
    it("with no administrations the study has no contrast at all", () => {
      expect(summariseContrast([])).toEqual({
        contrastGiven: false, contrastAgent: null, contrastVolumeMl: null,
      });
    });

    it("sums intravascular volumes in whole hundredths, never in floats", () => {
      expect(summariseContrast([
        { agent: "Omnipaque 350", volumeMl: "0.10", route: "intravenous" },
        { agent: "Omnipaque 350", volumeMl: "0.20", route: "intraarterial" },
      ])).toEqual({ contrastGiven: true, contrastAgent: "Omnipaque 350", contrastVolumeMl: "0.30" });
    });

    /**
     * ═══ THE NAMED MUTANT: SUM EVERY ROUTE ═══
     *
     * A litre of dilute oral barium plus 90 ml of iohexol is 1090, and `drafter.ts` would print
     * *"with 1090 ml … intravenously"* into a signed, courtroom-readable report. The mutant passes
     * every other test in this file — it differs only when the routes are MIXED, which is why this
     * fixture mixes them.
     */
    it("a study given oral AND intravenous contrast carries the INTRAVENOUS volume only", () => {
      expect(summariseContrast([
        { agent: "Barium sulphate", volumeMl: "1000.00", route: "oral" },
        { agent: "Omnipaque 350", volumeMl: "90.00", route: "intravenous" },
      ])).toEqual({
        contrastGiven: true,
        contrastAgent: "Barium sulphate + Omnipaque 350",
        contrastVolumeMl: "90.00",
      });
    });

    /** Oral only: contrast WAS given, the agent is named, and the volume is honestly absent. */
    it("a study given only oral contrast has an agent and a NULL volume", () => {
      expect(summariseContrast([
        { agent: "Barium sulphate", volumeMl: "1000.00", route: "oral" },
      ])).toEqual({ contrastGiven: true, contrastAgent: "Barium sulphate", contrastVolumeMl: null });
    });

    it("names each agent once, in the order it was first given", () => {
      expect(summariseContrast([
        { agent: "Omnipaque 350", volumeMl: "50.00", route: "intravenous" },
        { agent: "Omnipaque 350", volumeMl: "40.00", route: "intravenous" },
      ]).contrastAgent).toBe("Omnipaque 350");
    });
  });

  /* ═════════════════════════ THE ORDINARY CONTRACT ═════════════════════════ */

  it("records the injection and leaves the study's summary agreeing with it", async () => {
    await contrastBook("required");
    const study = await onTheTable();

    const { administrationId } = await give(study.studyId, {
      site: "right antecubital", vialBatchNo: "LOT-2291", vialExpiry: "2027-04-30",
    });

    const [row] = await db.select().from(imagingContrastAdministrations)
      .where(eq(imagingContrastAdministrations.id, administrationId));
    expect([row!.agent, row!.volumeMl, row!.route, row!.site]).toEqual(
      ["Omnipaque 350", "90.00", "intravenous", "right antecubital"],
    );
    expect([row!.vialBatchNo, row!.vialExpiry, row!.givenBy, row!.recordedBy])
      .toEqual(["LOT-2291", "2027-04-30", fx.radiographer.id, fx.radiographer.id]);

    const study1 = await studyRow(study.studyId);
    expect([study1.contrastGiven, study1.contrastAgent, study1.contrastVolumeMl])
      .toEqual([true, "Omnipaque 350", "90.00"]);
  });

  it("a second injection moves the summary, and the register reads back in the order given", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await give(study.studyId, { volumeMl: 50 });
    await give(study.studyId, {
      agent: "Barium sulphate", volumeMl: 800, route: "oral",
      givenAt: new Date(NOW.getTime() + 60_000), now: new Date(NOW.getTime() + 120_000),
    });

    const rows = await contrastAdministrationsFor(db, study.studyId);
    expect(rows.map((r) => r.route)).toEqual(["intravenous", "oral"]);
    const after = await studyRow(study.studyId);
    expect([after.contrastAgent, after.contrastVolumeMl])
      .toEqual(["Omnipaque 350 + Barium sulphate", "50.00"]);
  });

  it("emits imaging.contrast_administered once, carrying the agent and the route and no finding", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await give(study.studyId);

    const rows = (await db.select().from(events))
      .filter((e) => e.name === "imaging.contrast_administered");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      studyId: study.studyId, agent: "Omnipaque 350", route: "intravenous", volumeMl: "90.00",
    });
  });

  /* ══════════ THE CASE THE RECORD EXISTS FOR: THE SCAN THAT NEVER HAPPENED ══════════ */

  /**
   * The injection at 09:40, the reaction, the abandoned scan. `recordAcquired` never runs, so a
   * design that carried the dose on the acquisition would have no row for the only contrast this
   * patient ever received — and T2's reaction would hang off nothing.
   */
  it("a study CANCELLED off the machine still takes the injection that was actually given", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await withTx(db, (tx) => cancelStudy(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, reason: "contrast reaction — scan abandoned",
    }));
    expect((await studyRow(study.studyId)).status).toBe("cancelled");

    await give(study.studyId);
    const after = await studyRow(study.studyId);
    expect([after.contrastGiven, after.contrastVolumeMl]).toEqual([true, "90.00"]);
  });

  it("a study still on READY has had nothing given to it, and says so", async () => {
    await contrastBook("required");
    seq += 1;
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", `r${String(seq)}`, NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: SLOT,
    }));

    await expect(give(study.studyId)).rejects.toMatchObject({ code: "bad_transition" });
    expect(await contrastAdministrationsFor(db, study.studyId)).toHaveLength(0);
  });

  it("a study cancelled BEFORE the patient reached the machine spent no contrast", async () => {
    await contrastBook("required");
    seq += 1;
    const study = await placeAndCreateStudy(db, fx, "CT-HEAD", `x${String(seq)}`, NOW);
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.ct!, scheduledAt: SLOT,
    }));
    /** A `scheduled` study is cancelled by the desk, not the console — `workflow-def.ts`'s roles. */
    await withTx(db, (tx) => cancelStudy(tx, fx.radiologist, fx.decls, {
      studyId: study.studyId, reason: "patient went home",
    }));
    const cancelled = await studyRow(study.studyId);
    expect([cancelled.status, cancelled.acquisitionStartedAt]).toEqual(["cancelled", null]);

    await expect(give(study.studyId)).rejects.toMatchObject({ code: "bad_transition" });
  });

  /* ════════════════════════════ THE EXPIRED VIAL ════════════════════════════ */

  /**
   * ═══ NOBODY WROTE THIS DOWN, WHICH IS WHY IT IS HERE ═══
   *
   * The phase doc's T1 asks for "the vial, the agent, the volume, the route, who gave it, when" and
   * says nothing about expiry — exactly the asymmetry the pharmacy module shipped as a CRITICAL
   * (FEFO offering expired stock). An expiry that is RECORDED is a fact with a consequence.
   */
  it("refuses a vial that had expired on the day it was given, and writes nothing", async () => {
    await contrastBook("required");
    const study = await onTheTable();

    await expect(give(study.studyId, { vialBatchNo: "LOT-OLD", vialExpiry: "2026-08-30" }))
      .rejects.toMatchObject({ code: "vial_expired" });

    expect(await contrastAdministrationsFor(db, study.studyId)).toHaveLength(0);
    const after = await studyRow(study.studyId);
    expect([after.contrastGiven, after.contrastVolumeMl]).toEqual([false, null]);
  });

  it("accepts a vial expiring ON the day it was given — the label's last day is a usable day", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await expect(give(study.studyId, { vialExpiry: "2026-08-31" })).resolves.toBeDefined();
  });

  /**
   * The service refusal above proves the SERVICE. This proves the DATABASE, by adding the forbidden
   * row directly — a refusal cannot be proved by a revert pair, only by a mutant that ADDS the thing
   * the guard forbids.
   */
  it("the database itself refuses an expired-vial row, past every service branch", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await expect(db.insert(imagingContrastAdministrations).values({
      id: newId(), studyId: study.studyId, agent: "Omnipaque 350", volumeMl: "90.00",
      route: "intravenous", vialBatchNo: "LOT-OLD", vialExpiry: "2026-08-30",
      givenBy: fx.radiographer.id, givenAt: NOW, recordedBy: "t",
    })).rejects.toThrow(/imaging_contrast_administrations_vial_expiry_ck/);
  });

  it("the database itself refuses a zero-millilitre administration", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await expect(db.insert(imagingContrastAdministrations).values({
      id: newId(), studyId: study.studyId, agent: "Omnipaque 350", volumeMl: "0.00",
      route: "intravenous", givenBy: fx.radiographer.id, givenAt: NOW, recordedBy: "t",
    })).rejects.toThrow(/imaging_contrast_administrations_volume_ck/);
  });

  it("a one-millilitre test dose is an administration", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await give(study.studyId, { volumeMl: 1 });
    expect((await studyRow(study.studyId)).contrastVolumeMl).toBe("1.00");
  });

  it("refuses a dose timed in the future", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await expect(give(study.studyId, { givenAt: new Date(NOW.getTime() + 3_600_000) }))
      .rejects.toMatchObject({ code: "invalid_date" });
  });

  /* ═══════ THE SAFETY QUESTION IS ASKED AT THIS DOOR TOO, AND IT IS THE SAME ONE ═══════ */

  /**
   * ═══ THE EXTRACTION IS THE POINT OF THIS TEST ═══
   *
   * Before T1 these three refusals lived inside `recordAcquired` and nothing else could ask them.
   * A new door that wrote contrast facts without asking would be a second, laxer answer to *"may
   * contrast go into this patient"* — and the allergy case is the one that kills someone.
   */
  it("refuses the injection when the patient's allergy list names a contrast agent", async () => {
    await contrastBook("required");
    const study = await onTheTable();
    await db.insert(patientAllergies).values({
      id: newId(), patientId: fx.patientId, substance: "Iohexol", severity: "severe",
      source: "registration", recordedBy: "t",
    });

    await expect(give(study.studyId)).rejects.toMatchObject({ code: "contrast_mismatch" });
    expect(await contrastAdministrationsFor(db, study.studyId)).toHaveLength(0);
  });

  it("refuses the injection on a study type the book says takes no contrast", async () => {
    await contrastBook("none");
    const study = await onTheTable();
    await expect(give(study.studyId)).rejects.toMatchObject({ code: "contrast_mismatch" });
  });

  /**
   * `contrast_option: 'optional'` opens NO contrast gates at check-in — T5's decision, because
   * whether an optional study receives contrast is decided at the console. So the consent gate is
   * "not open", and the injection is refused until somebody opens and clears it. This is the exact
   * seam T5 recorded and T7 owed, arriving at the second door.
   */
  it("refuses the injection when the contrast consent gate was never opened", async () => {
    await contrastBook("optional");
    const study = await onTheTable();
    await expect(give(study.studyId)).rejects.toMatchObject({ code: "contrast_mismatch" });
  });
});
