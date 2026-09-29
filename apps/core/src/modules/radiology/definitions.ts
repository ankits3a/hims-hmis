import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CODED_SYSTEMS, newId } from "@hmis/contracts";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { imagingDefinitions } from "../../kernel/db/schema/radiology";
import {
  IMAGING_CRITICAL_CATEGORIES, IMAGING_DEFINITION_KIND_VALUES, IMAGING_GATE_KIND_VALUES,
} from "../../kernel/db/schema/radiology";
import { IMAGING_MODALITIES } from "./kinds";
import { IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE } from "./approval-types";
import { RadiologyError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { ImagingDefinitionKind } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18a T4 / DD13 — **STUDY TYPES AND GATE RULES ARE GOVERNED DEFINITIONS, NOT A TABLE AN ADMIN
 * EDITS.** `modules/ot/definitions.ts` transcribed, because the OT's version is the house pattern
 * for Class-A clinical data and a second shape would be a second thing to reason about.
 *
 * ═══ WHY A DEFINITION AND NOT A MASTER TABLE ═══
 *
 * The gate SET a study type opens is a CLINICAL rule — which scans demand a pregnancy declaration,
 * which demand a creatinine, which are covered by the PCPNDT Act. Clinical rules in this house are
 * Class-A governed data (§10.2): drafted, approved by the medical superintendent, published as a
 * version, and superseded rather than edited. That is also how a radiologist adds a gate without a
 * deploy, and how an inspector can be shown WHICH version was in force on a given day.
 *
 * ═══ THE ACTIVE VERSION IS `status = 'active'`, NEVER `max(version)` — A5 ═══
 *
 * A5's mutant is returning the newest ROW, and the consequence it names is *"a drafted gate set is
 * live before anyone approved it"*. `imaging_definitions_one_active_ux` makes one-active-per-kind a
 * database invariant; this file never reads a version number to decide what is in force.
 */

/**
 * DD13's study-type body row. Every field is read by something downstream, and the ones that look
 * like metadata are not:
 *
 *   · `pcpndt_applicable` — T3's applicability rule reads this and nothing else decides whether a
 *     statutory form opens. It is the reason this body is governed rather than editable.
 *   · `ionising` — snapshotted onto the study at acquisition for 18c's dose register.
 *   · `contrast_option` — `required` opens `contrast_consent` + `renal_function` +
 *     `prior_contrast_reaction` at check-in (T5 A1).
 *   · `laterality_applicable` — T8 refuses a signed report whose laterality disagrees with the
 *     order item's.
 *   · `gates` — the kinds this type opens BEYOND the ones the patient's own facts imply. The
 *     evaluator (T5) unions this list with what sex, age and the flags above produce.
 */
export const studyTypeSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(160),
  modality: z.enum(IMAGING_MODALITIES),
  body_part: z.string().min(1).max(80),
  /** The tariff link, and the ONLY one — T3 maps `services.id` → study type through this field. */
  service_id: z.string().min(1).max(64),
  duration_min: z.number().int().positive().max(600),
  ionising: z.boolean(),
  contrast_option: z.enum(["none", "optional", "required"]),
  pcpndt_applicable: z.boolean(),
  chaperone_required: z.boolean(),
  laterality_applicable: z.boolean(),
  gates: z.array(z.enum(IMAGING_GATE_KIND_VALUES)).default([]),
});

export const studyTypesBodySchema = z.object({
  types: z.array(studyTypeSchema).min(1),
})
  /**
   * ═══ TWO INVARIANTS ENFORCED IN THE SCHEMA, BECAUSE BOTH ARE STATUTORY OR MONETARY ═══
   *
   * A duplicate CODE makes `studyTypeFor` ambiguous. A duplicate SERVICE ID makes
   * `studyTypeByService` ambiguous, and T3 refuses that at read time with `definition_invalid` —
   * but refusing it at PUBLISH is better, because the read-time refusal stops a laboratory at a
   * counter while the publish-time refusal stops a governance action nobody was depending on yet.
   * Both are here so the same body cannot be activated at all.
   */
  .refine(
    (b) => new Set(b.types.map((t) => t.code)).size === b.types.length,
    { message: "two study types share a code — `studyTypeFor` would have two answers" },
  )
  .refine(
    (b) => new Set(b.types.map((t) => t.service_id)).size === b.types.length,
    {
      message:
        "two study types name the same service_id — PCPNDT applicability would depend on which "
        + "one a reader found first",
    },
  );

