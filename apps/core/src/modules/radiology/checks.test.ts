import { criticalTermsIn, runPreSignChecks } from "./checks";
import type { PreSignContext } from "./checks";
import type { GovernedReportTemplate } from "./definitions";

/**
 * PLAN 18-S RS8a T2 — the pre-sign checks as pure functions: a TRUE POSITIVE for each, and the
 * false positives a word list is famous for (negation, "cervical spine", "upright", "testing").
 */
const base: PreSignContext = {
  studyTypeCode: "XR-KNEE", studyTypeName: "X-ray knee", studyLaterality: "na", patientSex: "female",
  sections: { technique: "AP and lateral views.", findings: "No fracture. Joint spaces preserved." },
  impression: "Normal study.", coded: {}, template: null, criticalCategory: null,
};
const ctx = (over: Partial<PreSignContext>): PreSignContext => ({ ...base, ...over });
const codes = (c: PreSignContext) => runPreSignChecks(c).map((f) => `${f.level}:${f.code}`);

const mammo: GovernedReportTemplate = {
  key: "mammo_birads", name: "Mammography", modalities: ["mammography"], study_type_codes: [],
  sections: [{ key: "findings", label: "Findings" }, { key: "impression", label: "Impression" }],
  macros: [], coded: [{ system: "birads", required: true }],
};

describe("the pre-sign checks (18-S RS8a T2)", () => {
  it("a clean report raises nothing", () => {
    expect(codes(base)).toEqual([]);
  });

  describe("(5) the impression", () => {
    it("empty or whitespace is refused", () => {
      expect(codes(ctx({ impression: "   " }))).toEqual(["refuse:impression_required"]);
    });
  });

  describe("(1) the side", () => {
    it("a LEFT study whose report names only the right is refused", () => {
      const c = ctx({ studyLaterality: "left", sections: { findings: "Undisplaced fracture of the right distal radius." }, impression: "Right radius fracture." });
      expect(codes(c)).toEqual(["refuse:side_conflict"]);
    });

    it("naming both sides is a warning, not a refusal (the other side for comparison)", () => {
      const c = ctx({ studyLaterality: "left", sections: { findings: "Left knee effusion. Compared with the right, the joint space is reduced." }, impression: "Left knee effusion." });
      expect(codes(c)).toEqual(["warn:side_mentions_both"]);
    });

    it("false-positive guards: a bilateral or non-lateralised study, and 'upright' / 'rightward'", () => {
      expect(codes(ctx({ studyLaterality: "bilateral", sections: { findings: "Right and left knees normal." } }))).toEqual([]);
      expect(codes(ctx({ studyLaterality: "na", sections: { findings: "Right lower lobe consolidation." } }))).toEqual([]);
      expect(codes(ctx({ studyLaterality: "left", sections: { findings: "Upright film of the left knee; rightward tilt." } }))).toEqual([]);
    });
  });

  describe("(2) sex-specific organs", () => {
    it("a uterus on a man's report, and a prostate on a woman's, are refused", () => {
      expect(codes(ctx({ patientSex: "male", sections: { findings: "Uterus normal in size." } }))).toEqual(["refuse:sex_organ_mismatch"]);
      expect(codes(ctx({ patientSex: "female", impression: "Prostate enlarged, 45 cc." }))).toEqual(["refuse:sex_organ_mismatch"]);
    });

    it("false-positive guards: 'cervical spine', 'testing', 'ovary' for a woman, and a patient registered other", () => {
      expect(codes(ctx({ patientSex: "male", sections: { findings: "Cervical spine alignment normal; testing of the reflexes deferred." } }))).toEqual([]);
      expect(codes(ctx({ patientSex: "female", sections: { findings: "Both ovaries normal." } }))).toEqual([]);
      expect(codes(ctx({ patientSex: "other", sections: { findings: "Prostate and uterus not seen." } }))).toEqual([]);
    });
  });

  describe("(3) the coded category", () => {
    it("a template that requires BI-RADS refuses a report without one, and a value that is not a category", () => {
      expect(codes(ctx({ template: mammo }))).toEqual(["refuse:coded_category_required"]);
      expect(codes(ctx({ template: mammo, coded: { birads: { value: "4D" } } }))).toEqual(["refuse:coded_category_required"]);
    });

    it("a valid category passes; an optional one may be left out", () => {
      expect(codes(ctx({ template: mammo, coded: { birads: { value: "4A" } } }))).toEqual([]);
      expect(codes(ctx({ template: { ...mammo, coded: [{ system: "birads", required: false }] } }))).toEqual([]);
    });

    it("a category that disagrees with its recorded calculator inputs is a WARNING, not a refusal", () => {
      const c = ctx({ coded: { tirads: { value: "TR3", inputs: { composition: "solid", echogenicity: "hypo", shape: "wider_than_tall", margin: "smooth", foci: [] } } } });
      expect(codes(c)).toEqual(["warn:coded_calculation_differs"]);
    });
  });

  describe("(4) critical terms, with negation", () => {
    it("true positives", () => {
      expect(criticalTermsIn("Large right pneumothorax with mediastinal shift.")).toEqual(["pneumothorax"]);
      expect(criticalTermsIn("Acute subdural haematoma, 9 mm, with midline shift of 4 mm.")).toEqual(["subdural haematoma", "midline shift"]);
      expect(criticalTermsIn("Stanford type A aortic dissection.")).toEqual(["aortic dissection"]);
      expect(criticalTermsIn("Free air under both domes of the diaphragm.")).toEqual(["free air"]);
      /** A negation in the FIRST sentence does not reach the second. */
      expect(criticalTermsIn("No pneumothorax on the first film. Large pneumothorax on the repeat.")).toEqual(["pneumothorax"]);
      /** …nor across a termination word. */
      expect(criticalTermsIn("No effusion but a small pneumoperitoneum.")).toEqual(["pneumoperitoneum"]);
      /** A longer term shadows the shorter one it contains. */
      expect(criticalTermsIn("Right tension pneumothorax.")).toEqual(["tension pneumothorax"]);
    });

    it("false-positive guards: every normal-study phrasing of a negation", () => {
      for (const text of [
        "No pneumothorax.",
        "No evidence of pneumothorax, intracranial haemorrhage or free air.",
        "Pneumothorax is not seen.",
        "There is no pulmonary embolism.",
        "Negative for aortic dissection.",
        "Without midline shift.",
        "Ectopic pregnancy ruled out; intrauterine gestation seen.",
      ]) {
        expect({ text, hits: criticalTermsIn(text) }).toEqual({ text, hits: [] });
      }
    });

    it("an unflagged critical term is a WARNING; a flagged one raises nothing", () => {
      const c = ctx({ sections: { findings: "Large right pneumothorax." }, impression: "Right pneumothorax." });
      expect(codes(c)).toEqual(["warn:critical_term"]);
      expect(codes({ ...c, criticalCategory: "red" })).toEqual([]);
    });
  });
});
