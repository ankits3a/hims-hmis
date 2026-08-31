import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  placeAndCreateStudy, setupRadiologyFixture, studyTypeRow,
} from "../../../test/helpers/radiology";
import { imagingDefinitions, imagingSafetyScreenings, imagingStudies, patients } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { checkIn, deriveGateSet } from "./checkin";
import { DEFAULT_PREGNANCY_POLICY, studyGates, studyState } from "./gates";
import { RadiologyError } from "./errors";
import { scheduleStudy } from "./schedule";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { StudyType } from "./definitions";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T5 — Assertion Book row **A1**, from both sides.
 *
 * ═══ THE MATRIX IS WALKED WITHOUT A DATABASE, AND THAT IS THE POINT ═══
 *
 * `deriveGateSet` is pure for `applicability.ts`'s reason: a rule that decides whether a safety
 * control EXISTS should be testable at every boundary rather than at whatever age and sex the e2e
 * fixture happens to carry. A1's own mutant — *"drop the sex check and every male gets a pregnancy
 * declaration"* — is one line in the pure block below and would cost a whole fixture in the second.
 *
 * The database block then proves the WIRING: that check-in reads the active book, the patient master
 * and the study's frozen `form_f_required`, and writes one `imaging_safety_screenings` row per kind
 * with a live `imaging_gate` instance behind it.
 */

/** A 30-year-old woman on the scan day — the fixture's own patient, stated here so the pure block reads. */
type PatientFacts = { sex: string; dob: Date | null };
const FEMALE_30: PatientFacts = { sex: "female", dob: new Date(Date.UTC(1996, 0, 1)) };
const MALE_30: PatientFacts = { sex: "male", dob: new Date(Date.UTC(1996, 0, 1)) };
const ASOF = new Date("2026-08-31T06:00:00.000Z");
const POLICY = DEFAULT_PREGNANCY_POLICY;

const type = (over: Partial<StudyType>): StudyType =>
  studyTypeRow({ code: over.code ?? "T", service_id: "01SERVICE0000000000000001", ...over });