/**
 * O-5's recommendation, expressed as data. The policy decides HOW a pregnancy screen may be
 * satisfied for a given age band, not whether one opens — that is the study type's `gates` and the
 * patient's own facts.
 */
export const pregnancyPolicyBodySchema = z.object({
  /** Below this age the screen does not open at all. */
  min_age_years: z.number().int().min(0).max(60),
  /** Above it, likewise. Kept separate from the PCPNDT band, which is a different statute. */
  max_age_years: z.number().int().min(0).max(80),
  /** What counts as evidence, in the order a floor should try them. */
  accepted_evidence: z.array(z.enum(["declaration", "lmp_date", "hcg_result"])).min(1),
  /** Days an hCG result stays fresh enough to satisfy the gate. */
  hcg_validity_days: z.number().int().positive().max(90),
  /** Whether a declaration alone may satisfy the gate for an IONISING study. */
  declaration_sufficient_for_ionising: z.boolean(),
});

/**
 * DD15's three tiers, with the communication rule per tier. `red` is the one that pages a human and
 * opens a critical-findings row; the other two are worklist facts.
 */
export const criticalCategoriesBodySchema = z.object({
  categories: z.array(z.object({
    category: z.enum(IMAGING_CRITICAL_CATEGORIES),
    /** Minutes within which the finding must reach a clinician. Record-only in this slice. */
    communicate_within_min: z.number().int().positive().max(1440),
    /** `red` demands a read-back; the others are satisfied by an acknowledgement. */
    requires_read_back: z.boolean(),
    examples: z.array(z.string().min(1).max(160)).default([]),
  })).min(1),
}).refine(
  (b) => new Set(b.categories.map((c) => c.category)).size === b.categories.length,
  { message: "a criticality tier is defined twice" },
);

/**
 * PLAN 18b T3 / D5 — where the images are viewed, as a GOVERNED definition rather than an
 * environment variable. The template admits exactly two placeholders and must be `https://`: a
 * viewer URL is a link every reader in the building will click, and the book that publishes it
 * goes through the same draft → approval → publish as the study types.
 */
export const VIEWER_URL_PLACEHOLDERS = ["accessionNo", "studyInstanceUid"] as const;

export const pacsSettingsBodySchema = z.object({
  viewer_url_template: z.string().min(12).max(2000)
    .refine((t) => t.startsWith("https://"), { message: "the viewer URL must be https://" })
    // Close review B5 — a template that is not a URL would 500 at the door; refuse it at publish.
    .refine((t) => { try { new URL(t); return true; } catch { return false; } }, { message: "the viewer URL must parse as a URL" })
    .refine((t) => {
      const names = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
      return names.length > 0 && names.every((n) => (VIEWER_URL_PLACEHOLDERS as readonly string[]).includes(n));
    }, { message: `the template must name at least one of {${VIEWER_URL_PLACEHOLDERS.join("} {")}} and nothing else in braces` }),
  enabled: z.boolean(),
});

/**
 * PLAN 18c T3 / D6 — **DIAGNOSTIC REFERENCE LEVELS, a governed book like every other.**
 *
 * A DRL is the dose a typical patient receives for a typical examination on typical equipment: it
 * is not a limit and exceeding it is not an error, it is a signal to look at the protocol. So the
 * book is published through the same draft → approval → publish as the study types, and the
 * comparison it drives is STORED with the dose row rather than recomputed — a level republished
 * next year must not retroactively change what an examination in March was measured against.
 *
 * `study_type_code` first, `modality` as the fallback: a hospital that has not set a level for
 * `CT-HEAD` may still have one for CT. A row matching neither leaves the register's verdict NULL,
 * which is deliberately NOT the same as "under" — an examination nobody has set a level for has not
 * passed anything.
 *
 * The quantity is named per row because DRLs are set on different quantities for different
 * examinations: DLP for a CT protocol, DAP for an interventional room, fluoroscopy seconds for a
 * screening procedure. `aerb/units.ts` owns what each one is measured in.
 */
