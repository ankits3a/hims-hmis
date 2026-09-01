/**
 * PLAN 18a T8 — **THE REPORT SKELETONS, AS DATA AND NOT AS A TABLE.**
 *
 * ═══ WHY THIS IS A CONSTANT AND NOT A GOVERNED DEFINITION ═══
 *
 * A template here is a SECTION LIST — "technique, findings, impression" — and nothing more. It
 * shapes a form; it decides nothing clinical, gates nothing, and appears in no refusal. That is the
 * line §5 T8 draws in as many words: *"DOCTOR-WISE editing of templates is a `study_types`
 * definition concern and not a table of its own in this slice."*
 *
 * The distinction is worth keeping sharp, because the pull towards a `report_templates` table is
 * constant and every phase that yields to it acquires a second governance surface. **What a
 * radiologist may write is not governed; what a scan REQUIRES is** — the gate set, the PCPNDT flag,
 * the criticality tiers — and all three of those already live in `imaging_definitions` under an
 * approval. A template that could change a required section would be clinical rule masquerading as
 * a form, and it would be the one governed thing with no approval behind it.
 *
 * When a hospital wants per-doctor templates, the seam is `study_types`' body (a `template_key` per
 * type, already carried on the report row) or 18a-iii's own plan — not a table added here.
 */

export type ReportTemplate = {
  key: string;
  title: string;
  /** The sections a body is expected to carry. A report may carry more; it may not carry fewer. */
  sections: readonly string[];
};

/** `general` is the fallback and every modality falls back to it rather than to nothing. */
export const REPORT_TEMPLATES: readonly ReportTemplate[] = [
  { key: "general", title: "General report", sections: ["technique", "findings", "impression"] },
  { key: "xray", title: "Plain radiograph", sections: ["technique", "findings", "impression"] },
  {
    key: "usg",
    title: "Ultrasound",
    sections: ["technique", "findings", "impression"],
  },
  {
    key: "usg_obstetric",
    title: "Obstetric ultrasound",
    /**
     * `indication` is a section here and nowhere else, and the reason is statutory rather than
     * editorial: Part F of Form F records WHY an obstetric scan was performed, and a report whose
     * own text cannot say so leaves the register and the report disagreeing.
     */
    sections: ["indication", "technique", "findings", "biometry", "impression"],
  },
  { key: "ct", title: "Computed tomography", sections: ["technique", "findings", "impression"] },
  { key: "mri", title: "Magnetic resonance", sections: ["technique", "sequences", "findings", "impression"] },
  { key: "mammography", title: "Mammography", sections: ["technique", "findings", "birads", "impression"] },
];

const BY_KEY = new Map(REPORT_TEMPLATES.map((t) => [t.key, t]));

/** Unknown keys fall back to `general` rather than throwing: a missing skeleton must not block a report. */
export function templateFor(key: string): ReportTemplate {
  return BY_KEY.get(key) ?? BY_KEY.get("general")!;
}

/**
 * The default skeleton for a study type. Obstetric ultrasound is the one special case, for the
 * reason its own entry gives.
 */
export function templateKeyFor(modality: string, bodyPart: string): string {
  if (modality === "usg" && bodyPart.toLowerCase().includes("obstetric")) return "usg_obstetric";
  return BY_KEY.has(modality) ? modality : "general";
}
