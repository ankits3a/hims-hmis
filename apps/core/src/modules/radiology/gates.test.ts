import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  placeAndCreateStudy, setupRadiologyFixture, studyTypeRow,
} from "../../../test/helpers/radiology";
import {
  events, imagingDefinitions, imagingSafetyScreenings, patientAllergies, patients,
} from "../../kernel/db/schema";
import { ROLE_MODEL } from "../../../scripts/seed-roles";
import { withTx } from "../../kernel/db/client";
import { checkIn } from "./checkin";
import { RadiologyError } from "./errors";
import {
  RENAL_CREATININE_CEILING_UMOL_L, RENAL_VALIDITY_DAYS_ADMITTED, RENAL_VALIDITY_DAYS_OPD,
  WAIVABLE_KINDS, evaluateReadiness, gateState, isContrastAllergen, overrideGate, readiness,
  requireStudyGate, satisfyGate, studyGates, studyState, waiveGate,
} from "./gates";
import { scheduleStudy } from "./schedule";
import { imagingGateDefinition } from "./workflow-def";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T5 — Assertion Book rows **A2, A3, A4, A5 and A6**. A1 is `checkin.test.ts` and A7 is
 * `gates.concurrency.test.ts`, because a race needs two connections and this suite runs on one.
 *
 * ═══ ONE FIXTURE, MANY STUDIES — §2.144 / F17 ═══
 *
 * The T4 lane wrote a race test that rebuilt the whole radiology fixture inside a loop, passed in
 * isolation, blew the 15 s budget under a full workspace verify, and left abandoned async work that
 * failed the NEXT test on `patients_pkey`. Nothing in this suite rebuilds a fixture: `beforeEach`
 * builds one, and every test takes its own study, its own placement instant and its own slot.
 */
/**
 * ═══ F9's LESSON, MADE INTO AN INSTRUMENT: BOTH ENFORCEMENT PLANES, PINNED SIDE BY SIDE ═══
 *
 * `transition` gates on ROLE KEYS in `role_assignments` and consults no permission at any point;
 * the HTTP guard reads the PERMISSION registry and consults no transition. **A rule stated on one
 * plane and not the other is not a rule** — F9 is what that cost this phase, and F19 is the same
 * defect class measured pointing the other way.
 *
 * Both planes are read from their SHIPPED sources — `imagingGateDefinition` and `ROLE_MODEL` — and
 * neither from the fixture, which grants no radiology permissions at all and would make an
 * assertion against the database vacuous. No database is touched here on purpose: this is a census,
 * and it must fail the moment either plane moves without the other.
 */
describe("the two enforcement planes, pinned against each other (18a T5 A3 / F9 / F19)", () => {
  const rolesOn = (to: string) => [...imagingGateDefinition.transitions
    .find((t) => t.from === "open" && t.to === to)!.roles].sort();
  const holdersOf = (permission: string) => ROLE_MODEL
    .filter((r) => r.permissions.includes(permission)).map((r) => r.roleKey).sort();

  /** THE OVERRIDE LANE — the two planes COINCIDE, and A3's role half rides on that. */
  it("A3: the override and waiver edges name `radiologist`, and so does the permission model", () => {
    expect(rolesOn("overridden")).toEqual(["radiologist"]);
    expect(rolesOn("waived")).toEqual(["radiologist"]);
    expect(holdersOf("radiology.gates.override")).toEqual(["radiologist"]);
  });

  /**
   * ═══ F19 — THE SATISFY LANE, WHERE THEY DO NOT COINCIDE, PINNED RATHER THAN PAPERED OVER ═══
   *
   * `open → satisfied` names four roles; `radiology.gates.satisfy` is granted to ONE. So a
   * radiologist or a doctor is refused 403 by the guard before the engine's role check ever runs,
   * and two of the four names on that edge are dead. It fails SAFE — the narrower plane wins — and
   * it is recorded here so that a later change to EITHER plane trips this assertion and forces the
   * ruling the close review owns, instead of one plane being quietly widened to match the other.
   */
  it("F19: the satisfy edge names four roles and the permission model grants one — a MEASURED disagreement", () => {
    expect(rolesOn("satisfied")).toEqual(["doctor", "radiographer", "radiologist", "system"]);
    expect(holdersOf("radiology.gates.satisfy")).toEqual(["radiographer"]);
    /** And check-in is the same hand: the desk that takes the money opens no gate set. */
    expect(holdersOf("radiology.checkin")).toEqual(["radiographer"]);
  });
});