export const DRL_QUANTITIES = ["ctdivol", "dlp", "dap", "fluoro_seconds"] as const;

export const doseReferenceLevelsBodySchema = z.object({
  levels: z.array(z.object({
    /** Exactly one of the two is the key; `study_type_code` wins where both match. */
    study_type_code: z.string().min(1).max(40).optional(),
    modality: z.string().min(1).max(40).optional(),
    quantity: z.enum(DRL_QUANTITIES),
    value: z.number().positive(),
    /** Free text: "ICRP 135 national survey 2023", "local 75th percentile, n=142". */
    source: z.string().max(200).optional(),
  }).refine((r) => r.study_type_code !== undefined || r.modality !== undefined, {
    message: "a reference level must name a study_type_code or a modality",
  })).min(1),
});

/**
 * PLAN 18-S RS6 — **THE PROTOCOL BOOK: how each examination is done, as governed clinical data.**
 *
 * A protocol is the radiologist's instruction to the technologist — technique, exposure, slices or
 * sequences, the contrast dose per kilogram and its ceiling, the breath-hold words said to the
 * patient. It is clinical, so it is published like every other book in this file: drafted by the
 * radiologist (HOD), approved by the medical superintendent, published as a version. **Nothing is
 * seeded** (DECIDED, RS6): the hospital's protocols are its radiologists' to write, and a seeded
 * default would be a protocol nobody chose, read aloud to a patient.
 *
 * Keyed the way the DRL book is: `study_type_code` for an examination's own protocol, `modality`
 * for a department-wide default, and the study type wins where both match (`protocolFor`).
 *
 * The console READS this; nothing here refuses a scan. A study with no protocol shows "no protocol
 * published" and the technologist works from the radiologist's word — the book is guidance, and a
 * missing page must not stop an ER head CT.
 */
const range = z.object({ min: z.number().positive().max(100_000), max: z.number().positive().max(100_000) })
  .refine((r) => r.min <= r.max, { message: "a range's min is above its max" });

export const PROTOCOL_CONTRAST_PHASES = [
  "non_contrast", "arterial", "portal_venous", "nephrographic", "delayed", "multiphase", "angiographic", "mri_gadolinium",
] as const;

export const imagingProtocolSchema = z.object({
  /** Exactly one key is required; `study_type_code` wins where both match (`protocolFor`). */
  study_type_code: z.string().min(1).max(40).optional(),
  modality: z.enum(IMAGING_MODALITIES).optional(),
  /** What the technologist sees at the top of the card — "CT abdomen, triple phase". */
  name: z.string().min(1).max(160),
  /** The instruction in the radiologist's words: positioning, coverage, reconstruction. */
  technique: z.string().min(1).max(2000),
  /** The machine's own stored protocol name, when the console should just pick it. */
  preset: z.string().min(1).max(80).optional(),
  kv: range.optional(),
  mas: range.optional(),
  /** CT only — reconstructed slice thickness and pitch. */
  ct: z.object({ slice_mm: z.number().positive().max(20), pitch: z.number().positive().max(3) }).optional(),
  /** MRI only — the sequences, in order. */
  sequences: z.array(z.string().min(1).max(80)).max(40).optional(),
  contrast: z.object({
    agent: z.string().min(1).max(120).optional(),
    phase: z.enum(PROTOCOL_CONTRAST_PHASES),
    ml_per_kg: z.number().positive().max(5),
    max_ml: z.number().positive().max(500),
    /** Seconds from the start of the injection to the scan (bolus tracking is written in `technique`). */
    delay_s: z.number().int().min(0).max(1800),
    rate_ml_s: z.number().positive().max(10).optional(),
  }).optional(),
  /** Said to the patient — both languages or neither; the console shows the one the patient speaks. */
  breath_hold: z.object({ en: z.string().min(1).max(400), hi: z.string().min(1).max(400) }).optional(),
  /**
   * The paediatric variant: weight bands, each with its own exposure and contrast per kilogram. A
   * child is dosed by weight, never by age, and a band the child's weight falls outside of is a
   * question for the radiologist, not a rounding.
   */
  paediatric: z.object({
    bands: z.array(z.object({
      from_kg: z.number().min(0).max(200),
      to_kg: z.number().positive().max(200),
      kv: range.optional(),
      mas: range.optional(),
      ml_per_kg: z.number().positive().max(5).optional(),
      note: z.string().min(1).max(400).optional(),
    }).refine((b) => b.from_kg < b.to_kg, { message: "a weight band's from_kg must be below its to_kg" })).min(1),
  }).optional(),
}).refine((p) => p.study_type_code !== undefined || p.modality !== undefined, {
  message: "a protocol must name a study_type_code or a modality",
});

