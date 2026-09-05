import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../test/helpers/radiology";
import {
  events, imagingContrastReactions, imagingDefinitions, imagingStudies, patientAllergies,
} from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { listAllergies } from "../patients";
import { checkIn } from "./checkin";
import { evaluateReadiness, isContrastAllergen, requireStudyGate, satisfyGate } from "./gates";
import { scheduleStudy } from "./schedule";
import { abortAcquisition, startAcquisition } from "./acquisition";
import { recordContrastAdministration } from "./contrast";
import { contrastAllergySubstance, contrastReactionHistory, recordContrastReaction } from "./reactions";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a-iii T2 — **the reaction, the allergy write, and the loop.**
 *
 * The phase doc names the one test this suite exists for: *"record a severe reaction, then start a
 * new contrast CT for that patient and prove `prior_contrast_reaction` now refuses. A reaction that
 * does not reach the next gate is the defect."* That test is `THE LOOP` below, and it is run twice —
 * once with an agent the allergen term list knows, and once with a brand it has never heard of,
 * because the second is the one a term-list implementation silently fails.
 */
describe("contrast reactions (18a-iii T2)", () => {
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
    await db.update(imagingDefinitions).set({
      body: {
        types: [
          studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg" }),
          studyTypeRow({ code: "XR-CHEST", service_id: fx.services["XR-CHEST"]!, modality: "xray", ionising: true }),
          studyTypeRow({
            code: "CT-HEAD", service_id: fx.services["CT-HEAD"]!, modality: "ct", ionising: true,
            contrast_option: "required",
          }),
          studyTypeRow({ code: "MRI-BRAIN", service_id: fx.services["MRI-BRAIN"]!, modality: "mri" }),
        ] satisfies StudyType[],
      },
    }).where(eq(imagingDefinitions.kind, "study_types"));
  });
  afterEach(() => { fx.unregister(); });

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

  /** Books a CT, checks in, and returns the study plus the gate kinds check-in opened. */
  const arrive = async () => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, "CT-HEAD", `k${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices.ct!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    return { study, gates: checked.gates };
  };

  /** …and clears every gate, starts on the machine. `over` supplies evidence for a named gate. */
  const onTheTable = async (over: Record<string, unknown> = {}) => {
    const { study, gates } = await arrive();
    for (const kind of gates) {
      const gate = await requireStudyGate(db, study.studyId, kind);
      const evidence = kind in over ? over[kind] : evidenceFor(kind, "CT-HEAD");
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence, NOW));
    }
    await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
    await db.update(imagingStudies).set({ priority: "stat" }).where(eq(imagingStudies.id, study.studyId));
    await withTx(db, (tx) => startAcquisition(tx, fx.radiographer, fx.decls, {
      studyId: study.studyId, now: NOW,
    }));
    return study;
  };

  const inject = async (agent = "Omnipaque 350") => {
    const study = await onTheTable();
    const { administrationId } = await withTx(db, (tx) => recordContrastAdministration(
      tx, fx.radiographer,
      {
        studyId: study.studyId, agent, volumeMl: 90, route: "intravenous",
        givenBy: fx.radiographer.id, givenAt: NOW, now: NOW,
      },
    ));
    return { study, administrationId };
  };

  const react = (administrationId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => recordContrastReaction(tx, fx.radiographer, {
      administrationId, severity: "severe", onset: "immediate",
      manifestation: "bronchospasm and hypotension on the table",
      treatmentGiven: "adrenaline 0.5 mg IM, oxygen, IV fluids",
      managingClinicianId: fx.radiologist.id,
      observedBy: fx.radiographer.id, observedAt: new Date(NOW.getTime() + 120_000),
      now: new Date(NOW.getTime() + 180_000), ...over,
    }));

  /* ════════════════════════════════ THE LOOP ════════════════════════════════ */

  /**
   * ═══ THE TEST THIS TASK EXISTS FOR ═══
   *
   * A reaction recorded in radiology and invisible to the next CT's gate is the defect. Nothing
   * short of driving a SECOND study through check-in and asking the gate proves it closed: the
   * reaction row, the allergy row and the event all exist in the mutant that writes an allergy the
   * gate cannot match.
   */
  it("THE LOOP: after a severe reaction, the next contrast CT's gate refuses without a radiologist", async () => {
    const first = await inject();
    await react(first.administrationId);

    const next = await arrive();
    expect(next.gates).toContain("prior_contrast_reaction");
    const gate = await requireStudyGate(db, next.study.studyId, "prior_contrast_reaction");

    await expect(withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, {}, NOW)))
      .rejects.toMatchObject({ code: "gate_open" });
  });

  /**
   * ═══ THE BRAND THE TERM LIST HAS NEVER HEARD OF ═══
   *
   * `CONTRAST_ALLERGEN_TERMS` holds `omnipaque`, `iohexol`, `gadolinium` and thirteen others. It
   * does NOT hold `visipaque`, and it will not hold whatever a purchasing decision brings in next
   * year. A reaction that wrote the bare agent name would put an allergy on the list that
   * `isContrastAllergen` cannot see — the defect arriving through the door built to prevent it —
   * and every other test in this file would still pass.
   */
  it("THE LOOP holds for an agent the allergen term list has never heard of", async () => {
    expect(isContrastAllergen("Visipaque 320")).toBe(false);

    const first = await inject("Visipaque 320");
    await react(first.administrationId, { severity: "moderate", treatmentGiven: null, managingClinicianId: null });

    const [allergy] = await listAllergies(db, fx.patientId);
    expect(isContrastAllergen(allergy!.substance)).toBe(true);

    const next = await arrive();
    const gate = await requireStudyGate(db, next.study.studyId, "prior_contrast_reaction");
    await expect(withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, {}, NOW)))
      .rejects.toMatchObject({ code: "gate_open" });
  });

  /**
   * ═══ AND THE SECOND DOOR IS STRICTER THAN THE GATE, WHICH IS 18a's RULE AND NOT A NEW ONE ═══
   *
   * The gate CAN be satisfied over a documented allergy — by a named radiologist, with a reason —
   * and that is how a premedicated patient reaches the table at all. **The injection still refuses.**
   * F67's rule is that only an OVERRIDDEN `prior_contrast_reaction` goes past a documented reaction
   * at the syringe, and `assertContrastPermissible` carries that verbatim out of `recordAcquired`.
   *
   * The first draft of this test could not even build its fixture: `onTheTable()` threw at
   * `satisfyGate`, because after T2's allergy write a technologist can no longer clear that gate at
   * all. The loop was working harder than the test expected, which is the good direction to be wrong
   * in — but a test that dies in its own setup proves nothing about the door it was aimed at.
   */
  it("and the injection is refused on the next study too — a SATISFIED gate is not an override", async () => {
    const first = await inject();
    await react(first.administrationId);
    /**
     * The reaction ends the scan and the machine goes back to the department — which is also what
     * frees the CT for the second study. Without it this test dies in `assignResource` with the
     * first study still holding the gantry, which is a fixture failure wearing a product error's
     * clothes.
     */
    await withTx(db, (tx) => abortAcquisition(tx, fx.radiographer, fx.decls, {
      studyId: first.study.studyId, reason: "contrast reaction — scan abandoned", now: NOW,
    }));

    const next = await onTheTable({
      prior_contrast_reaction: {
        radiologistId: fx.radiologist.id,
        reason: "premedicated with steroids and antihistamine; benefit outweighs risk",
      },
    });

    await expect(withTx(db, (tx) => recordContrastAdministration(tx, fx.radiographer, {
      studyId: next.studyId, agent: "Omnipaque 350", volumeMl: 90, route: "intravenous",
      givenBy: fx.radiographer.id, givenAt: NOW, now: NOW,
    }))).rejects.toMatchObject({ code: "contrast_mismatch" });
  });

  /**
   * The technologist's lane is closed the moment the reaction is on the record — proved directly,
   * because the test above now depends on it working and would otherwise pass for the wrong reason.
   */
  it("a technologist can no longer clear the prior-reaction gate at all once a reaction is recorded", async () => {
    const first = await inject();
    await react(first.administrationId);
    const next = await arrive();
    const gate = await requireStudyGate(db, next.study.studyId, "prior_contrast_reaction");
    await expect(withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, {}, NOW)))
      .rejects.toMatchObject({ code: "gate_open" });
  });

  /* ═══════════════════ WHAT THE SUBSTANCE MUST KEEP LOOKING LIKE ═══════════════════ */

  /**
   * ═══ THE HALF OF A CROSS-MODULE DEPENDENCY THAT NOTHING ELSE PINS ═══
   *
   * `opd/rx-checks.ts` warns a prescriber about an allergy by matching the substance against the
   * drug text BOTH WAYS. The class label breaks the forward arm, so the warning survives only
   * because the substance still CONTAINS the bare agent — and opd's own suite pins its two-way
   * match, so that side is guarded.
   *
   * This side was not. A later change writing `"contrast media: <agent>"`, or dropping the agent,
   * would leave opd's second arm running and finding nothing: **the prescriber's contrast warning
   * disappears, with no error and no red test anywhere.** The two modules cannot import each other,
   * so this is the strongest assertion the boundary permits — weaker than a cross-module one, and
   * pointed at the side whose change fails silently.
   */
  it("the substance CONTAINS the bare agent — the property opd's prescription check matches on", () => {
    for (const agent of ["Omnipaque 350", "Visipaque 320", "Gadoterate meglumine", "Barium sulphate"]) {
      const substance = contrastAllergySubstance(agent);
      expect(substance.toLowerCase()).toContain(agent.toLowerCase());
      /** And long enough to stay in opd's two-way band rather than its one-way token branch. */
      expect(substance.length).toBeGreaterThanOrEqual(4);
      /** And still a contrast allergen to radiology's own reader, whatever the brand. */
      expect(isContrastAllergen(substance)).toBe(true);
    }
  });

  /* ═══════════════════ THE ALLERGY WRITE IS THE SAME TRANSACTION ═══════════════════ */

  it("writes the allergy from the agent that actually went in, sourced to radiology", async () => {
    const { administrationId } = await inject();
    const { reactionId, allergyId } = await react(administrationId);

    const allergies = await listAllergies(db, fx.patientId);
    expect(allergies).toHaveLength(1);
    expect([allergies[0]!.id, allergies[0]!.substance, allergies[0]!.severity, allergies[0]!.source])
      .toEqual([allergyId, contrastAllergySubstance("Omnipaque 350"), "severe", "radiology"]);
    expect(allergies[0]!.reaction).toBe("bronchospasm and hypotension on the table");

    const [row] = await db.select().from(imagingContrastReactions)
      .where(eq(imagingContrastReactions.id, reactionId));
    expect([row!.allergyId, row!.patientId, row!.administrationId])
      .toEqual([allergyId, fx.patientId, administrationId]);
  });

  /** D2 at every severity: a mild reaction today is the only warning before a severe one next time. */
  it("a MILD reaction writes the allergy too", async () => {
    const { administrationId } = await inject();
    await react(administrationId, {
      severity: "mild", manifestation: "transient nausea", treatmentGiven: null,
      managingClinicianId: null,
    });
    expect(await listAllergies(db, fx.patientId)).toHaveLength(1);
  });

  /**
   * ═══ THE MUTANT THAT PROVES THIS ONE TAKES TWO SITES TO BREAK ═══
   *
   * A single-site mutant — adding `manifestation` to the payload OBJECT in `reactions.ts` — SURVIVES
   * this test, and it survives for a reassuring reason rather than a worrying one: `defineEvent`'s
   * `make()` is `payloadSchema.parse(args.payload)` (`packages/contracts/src/envelope.ts:89`) and zod
   * strips unknown keys, so the field is dropped before it ever reaches `events`. One site cannot
   * break the property, so a one-site mutant tests nothing about it.
   *
   * The reachable defect takes TWO edits, and it is how the leak would actually arrive: a later task
   * widens the event's zod schema *because a consumer wants a field*, and the service fills it in.
   * That two-site mutant was run and **died here** — `toEqual` pins the payload's exact key set, so a
   * widened schema with a narrative in it reddens this line rather than shipping.
   */
  it("emits imaging.contrast_reaction carrying ids and a severity — and never the manifestation", async () => {
    const { administrationId } = await inject();
    const { reactionId, allergyId } = await react(administrationId);

    const emitted = (await db.select().from(events))
      .filter((e) => e.name === "imaging.contrast_reaction");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({
      studyId: expect.any(String), administrationId, reactionId, allergyId,
      severity: "severe", onset: "immediate",
    });
    expect(JSON.stringify(emitted[0]!.payload)).not.toContain("bronchospasm");
  });

  /* ═══════════════════════ WHAT THE RECORD REQUIRES (D3) ═══════════════════════ */

  /**
   * The refusal is asserted with its AFTERMATH: the severity check runs BEFORE `addAllergy`, so a
   * refused severe reaction must leave the patient's allergy list untouched. A guard placed after
   * the write throws exactly the same error and leaves an allergy for a reaction nobody recorded.
   */
  it("a SEVERE reaction with no treatment and no clinician is refused, and writes no allergy", async () => {
    const { administrationId } = await inject();
    await expect(react(administrationId, { treatmentGiven: null, managingClinicianId: null }))
      .rejects.toMatchObject({ code: "evidence_invalid" });

    expect(await listAllergies(db, fx.patientId)).toHaveLength(0);
    expect(await contrastReactionHistory(db, fx.patientId)).toHaveLength(0);
  });

  it("a MODERATE reaction needs neither — severity decides what the record requires, not who writes it", async () => {
    const { administrationId } = await inject();
    await expect(react(administrationId, {
      severity: "moderate", treatmentGiven: null, managingClinicianId: null,
    })).resolves.toBeDefined();
  });

  it("the database itself refuses a severe reaction with no managing clinician", async () => {
    const { study, administrationId } = await inject();
    const [allergy] = await db.insert(patientAllergies).values({
      id: newId(), patientId: fx.patientId, substance: "x", source: "registration", recordedBy: "t",
    }).returning({ id: patientAllergies.id });

    await expect(db.insert(imagingContrastReactions).values({
      id: newId(), administrationId, studyId: study.studyId, patientId: fx.patientId,
      allergyId: allergy!.id, severity: "severe", onset: "immediate", manifestation: "arrest",
      treatmentGiven: "CPR", managingClinicianId: null,
      observedBy: fx.radiographer.id, observedAt: NOW, recordedBy: "t",
    })).rejects.toThrow(/imaging_contrast_reactions_severe_ck/);
  });

  /* ═══════════════════════════ THE CLOCK AND THE DOSE ═══════════════════════════ */

  it("refuses a reaction timed BEFORE the dose it reacts to", async () => {
    const { administrationId } = await inject();
    await expect(react(administrationId, { observedAt: new Date(NOW.getTime() - 60_000) }))
      .rejects.toMatchObject({ code: "invalid_date" });
    expect(await listAllergies(db, fx.patientId)).toHaveLength(0);
  });

  it("refuses a reaction timed in the future", async () => {
    const { administrationId } = await inject();
    await expect(react(administrationId, {
      observedAt: new Date(NOW.getTime() + 3_600_000), now: NOW,
    })).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("refuses a reaction to a dose that does not exist, and writes nothing", async () => {
    await inject();
    await expect(react(newId())).rejects.toMatchObject({ code: "unknown_administration" });
    expect(await listAllergies(db, fx.patientId)).toHaveLength(0);
  });

  /* ═════════════════════ RECORD-ONLY: `ot` IS NOT REACHED INTO (D1) ═════════════════════ */

  it("records no OT incident — the hospital-wide register is 28a's and does not exist", async () => {
    const { administrationId } = await inject();
    await react(administrationId);
    const emitted = (await db.select().from(events)).map((e) => e.name);
    expect(emitted).not.toContain("incident.reported");
    expect(emitted).toContain("imaging.contrast_reaction");
  });
});
