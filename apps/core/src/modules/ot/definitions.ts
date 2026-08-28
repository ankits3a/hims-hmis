import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { otDefinitions } from "../../kernel/db/schema";
import { requestApproval } from "../../kernel/approvals/requests";
import { getApproval } from "../../kernel/approvals/worklist";
import { OT_DEFINITION_KIND_VALUES, OT_GATE_KIND_VALUES, PAYER_CLASS_VALUES, ANAESTHESIA_TYPE_VALUES } from "../../kernel/db/schema/ot";
import { DEFINITION_PUBLISH_APPROVAL_TYPE } from "./approval-types";
import { OtError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T3 / DD6 — **GOVERNED DEFINITION DATA: ONE VERSIONED TABLE, PUBLISHED THROUGH APPROVALS.**
 *
 * Four kinds — `criteria`, `privileges`, `deposit_policy`, `pacu_thresholds` — each a `body jsonb`
 * validated by the zod schema below it. A draft is inert; an MS publishes it; the previous active
 * version is superseded in the same transaction.
 *
 * ═══ THE `procedureClass` ENUM IS CLOSED, AND THAT IS DD18's "ABSENT, NOT STUBBED" (A5b / F12) ═══
 *
 * `mtp` and every `usg_*` class are NOT members of `PROCEDURE_CLASS_VALUES`, so a criteria draft
 * naming one **fails zod validation and cannot be stored**. The whitelist cannot be widened into
 * 15b's territory by DATA — not by an MS in a hurry, not by a seed, not by a hand-written row. That
 * is a stronger guarantee than a feature flag, and it is the reason this enum exists in CODE while
 * everything about each class is data: what the unit MAY be configured to do is a code-review
 * question; which of those it IS configured to do is the department heads'.
 *
 * The list is R-3.18's whitelist minus the two 15b owns. It is not "every procedure" and is not
 * meant to be: an ELEVENTH gynae class is a one-line code change plus a review, which is exactly
 * the friction a surgical whitelist should have.
 *
 * ═══ WHY `activeDefinition` READS `status = 'active'` AND NOT `max(version)` (A2) ═══
 *
 * A draft is a proposal. Reading the newest version regardless of status is the mutant A2 names,
 * and it is a plausible implementation — `order by version desc limit 1` looks like "the current
 * one". It would let a coordinator book a procedure the MS has not approved, by the mere existence
 * of a draft somebody typed. The partial unique index `ot_definitions_one_active_ux` makes "one
 * active per kind" a database invariant, so this read cannot return two.
 */

/**
 * THE CLOSED UNIVERSE OF PROCEDURE CLASSES. Twenty, from R-3.18, with `mtp` and the USG classes
 * structurally absent until 15b.
 */
export const PROCEDURE_CLASS_VALUES = [
  // gynaecology — R-3.18 minus first-trimester MTP and pelvic USG (both 15b's)
  "gynae_dnc",
  "gynae_hysteroscopy_diagnostic",
  "gynae_hysteroscopy_operative",
  "gynae_leep_cervical_biopsy",
  "gynae_bartholin_marsupialisation",
  "gynae_tubectomy",
  "gynae_polypectomy",
  "gynae_colposcopy",
  "gynae_iucd_removal",
  // orthopaedics — R-3.18 in full
  "ortho_implant_removal",
  "ortho_closed_reduction_pinning",
  "ortho_carpal_tunnel_release",
  "ortho_trigger_finger_release",
  "ortho_ganglion_excision",
  "ortho_knee_arthroscopy",
  "ortho_tendon_repair",
  "ortho_distal_radius_fixation",
  "ortho_ankle_fixation",
  "ortho_joint_injection",
  "ortho_mua",
] as const;

export type ProcedureClass = (typeof PROCEDURE_CLASS_VALUES)[number];

const procedureClass = z.enum(PROCEDURE_CLASS_VALUES);
const gateKind = z.enum(OT_GATE_KIND_VALUES);
const bps = z.number().int().min(0).max(10000);

/**
 * DD6 — one entry per procedure class the unit is CONFIGURED to do.
 *
 * `requiredGates` is the per-class gate set (A4): `mlc` only where `traumaClass`, `site_marking`
 * only where `lateral`, and `npo` absent entirely for a class with `npoRequired: false` — a
 * local-anaesthesia-only ganglion or trigger finger gets NO NPO gate rather than a waived one
 * (H9/N1/F25). The `superRefine` below enforces those three coherences, because a criteria row that
 * says `lateral: true` and omits `site_marking` is a whitelist that permits wrong-side surgery.
 */
const criteriaEntrySchema = z.object({
  procedureClass,
  department: z.enum(["gynaecology", "orthopaedics"]),
  packageServiceCode: z.string().min(1), // DD6/F8 — ONE `daycare_package` tariff service per class
  lateral: z.boolean(),
  traumaClass: z.boolean(),
  implantExpected: z.boolean(),
  cArm: z.boolean(),
  npoRequired: z.boolean(),
  escortRequired: z.boolean(),
  requiredGates: z.array(gateKind).min(1),
  waivableGates: z.array(gateKind).default([]),
  asaMax: z.number().int().min(1).max(5),
  ageMin: z.number().int().min(0),
  ageMax: z.number().int().min(0),
  bmiMax: z.number().min(1),
  /** R-3.23 — after this IST wall-clock time, `discharge_ready` offers conversion. */
  lateCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
}).superRefine((entry, ctx) => {
  const has = (k: (typeof OT_GATE_KIND_VALUES)[number]) => entry.requiredGates.includes(k);
  if (entry.lateral && !has("site_marking")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${entry.procedureClass}: a lateral class must require the site_marking gate` });
  }
  if (!entry.lateral && has("site_marking")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${entry.procedureClass}: a non-lateral class must not require site_marking — it would never be satisfiable` });
  }
  if (entry.traumaClass && !has("mlc")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${entry.procedureClass}: a trauma class must require the mlc gate` });
  }
  if (entry.npoRequired !== has("npo")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${entry.procedureClass}: npoRequired and the npo gate must agree` });
  }
  if (entry.escortRequired !== has("escort")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${entry.procedureClass}: escortRequired and the escort gate must agree` });
  }
  for (const w of entry.waivableGates) {
    if (!has(w)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${entry.procedureClass}: ${w} is waivable but not required` });
    }
    /**
     * ═══ CLOSE REVIEW (MINOR 6) — THREE GATES ARE NOT WAIVABLE, WHATEVER A DEFINITION SAYS ═══
     *
     * `waiveGate` reaches `waived`, and `TERMINAL_GATE_STATES` counts `waived` as done — so a
     * definition that listed `escort`, `deposit` or `privilege` as waivable would be a second door
     * past exactly the gates `overrideGate` refuses outright. Each of the three refuses for a
     * reason no definition author is entitled to overrule:
     *
     *   · `escort`  — E-4: a day-care patient discharges to an adult, structurally.
     *   · `deposit` — DD12: the only path past a shortfall is the owner's approval, not a drafter's.
     *   · `privilege` — R-3.15: outside privilege is a refusal, not a warning.
     *
     * The seeded definitions all carry `waivableGates: []`, so this was data-only today — which is
     * the point: it is refused now, before somebody publishes the definition that uses it.
     */
    if (w === "escort" || w === "deposit" || w === "privilege") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${entry.procedureClass}: ${w} can never be waivable — it is overridden by approval or not at all`,
      });
    }
  }
  if (entry.ageMin > entry.ageMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${entry.procedureClass}: ageMin exceeds ageMax` });
  }
});