export const imagingProtocolsBodySchema = z.object({
  protocols: z.array(imagingProtocolSchema).min(1),
}).refine(
  (b) => new Set(b.protocols.map((p) => `${p.study_type_code ?? ""}|${p.study_type_code === undefined ? p.modality ?? "" : ""}`)).size
    === b.protocols.length,
  { message: "two protocols share a key — the console would have two answers for one examination" },
);

export type ImagingProtocolsBody = z.infer<typeof imagingProtocolsBodySchema>;
export type ImagingProtocol = z.infer<typeof imagingProtocolSchema>;

/**
 * The protocol for one examination: the study type's own, else the modality's default, else null.
 * Pure, so the room read and its test agree on one rule.
 */
export function protocolFor(
  body: ImagingProtocolsBody, studyTypeCode: string, modality: string,
): { protocol: ImagingProtocol; matchedOn: "study_type" | "modality" } | null {
  const own = body.protocols.find((p) => p.study_type_code === studyTypeCode);
  if (own !== undefined) return { protocol: own, matchedOn: "study_type" };
  const dflt = body.protocols.find((p) => p.study_type_code === undefined && p.modality === modality);
  return dflt === undefined ? null : { protocol: dflt, matchedOn: "modality" };
}

/**
 * PLAN 18-S RS8a — **THE REPORT TEMPLATES BOOK: structured templates with coded categories.**
 *
 * `templates.ts` (18a T8) kept the seven section skeletons as a constant and argued, rightly, that a
 * SECTION LIST decides nothing clinical. A template that REQUIRES a category does: "a mammogram is
 * not signed without a BI-RADS" is a department rule, and this file's header is where department
 * rules live — drafted by the radiologist, approved by the medical superintendent, published as a
 * version. So the structured templates are a governed book, and the seven constants stay as the
 * fallback a study gets when the book is not published or has no template for it (a missing page
 * must not stop a report).
 *
 * A template carries:
 *   · `modalities` / `study_type_codes` — which studies it is offered for (`study_type_codes`
 *     first, then the modality, the DRL book's rule);
 *   · `sections` — each with the words its "normal study" macro inserts;
 *   · `macros` — further named phrases for a section;
 *   · `coded` — the categories the report carries, and whether one is REQUIRED before signing
 *     (`coded_category_required`, the pre-sign check).
 *
 * **Nothing is seeded active** (DECIDED, RS8a): the words a normal study inserts are clinical
 * content and they are the HOD's. A reference set ships as a draft to paste
 * (`docs/runbooks/radiology-report-templates.reference.json`, RS8a).
 */
export const REPORT_SECTION_KEYS = ["indication", "technique", "comparison", "findings", "biometry", "impression", "recommendation"] as const;

const templateKey = z.string().regex(/^[a-z0-9_]{1,40}$/, "a template key is 1–40 of a–z, 0–9 and _");