/**
 * The allergen term list is pure, so it is walked HERE rather than inside the database block.
 *
 * Seven cases sitting in a suite with a `beforeEach` that rebuilds the whole radiology fixture cost
 * eleven seconds to assert seven string comparisons — §2.144's shape in miniature, and the reason
 * to look at what a case actually needs before choosing where it lives. It over-matches rather than
 * under-matches on purpose: that is the direction a safety flag belongs.
 */
describe("the contrast allergen term list is pure, and over-matches on purpose (18a T5 A5)", () => {
  it.each([
    ["Iodine", true], ["iohexol", true], ["GADOLINIUM", true], ["contrast media", true],
    ["Iohexol (Omnipaque)", true], ["gadobutrol", true],
    ["penicillin", false], ["sulfa drugs", false], ["dust", false], ["latex", false],
  ])("isContrastAllergen(%s) = %s", (substance, expected) => {
    expect(isContrastAllergen(substance)).toBe(expected);
  });
});

describe("the ten imaging safety gates (18a T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    seq = 0;
  });
  afterEach(() => { fx.unregister(); });

  let seq = 0;

  const rewriteBook = async (types: StudyType[]) => {
    await db.update(imagingDefinitions).set({ body: { types } })
      .where(eq(imagingDefinitions.kind, "study_types"));
  };
  const bookRow = (code: string, over: Partial<StudyType>) =>
    studyTypeRow({ code, service_id: fx.services[code]!, ...over });

  /** Places, books a slot, and checks in — the precondition every gate assertion needs. */
  const arrive = async (serviceCode: string, deviceKey: string) => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, serviceCode, `g${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    return { ...study, gates: checked.gates };
  };

  const gateIdFor = async (studyId: string, kind: string) =>
    (await requireStudyGate(db, studyId, kind)).id;

  const satisfy = (gateId: string, evidence: unknown, now = NOW, actor = fx.radiographer) =>
    withTx(db, (tx) => satisfyGate(tx, actor, gateId, evidence, now));

  /** The identity evidence the fixture's own patient satisfies — used wherever identity is noise. */
  const IDENTITY_OK = { secondIdentifier: "uhid" as const, value: "HMS-00000001-5" };

  /* ══════════════════════════ A2 — THE STATUTORY REFUSALS ══════════════════════════ */

  /**
   * ═══ A2 — THE REFUSAL HAPPENS WITH AN EMPTY DEFINITION TABLE ═══
   *
   * A2's mutant consults the definition FIRST, and the harm it names is one row away: a governed
   * body that lists `form_f` as waivable makes it waivable, and a governed body is DATA a human
   * republishes. So the assertion is not "form_f is refused" — it is "form_f is refused when there
   * is no definition to consult at all", which no ordering-by-luck can pass.
   *
   * The whole `imaging_definitions` table is DELETED after check-in, so `requireStudyType`,
   * `activeStudyTypes` and `pregnancyPolicy` would every one of them throw if they were reached.
   */
  it("A2: waiveGate('form_f') is refused BEFORE any definition is consulted — with the table empty", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("USG-ABDO", "usg");
    expect(study.gates).toContain("form_f");
    const gateId = await gateIdFor(study.studyId, "form_f");

    await db.delete(imagingDefinitions);
    expect(await db.select().from(imagingDefinitions)).toEqual([]);

    await expect(withTx(db, (tx) => waiveGate(tx, fx.radiologist, gateId, "casualty is full")))
      .rejects.toMatchObject({ code: "gate_not_overridable" });
    expect(await gateState(db, gateId)).toBe("open");
  });

  it("A2: overrideGate('form_f') is refused the same way, and the radiologist's role does not help", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "form_f");
    await db.delete(imagingDefinitions);

    const e = await withTx(db, (tx) => overrideGate(tx, fx.radiologist, gateId, "benefit outweighs risk"))
      .catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("gate_not_overridable");
    expect(String(e)).toMatch(/no emergency bypass exists/);
    expect(await gateState(db, gateId)).toBe("open");
  });

  /**
   * N2 from the OTHER side, and it is the half a reader would not think to check: the refusal is not
   * merely a missing transition on the definition. `open → waived` and `open → overridden` BOTH
   * exist on `imaging_gate` — they have to, for the other nine kinds — so if `waiveGate` did not
   * refuse by KIND, the engine would happily move a `form_f` gate.
   */
  it("A2: the engine itself has both lanes — the form_f refusal is CODE, not an absent transition", () => {
    const lanes = imagingGateDefinition.transitions
      .filter((t) => t.from === "open").map((t) => t.to).sort();
    expect(lanes).toEqual(["overridden", "satisfied", "waived"]);
  });

  /** A6's second half: identity is never WAIVED. It is overridable, and that is a different act. */
  it("A2/A6: identity_two_factor is never waivable, and is refused before the row's own flag is read", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "identity_two_factor");
    /** Even with the column hand-flipped to `true`, the KIND decides. */
    await db.update(imagingSafetyScreenings).set({ waivable: true })
      .where(eq(imagingSafetyScreenings.id, gateId));

    await expect(withTx(db, (tx) => waiveGate(tx, fx.radiologist, gateId, "unconscious, no papers")))
      .rejects.toMatchObject({ code: "gate_not_overridable" });

    /** …and the override lane IS open to it, with a reason. */
    const done = await withTx(db, (tx) => overrideGate(tx, fx.radiologist, gateId, "unidentified male, trauma"));
    expect(done.state).toBe("overridden");
  });

  it("a kind outside WAIVABLE_KINDS is refused even though its lane exists on the definition", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg" }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("CT-HEAD", "ct");
    const gateId = await gateIdFor(study.studyId, "renal_function");
    expect(WAIVABLE_KINDS).not.toContain("renal_function");
    await expect(withTx(db, (tx) => waiveGate(tx, fx.radiologist, gateId, "no lab today")))
      .rejects.toMatchObject({ code: "gate_not_overridable" });
  });

  it("a WAIVABLE kind takes a waiver with a reason, and refuses a blank one", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", chaperone_required: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "chaperone_present");

    await expect(withTx(db, (tx) => waiveGate(tx, fx.radiologist, gateId, "   ")))
      .rejects.toMatchObject({ code: "reason_required" });

    const done = await withTx(db, (tx) => waiveGate(tx, fx.radiologist, gateId, "patient declined a chaperone"));
    expect(done.state).toBe("waived");
    const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
    expect(row!.evidence).toMatchObject({ kind: "waiver", reason: "patient declined a chaperone" });
  });

  /* ══════════════════════════ A3 — THE OVERRIDE LANE ══════════════════════════ */

  /**
   * ═══ A3 — A REASON, A RECORD AND AN EVENT ═══
   *
   * A3's mutant drops the reason, and what it costs is the whole control: P1's *"benefit outweighs
   * risk"* becomes a click on a screen. Blank and whitespace are both refused, because `.trim()` is
   * the difference between a rule and a formality.
   */
  it("A3: an override with no reason is refused, and the gate does not move", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "identity_two_factor");

    for (const reason of ["", "   ", "\n\t"]) {
      await expect(withTx(db, (tx) => overrideGate(tx, fx.radiologist, gateId, reason)))
        .rejects.toMatchObject({ code: "reason_required" });
    }
    expect(await gateState(db, gateId)).toBe("open");
  });

  it("A3: an override writes {actorId, reason} and emits imaging.gate_evaluated{overridden}", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "identity_two_factor");

    await withTx(db, (tx) => overrideGate(tx, fx.radiologist, gateId, "unidentified male, trauma bay"));

    const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
    expect(row!.override).toEqual({ actorId: fx.radiologist.id, reason: "unidentified male, trauma bay" });

    const emitted = (await db.select().from(events)).filter((e) => e.name === "imaging.gate_evaluated");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({
      studyId: study.studyId, kind: "identity_two_factor", outcome: "overridden",
      evidenceRef: null, actorId: fx.radiologist.id,
    });
  });

  it("A3: a radiographer cannot override — the engine refuses on the plane it actually reads", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "identity_two_factor");
    await expect(withTx(db, (tx) => overrideGate(tx, fx.radiographer, gateId, "we are busy")))
      .rejects.toMatchObject({ code: "role_denied" });
    expect(await gateState(db, gateId)).toBe("open");
  });

  /* ══════════════════════════ A4 — THE RENAL WINDOW ══════════════════════════ */

  describe("A4 — the creatinine's validity is the CONTEXT's, and the context is derived", () => {
    const contrastCt = async () => {
      await rewriteBook([
        bookRow("USG-ABDO", { modality: "usg" }),
        bookRow("XR-CHEST", { modality: "xray", ionising: true }),
        bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
        bookRow("MRI-BRAIN", { modality: "mri" }),
      ]);
      const study = await arrive("CT-HEAD", "ct");
      return { studyId: study.studyId, gateId: await gateIdFor(study.studyId, "renal_function") };
    };
    const sampled = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

    /**
     * A4's first leg. Thirty-one days in an OPD context is one day past the window, which is the
     * boundary the mutant walks straight through.
     */
    it("A4: 31 days old on an OPD visit is `evidence_stale` and the gate stays open", async () => {
      const { gateId } = await contrastCt();
      const e = await satisfy(gateId, { creatinineUmolL: 80, sampledAt: sampled(31), source: "internal" })
        .catch((x: unknown) => x);
      expect((e as { code: string }).code).toBe("evidence_stale");
      expect(String(e)).toMatch(/valid for 30 in a opd/);
      expect(await gateState(db, gateId)).toBe("open");
    });

    it("A4: 30 days old on the same visit is FRESH — the window is inclusive at its edge", async () => {
      const { gateId } = await contrastCt();
      const done = await satisfy(gateId, {
        creatinineUmolL: 80, sampledAt: sampled(RENAL_VALIDITY_DAYS_OPD), source: "internal",
      });
      expect(done.state).toBe("satisfied");
    });

    /**
     * A4's second leg, and the one whose mutant the plan names: *"compare days with the wrong
     * context → an ICU creatinine from last month passes gadolinium"*. Six days in a CKD-flagged
     * context is fresh; twenty is not, and twenty WOULD be fresh if the OPD window were used.
     */
    it("A4: a CKD-flagged patient gets 7 days — 6 passes, 20 does not, and 20 would pass on the OPD window", async () => {
      const first = await contrastCt();
      const fresh = await satisfy(first.gateId, {
        creatinineUmolL: 95, sampledAt: sampled(6), source: "internal", ckdFlagged: true,
      });
      expect(fresh.state).toBe("satisfied");

      const second = await contrastCt();
      const e = await satisfy(second.gateId, {
        creatinineUmolL: 95, sampledAt: sampled(20), source: "internal", ckdFlagged: true,
      }).catch((x: unknown) => x);
      expect((e as { code: string }).code).toBe("evidence_stale");
      expect((e as { detail: { validDays: number } }).detail.validDays).toBe(RENAL_VALIDITY_DAYS_ADMITTED);
      expect(20).toBeLessThan(RENAL_VALIDITY_DAYS_OPD);
    });

    /** H5 — the outside lab's creatinine on paper is ACCEPTED, and the flag stays visible for ever. */
    it("A4: an `external` source satisfies, and `external` is still in the stored evidence (H5)", async () => {
      const { gateId } = await contrastCt();
      await satisfy(gateId, { creatinineUmolL: 72, sampledAt: sampled(3), source: "external" });
      const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
      expect(row!.evidence).toMatchObject({ kind: "renal_function", source: "external", context: "opd" });
    });

    /** A creatinine the gate RECORDS without reading would be a checkbox with a number on it. */
    it("A4: a creatinine above the contrast ceiling cannot SATISFY — it is the override's lane", async () => {
      const { gateId } = await contrastCt();
      const e = await satisfy(gateId, {
        creatinineUmolL: RENAL_CREATININE_CEILING_UMOL_L + 0.1, sampledAt: sampled(1), source: "internal",
      }).catch((x: unknown) => x);
      expect((e as { code: string }).code).toBe("gate_open");
      const done = await withTx(db, (tx) => overrideGate(tx, fx.radiologist, gateId, "CT is the only way to find the bleed"));
      expect(done.state).toBe("overridden");
    });
  });

  /* ══════════════════════════ A5 — THE CONTRAST ALLERGY ══════════════════════════ */

  describe("A5 — prior_contrast_reaction reads the PATIENT MASTER's allergy list", () => {
    const contrastCt = async () => {
      await rewriteBook([
        bookRow("USG-ABDO", { modality: "usg" }),
        bookRow("XR-CHEST", { modality: "xray", ionising: true }),
        bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
        bookRow("MRI-BRAIN", { modality: "mri" }),
      ]);
      const study = await arrive("CT-HEAD", "ct");
      return { studyId: study.studyId, gateId: await gateIdFor(study.studyId, "prior_contrast_reaction") };
    };
    const allergy = (substance: string, status = "active") => db.insert(patientAllergies).values({
      id: newId(), patientId: fx.patientId, substance, severity: "severe",
      source: "registration", status, recordedBy: "t",
    });

    it("with no contrast allergy on the record the gate satisfies, and says how many it checked", async () => {
      await allergy("penicillin");
      const { gateId } = await contrastCt();
      const done = await satisfy(gateId, {});
      expect(done.state).toBe("satisfied");
      const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
      expect(row!.evidence).toMatchObject({ contrastAllergyFound: false, allergiesChecked: 1 });
    });

    /**
     * A5's mutant reads the prescription's `allergy_overrides` instead, and what that costs is
     * exactly this row: an allergy recorded at REGISTRATION is invisible to a CT with contrast. The
     * allergy below is written to the patient master and to nothing else.
     */
    it("A5: a contrast-class allergy on the patient master leaves the gate OPEN with a hard warning", async () => {
      await allergy("Iohexol (Omnipaque)");
      const { gateId } = await contrastCt();
      const e = await satisfy(gateId, {}).catch((x: unknown) => x);
      expect((e as { code: string }).code).toBe("gate_open");
      expect(String(e)).toMatch(/recorded contrast allergy/);
      expect((e as { detail: { substances: string[] } }).detail.substances).toEqual(["Iohexol (Omnipaque)"]);
      expect(await gateState(db, gateId)).toBe("open");
    });

    it("A5: it is satisfiable ONLY with a named radiologist's reason (P2)", async () => {
      await allergy("gadolinium");
      const { gateId } = await contrastCt();

      /** A reason from nobody in particular is not a radiologist's decision. */
      await expect(satisfy(gateId, { reason: "we will pre-medicate" }))
        .rejects.toMatchObject({ code: "gate_open" });
      /** A named person who is not a radiologist is not one either. */
      await expect(satisfy(gateId, { radiologistId: fx.radiographer.id, reason: "we will pre-medicate" }))
        .rejects.toMatchObject({ code: "evidence_invalid" });

      const done = await satisfy(gateId, {
        radiologistId: fx.radiologist.id, reason: "steroid cover, ITU informed",
      });
      expect(done.state).toBe("satisfied");
      const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
      expect(row!.evidence).toMatchObject({
        contrastAllergyFound: true, radiologistId: fx.radiologist.id, reason: "steroid cover, ITU informed",
      });
    });

    /** A corrected allergy is not an allergy. `entered_in_error` is the patients module's own answer. */
    it("an allergy marked entered_in_error does not hold the gate", async () => {
      await allergy("iodine", "entered_in_error");
      const { gateId } = await contrastCt();
      expect((await satisfy(gateId, {})).state).toBe("satisfied");
    });

  });

  /* ══════════════════════════ A6 — READINESS ══════════════════════════ */

  describe("A6 — every opened gate terminal, and not one gate sooner", () => {
    const contrastCt = async () => {
      await rewriteBook([
        bookRow("USG-ABDO", { modality: "usg" }),
        bookRow("XR-CHEST", { modality: "xray", ionising: true }),
        bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
        bookRow("MRI-BRAIN", { modality: "mri" }),
      ]);
      return await arrive("CT-HEAD", "ct");
    };

    /**
     * A6's mutant counts `satisfied` only. Its discriminating input is FOUR of five gates satisfied
     * and one overridden: the shipped code readies the study and the mutant leaves it `checked_in`
     * for ever — so the floor learns to satisfy gates it should be overriding, and P1's record is
     * destroyed by a counting bug.
     */
    it("A6: an OVERRIDDEN gate counts as done — satisfied, waived and overridden are all terminal", async () => {
      const study = await contrastCt();
      expect(study.gates).toHaveLength(5);

      await satisfy(await gateIdFor(study.studyId, "identity_two_factor"), IDENTITY_OK);
      await satisfy(await gateIdFor(study.studyId, "pregnancy_screen"), {
        declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
      });
      await satisfy(await gateIdFor(study.studyId, "renal_function"), {
        creatinineUmolL: 70, sampledAt: NOW.toISOString(), source: "internal",
      });
      await satisfy(await gateIdFor(study.studyId, "prior_contrast_reaction"), {});

      /** Four down, one open: NOT ready, and the open one is named. */
      const before = await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
      expect(before).toEqual({ state: "checked_in", open: ["contrast_consent"] });

      const consentGate = await gateIdFor(study.studyId, "contrast_consent");
      await withTx(db, (tx) => overrideGate(
        tx, fx.radiologist, consentGate, "verbal consent from the son, documented",
      ));
      const after = await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
      expect(after).toEqual({ state: "ready", open: [] });
      expect(await studyState(db, study.studyId)).toBe("ready");
    });

    it("A6: one open gate out of five keeps the study checked_in, and names what is holding it", async () => {
      const study = await contrastCt();
      await satisfy(await gateIdFor(study.studyId, "identity_two_factor"), IDENTITY_OK);
      const result = await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
      expect(result.state).toBe("checked_in");
      expect(result.open.sort()).toEqual([
        "contrast_consent", "pregnancy_screen", "prior_contrast_reaction", "renal_function",
      ]);
    });

    it("A6: a single-gate study readies the moment its one gate is satisfied", async () => {
      const study = await arrive("USG-ABDO", "usg");
      await satisfy(await gateIdFor(study.studyId, "identity_two_factor"), IDENTITY_OK);
      expect(await withTx(db, (tx) => evaluateReadiness(tx, study.studyId)))
        .toEqual({ state: "ready", open: [] });
    });

    /** IDEMPOTENT — the caller is a console that does not know which gate was the last one. */
    it("A6: evaluating a study that is already ready leaves it alone rather than refusing", async () => {
      const study = await arrive("USG-ABDO", "usg");
      await satisfy(await gateIdFor(study.studyId, "identity_two_factor"), IDENTITY_OK);
      await withTx(db, (tx) => evaluateReadiness(tx, study.studyId));
      expect(await withTx(db, (tx) => evaluateReadiness(tx, study.studyId)))
        .toEqual({ state: "ready", open: [] });
    });

    /** The GET reports and never transitions — a screen polling it must not write history. */
    it("the readiness READ reports the same picture and moves nothing", async () => {
      const study = await arrive("USG-ABDO", "usg");
      const view = await readiness(db, study.studyId);
      expect([view.state, view.ready, view.open]).toEqual(["checked_in", false, ["identity_two_factor"]]);
      expect(await studyState(db, study.studyId)).toBe("checked_in");
    });
  });

  /* ══════════════════════════ the per-kind computations ══════════════════════════ */

  it("identity: the second identifier is CHECKED against the patient master, not ticked", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "identity_two_factor");

    await expect(satisfy(gateId, { secondIdentifier: "uhid", value: "HMS-00000009-1" }))
      .rejects.toMatchObject({ code: "gate_open" });
    await expect(satisfy(gateId, { secondIdentifier: "dob", value: "1990-05-05" }))
      .rejects.toMatchObject({ code: "gate_open" });
    expect((await satisfy(gateId, { secondIdentifier: "dob", value: "1996-01-01" })).state).toBe("satisfied");
  });

  it("pregnancy: a declaration ALONE does not carry an ionising study under the default policy", async () => {
    const study = await arrive("XR-CHEST", "xray");
    const gateId = await gateIdFor(study.studyId, "pregnancy_screen");

    await expect(satisfy(gateId, { declared: true }))
      .rejects.toMatchObject({ code: "gate_open" });
    /** …and an LMP quoted from two months ago is a number that means nothing. */
    await expect(satisfy(gateId, {
      declared: true, lmpDate: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(),
    })).rejects.toMatchObject({ code: "evidence_stale" });

    const done = await satisfy(gateId, {
      declared: true, lmpDate: new Date(NOW.getTime() - 12 * 86_400_000).toISOString(),
    });
    expect(done.state).toBe("satisfied");
  });

  /**
   * A mistyped year makes evidence NEGATIVE-aged, which passes every `> validDays` test there is.
   * The two ageing gates are walked, because a window check is exactly where a typo becomes a
   * satisfied safety gate.
   */
  it("evidence dated in the FUTURE is refused rather than aged — a typo must not clear a window", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg" }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("CT-HEAD", "ct");
    const tomorrow = new Date(NOW.getTime() + 86_400_000).toISOString();

    await expect(satisfy(await gateIdFor(study.studyId, "renal_function"), {
      creatinineUmolL: 70, sampledAt: tomorrow, source: "internal",
    })).rejects.toMatchObject({ code: "evidence_invalid" });
    await expect(satisfy(await gateIdFor(study.studyId, "pregnancy_screen"), {
      declared: true, lmpDate: tomorrow,
    })).rejects.toMatchObject({ code: "evidence_invalid" });
  });

  it("pregnancy: a patient who has NOT declared cannot satisfy — that is the radiologist's call", async () => {
    const study = await arrive("XR-CHEST", "xray");
    const gateId = await gateIdFor(study.studyId, "pregnancy_screen");
    await expect(satisfy(gateId, { declared: false })).rejects.toMatchObject({ code: "gate_open" });
  });

  it("mri_safety: a pacemaker cannot be SATISFIED away, and claustrophobia does not block", async () => {
    const study = await arrive("MRI-BRAIN", "mri");
    const gateId = await gateIdFor(study.studyId, "mri_safety");
    const base = { implants: [], pacemaker: false, clips: false, cochlear: false, metalFb: false };

    for (const positive of ["pacemaker", "clips", "cochlear", "metalFb"]) {
      await expect(satisfy(gateId, { ...base, [positive]: true }))
        .rejects.toMatchObject({ code: "gate_open" });
    }
    const done = await satisfy(gateId, { ...base, claustrophobia: true, implants: ["titanium hip, 2019"] });
    expect(done.state).toBe("satisfied");
  });

  /**
   * The consent SHAPE is `ot/consents.ts`'s, imported rather than copied — §5 T5's own instruction.
   * What differs is what it is checked AGAINST: the STUDY TYPE instead of a procedure code, and a
   * laterality that may be `na` on the study and is `null` on the consent. H6 and K4 both still
   * bite, which is the whole reason for reusing the schema instead of writing a thinner one.
   */
  it("contrast_consent: the OT's consent schema, checked against the study type (H6) and K4's witness", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg" }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("CT-HEAD", "ct");
    const gateId = await gateIdFor(study.studyId, "contrast_consent");
    const consent = {
      procedureCode: "CT-HEAD", templateVersion: "rad-contrast-v3", language: "hi",
      signer: "patient" as const, conversionCovered: false, laterality: null,
      signedAt: NOW.toISOString(),
    };

    /** H6 — a consent for a different study is not consent to this one. */
    await expect(satisfy(gateId, { ...consent, procedureCode: "MRI-BRAIN" }))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    /** K4 — a thumb impression with no named witness is how an Indian consent fails in court. */
    await expect(satisfy(gateId, { ...consent, thumbImpression: true }))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    /** The side must agree: the study is `na`, so the consent must be `null` and not a limb. */
    await expect(satisfy(gateId, { ...consent, laterality: "left" }))
      .rejects.toMatchObject({ code: "evidence_invalid" });

    const done = await satisfy(gateId, consent);
    expect(done.state).toBe("satisfied");
    const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
    expect(row!.evidence).toMatchObject({
      kind: "consent", recordedBy: fx.radiographer.id,
      consent: { procedureCode: "CT-HEAD", templateVersion: "rad-contrast-v3", language: "hi" },
    });
  });

  it("form_f: with no row in the PCPNDT register the gate is form_f_missing, and takes no evidence", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "form_f");
    await expect(satisfy(gateId, { formFId: "anything at all" }))
      .rejects.toMatchObject({ code: "form_f_missing" });
  });

  it("chaperone: the person performing the scan cannot also be the chaperone", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", chaperone_required: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "chaperone_present");
    await expect(satisfy(gateId, { chaperoneUserId: fx.radiographer.id }))
      .rejects.toMatchObject({ code: "evidence_invalid" });
    expect((await satisfy(gateId, { chaperoneUserId: fx.radiologist.id })).state).toBe("satisfied");
  });

  it("laterality: a disagreement between the patient and the order leaves the gate open", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", laterality_applicable: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "laterality_confirm");
    /** The order carries `na`; the patient says `left`. Nobody at the console resolves that. */
    await expect(satisfy(gateId, { patientStated: "left" }))
      .rejects.toMatchObject({ code: "gate_open" });
    expect((await satisfy(gateId, { patientStated: "na" })).state).toBe("satisfied");
  });

  /* ══════════════════════════ the shared refusals ══════════════════════════ */

  it("a gate that is already terminal refuses the second act rather than rewriting the first", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "identity_two_factor");
    await satisfy(gateId, IDENTITY_OK);

    for (const act of [
      () => satisfy(gateId, IDENTITY_OK),
      () => withTx(db, (tx) => waiveGate(tx, fx.radiologist, gateId, "r")),
      () => withTx(db, (tx) => overrideGate(tx, fx.radiologist, gateId, "r")),
    ]) {
      await expect(act()).rejects.toMatchObject({ code: expect.stringMatching(/gate_already_terminal|gate_not_overridable/) });
    }
  });

  it("a satisfied gate records WHO and WHEN, and every outcome is evented", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const gateId = await gateIdFor(study.studyId, "identity_two_factor");
    await satisfy(gateId, IDENTITY_OK);

    const [row] = await db.select().from(imagingSafetyScreenings).where(eq(imagingSafetyScreenings.id, gateId));
    expect([row!.satisfiedBy, row!.satisfiedAt?.toISOString()]).toEqual([fx.radiographer.id, NOW.toISOString()]);
    const emitted = (await db.select().from(events)).filter((e) => e.name === "imaging.gate_evaluated");
    expect(emitted.map((e) => (e.payload as { outcome: string }).outcome)).toEqual(["satisfied"]);
    /** The evidence never rides the bus — `evidenceRef` is a pointer slot and this one is null. */
    expect((emitted[0]!.payload as { evidenceRef: null }).evidenceRef).toBeNull();
  });

  /**
   * ═══ THE 500-ESCAPE THIS REPOSITORY HAS SHIPPED THREE TIMES (Plans 09, 13, 15) ═══
   *
   * The evidence body is `unknown` at the controller and parsed per KIND in the service, so a bad
   * body's refusal is raised where zod raises it. A bare `schema.parse()` there throws a `ZodError`,
   * which `toHttp` does not know and rethrows — and a technologist who typed a creatinine as a
   * string would get "Internal Server Error" instead of the field that is wrong. Every one of the
   * ten kinds goes through `parseEvidence`, and this walks four of them.
   */
  it("a malformed evidence body is `evidence_invalid` with the field named — never a raw ZodError", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg" }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("CT-HEAD", "ct");

    for (const [kind, bad, field] of [
      ["identity_two_factor", { secondIdentifier: "passport", value: "x" }, "secondIdentifier"],
      ["renal_function", { creatinineUmolL: "eighty", sampledAt: NOW.toISOString(), source: "internal" }, "creatinineUmolL"],
      ["pregnancy_screen", { declared: "yes" }, "declared"],
      ["prior_contrast_reaction", { reason: 42 }, "reason"],
    ] as const) {
      const e = await satisfy(await gateIdFor(study.studyId, kind), bad).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RadiologyError);
      expect((e as RadiologyError).code).toBe("evidence_invalid");
      expect(String(e)).toContain(field);
    }
  });

  it("gates are addressable by (study, kind), and an unopened kind is refused rather than invented", async () => {
    const study = await arrive("USG-ABDO", "usg");
    expect((await studyGates(db, study.studyId)).map((g) => g.kind)).toEqual(["identity_two_factor"]);
    await expect(requireStudyGate(db, study.studyId, "mri_safety"))
      .rejects.toMatchObject({ code: "unknown_study" });
  });
});
