/**
 * PLAN 18-S RS7 — **WHAT A FORM F STILL LACKS, measured against the statutory form** (PCPNDT Rules
 * r.9(4), Form F as amended 2014: Section A for every pre-natal procedure, Section B for the
 * non-invasive ones — ultrasonography — and Section D's two declarations).
 *
 * `pcpndt_form_f` keeps the register's own columns (serial, machine, person, indication, gestation,
 * signer) and three jsonb blocks (`sections`, `declaration`, `referral`) that 18a left free-form. The
 * RS7 spike found every statutory item either in a column, in the patient record (name, age, address,
 * phone — read at print, never copied), or storable under a named key in `sections` — so there is **no
 * migration**: the keys below are the contract the Scan room writes and this function reads.
 *
 *   Section A  5  living children, sons and daughters (the Act asks for each child's sex; the FORM
 *                 carries it, a report never does)        → sections.living_children {sons, daughters}
 *              6  husband's / father's name                → sections.relative_name
 *              8  referred by (doctor, registration no.) or self-referral
 *                                                          → referral.self_referral / sections.referrer
 *              9  LMP or weeks of pregnancy                → sections.lmp or gestation_weeks
 *   Section B 11  indication (the Act's list, i–xxiii)     → indication_code
 *             13  date the woman's declaration was taken   → sections.patient_declaration.obtained_at
 *   Section D     the woman's declaration                  → sections.patient_declaration
 *                 the sonologist's declaration              → signed_by / signed_at (recordFormF)
 *
 * The rest of Section B (the procedure, its date, the result and to whom it was conveyed) is the
 * STUDY's — its type, its acquisition time and its signed report — and is read from there.
 */
export const FORM_F_FIELDS = [
  "living_children", "relative_name", "referral", "lmp_or_weeks", "indication",
  "patient_declaration", "sonologist_declaration",
] as const;
export type FormFField = (typeof FORM_F_FIELDS)[number];

type FormLike = {
  sections: unknown; referral: unknown; indicationCode: string | null;
  gestationWeeks: number | null; signedBy: string | null;
};

const obj = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
const count = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The statutory items this form does not yet carry, in the form's own order. Pure. */
export function formFMissingFields(form: FormLike): FormFField[] {
  const s = obj(form.sections);
  const referral = obj(form.referral);
  const referrer = obj(s.referrer);
  const children = obj(s.living_children);
  const decl = obj(s.patient_declaration);
  const present: Record<FormFField, boolean> = {
    living_children: count(children.sons) && count(children.daughters),
    relative_name: text(s.relative_name),
    referral: referral.self_referral === true || text(referrer.name) || text(referral.slip_doc_id) || text(referral.paper_serial),
    lmp_or_weeks: text(s.lmp) || form.gestationWeeks !== null,
    indication: text(form.indicationCode),
    patient_declaration: text(decl.obtained_at),
    sonologist_declaration: form.signedBy !== null,
  };
  return FORM_F_FIELDS.filter((f) => !present[f]);
}