export const reportTemplateSchema = z.object({
  key: templateKey,
  name: z.string().min(1).max(120),
  modalities: z.array(z.enum(IMAGING_MODALITIES)).min(1),
  study_type_codes: z.array(z.string().min(1).max(40)).max(200).default([]),
  sections: z.array(z.object({
    key: z.enum(REPORT_SECTION_KEYS),
    label: z.string().min(1).max(60),
    /** The "normal study" macro for this section. */
    normal: z.string().max(4000).optional(),
  })).min(1).max(REPORT_SECTION_KEYS.length)
    .refine((s) => new Set(s.map((x) => x.key)).size === s.length, { message: "a section is listed twice" })
    .refine((s) => s.some((x) => x.key === "impression"), {
      message: "every template has an impression — a report is not signed without one",
    }),
  macros: z.array(z.object({
    key: templateKey,
    label: z.string().min(1).max(80),
    section: z.enum(REPORT_SECTION_KEYS),
    text: z.string().min(1).max(4000),
  })).max(100).default([]),
  coded: z.array(z.object({ system: z.enum(CODED_SYSTEMS), required: z.boolean() })).max(4).default([])
    .refine((c) => new Set(c.map((x) => x.system)).size === c.length, { message: "a coded system is listed twice" }),
});

export const reportTemplatesBodySchema = z.object({
  templates: z.array(reportTemplateSchema).min(1).max(200),
}).refine(
  (b) => new Set(b.templates.map((t) => t.key)).size === b.templates.length,
  { message: "two templates share a key — a report would name a template with two meanings" },
);

export type ReportTemplatesBody = z.infer<typeof reportTemplatesBodySchema>;
export type GovernedReportTemplate = z.infer<typeof reportTemplateSchema>;

/**
 * The templates offered for one study: those naming its study-type code first, then those naming
 * its modality. Pure, so the reading room's read and the pre-sign check agree on one rule.
 */
export function templatesFor(
  body: ReportTemplatesBody, studyTypeCode: string, modality: string,
): GovernedReportTemplate[] {
  const own = body.templates.filter((t) => t.study_type_codes.includes(studyTypeCode));
  const byModality = body.templates.filter((t) => !own.includes(t)
    && t.study_type_codes.length === 0 && (t.modalities as readonly string[]).includes(modality));
  return [...own, ...byModality];
}

/**
 * PLAN 18-S RS8a / owner ruling 4 — **WHO MAY SIGN AN IMAGING REPORT, AND WHAT THE PRINT SAYS ABOUT THEM.**
 *
 * Ruling 4: the printed report carries the signing radiologist's or sonologist's NAME,
 * QUALIFICATION, COUNCIL REGISTRATION NUMBER and digital signature. The spike found a name
 * (`users.full_name`) and, sometimes, a council number (`opd_doctors.registration_no`, the roster's
 * `nmr`/`smr` credential) — and **no qualification anywhere general**. The roster's credential
 * register has no route and no screen, so adding a key there would be a reader without a writer.
 *
 * DECIDED (RS8a): the department's **list of authorised signatories** is a governed book. It is what
 * NABH asks an imaging department to hold (who may sign a diagnostic report), it is the HOD's to
 * draft and the medical superintendent's to approve, and it has a writer today — Setup → Books. The
 * council number here is optional: where it is blank, the roster's `nmr`/`smr` credential and then
 * `opd_doctors.registration_no` are read (`signer.ts`). A signer who is not on the list, or whose
 * council number is found nowhere, is refused `signer_credentials_missing` — a signature whose print
 * cannot carry what ruling 4 requires is not made.
 */
export const reportSignatoriesBodySchema = z.object({
  signatories: z.array(z.object({
    user_id: z.string().min(1).max(64),
    /** As printed: "MBBS, MD (Radiodiagnosis)". */
    qualification: z.string().min(2).max(160),
    /** As printed: "Consultant Radiologist". */
    designation: z.string().min(1).max(120).optional(),
    /** As printed: "Jharkhand State Medical Council · 2014/1187". */
    council_reg_no: z.string().min(3).max(120).optional(),
  })).min(1).max(200),
}).refine(
  (b) => new Set(b.signatories.map((s) => s.user_id)).size === b.signatories.length,
  { message: "a person is listed twice — the print would have two qualifications for one signer" },
);

export type ReportSignatoriesBody = z.infer<typeof reportSignatoriesBodySchema>;

