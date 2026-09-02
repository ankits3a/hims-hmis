import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@hmis/contracts";
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
    .refine((t) => {
      const names = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "");
      return names.length > 0 && names.every((n) => (VIEWER_URL_PLACEHOLDERS as readonly string[]).includes(n));
    }, { message: `the template must name at least one of {${VIEWER_URL_PLACEHOLDERS.join("} {")}} and nothing else in braces` }),
  enabled: z.boolean(),
});

const SCHEMA_BY_KIND = {
  study_types: studyTypesBodySchema,
  pregnancy_policy: pregnancyPolicyBodySchema,
  critical_categories: criticalCategoriesBodySchema,
  pacs_settings: pacsSettingsBodySchema,
} as const;

export type StudyTypesBody = z.infer<typeof studyTypesBodySchema>;
export type StudyType = z.infer<typeof studyTypeSchema>;
export type PregnancyPolicyBody = z.infer<typeof pregnancyPolicyBodySchema>;
export type CriticalCategoriesBody = z.infer<typeof criticalCategoriesBodySchema>;
export type PacsSettingsBody = z.infer<typeof pacsSettingsBodySchema>;
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