export const criteriaBodySchema = z.object({
  entries: z.array(criteriaEntrySchema).min(1),
}).superRefine((body, ctx) => {
  const seen = new Set<string>();
  for (const e of body.entries) {
    if (seen.has(e.procedureClass)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate criteria entry for ${e.procedureClass}` });
    }
    seen.add(e.procedureClass);
  }
});

/** R-3.15 — a surgeon's privilege list. Outside it, booking is REFUSED, not warned. */
export const privilegesBodySchema = z.object({
  surgeons: z.array(z.object({
    surgeonId: z.string().min(1),
    procedureClasses: z.array(procedureClass),
  })).min(1),
});

/**
 * §3A as data. One rule per payer class, and the eight are exhaustive because `payer_class` is a
 * CHECK on two tables — a policy missing a class would make that class unbookable, silently.
 */
const depositRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("zero") }),
  z.object({ kind: z.literal("percent_of_quote"), percentBps: bps, includeImplantEstimate: z.boolean() }),
  z.object({ kind: z.literal("quote_minus_sanctioned"), coPayFloorBps: bps }),
  z.object({ kind: z.literal("excess_over_credit") }),
  z.object({ kind: z.literal("quote_minus_entitlement") }),
]);

/**
 * ═══ CLOSE REVIEW (MINOR 7) — D10's "NO BALANCE BILLING, STRUCTURALLY" HAS TO BE STRUCTURAL ═══
 *
 * A1's test asserts that `govt_scheme`, `fp_scheme` and `charity` require exactly ₹0. That was a
 * property of the SEEDED POLICY and of nothing else: `requiredDeposit` just reads
 * `policy.rules[class]`, and this schema accepted any rule for any class — so a published policy
 * putting `percent_of_quote` on `govt_scheme` would have made the test's claim false while the test
 * went on passing, because the test reads the same seed it is asserting about (§3.14's family).
 *
 * A scheme patient may not be charged a deposit at all; that is what the scheme IS. Refusing it in
 * the schema means the definition cannot be published rather than discovered at a counter.
 */
const NON_CHARGING_PAYER_CLASSES = ["govt_scheme", "fp_scheme", "charity"] as const;

export const depositPolicyBodySchema = z.object({
  rules: z.object(
    Object.fromEntries(PAYER_CLASS_VALUES.map((c) => [c, depositRuleSchema])) as Record<
      (typeof PAYER_CLASS_VALUES)[number], typeof depositRuleSchema
    >,
  ),
}).superRefine((body, ctx) => {
  for (const cls of NON_CHARGING_PAYER_CLASSES) {
    const rule = body.rules[cls];
    if (rule !== undefined && rule.kind !== "zero") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${cls} must carry a "zero" deposit rule — a scheme or charity patient is not asked for a deposit (D10)`,
      });
    }
  }
});