const SCHEMA_BY_KIND = {
  study_types: studyTypesBodySchema,
  pregnancy_policy: pregnancyPolicyBodySchema,
  critical_categories: criticalCategoriesBodySchema,
  pacs_settings: pacsSettingsBodySchema,
  dose_reference_levels: doseReferenceLevelsBodySchema,
  imaging_protocols: imagingProtocolsBodySchema,
  report_templates: reportTemplatesBodySchema,
  report_signatories: reportSignatoriesBodySchema,
} as const;

export type StudyTypesBody = z.infer<typeof studyTypesBodySchema>;
export type StudyType = z.infer<typeof studyTypeSchema>;
export type PregnancyPolicyBody = z.infer<typeof pregnancyPolicyBodySchema>;
export type CriticalCategoriesBody = z.infer<typeof criticalCategoriesBodySchema>;
export type PacsSettingsBody = z.infer<typeof pacsSettingsBodySchema>;
export type DoseReferenceLevelsBody = z.infer<typeof doseReferenceLevelsBodySchema>;
export type DoseReferenceLevel = DoseReferenceLevelsBody["levels"][number];
export type ImagingDefinitionRow = typeof imagingDefinitions.$inferSelect;

export const IMAGING_DEFINITION_KINDS = IMAGING_DEFINITION_KIND_VALUES;