describe("the gate set is derived from the type's flags and the patient (18a T5 A1)", () => {
  const derive = (t: Partial<StudyType>, patient: PatientFacts = FEMALE_30, formFRequired = false) =>
    deriveGateSet(type(t), patient, { formFRequired }, POLICY, ASOF).kinds;

  /**
   * Every study opens it, and no branch can turn it off. A1's list does not name it because A1 is
   * about the DERIVED kinds; A6's mutant — *"treat waived identity as ready → A1's wrong Ram
   * Kumar"* — is about this one, and it is only ever a hazard because it is universal.
   */
  it("identity_two_factor opens on EVERY study, whatever the flags say", () => {
    expect(derive({ modality: "usg" })).toEqual(["identity_two_factor"]);
    expect(derive({ modality: "usg" }, MALE_30)).toEqual(["identity_two_factor"]);
  });

  /* ═══════════════ the pregnancy screen: ionising ∧ female ∧ in band ═══════════════ */

  it("A1: an ionising CT on a female aged 30 opens pregnancy_screen", () => {
    expect(derive({ modality: "ct", ionising: true }))
      .toEqual(["identity_two_factor", "pregnancy_screen"]);
  });

  /**
   * A1's NAMED MUTANT. Dropping the sex check gives every male a pregnancy declaration, and a gate
   * that fires on people it cannot apply to is a gate the floor routes around — which costs the
   * gate on the patients it DOES apply to.
   */
  it("A1: the same CT on a male opens NO pregnancy screen", () => {
    expect(derive({ modality: "ct", ionising: true }, MALE_30)).toEqual(["identity_two_factor"]);
    expect(deriveGateSet(type({ modality: "ct", ionising: true }), MALE_30, { formFRequired: false }, POLICY, ASOF)
      .pregnancyReason).toBe("sex_not_female");
  });

  /** A NON-ionising study opens none of it — an obstetric ultrasound asking for a declaration is absurd. */
  it("a non-ionising ultrasound on the same woman opens no pregnancy screen", () => {
    expect(derive({ modality: "usg", ionising: false })).toEqual(["identity_two_factor"]);
  });

  /**
   * The band is the POLICY's and is walked at both edges, because an off-by-one here is a woman who
   * gets no screen. `min_age_years` and `max_age_years` are INCLUSIVE.
   */
  it.each([
    [POLICY.min_age_years - 1, false],
    [POLICY.min_age_years, true],
    [POLICY.max_age_years, true],
    [POLICY.max_age_years + 1, false],
  ])("age %i on an ionising study: pregnancy screen opens = %s", (age, expected) => {
    const dob = new Date(Date.UTC(ASOF.getUTCFullYear() - age, ASOF.getUTCMonth(), ASOF.getUTCDate()));
    const kinds = derive({ modality: "xray", ionising: true }, { sex: "female", dob });
    expect(kinds.includes("pregnancy_screen")).toBe(expected);
  });

  /**
   * An ABSENT date of birth OPENS the screen, exactly as it makes a covered study PCPNDT applicable.
   * The costs are not symmetrical: over-applying is a declaration from a 71-year-old, and
   * under-applying is an X-ray on an early pregnancy nobody asked about.
   */
  it("a female patient of UNKNOWN age on an ionising study still opens the screen", () => {
    expect(derive({ modality: "xray", ionising: true }, { sex: "female", dob: null }))
      .toEqual(["identity_two_factor", "pregnancy_screen"]);
  });

  /* ═══════════════ contrast, MRI, chaperone, laterality, Form F ═══════════════ */

  it("A1: contrast_option 'required' opens contrast_consent + renal_function + prior_contrast_reaction", () => {
    expect(derive({ modality: "ct", ionising: true, contrast_option: "required" })).toEqual([
      "contrast_consent", "identity_two_factor", "pregnancy_screen", "prior_contrast_reaction",
      "renal_function",
    ]);
  });

  /**
   * **DECIDED (§9.2): `optional` opens NONE of the three at check-in.** Whether contrast is given is
   * decided at the console, and a consent gate opened for a scan that turns out to need no contrast
   * is a gate the floor learns to click past — A1's own stated failure mode, arriving by a different
   * door. `openStudyGate` is exported so T7 opens them at the moment the decision is taken.
   */
  it("contrast_option 'optional' opens none of the three at check-in — T7's seam, not this one's", () => {
    expect(derive({ modality: "ct", ionising: true, contrast_option: "optional" }))
      .toEqual(["identity_two_factor", "pregnancy_screen"]);
  });

  it("A1: an MRI opens mri_safety, and it is the MODALITY that opens it, not the contrast", () => {
    expect(derive({ modality: "mri", ionising: false })).toEqual(["identity_two_factor", "mri_safety"]);
    expect(derive({ modality: "mri", ionising: false, contrast_option: "required" })).toEqual([
      "contrast_consent", "identity_two_factor", "mri_safety", "prior_contrast_reaction",
      "renal_function",
    ]);
  });

  /**
   * A1: the obstetric ultrasound. `form_f` comes from the STUDY's frozen `form_f_required` and not
   * from `pcpndt_applicable` — see `checkin.ts`'s header for why re-reading the flag here would be
   * a second reader of a statutory rule (the defect F13 exists over).
   */
  it("A1: an obstetric USG opens form_f + chaperone_present", () => {
    expect(derive({ modality: "usg", pcpndt_applicable: true, chaperone_required: true }, FEMALE_30, true))
      .toEqual(["chaperone_present", "form_f", "identity_two_factor"]);
  });

  it("a pcpndt-applicable TYPE whose study was not marked at placement opens no form_f", () => {
    expect(derive({ modality: "usg", pcpndt_applicable: true }, MALE_30, false))
      .toEqual(["identity_two_factor"]);
  });

  it("laterality_applicable opens laterality_confirm", () => {
    expect(derive({ modality: "xray", ionising: true, laterality_applicable: true }, MALE_30))
      .toEqual(["identity_two_factor", "laterality_confirm"]);
  });

  /** The seam for the kind no flag implies. A UNION with the derived set, never a replacement. */
  it("the type's own `gates` array is unioned in, and never replaces the derived set", () => {
    expect(derive({ modality: "ct", ionising: true, gates: ["mlc_check"] }))
      .toEqual(["identity_two_factor", "mlc_check", "pregnancy_screen"]);
    /** A kind the flags ALREADY imply is not opened twice — the set is a Set. */
    expect(derive({ modality: "mri", gates: ["mri_safety"] }, MALE_30))
      .toEqual(["identity_two_factor", "mri_safety"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("check-in opens the derived set on a real study (18a T5 A1)", () => {
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

  /** T3's 24-hour duplicate window is real — every placement takes its own instant (T4's pattern). */
  let seq = 0;
  const arrive = async (serviceCode: string, deviceKey: string) => {
    seq += 1;
    const study = await placeAndCreateStudy(
      db, fx, serviceCode, `ci${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000),
    );
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: study.studyId, deviceResourceId: fx.devices[deviceKey]!,
      scheduledAt: new Date(SLOT.getTime() + seq * 3_600_000),
    }));
    return study;
  };

  /**
   * Rewrites the ACTIVE book in place. The fixture's four types are deliberately plain; a suite that
   * needs a contrast CT or an obstetric USG says so here rather than forking the fixture, and
   * `studyTypeRow` guarantees the body still satisfies the published schema (F15).
   */
  const rewriteBook = async (types: StudyType[]) => {
    await db.update(imagingDefinitions).set({ body: { types } })
      .where(eq(imagingDefinitions.kind, "study_types"));
  };
  const bookRow = (code: string, over: Partial<StudyType>) =>
    studyTypeRow({ code, service_id: fx.services[code]!, ...over });

  it("moves scheduled → checked_in, stamps the instant, and does NOT make the study ready (B7)", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const result = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));

    expect(result.status).toBe("checked_in");
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, study.studyId));
    expect([row!.status, row!.checkedInAt?.toISOString()]).toEqual(["checked_in", NOW.toISOString()]);
    /** The INSTANCE, not the projection — the state is the instance's and the column mirrors it. */
    expect(await studyState(db, study.studyId)).toBe("checked_in");
  });

  it("A1: a plain ultrasound opens exactly one gate, and it is open with a live instance", async () => {
    const study = await arrive("USG-ABDO", "usg");
    const result = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));

    expect(result.gates).toEqual(["identity_two_factor"]);
    expect(await studyGates(db, study.studyId))
      .toEqual([expect.objectContaining({ kind: "identity_two_factor", state: "open", waivable: false })]);
  });

  /**
   * The database leg of A1's sharpest row: the SAME study type, two patients, two gate sets. The
   * fixture's own patient is female; `sex` is flipped on the row rather than a second patient being
   * built, so the ONLY difference between the two runs is the column the rule reads.
   */
  it("A1: an ionising X-ray opens pregnancy_screen for a woman and not for a man", async () => {
    const first = await arrive("XR-CHEST", "xray");
    const forWoman = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: first.studyId, now: NOW }));
    expect(forWoman.gates).toEqual(["identity_two_factor", "pregnancy_screen"]);

    await db.update(patients).set({ sex: "male" }).where(eq(patients.id, fx.patientId));
    const second = await arrive("XR-CHEST", "xray");
    const forMan = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: second.studyId, now: NOW }));
    expect(forMan.gates).toEqual(["identity_two_factor"]);
  });

  it("A1: a with-contrast CT opens the three contrast gates on top of the pregnancy screen", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg" }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true, contrast_option: "required" }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("CT-HEAD", "ct");
    const result = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));

    expect(result.gates).toEqual([
      "contrast_consent", "identity_two_factor", "pregnancy_screen", "prior_contrast_reaction",
      "renal_function",
    ]);
    /** One row per kind, each with its own instance — five gates, five instances, no sharing. */
    const rows = await db.select().from(imagingSafetyScreenings)
      .where(eq(imagingSafetyScreenings.studyId, study.studyId));
    expect(new Set(rows.map((r) => r.workflowInstanceId)).size).toBe(5);
  });

  /**
   * `form_f` comes off the STUDY, which took it from the order ITEM, which took it from the
   * applicability rule at PLACEMENT. Proved by placing an obstetric type and reading the row rather
   * than by asserting the rule again — the rule has its own suite.
   */
  it("A1: an obstetric USG opens form_f + chaperone_present, and form_f rides the study's frozen flag", async () => {
    await rewriteBook([
      bookRow("USG-ABDO", { modality: "usg", pcpndt_applicable: true, chaperone_required: true }),
      bookRow("XR-CHEST", { modality: "xray", ionising: true }),
      bookRow("CT-HEAD", { modality: "ct", ionising: true }),
      bookRow("MRI-BRAIN", { modality: "mri" }),
    ]);
    const study = await arrive("USG-ABDO", "usg");
    const [row] = await db.select({ f: imagingStudies.formFRequired }).from(imagingStudies)
      .where(eq(imagingStudies.id, study.studyId));
    expect(row!.f).toBe(true);

    const result = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    expect(result.gates).toEqual(["chaperone_present", "form_f", "identity_two_factor"]);
  });

  /** No policy has ever been published in this fixture, so the DEFAULT is what decided the band. */
  it("reports which pregnancy policy decided the band — `default` until a hospital publishes one", async () => {
    const study = await arrive("XR-CHEST", "xray");
    const result = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    expect([result.policySource, result.pregnancyReason]).toEqual(["default", "opened"]);
  });

  /* ═══════════════════════════ the refusals ═══════════════════════════ */

  it("refuses a study with no slot — a check-in must not book a machine it has no permission to book", async () => {
    seq += 1;
    const study = await placeAndCreateStudy(db, fx, "USG-ABDO", "noslot", new Date(NOW.getTime() + 99 * 3_600_000));
    await expect(withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW })))
      .rejects.toThrow(/has no slot/);
  });

  it("a SECOND check-in of a checked-in study is bad_transition, not a silent success", async () => {
    const study = await arrive("USG-ABDO", "usg");
    await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW }));
    await expect(withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: study.studyId, now: NOW })))
      .rejects.toMatchObject({ code: "bad_transition" });
  });

  it("refuses an unknown study rather than checking in nothing", async () => {
    const e = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: "01NOPE0000000000000000000" }))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RadiologyError);
    expect((e as RadiologyError).code).toBe("unknown_study");
  });
});