/**
 * F24b — PACU thresholds keyed by ANAESTHESIA TECHNIQUE, not one PADSS for everybody. A spinal adds
 * ambulation and voiding items; a local-sedation case is scored on a shorter set. `minScores` and
 * `minGapMinutes` are the B7 rule as data: two scores, thirty minutes apart, by `occurred_at`.
 */
export const pacuThresholdsBodySchema = z.object({
  scales: z.array(z.object({
    anaesthesiaType: z.enum(ANAESTHESIA_TYPE_VALUES),
    scale: z.string().min(1),
    items: z.array(z.object({ key: z.string().min(1), max: z.number().int().positive() })).min(1),
    threshold: z.number().int().positive(),
    minScores: z.number().int().min(1),
    minGapMinutes: z.number().int().min(0),
  })).min(1),
}).superRefine((body, ctx) => {
  const seen = new Set<string>();
  for (const s of body.scales) {
    if (seen.has(s.anaesthesiaType)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate PACU scale for ${s.anaesthesiaType}` });
    }
    seen.add(s.anaesthesiaType);
    /**
     * CLOSE REVIEW (MINOR 18) — "one qualifying score, but stable for thirty minutes" is not a
     * strict scale, it is an unsatisfiable one: a gap needs two observations to exist between. A
     * definition carrying it would have deadlocked every discharge scored on it, and the author
     * would have had no way to tell that from a patient who simply was not ready.
     */
    if (s.minScores <= 1 && s.minGapMinutes > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${s.anaesthesiaType}: minGapMinutes needs at least two qualifying scores — a gap cannot be measured against one`,
      });
    }
    const maxPossible = s.items.reduce((sum, i) => sum + i.max, 0);
    if (s.threshold > maxPossible) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${s.anaesthesiaType}: threshold ${String(s.threshold)} exceeds the maximum achievable score ${String(maxPossible)} — no patient could ever be discharged`,
      });
    }
  }
});

export type CriteriaBody = z.infer<typeof criteriaBodySchema>;
export type CriteriaEntry = CriteriaBody["entries"][number];
export type PrivilegesBody = z.infer<typeof privilegesBodySchema>;
export type DepositPolicyBody = z.infer<typeof depositPolicyBodySchema>;
export type PacuThresholdsBody = z.infer<typeof pacuThresholdsBodySchema>;
export type OtDefinitionKind = (typeof OT_DEFINITION_KIND_VALUES)[number];

/** The one place a body is validated. One kind, one schema, no second copy anywhere. */
const SCHEMA_BY_KIND = {
  criteria: criteriaBodySchema,
  privileges: privilegesBodySchema,
  deposit_policy: depositPolicyBodySchema,
  pacu_thresholds: pacuThresholdsBodySchema,
} as const;

export type OtDefinitionRow = typeof otDefinitions.$inferSelect;

/**
 * Validates a body against its kind's schema, or refuses `definition_invalid` with every problem
 * zod found — A5b's refusal, and the one that keeps `mtp` out of the whitelist for good.
 */
export function parseDefinitionBody<K extends OtDefinitionKind>(
  kind: K,
  body: unknown,
): z.infer<(typeof SCHEMA_BY_KIND)[K]> {
  const parsed = SCHEMA_BY_KIND[kind].safeParse(body);
  if (!parsed.success) {
    throw new OtError(
      "definition_invalid",
      `${kind} definition is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      { kind, issues: parsed.error.issues.length },
    );
  }
  return parsed.data as z.infer<(typeof SCHEMA_BY_KIND)[K]>;
}