export function parseDefinitionBody<K extends ImagingDefinitionKind>(
  kind: K,
  body: unknown,
): z.infer<(typeof SCHEMA_BY_KIND)[K]> {
  const parsed = SCHEMA_BY_KIND[kind].safeParse(body);
  if (!parsed.success) {
    throw new RadiologyError(
      "definition_invalid",
      `${kind} definition is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      { kind, issues: parsed.error.issues.length },
    );
  }
  return parsed.data as z.infer<(typeof SCHEMA_BY_KIND)[K]>;
}

/** Drafts a new version of a definition kind. Inert until it is published. */
export async function draftDefinition(
  tx: Tx,
  actor: Actor,
  input: { kind: ImagingDefinitionKind; body: unknown },
): Promise<{ definitionId: string; version: number }> {
  parseDefinitionBody(input.kind, input.body);
  const latest = await tx
    .select({ version: imagingDefinitions.version })
    .from(imagingDefinitions)
    .where(eq(imagingDefinitions.kind, input.kind))
    .orderBy(desc(imagingDefinitions.version))
    .limit(1);
  const version = (latest[0]?.version ?? 0) + 1;
  const definitionId = newId();
  await tx.insert(imagingDefinitions).values({
    id: definitionId, kind: input.kind, version, body: input.body as object,
    status: "draft", draftedBy: actor.id,
  });
  return { definitionId, version };
}

/**
 * Files the `imaging_definition_publish` approval. The engine's own `requester_approver` SoD is what
 * forces two distinct humans; this adds nothing to it and takes nothing away. Filed on the CALLER's
 * transaction, so a draft and its request land together or not at all.
 */
export async function requestDefinitionPublish(
  tx: Tx,
  actor: Actor,
  definitionId: string,
): Promise<{ approvalId: string }> {
  const rows = await tx.select().from(imagingDefinitions).where(eq(imagingDefinitions.id, definitionId));
  const draft = rows[0];
  if (!draft) throw new RadiologyError("definition_not_active", `unknown definition ${definitionId}`);
  if (draft.status !== "draft") {
    throw new RadiologyError(
      "definition_not_active",
      `definition ${definitionId} is ${draft.status}, not a draft`,
    );
  }
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE,
    subject: { type: "imaging_definition", id: definitionId },
    requestNote: `publish ${draft.kind} v${String(draft.version)}`,
  });
  return { approvalId };
}

/**
 * Publishes a draft whose approval has been GRANTED: the draft becomes `active` and the previous
 * active version becomes `superseded`, in one transaction.
 *
 * **The approval is checked ON EXECUTE, never trusted from the caller.** A caller holding a granted
 * approval id for a DIFFERENT definition must not be able to publish this one, so the SUBJECT is
 * compared as well as the status — `issueInvoice`'s credit-lane shape.
 */
export async function publishDefinition(
  db: Db,
  actor: Actor,
  input: { definitionId: string; approvalId: string },
): Promise<{ kind: ImagingDefinitionKind; version: number; supersededVersion: number | null }> {
  const approval = await getApproval(db, input.approvalId);
  if (!approval || approval.status !== "granted") {
    throw new RadiologyError("definition_not_active", `approval ${input.approvalId} is not granted`);
  }
  if (approval.typeKey !== IMAGING_DEFINITION_PUBLISH_APPROVAL_TYPE
    || approval.subjectType !== "imaging_definition"
    || approval.subjectId !== input.definitionId) {
    throw new RadiologyError(
      "definition_not_active",
      `approval ${input.approvalId} does not authorise publishing definition ${input.definitionId}`,
    );
  }
  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(imagingDefinitions).where(eq(imagingDefinitions.id, input.definitionId));
    const draft = rows[0];
    if (!draft) throw new RadiologyError("definition_not_active", `unknown definition ${input.definitionId}`);
    if (draft.status !== "draft") {
      throw new RadiologyError(
        "definition_not_active",
        `definition ${input.definitionId} is ${draft.status}, not a draft`,
      );
    }
    /**
     * Re-validated at PUBLISH as well as at draft: a body that reached the table around this API —
     * a data fix, a bulk load, a restored dump — must not become active without passing the schema.
     * The OT gives the same defence-in-depth argument, and here it also catches the two duplicate
     * invariants, which are the ones with a statute behind them.
     */
    parseDefinitionBody(draft.kind as ImagingDefinitionKind, draft.body);

    const superseded = await tx
      .update(imagingDefinitions)
      .set({ status: "superseded" })
      .where(and(eq(imagingDefinitions.kind, draft.kind), eq(imagingDefinitions.status, "active")))
      .returning({ version: imagingDefinitions.version });

    await tx.update(imagingDefinitions)
      .set({
        status: "active", publishedBy: actor.id, publishedAt: new Date(), approvalId: input.approvalId,
      })
      .where(eq(imagingDefinitions.id, input.definitionId));

    return {
      kind: draft.kind as ImagingDefinitionKind,
      version: draft.version,
      supersededVersion: superseded[0]?.version ?? null,
    };
  });
}

/**
 * ═══ OWNER RULING 2026-08-31 — THE SEED SELF-PUBLISHES, AND THE ROW SAYS SO ═══
 *
 * T4 shipped `seed:radiology` drafting and stopping, on the argument that a seed granting its own
 * approval makes the governed-definition design decorative. **The owner ruled otherwise for now**:
 * the pilot needs a department that works without a second human standing by, and the same
 * second-administrator shortfall that holds Plan 17b would have held this too.
 *
 * This is the honest form of that ruling. It does NOT fabricate an approval:
 *
 *   · the body is re-parsed, exactly as `publishDefinition` does — a seeded book is still refused if
 *     it does not satisfy the schema;
 *   · the previous active version is superseded in the same transaction, so the one-active-per-kind
 *     invariant holds;
 *   · **`approval_id` is left NULL**, which is what makes a seeded activation distinguishable from a
 *     governed one FOR EVER. `imaging_definitions_published_ck` requires `published_by` and
 *     `published_at` and says nothing about `approval_id`, so a NULL there is representable and is
 *     the provenance record: any row a reader finds active with no approval id was seeded, not
 *     approved.
 *
 * An inspector asking "who approved the gate set in force on this date" gets a truthful answer
 * either way — which is the property that would have been lost by minting a second system actor to
 * rubber-stamp it. **The governed path is untouched and is still the only way a HUMAN publishes.**
 */
export async function activateSeededDefinition(
  db: Db,
  actor: Actor,
  definitionId: string,
): Promise<{ kind: ImagingDefinitionKind; version: number; supersededVersion: number | null }> {
  return await db.transaction(async (tx) => {
    const rows = await tx.select().from(imagingDefinitions).where(eq(imagingDefinitions.id, definitionId));
    const draft = rows[0];
    if (!draft) throw new RadiologyError("definition_not_active", `unknown definition ${definitionId}`);
    if (draft.status !== "draft") {
      throw new RadiologyError(
        "definition_not_active",
        `definition ${definitionId} is ${draft.status}, not a draft`,
      );
    }
    parseDefinitionBody(draft.kind as ImagingDefinitionKind, draft.body);

    /**
     * ═══ A SEEDED ACTIVATION MAY NOT OUTRANK A GOVERNED ONE ═══
     *
     * The supersede below is what makes this function useful, and it is how `seed:radiology` came to
     * revert the medical superintendent's approved book: a re-run drafted a fresh version from the
     * hardcoded seeds, superseded the approved one, and activated with `approval_id` NULL. That was
     * fixed at the call site, and this function had exactly one caller, so the exposure closed.
     * **But the invariant then lived in one caller's early return and a comment**, and the next
     * caller would have reintroduced it with nothing to stop them. The guard belongs where the act
     * happens — the same lesson as a merge freeze held in somebody's memory.
     *
     * **It is narrow on purpose.** Seed-over-seed superseding stays legal — replacing one
     * un-approved book with another is exactly what a stand-up does, and a test pins it. This keys
     * on `approval_id`, the one distinction that is never a judgement call: a row a human approved
     * may not be retired by a script that approves itself. NULL is already this module's provenance
     * marker for "seeded, not approved" (the owner's 2026-08-31 ruling), so the guard reads a fact
     * that ruling created rather than inventing a second one.
     */
    const active = await tx
      .select({ version: imagingDefinitions.version, approvalId: imagingDefinitions.approvalId })
      .from(imagingDefinitions)
      .where(and(eq(imagingDefinitions.kind, draft.kind), eq(imagingDefinitions.status, "active")));
    const governed = active.find((r) => r.approvalId !== null);
    if (governed) {
      throw new RadiologyError(
        "definition_not_active",
        `${draft.kind} v${String(governed.version)} was published through the approval route and a `
        + "seeded activation may not supersede it — change the book at the publish route, which "
        + "needs the medical superintendent's approval",
        { kind: draft.kind, activeVersion: governed.version },
      );
    }

    const superseded = await tx
      .update(imagingDefinitions)
      .set({ status: "superseded" })
      .where(and(eq(imagingDefinitions.kind, draft.kind), eq(imagingDefinitions.status, "active")))
      .returning({ version: imagingDefinitions.version });

    await tx.update(imagingDefinitions)
      .set({ status: "active", publishedBy: actor.id, publishedAt: new Date(), approvalId: null })
      .where(eq(imagingDefinitions.id, definitionId));

    return {
      kind: draft.kind as ImagingDefinitionKind,
      version: draft.version,
      supersededVersion: superseded[0]?.version ?? null,
    };
  });
}

/** The active ROW of a kind — `status = 'active'`, never `max(version)` (A5). */
export async function activeDefinitionRow(
  exec: Db | Tx,
  kind: ImagingDefinitionKind,
): Promise<ImagingDefinitionRow | undefined> {
  const rows = await (exec as Db).select().from(imagingDefinitions)
    .where(and(eq(imagingDefinitions.kind, kind), eq(imagingDefinitions.status, "active")))
    .limit(1);
  return rows[0];
}

/**
 * The active BODY, parsed. Throws `definition_not_active` when the kind has no active version —
 * and every caller lets that refusal through rather than defaulting, so a hospital that has
 * published no study-type book cannot place or schedule an imaging order at all. That is the
 * intended posture at go-live: the department is inert until somebody says what it may do.
 */
export async function activeDefinition<K extends ImagingDefinitionKind>(
  exec: Db | Tx,
  kind: K,
): Promise<z.infer<(typeof SCHEMA_BY_KIND)[K]>> {
  const row = await activeDefinitionRow(exec, kind);
  if (!row) {
    throw new RadiologyError(
      "definition_not_active",
      `no active ${kind} definition — the ${kind} book has never been published`,
      { kind },
    );
  }
  return parseDefinitionBody(kind, row.body);
}