/** Drafts a new version of a definition kind. Inert until an MS publishes it. */
export async function draftDefinition(
  tx: Tx,
  actor: Actor,
  input: { kind: OtDefinitionKind; body: unknown },
): Promise<{ definitionId: string; version: number }> {
  parseDefinitionBody(input.kind, input.body);
  const latest = await tx
    .select({ version: otDefinitions.version })
    .from(otDefinitions)
    .where(eq(otDefinitions.kind, input.kind))
    .orderBy(desc(otDefinitions.version))
    .limit(1);
  const version = (latest[0]?.version ?? 0) + 1;
  const definitionId = newId();
  await tx.insert(otDefinitions).values({
    id: definitionId, kind: input.kind, version, body: input.body as object,
    status: "draft", draftedBy: actor.id,
  });
  return { definitionId, version };
}

/**
 * DD6 — files the `ot_definition_publish` approval. The engine's own `requester_approver` SoD is
 * what forces two distinct humans; this function adds nothing to it and takes nothing away.
 *
 * The approval is filed on the CALLER's transaction (the `requestApproval` contract), so a draft
 * and its request land together or not at all.
 */
export async function requestDefinitionPublish(
  tx: Tx,
  actor: Actor,
  definitionId: string,
): Promise<{ approvalId: string }> {
  const rows = await tx.select().from(otDefinitions).where(eq(otDefinitions.id, definitionId));
  const draft = rows[0];
  if (!draft) throw new OtError("definition_not_active", `unknown definition ${definitionId}`);
  if (draft.status !== "draft") {
    throw new OtError("definition_not_active", `definition ${definitionId} is ${draft.status}, not a draft`);
  }
  const { approvalId } = await requestApproval(tx, actor, {
    typeKey: DEFINITION_PUBLISH_APPROVAL_TYPE,
    subject: { type: "ot_definition", id: definitionId },
    requestNote: `publish ${draft.kind} v${String(draft.version)}`,
  });
  return { approvalId };
}

/**
 * Publishes a draft whose approval has been GRANTED: the draft becomes `active` and the previous
 * active version becomes `superseded`, in one transaction.
 *
 * **The approval is checked ON EXECUTE, not trusted from the caller** — the `issueInvoice` credit
 * lane's shape. A caller holding a granted approval id for a DIFFERENT definition must not be able
 * to publish this one, so the subject is compared as well as the status.
 */
export async function publishDefinition(
  db: Db,
  actor: Actor,
  input: { definitionId: string; approvalId: string },
): Promise<{ kind: OtDefinitionKind; version: number; supersededVersion: number | null }> {
  const approval = await getApproval(db, input.approvalId);
  if (!approval || approval.status !== "granted") {
    throw new OtError("definition_not_active", `approval ${input.approvalId} is not granted`);
  }
  if (approval.typeKey !== DEFINITION_PUBLISH_APPROVAL_TYPE
    || approval.subjectType !== "ot_definition"
    || approval.subjectId !== input.definitionId) {
    throw new OtError(
      "definition_not_active",
      `approval ${input.approvalId} does not authorise publishing definition ${input.definitionId}`,
    );
  }
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(otDefinitions).where(eq(otDefinitions.id, input.definitionId));
    const draft = rows[0];
    if (!draft) throw new OtError("definition_not_active", `unknown definition ${input.definitionId}`);
    if (draft.status !== "draft") {
      throw new OtError("definition_not_active", `definition ${input.definitionId} is ${draft.status}, not a draft`);
    }
    // Re-validated at PUBLISH as well as at draft: a body that reached the table around this API
    // (a data fix, a bulk load) must not become active without passing the schema (`priceLine`'s
    // defence-in-depth reasoning, applied to definition data).
    parseDefinitionBody(draft.kind as OtDefinitionKind, draft.body);

    const superseded = await tx
      .update(otDefinitions)
      .set({ status: "superseded" })
      .where(and(eq(otDefinitions.kind, draft.kind), eq(otDefinitions.status, "active")))
      .returning({ version: otDefinitions.version });

    await tx.update(otDefinitions)
      .set({ status: "active", publishedBy: actor.id, publishedAt: new Date(), approvalId: input.approvalId })
      .where(eq(otDefinitions.id, input.definitionId));

    return {
      kind: draft.kind as OtDefinitionKind,
      version: draft.version,
      supersededVersion: superseded[0]?.version ?? null,
    };
  });
}

/**
 * **THE ACTIVE definition of a kind — `status = 'active'`, never `max(version)` (A2).** Returns
 * `undefined` when nothing is published; every caller turns that into `definition_not_active`, so a
 * unit whose criteria have not been published cannot book anything at all. That is the intended
 * posture at go-live: the theatre is inert until an MS says what it may do.
 */
export async function activeDefinitionRow(
  exec: Db | Tx,
  kind: OtDefinitionKind,
): Promise<OtDefinitionRow | undefined> {
  const rows = await exec.select().from(otDefinitions)
    .where(and(eq(otDefinitions.kind, kind), eq(otDefinitions.status, "active")))
    .limit(1);
  return rows[0];
}

/** The active body, parsed. Throws `definition_not_active` when the kind has no active version. */
export async function activeDefinition<K extends OtDefinitionKind>(
  exec: Db | Tx,
  kind: K,
): Promise<z.infer<(typeof SCHEMA_BY_KIND)[K]>> {
  const row = await activeDefinitionRow(exec, kind);
  if (!row) {
    throw new OtError("definition_not_active", `no ACTIVE ${kind} definition — an MS must publish one (DD6)`);
  }
  return parseDefinitionBody(kind, row.body);
}

/** The criteria entry for a class, or `undefined` when the ACTIVE whitelist does not carry it. */
export function criteriaFor(body: CriteriaBody, procedure: string): CriteriaEntry | undefined {
  return body.entries.find((e) => e.procedureClass === procedure);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE SEED BODIES — R-3.18's whitelist, §3A's policy and F24b's PACU scales, as DRAFTS.
//
// `seed-ot.ts` installs these as DRAFTS on every deploy and **activates nothing** (DD6: "a seed
// that activates a Class-B definition is the theatre the owner named"). A human publishes them
// through the approvals engine; until then the unit is inert and `bookCase` refuses everything with
// `definition_not_active`, which is the correct posture at go-live.
//
// **THE WHITELIST IS PROVISIONAL AND SAYS SO** (§4A-1). The gynae and ortho heads strike or add
// before the MS publishes; nothing here is hard-coded into a code path, and the twenty classes the
// ENUM admits are the universe a draft may draw from, not the list the unit will run.
//
// `packageServiceCode` names a tariff service the go-live runbook creates (`daycare_package`
// category, one per class — DD6/F8). A draft naming a service the tariff does not carry is legal;
// `bookCase` is where that becomes a refusal, at the first booking rather than at the seed.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const GYNAE_BASE = {
  department: "gynaecology" as const,
  lateral: false, traumaClass: false, implantExpected: false, cArm: false,
  npoRequired: true, escortRequired: true,
  requiredGates: ["anaesthesia_review", "consent_procedure", "consent_anaesthesia", "npo", "deposit", "escort", "privilege"],
  waivableGates: [] as string[],
  asaMax: 2, ageMin: 12, ageMax: 70, bmiMax: 35, lateCutoff: "20:00",
};

const ORTHO_BASE = {
  department: "orthopaedics" as const,
  lateral: true, traumaClass: false, implantExpected: false, cArm: false,
  npoRequired: true, escortRequired: true,
  requiredGates: ["anaesthesia_review", "consent_procedure", "consent_anaesthesia", "site_marking", "npo", "deposit", "escort", "privilege"],
  waivableGates: [] as string[],
  asaMax: 2, ageMin: 12, ageMax: 70, bmiMax: 35, lateCutoff: "20:00",
};

/** R-3.18's whitelist seed, PROVISIONAL. `DC-` + the class, as the runbook names the services. */
export const CRITERIA_SEED_BODY = {
  entries: [
    { ...GYNAE_BASE, procedureClass: "gynae_dnc", packageServiceCode: "DC-GYNAE-DNC" },
    { ...GYNAE_BASE, procedureClass: "gynae_hysteroscopy_diagnostic", packageServiceCode: "DC-GYNAE-HYSTD" },
    { ...GYNAE_BASE, procedureClass: "gynae_hysteroscopy_operative", packageServiceCode: "DC-GYNAE-HYSTO" },
    { ...GYNAE_BASE, procedureClass: "gynae_leep_cervical_biopsy", packageServiceCode: "DC-GYNAE-LEEP" },
    { ...GYNAE_BASE, procedureClass: "gynae_bartholin_marsupialisation", packageServiceCode: "DC-GYNAE-BARTH" },
    { ...GYNAE_BASE, procedureClass: "gynae_tubectomy", packageServiceCode: "DC-GYNAE-TUBEC" },
    { ...GYNAE_BASE, procedureClass: "gynae_polypectomy", packageServiceCode: "DC-GYNAE-POLYP" },
    // A colposcopy and a difficult IUCD removal are done under local anaesthesia: NO NPO gate at
    // all (H9/N1/F25), rather than one that is waived every time.
    {
      ...GYNAE_BASE, procedureClass: "gynae_colposcopy", packageServiceCode: "DC-GYNAE-COLPO",
      npoRequired: false,
      requiredGates: ["consent_procedure", "deposit", "escort", "privilege"],
    },
    {
      ...GYNAE_BASE, procedureClass: "gynae_iucd_removal", packageServiceCode: "DC-GYNAE-IUCD",
      npoRequired: false,
      requiredGates: ["consent_procedure", "deposit", "escort", "privilege"],
    },

    { ...ORTHO_BASE, procedureClass: "ortho_implant_removal", packageServiceCode: "DC-ORTHO-IMPREM" },
    // The three TRAUMA classes carry `mlc` — E5's "RTA ortho: the MLC decision is recorded before
    // wheel-in". They are also the three with `implantExpected` and a C-arm.
    {
      ...ORTHO_BASE, procedureClass: "ortho_closed_reduction_pinning", packageServiceCode: "DC-ORTHO-CRPP",
      traumaClass: true, implantExpected: true, cArm: true, asaMax: 3, ageMin: 5, ageMax: 75,
      requiredGates: [...ORTHO_BASE.requiredGates, "mlc"],
    },
    {
      ...ORTHO_BASE, procedureClass: "ortho_distal_radius_fixation", packageServiceCode: "DC-ORTHO-RADIUS",
      traumaClass: true, implantExpected: true, cArm: true, asaMax: 3, ageMin: 5, ageMax: 75,
      requiredGates: [...ORTHO_BASE.requiredGates, "mlc"],
    },
    {
      ...ORTHO_BASE, procedureClass: "ortho_ankle_fixation", packageServiceCode: "DC-ORTHO-ANKLE",
      traumaClass: true, implantExpected: true, cArm: true, asaMax: 3, ageMin: 12, ageMax: 75,
      requiredGates: [...ORTHO_BASE.requiredGates, "mlc"],
    },
    { ...ORTHO_BASE, procedureClass: "ortho_carpal_tunnel_release", packageServiceCode: "DC-ORTHO-CTR" },
    // Local-anaesthesia hand cases: no NPO gate, and `site_marking` waivable is NOT offered — a
    // trigger finger is still on a named side.
    {
      ...ORTHO_BASE, procedureClass: "ortho_trigger_finger_release", packageServiceCode: "DC-ORTHO-TRIGGER",
      npoRequired: false,
      requiredGates: ["consent_procedure", "site_marking", "deposit", "escort", "privilege"],
    },
    {
      ...ORTHO_BASE, procedureClass: "ortho_ganglion_excision", packageServiceCode: "DC-ORTHO-GANGLION",
      npoRequired: false,
      requiredGates: ["consent_procedure", "site_marking", "deposit", "escort", "privilege"],
    },
    { ...ORTHO_BASE, procedureClass: "ortho_knee_arthroscopy", packageServiceCode: "DC-ORTHO-ARTHRO", asaMax: 3 },
    { ...ORTHO_BASE, procedureClass: "ortho_tendon_repair", packageServiceCode: "DC-ORTHO-TENDON" },
    {
      ...ORTHO_BASE, procedureClass: "ortho_joint_injection", packageServiceCode: "DC-ORTHO-INJECT",
      npoRequired: false,
      requiredGates: ["consent_procedure", "site_marking", "deposit", "escort", "privilege"],
    },
    { ...ORTHO_BASE, procedureClass: "ortho_mua", packageServiceCode: "DC-ORTHO-MUA", asaMax: 3 },
  ],
};

/** §3A's table, as data. The owner's ruling: 100 % default for self-pay, flexible per class. */
export const DEPOSIT_POLICY_SEED_BODY = {
  rules: {
    self_pay: { kind: "percent_of_quote", percentBps: 10000, includeImplantEstimate: true },
    insured_tpa: { kind: "quote_minus_sanctioned", coPayFloorBps: 2000 },
    govt_scheme: { kind: "zero" },
    fp_scheme: { kind: "zero" },
    corporate_credit: { kind: "excess_over_credit" },
    membership_prepaid: { kind: "quote_minus_entitlement" },
    staff_dependant: { kind: "percent_of_quote", percentBps: 5000, includeImplantEstimate: false },
    charity: { kind: "zero" },
  },
};

/** F24b — one scale per technique. Spinal adds ambulation and voiding; local sedation is shorter. */
export const PACU_THRESHOLDS_SEED_BODY = {
  scales: [
    {
      anaesthesiaType: "general", scale: "padss",
      items: [
        { key: "vitals", max: 2 }, { key: "ambulation", max: 2 }, { key: "nausea", max: 2 },
        { key: "pain", max: 2 }, { key: "bleeding", max: 2 },
      ],
      threshold: 9, minScores: 2, minGapMinutes: 30,
    },
    {
      anaesthesiaType: "regional", scale: "padss",
      items: [
        { key: "vitals", max: 2 }, { key: "ambulation", max: 2 }, { key: "nausea", max: 2 },
        { key: "pain", max: 2 }, { key: "bleeding", max: 2 },
      ],
      threshold: 9, minScores: 2, minGapMinutes: 30,
    },
    {
      anaesthesiaType: "spinal", scale: "padss_spinal",
      items: [
        { key: "vitals", max: 2 }, { key: "ambulation", max: 2 }, { key: "nausea", max: 2 },
        { key: "pain", max: 2 }, { key: "bleeding", max: 2 }, { key: "voiding", max: 2 },
        { key: "motor_block", max: 2 },
      ],
      threshold: 12, minScores: 2, minGapMinutes: 30,
    },
    {
      anaesthesiaType: "local_sedation", scale: "padss_light",
      items: [{ key: "vitals", max: 2 }, { key: "nausea", max: 2 }, { key: "pain", max: 2 }],
      threshold: 5, minScores: 2, minGapMinutes: 30,
    },
  ],
};

/**
 * The three bodies `seed-ot.ts` drafts. **`privileges` is NOT among them, and that is a decision:**
 * a privilege list names REAL surgeon user ids, which a seed cannot know and must not invent. The
 * MS drafts it at go-live from the credentialing committee's list (T9's runbook), and until they do,
 * every booking is refused `definition_not_active` — which is the honest state of a unit whose
 * surgeons have not been credentialed in this system.
 */
export const OT_DEFINITION_SEEDS: { kind: OtDefinitionKind; body: unknown }[] = [
  { kind: "criteria", body: CRITERIA_SEED_BODY },
  { kind: "deposit_policy", body: DEPOSIT_POLICY_SEED_BODY },
  { kind: "pacu_thresholds", body: PACU_THRESHOLDS_SEED_BODY },
];
