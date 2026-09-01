import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { imagingSafetyScreenings, imagingStudies } from "../../kernel/db/schema/radiology";
import { pcpndtFormF } from "../../kernel/db/schema/pcpndt";
import { patients } from "../../kernel/db/schema/patients";
import { users } from "../../kernel/db/schema/auth";
import { appendEvent } from "../../kernel/events/append";
import { startInstance, transition, WorkflowError } from "../../kernel/workflow/instances";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { consentSchema, consentEvidence } from "../ot";
import { guardiansWithAuthority, listAllergies } from "../patients";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { RadiologyError } from "./errors";
import { imagingGateEvaluated } from "./events";
import { requireStudyType } from "./study-types";
import { IMAGING_GATE_DEF_KEY } from "./workflow-def";
import type { PregnancyPolicyBody } from "./definitions";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";
import type { ImagingGateKind } from "../../kernel/db/schema/radiology";

/**
 * PLAN 18a T5 / DD7 — **THE TEN SAFETY GATES: opened from facts, satisfied by evidence, and one
 * override lane that the statute is not on.** `modules/ot/gates.ts` transcribed, because the OT's
 * version is the house pattern for a gate and a second shape would be a second thing to reason
 * about — with three differences, each of which is a ruling rather than a drift.
 *
 * ═══ 1. THE OVERRIDE IS THE RADIOLOGIST'S ALONE, NOT TWO ACTORS ═══
 *
 * The OT demands a surgeon AND an anaesthetist because both are about to be in the room. DD7 rules
 * otherwise here, and the reason is who raised the gate: **the technologist raises it and the
 * radiologist IS the second clinical opinion on it.** A two-actor form would need a second
 * radiologist at 02:00 for a head CT, which is a rule that gets worked around rather than followed.
 * `overrideGate` still demands a non-empty REASON (A3), because P1's *"benefit outweighs risk"* is
 * a judgement somebody must be willing to write down.
 *
 * ═══ 2. TWO KINDS HAVE NO LANE AT ALL, AND THE REFUSAL IS BY KIND, FIRST, ALWAYS (A2) ═══
 *
 *   · **`form_f` is neither waivable nor overridable.** N2: *"no emergency bypass exists."* The
 *     PCPNDT Act does not contain a clause for a busy evening.
 *   · **`identity_two_factor` is not WAIVABLE** — it is overridable with a reason, and the two are
 *     not the same act. A waiver says *"this gate does not apply to this patient"*, which is never
 *     true of identity; an override says *"it applies, I am accepting the risk, and here is why"*,
 *     which is exactly the unconscious trauma patient with no name.
 *
 * **Both refusals happen before ANY definition, role or `waivable` column is read** (A2's own
 * words: *"the refusal happens with an empty definition table"*). A2's mutant consults the
 * definition first, and the harm it names is one row away: a body that lists `form_f` as waivable
 * makes it waivable, and a governed definition is DATA that a human republishes.
 *
 * ═══ 3. `waivable` IS SNAPSHOTTED FROM CODE, NOT FROM THE BODY, AND IT IS THE SECOND LAYER ═══
 *
 * `ot_case_gates.waivable` is snapshotted from the criteria definition's `waivableGates`.
 * `studyTypeSchema` (T4) carries no such list — a fact measured, not assumed — so this file owns
 * `WAIVABLE_KINDS`. That is the better place for it anyway: a statutory kind whose waivability
 * lived in a governed body would be one UPDATE from being false, which is the exact shape
 * `radiology.ts`'s own table header rejects. The column is still written and still read, so a row
 * hand-edited to `waivable = true` widens the *clinical* kinds and cannot touch the two above.
 *
 * ═══ EVERY GATE IS COMPUTED, NEVER ASSERTED — AND THAT IS WHERE THIS FILE SPENDS ITS LINES ═══
 *
 * `ot/gates.ts`'s header: *"`npo: { satisfied: true }` is a checkbox, and a checkbox on a
 * pre-operative gate is a checkbox somebody ticks at 08:55 for a 09:00 list."* The same discipline,
 * applied to the ten kinds here, is what produced the deviations from the plan's evidence sketch
 * that §9.2 records: `identity_two_factor` carries the VALUE it is claiming to have checked and is
 * compared against the patient master; `renal_function`'s context is DERIVED from the encounter
 * number rather than typed; `form_f` reads the register and takes no evidence from the caller at
 * all; `prior_contrast_reaction` reads `listAllergies` itself.
 */

/** The three TERMINAL gate states. A gate in any of them is done; `open` is not. */
export const IMAGING_TERMINAL_GATE_STATES = ["satisfied", "waived", "overridden"] as const;

/**
 * ═══ THE TWO STATUTORY REFUSALS, BY KIND, BEFORE ANYTHING ELSE (A2, A6) ═══
 *
 * Read the header for why these are constants in code rather than fields on a governed body.
 */
export const NEVER_WAIVABLE_KINDS: readonly ImagingGateKind[] = ["form_f", "identity_two_factor"];
export const NEVER_OVERRIDABLE_KINDS: readonly ImagingGateKind[] = ["form_f"];

/**
 * The kinds a WAIVER may reach — *"this gate does not apply to this patient"*.
 *
 * Deliberately two, and every omission is an argument:
 *   · `pregnancy_screen` — a hysterectomy or a documented post-menopausal state makes the question
 *     inapplicable rather than answered, and asking for an LMP is then not a safety control.
 *   · `chaperone_present` — a patient may decline a chaperone, and a declined chaperone recorded is
 *     better than a chaperone gate somebody clicks past.
 *   · `contrast_consent`, `mri_safety`, `renal_function`, `prior_contrast_reaction` are NOT here:
 *     each is a fact about the patient that is either established or not, and the lane for
 *     "established and we are proceeding anyway" is the radiologist's OVERRIDE, which is evented.
 *   · `laterality_confirm` and `mlc_check` open only when they apply, so a waiver would be
 *     undoing the opening rule rather than making a clinical judgement.
 */
export const WAIVABLE_KINDS: readonly ImagingGateKind[] = ["pregnancy_screen", "chaperone_present"];

/**
 * ═══ THE PREGNANCY POLICY'S DEFAULT, AND WHY THERE IS ONE (DECIDED — §9.2) ═══
 *
 * `pregnancy_policy` is a governed definition kind with a published schema (T4) and NO SEED — the
 * seed script is T4's file and this task may not widen it. A `checkIn` that threw
 * `definition_not_active` until somebody published a policy would make the whole department
 * un-check-in-able at go-live, and unlike the study-type book there is nothing for a runbook step
 * to publish.
 *
 * So the policy is a governed OVERRIDE of a default rather than a precondition, and **the default
 * is the strict end of every field it has**: the widest age band, so no woman falls outside the
 * screen; and `declaration_sufficient_for_ionising: false`, so a verbal "no" alone does not carry a
 * CT. A hospital that publishes nothing gets the safest behaviour and not the laxest, which is the
 * same asymmetry `applicability.ts` argues for a null date of birth.
 */
export const DEFAULT_PREGNANCY_POLICY: PregnancyPolicyBody = {
  min_age_years: 10,
  max_age_years: 60,
  accepted_evidence: ["declaration", "lmp_date", "hcg_result"],
  hcg_validity_days: 7,
  declaration_sufficient_for_ionising: false,
};

/**
 * ═══ RENAL VALIDITY IS PER CONTEXT, AND THE CONTEXT IS DERIVED (A4) ═══
 *
 * A4's mutant is *"compare days with the wrong context → an ICU creatinine from last month passes
 * gadolinium"*. A context the RECORDER TYPES is that mutant with extra steps: the person in a hurry
 * types the band with the longest validity. So the context comes from the study's own encounter
 * number — `V…` is an OPD visit, `D…` is a day-care encounter — and only `ckdFlagged`, which no
 * table in this system carries yet, is typed.
 *
 * Thirty days for a well outpatient and seven for anybody else is the ordinary radiology-department
 * rule: renal function in a stable outpatient does not move, and in an admitted or CKD patient it
 * moves in days. A CKD flag takes the SHORTER of the two, never the longer.
 */
export const RENAL_VALIDITY_DAYS_OPD = 30;
export const RENAL_VALIDITY_DAYS_ADMITTED = 7;
export const RENAL_VALIDITY_DAYS_CKD = 7;

/**
 * Above this the gate cannot be SATISFIED and the radiologist's override is the only path. 176.8
 * µmol/L is 2.0 mg/dL, the cut most Indian departments hold gadolinium and iodinated contrast at.
 * The number is a threshold for a LANE, not a clinical decision — the decision is the override's
 * reason, and this is what makes somebody write one.
 */
export const RENAL_CREATININE_CEILING_UMOL_L = 176.8;

/**
 * The "28-day rule": an LMP inside one cycle is reassuring, and an LMP quoted from two months ago
 * is the commonest way a pregnancy screen is satisfied by a number that means nothing.
 */
export const LMP_REASSURING_DAYS = 28;

/** The childbearing band the screen opens on when no policy is published — see the default above. */
const DAY_MS = 86_400_000;

// ═══════════════════════════ evidence schemas, per kind ═══════════════════════════

/**
 * A1/A6 — the second identifier, WITH THE VALUE IT CLAIMS TO HAVE CHECKED.
 *
 * The plan's sketch is `{secondIdentifier: 'dob'|'uhid'|'wristband'}`, and that is a checkbox: it
 * records which question was asked and not what the answer was. **DISCLOSED DEVIATION (§9.2):**
 * `value` is required and, for `dob` and `uhid`, is COMPARED against the patient master here. A
 * wristband has no registry to compare against in this slice, so it is recorded as stated — which
 * is honest, and is why the two comparable kinds are compared.
 */
const identitySchema = z.object({
  secondIdentifier: z.enum(["dob", "uhid", "wristband"]),
  /** `YYYY-MM-DD` for `dob`, the UHID string for `uhid`, the band's printed id for `wristband`. */
  value: z.string().min(1).max(64),
});

/** The declaration, the LMP and the hCG pointer — which of them SUFFICES is the policy's answer. */
const pregnancySchema = z.object({
  /** The patient has DECLARED SHE IS NOT PREGNANT. `false` is not evidence; it is a reason to stop. */
  declared: z.boolean(),
  /** ISO date. Aged against the scan, not against today. */
  lmpDate: z.string().min(1).optional(),
  /** A POINTER at a result — never the value (the event grammar's rule, applied to evidence too). */
  hcgResultRef: z.string().min(1).optional(),
  /**
   * **DISCLOSED DEVIATION (§9.2):** the policy carries `hcg_validity_days` and the plan's evidence
   * sketch carries no instant to measure it from. A validity in days needs a date, so the sample
   * instant is required whenever an hCG is offered as the evidence.
   */
  hcgResultAt: z.string().min(1).optional(),
});

const renalSchema = z.object({
  creatinineUmolL: z.number().positive().max(3000),
  sampledAt: z.string().min(1),
  /** H5 — an outside-lab creatinine on paper is ACCEPTED, and the flag stays visible in the evidence. */
  source: z.enum(["internal", "external"]),
  /** Typed, because nothing in this system records a CKD diagnosis yet. Shortens the window only. */
  ckdFlagged: z.boolean().default(false),
});

/**
 * A5 — the caller offers a radiologist's decision; the ALLERGY LIST is read by this file. The
 * mutant the plan names is reading the prescription's `allergy_overrides` instead, which would make
 * a patient-master allergy invisible.
 */
const priorContrastReactionSchema = z.object({
  /**
   * Required only when an active contrast-class allergy exists — see `computeSatisfaction`. The
   * radiographer at the console records the radiologist's decision; the radiologist need not be the
   * actor, because `radiology.gates.satisfy` is the radiographer's grant (F19).
   */
  radiologistId: z.string().min(1).optional(),
  reason: z.string().min(1).max(400).optional(),
});

const mriSafetySchema = z.object({
  implants: z.array(z.string().min(1).max(120)).default([]),
  pacemaker: z.boolean(),
  clips: z.boolean(),
  cochlear: z.boolean(),
  metalFb: z.boolean(),
  claustrophobia: z.boolean().default(false),
});

const chaperoneSchema = z.object({ chaperoneUserId: z.string().min(1).max(64) });

const lateralitySchema = z.object({
  patientStated: z.enum(["left", "right", "bilateral", "na"]),
});

/** `ot/gates.ts`'s `mlcSchema`, transcribed: "ruled out" is a decision and is recorded as one. */
const mlcSchema = z.object({
  status: z.enum(["registered", "ruled_out"]),
  mlcNo: z.string().min(1).max(64).optional(),
});

// ═══════════════════════════ reads ═══════════════════════════

export type GateRow = typeof imagingSafetyScreenings.$inferSelect;
export type StudyRow = typeof imagingStudies.$inferSelect;

/** The gate's state, from its pinned instance — never mirrored on the row (DD7, `gateState`'s rule). */
export async function gateState(exec: Db | Tx, gateId: string): Promise<string> {
  const rows = (await exec.execute(sql`
    select w.current_state as "state" from imaging_safety_screenings g
      join workflow_instances w on w.id = g.workflow_instance_id
     where g.id = ${gateId}
  `)).rows as { state: string }[];
  const found = rows[0];
  if (!found) throw new RadiologyError("unknown_study", `unknown gate ${gateId}`, { gateId });
  return found.state;
}

export type StudyGate = { id: string; kind: string; state: string; waivable: boolean };

/** Every gate of a study, with its state. `evaluateReadiness` and the console both read this. */
export async function studyGates(exec: Db | Tx, studyId: string): Promise<StudyGate[]> {
  return (await exec.execute(sql`
    select g.id as "id", g.kind as "kind", w.current_state as "state", g.waivable as "waivable"
      from imaging_safety_screenings g
      join workflow_instances w on w.id = g.workflow_instance_id
     where g.study_id = ${studyId}
     order by g.kind
  `)).rows as StudyGate[];
}

/** The STUDY's own state, from its instance. `imaging_studies.status` is the projection, not this. */
export async function studyState(exec: Db | Tx, studyId: string): Promise<string> {
  const rows = (await exec.execute(sql`
    select w.current_state as "state" from imaging_studies s
      join workflow_instances w on w.id = s.workflow_instance_id
     where s.id = ${studyId}
  `)).rows as { state: string }[];
  const found = rows[0];
  if (!found) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  return found.state;
}

/**
 * Addresses a gate by KIND, which is what a console knows. Refuses rather than returning null.
 *
 * `unknown_study` for an unknown GATE is `ot/gates.ts`'s own choice (`unknown_case`), transcribed
 * rather than widened: `errors.ts` closes the union for the whole of Plan 18a on purpose, and the
 * rule it states is that a later task needing a missing code has found a PLAN DEFECT — it does not
 * add one. There is no honest gate-shaped 404 in the union, the message names the kind, and one
 * module over the same refusal reads the same way.
 */
export async function requireStudyGate(
  exec: Db | Tx, studyId: string, kind: string,
): Promise<StudyGate> {
  const found = (await studyGates(exec, studyId)).find((g) => g.kind === kind);
  if (!found) {
    throw new RadiologyError(
      "unknown_study",
      `study ${studyId} has no ${kind} gate — it was not opened at check-in`,
      { studyId, kind },
    );
  }
  return found;
}

/**
 * ═══ OPENING ONE GATE, AND IT IS EXPORTED FOR T7 RATHER THAN PRIVATE TO CHECK-IN ═══
 *
 * `checkIn` opens the derived set. T7 needs the same act for the kind that CANNOT be derived at
 * check-in: `contrast_option: 'optional'` means the contrast decision is taken at the console, and
 * a `contrast_consent` gate opened at check-in for a scan that turns out to need no contrast is a
 * gate the floor learns to click past. So the seam is here, in one place, instead of T7 growing a
 * second gate-creator. Idempotent by `imaging_safety_screenings_study_kind_ux`: a re-open returns
 * the existing gate rather than colliding.
 */
export async function openStudyGate(
  tx: Tx,
  study: Pick<StudyRow, "id" | "patientId" | "encounterNo">,
  kind: ImagingGateKind,
): Promise<{ gateId: string; opened: boolean }> {
  const existing = await (tx as unknown as Db)
    .select({ id: imagingSafetyScreenings.id })
    .from(imagingSafetyScreenings)
    .where(and(
      eq(imagingSafetyScreenings.studyId, study.id),
      eq(imagingSafetyScreenings.kind, kind),
    ));
  if (existing[0]) return { gateId: existing[0].id, opened: false };

  const { instanceId } = await startInstance(tx, IMAGING_GATE_DEF_KEY, {
    type: "imaging_gate", id: `${study.id}:${kind}`,
    patientId: study.patientId, encounterId: study.encounterNo,
  });
  const gateId = newId();
  await tx.insert(imagingSafetyScreenings).values({
    id: gateId, studyId: study.id, kind, workflowInstanceId: instanceId,
    waivable: WAIVABLE_KINDS.includes(kind),
  });
  return { gateId, opened: true };
}

// ═══════════════════════════ the per-kind computation ═══════════════════════════

async function loadGate(exec: Db | Tx, gateId: string): Promise<{ gate: GateRow; study: StudyRow }> {
  const gateRows = await (exec as Db).select().from(imagingSafetyScreenings)
    .where(eq(imagingSafetyScreenings.id, gateId));
  const gate = gateRows[0];
  if (!gate) throw new RadiologyError("unknown_study", `unknown gate ${gateId}`, { gateId });
  const studyRows = await (exec as Db).select().from(imagingStudies)
    .where(eq(imagingStudies.id, gate.studyId));
  return { gate, study: studyRows[0]! };
}

/**
 * The active `pregnancy_policy`, or the default. `activeDefinitionRow` rather than
 * `activeDefinition`, because the latter THROWS when a kind has never been published and the whole
 * point of the default is that this one has not been.
 */
export async function pregnancyPolicy(exec: Db | Tx): Promise<{
  policy: PregnancyPolicyBody; source: "published" | "default";
}> {
  const row = await activeDefinitionRow(exec, "pregnancy_policy");
  if (!row) return { policy: DEFAULT_PREGNANCY_POLICY, source: "default" };
  return { policy: parseDefinitionBody("pregnancy_policy", row.body), source: "published" };
}

/**
 * A5 — the substances that make a contrast study a conversation with a radiologist.
 *
 * A term list rather than a coded allergen class, because `patient_allergies.substance` is free
 * text typed at a counter and there is no allergen coding system in this repository to join to.
 * Matched case-insensitively as a substring, which over-matches rather than under-matches: this is
 * the direction the whole phase argues for on a safety flag.
 */
export const CONTRAST_ALLERGEN_TERMS: readonly string[] = [
  "contrast", "iodine", "iodinated", "iodine-based", "iohexol", "iopamidol", "ioversol",
  "iodixanol", "iopromide", "omnipaque", "ultravist", "gadolinium", "gadobutrol", "gadoterate",
  "gadopentetate", "dotarem", "magnevist",
];

export function isContrastAllergen(substance: string): boolean {
  const s = substance.toLowerCase();
  return CONTRAST_ALLERGEN_TERMS.some((t) => s.includes(t));
}

/**
 * Whole-and-fractional days between two instants, refusing a FUTURE one.
 *
 * Every ageing rule in this file compares "how old is this evidence" against a window, and a
 * mistyped year makes that age NEGATIVE — which passes every `> validDays` test there is. A
 * creatinine sampled in 2027 is not a fresh creatinine; it is a typo, and a window check is exactly
 * where a typo becomes a satisfied safety gate.
 */
function agedDays(now: Date, raw: string, field: string): number {
  const at = requireDate(raw, field);
  const days = (now.getTime() - at.getTime()) / DAY_MS;
  if (days < 0) {
    throw new RadiologyError(
      "evidence_invalid",
      `${field} is in the future (${raw}) — evidence cannot be aged against a date that has not happened`,
      { field },
    );
  }
  return days;
}

/**
 * ═══ EVERY EVIDENCE PARSE GOES THROUGH HERE, AND `errors.ts`'s HEADER IS WHY ═══
 *
 * A bare `schema.parse(raw)` throws a `ZodError`, which `toHttp` does not know and rethrows — so a
 * malformed evidence body reaches a technologist as **"Internal Server Error"** instead of as the
 * field that is wrong. That is the 500-escape this repository has shipped three times (Plans 09, 13
 * and 15) and the reason `radiologyHttpStatus` is exported at all. The evidence body cannot be
 * parsed at the controller the way `reason` is — ten kinds have ten shapes, and a controller that
 * switched on the kind to pick a schema would be a second place that knows which evidence belongs
 * to which gate — so the conversion happens here, once, for all ten.
 */
function parseEvidence<T>(schema: z.ZodType<T>, raw: unknown, kind: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RadiologyError(
      "evidence_invalid",
      `the ${kind} evidence is not usable: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      { kind, issues: parsed.error.issues.length },
    );
  }
  return parsed.data;
}

function requireDate(raw: string, field: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new RadiologyError("evidence_invalid", `${field} is not a date: "${raw}"`, { field });
  }
  return d;
}

/**
 * The per-kind computation. Returns the evidence blob to store, or throws.
 *
 * A switch and not a table of validators, for `ot/gates.ts`'s reason: every branch is the answer to
 * *"what would make THIS gate a lie?"*, and the answers are not symmetrical.
 */
async function computeSatisfaction(
  tx: Tx, actor: Actor, gate: GateRow, study: StudyRow, raw: unknown, now: Date,
): Promise<Record<string, unknown>> {
  switch (gate.kind) {
    /**
     * A6's "wrong Ram Kumar". Two identifiers, and the second one is CHECKED rather than ticked.
     */
    case "identity_two_factor": {
      const parsed = parseEvidence(identitySchema, raw, "identity_two_factor");
      const patient = (await (tx as unknown as Db).select({
        uhid: patients.uhid, dob: patients.dob,
      }).from(patients).where(eq(patients.id, study.patientId)))[0]!;

      /**
       * ═══ F64 (CLOSE REVIEW) — THE WRISTBAND LEG COMPARED NOTHING ═══
       *
       * `uhid` and `dob` were both computed against the patient master; `wristband` fell through
       * both branches and returned satisfied for ANY string. So the one gate this file calls **never
       * waivable** — the gate that exists for A6's "wrong Ram Kumar" — was cleared by typing four
       * characters into a field nothing read. The `dob`/`uhid` legs proved their negatives in
       * `gates.test.ts`; the wristband branch had no assertion beyond its acceptance, so a rule and
       * no rule agreed on every state the suite inspected.
       *
       * **A wristband carries the UHID** — it is printed from it at registration — so it is the
       * same datum read off a band instead of asked aloud, and it is compared the same way. The
       * distinction the enum keeps is HOW the identity was confirmed, which is what an audit of a
       * wrong-patient event wants to know; it was never meant to be a way of not confirming it.
       */
      if (
        (parsed.secondIdentifier === "uhid" || parsed.secondIdentifier === "wristband")
        && parsed.value.trim() !== patient.uhid
      ) {
        throw new RadiologyError(
          "gate_open",
          `the ${parsed.secondIdentifier === "uhid" ? "UHID the patient gave" : "wristband"} is not `
          + "this record's — check who is in front of you before scanning",
          { given: parsed.value, secondIdentifier: parsed.secondIdentifier },
        );
      }
      if (parsed.secondIdentifier === "dob") {
        if (patient.dob === null) {
          throw new RadiologyError(
            "gate_open",
            "this patient's record carries no date of birth, so a date of birth cannot be the second identifier",
          );
        }
        const stated = requireDate(parsed.value, "value");
        if (stated.toISOString().slice(0, 10) !== patient.dob.toISOString().slice(0, 10)) {
          throw new RadiologyError(
            "gate_open",
            "the date of birth the patient gave is not this record's",
            { given: parsed.value },
          );
        }
      }
      return { kind: "identity_two_factor", ...parsed };
    }

    /**
     * O-5 — WHAT COUNTS AS EVIDENCE IS THE POLICY'S ANSWER, and the ionising clause is the one that
     * matters: a verbal "no" carries a chest X-ray in most departments and does not carry a CT
     * abdomen. `declaration_sufficient_for_ionising` is the field that says which of those this
     * hospital is, and the DEFAULT (see the header) is the strict reading.
     */
    case "pregnancy_screen": {
      const parsed = parseEvidence(pregnancySchema, raw, "pregnancy_screen");
      const { policy, source } = await pregnancyPolicy(tx);
      const type = await requireStudyType(tx, study.studyTypeCode);

      if (!parsed.declared) {
        throw new RadiologyError(
          "gate_open",
          "the patient has not declared that she is not pregnant — a scan on a possibly pregnant "
          + "patient is the radiologist's call and needs an override with a reason (P1)",
        );
      }

      const offered: string[] = [];
      if (policy.accepted_evidence.includes("declaration")) offered.push("declaration");

      if (parsed.lmpDate !== undefined && policy.accepted_evidence.includes("lmp_date")) {
        const ageDays = agedDays(now, parsed.lmpDate, "lmpDate");
        if (ageDays > LMP_REASSURING_DAYS) {
          throw new RadiologyError(
            "evidence_stale",
            `the last menstrual period is ${String(Math.floor(ageDays))} days ago and is reassuring `
            + `for ${String(LMP_REASSURING_DAYS)} — take an hCG or record a declaration instead`,
            { ageDays, validDays: LMP_REASSURING_DAYS },
          );
        }
        offered.push("lmp_date");
      }

      if (parsed.hcgResultRef !== undefined && policy.accepted_evidence.includes("hcg_result")) {
        if (parsed.hcgResultAt === undefined) {
          throw new RadiologyError(
            "evidence_invalid",
            "an hCG result offered as evidence must carry the instant it was sampled — a validity "
            + "in days cannot be measured from a pointer alone",
          );
        }
        const ageDays = agedDays(now, parsed.hcgResultAt, "hcgResultAt");
        if (ageDays > policy.hcg_validity_days) {
          throw new RadiologyError(
            "evidence_stale",
            `the hCG is ${String(Math.floor(ageDays))} days old and the policy holds it for `
            + `${String(policy.hcg_validity_days)}`,
            { ageDays, validDays: policy.hcg_validity_days },
          );
        }
        offered.push("hcg_result");
      }

      /**
       * A policy MAY refuse declarations entirely (`accepted_evidence: ['hcg_result']`). Without
       * this the gate would then satisfy on evidence the policy does not accept and nothing else —
       * which is the emptiest possible checkbox, reached by a route the ionising clause below does
       * not cover because a non-ionising study can still carry this gate through the type's own
       * `gates` seam.
       */
      if (offered.length === 0) {
        throw new RadiologyError(
          "gate_open",
          "none of the evidence offered is accepted by this hospital's pregnancy policy "
          + `(it accepts ${policy.accepted_evidence.join(", ")})`,
          { accepted: policy.accepted_evidence, policySource: source },
        );
      }

      const beyondDeclaration = offered.filter((e) => e !== "declaration");
      if (type.ionising && !policy.declaration_sufficient_for_ionising && beyondDeclaration.length === 0) {
        throw new RadiologyError(
          "gate_open",
          "this hospital's pregnancy policy does not accept a declaration alone for an ionising "
          + "study — record the last menstrual period or an hCG result",
          { policySource: source, studyTypeCode: study.studyTypeCode },
        );
      }
      return { kind: "pregnancy_screen", ...parsed, acceptedBy: offered, policySource: source };
    }

    /**
     * The consent SHAPE is `ot/consents.ts`'s, imported rather than copied (the plan's own
     * instruction): `procedureCode` + `templateVersion`, `language` + `interpreter`, thumb
     * impression + witness, and the guardian-authority rule. What differs is what it is checked
     * AGAINST — the study type instead of a procedure code, and a laterality that may be `na`.
     */
    case "contrast_consent": {
      const parsedConsent = consentSchema.safeParse(raw);
      if (!parsedConsent.success) {
        throw new RadiologyError(
          "evidence_invalid",
          `the contrast consent is incomplete: ${parsedConsent.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      const consent = parsedConsent.data;
      if (consent.procedureCode !== study.studyTypeCode) {
        throw new RadiologyError(
          "evidence_invalid",
          `this consent is for "${consent.procedureCode}" and the study is "${study.studyTypeCode}" (H6)`,
        );
      }
      /** `na` on a study is "no side", and `null` on a consent is the same statement. */
      const studyLaterality = study.laterality === "na" ? null : study.laterality;
      if (consent.laterality !== studyLaterality) {
        throw new RadiologyError(
          "evidence_invalid",
          `the consent's side (${String(consent.laterality)}) is not the study's (${String(studyLaterality)})`,
        );
      }
      if (consent.signer === "guardian") {
        const guardians = await guardiansWithAuthority(tx, study.patientId, now);
        const guardian = guardians.find((g) => g.guardianId === consent.guardianId);
        if (!guardian) {
          throw new RadiologyError(
            "evidence_invalid",
            `guardian ${String(consent.guardianId)} is not a live guardian of this patient (E15)`,
          );
        }
        if (!guardian.authority.consents) {
          throw new RadiologyError(
            "evidence_invalid",
            `guardian ${guardian.guardianId} (${guardian.relationship}) does not hold CONSENT authority`,
            { guardianId: guardian.guardianId },
          );
        }
      }
      return consentEvidence(consent, actor);
    }

    /**
     * ═══ A4 — THE CONTEXT DECIDES THE WINDOW, AND THE CONTEXT IS NOT TYPED ═══
     *
     * See the header for why. `V…` is an OPD visit (30 days); anything else is admitted or day-care
     * (7); a CKD flag takes the shorter of the two and never the longer.
     */
    case "renal_function": {
      const parsed = parseEvidence(renalSchema, raw, "renal_function");
      const context = study.encounterNo.startsWith("V") ? "opd" : "admitted";
      const base = context === "opd" ? RENAL_VALIDITY_DAYS_OPD : RENAL_VALIDITY_DAYS_ADMITTED;
      const validDays = parsed.ckdFlagged ? Math.min(base, RENAL_VALIDITY_DAYS_CKD) : base;
      const ageDays = agedDays(now, parsed.sampledAt, "sampledAt");

      if (ageDays > validDays) {
        throw new RadiologyError(
          "evidence_stale",
          `the creatinine was sampled ${String(Math.floor(ageDays))} days ago and is valid for `
          + `${String(validDays)} in a ${context}${parsed.ckdFlagged ? ", CKD-flagged," : ""} context`,
          { ageDays, validDays, context, ckdFlagged: parsed.ckdFlagged },
        );
      }
      if (parsed.creatinineUmolL > RENAL_CREATININE_CEILING_UMOL_L) {
        throw new RadiologyError(
          "gate_open",
          `creatinine ${String(parsed.creatinineUmolL)} µmol/L is above the `
          + `${String(RENAL_CREATININE_CEILING_UMOL_L)} µmol/L ceiling for contrast — this is the `
          + "radiologist's override with a reason, not a satisfied gate (P1)",
          { creatinineUmolL: parsed.creatinineUmolL, ceiling: RENAL_CREATININE_CEILING_UMOL_L },
        );
      }
      /** H5 — the `external` flag stays in the stored evidence, visible to whoever reads it later. */
      return { kind: "renal_function", ...parsed, context, validDays, ageDays };
    }

    /**
     * ═══ A5 — THE ALLERGY LIST IS READ HERE, AND THE PATIENT MASTER IS THE BOOK ═══
     *
     * The mutant reads the prescription's `allergy_overrides`, which would make an allergy recorded
     * at registration invisible to a CT with contrast. `listAllergies` + `status === 'active'` is
     * the same read `opd/prescriptions.ts` performs, so there is one answer to "is this patient
     * allergic" in the building.
     */
    case "prior_contrast_reaction": {
      const parsed = parseEvidence(priorContrastReactionSchema, raw, "prior_contrast_reaction");
      const active = (await listAllergies(tx as unknown as Db, study.patientId))
        .filter((a) => a.status === "active");
      const hits = active.filter((a) => isContrastAllergen(a.substance));

      if (hits.length === 0) {
        return {
          kind: "prior_contrast_reaction", contrastAllergyFound: false,
          allergiesChecked: active.length,
        };
      }

      /** P2 — a known contrast reaction is not a gate a technologist clears. */
      if (parsed.radiologistId === undefined || parsed.reason === undefined || parsed.reason.trim() === "") {
        throw new RadiologyError(
          "gate_open",
          `this patient has a recorded contrast allergy (${hits.map((h) => h.substance).join(", ")}) — `
          + "only a named radiologist's reason clears this gate (P2)",
          { substances: hits.map((h) => h.substance), severities: hits.map((h) => h.severity) },
        );
      }
      if (!(await actorHoldsAnyRole(tx, parsed.radiologistId, ["radiologist"]))) {
        throw new RadiologyError(
          "evidence_invalid",
          `${parsed.radiologistId} does not hold the radiologist role, so this is not a radiologist's decision (P2)`,
          { radiologistId: parsed.radiologistId },
        );
      }
      return {
        kind: "prior_contrast_reaction", contrastAllergyFound: true,
        substances: hits.map((h) => h.substance), allergiesChecked: active.length,
        radiologistId: parsed.radiologistId, reason: parsed.reason.trim(),
      };
    }

    /**
     * The four that stop a scanner. A pacemaker, an aneurysm clip, a cochlear implant and an ocular
     * metallic foreign body are not questions the console answers — they are the radiologist's, and
     * MR-CONDITIONAL devices exist, which is exactly why the lane is an override with a reason
     * rather than a satisfied gate. `claustrophobia` and `implants` are recorded and block nothing.
     */
    case "mri_safety": {
      const parsed = parseEvidence(mriSafetySchema, raw, "mri_safety");
      const blocking = (["pacemaker", "clips", "cochlear", "metalFb"] as const)
        .filter((k) => parsed[k]);
      if (blocking.length > 0) {
        throw new RadiologyError(
          "gate_open",
          `the MRI safety questionnaire is positive for ${blocking.join(", ")} — an MR-conditional `
          + "device is the radiologist's override with a reason, never a satisfied screen",
          { positive: blocking },
        );
      }
      return { kind: "mri_safety", ...parsed };
    }

    /**
     * ═══ THE REGISTER IS THE EVIDENCE, AND THE CALLER OFFERS NOTHING ═══
     *
     * `pcpndt_form_f_study_ux` makes one form per study a database fact, so the gate can simply ask
     * whether one exists. There is nothing for a caller to type and therefore nothing to type
     * wrongly. **This gate is NOT the statutory control** — that is T6's `assertFormFRecorded`, on
     * T7's acquisition path, which demands a RECORDED form and not merely an open one. Two controls
     * at two strengths: this one keeps the study out of `ready` until the form is started, and the
     * register refuses the exposure without a completed one.
     */
    case "form_f": {
      const form = (await (tx as unknown as Db)
        .select({ id: pcpndtFormF.id, serialNo: pcpndtFormF.serialNo, status: pcpndtFormF.status })
        .from(pcpndtFormF).where(eq(pcpndtFormF.studyId, study.id)))[0];
      if (!form) {
        throw new RadiologyError(
          "form_f_missing",
          "no Form F has been opened for this study — the PCPNDT register is the only way past this "
          + "gate, and there is no waiver and no override (N2)",
          { studyId: study.id },
        );
      }
      return { kind: "form_f", formFId: form.id, serialNo: form.serialNo, formStatus: form.status };
    }

    /**
     * A chaperone who is the person performing the scan is not a chaperone; that is one person in
     * the room with a second name written down. The patient cannot chaperone herself either.
     */
    case "chaperone_present": {
      const parsed = parseEvidence(chaperoneSchema, raw, "chaperone_present");
      if (parsed.chaperoneUserId === actor.id) {
        throw new RadiologyError(
          "evidence_invalid",
          "the person performing the scan cannot also be the chaperone",
        );
      }
      if (parsed.chaperoneUserId === study.patientId) {
        throw new RadiologyError("evidence_invalid", "a patient cannot chaperone herself");
      }
      /**
       * ═══ F64 (CLOSE REVIEW) — THE CHAPERONE HAS TO BE SOMEBODY ═══
       *
       * The only two comparisons were "not the actor" and "not the patient", so any string that was
       * neither satisfied the gate — a chaperone gate cleared by typing `x`. E20's 16-year-old
       * pelvic USG is what this gate is for, and a named person who does not exist is not a
       * chaperone; it is a field that was filled in.
       *
       * The check is EXISTENCE and STAFF, not a role list: a chaperone may be a nurse, an
       * attendant, a technologist or the receptionist, and enumerating which roles may stand in a
       * room is the kind of list that goes stale and then gets worked around. What cannot be true is
       * that nobody was there.
       */
      const chaperone = await (tx as unknown as Db).select({ id: users.id, active: users.active })
        .from(users).where(eq(users.id, parsed.chaperoneUserId));
      if (!chaperone[0]) {
        throw new RadiologyError(
          "evidence_invalid",
          `${parsed.chaperoneUserId} is not a user of this hospital — a chaperone is a named person `
          + "who was in the room, not a note",
          { chaperoneUserId: parsed.chaperoneUserId },
        );
      }
      if (chaperone[0].active === false) {
        throw new RadiologyError(
          "evidence_invalid",
          `${parsed.chaperoneUserId} is not an active member of staff`,
          { chaperoneUserId: parsed.chaperoneUserId },
        );
      }
      return { kind: "chaperone_present", ...parsed, recordedBy: actor.id };
    }

    /**
     * The study's side is the ORDER's, frozen on the row; the patient's is asked at the machine.
     * A disagreement leaves the gate OPEN — it is not the technologist's to resolve by choosing one.
     */
    case "laterality_confirm": {
      const parsed = parseEvidence(lateralitySchema, raw, "laterality_confirm");
      /**
       * ═══ F59 (CLOSE REVIEW) — THIS GATE NOW RECORDS THE SIDE. IT USED TO COMPARE AGAINST `'na'` ═══
       *
       * `imaging_studies.laterality` had NO WRITER anywhere in the tree: there is no order field, no
       * route parameter and no update, so every study sat at the column default `'na'` for ever.
       * This gate compared the patient's statement against that default — so **the only evidence
       * that could clear it was `patientStated: 'na'`**, i.e. the console had to record that a knee
       * X-ray has no side. `assertSignable` then refused any report that named one, and two of the
       * twenty seeded study types became permanently unreportable. E3's wrong-site control did not
       * merely fail to fire: it forced the record to be wrong in exactly the way E3 exists to
       * prevent.
       *
       * **What this fix is, and what it is honestly NOT.** The side is now taken from the patient
       * at check-in, in front of the patient, and written to the study; sign compares the report
       * against it, so *"the report names a different side from the one confirmed at the console"*
       * is caught. What is still missing is the ORDER's own side — E3's *"left knee ordered, right
       * imaged"* needs `order_items.laterality`, which is a KERNEL column this phase may not add
       * (§8's freeze). **That is reported as a plan defect for the kernel, not taken here**, and
       * until it exists a mis-ordered side is caught by the patient at the console rather than by
       * the system at placement.
       *
       * A study whose side is already recorded may not be silently re-sided: a second statement
       * that disagrees is a refusal, because that is a person changing their mind about which knee
       * and it belongs to the referrer.
       */
      if (study.laterality !== "na" && parsed.patientStated !== study.laterality) {
        throw new RadiologyError(
          "gate_open",
          `the patient says ${parsed.patientStated} and this study is already recorded as `
          + `${study.laterality} — the referrer resolves a change of side, not the console`,
          { patientStated: parsed.patientStated, recorded: study.laterality },
        );
      }
      await tx.update(imagingStudies)
        .set({ laterality: parsed.patientStated })
        .where(eq(imagingStudies.id, study.id));
      return { kind: "laterality_confirm", ...parsed };
    }

    /** E5's shape, one department over: "ruled out" is a decision and a registered MLC has a number. */
    case "mlc_check": {
      const parsed = parseEvidence(mlcSchema, raw, "mlc_check");
      if (parsed.status === "registered" && parsed.mlcNo === undefined) {
        throw new RadiologyError("evidence_invalid", "a registered MLC must carry its police reference (E5)");
      }
      return { kind: "mlc_check", ...parsed, decidedBy: actor.id };
    }

    default:
      throw new RadiologyError("evidence_invalid", `no satisfaction rule for gate kind "${gate.kind}"`);
  }
}

// ═══════════════════════════ the three terminal acts ═══════════════════════════

/**
 * ═══ A7 — THE RACE IS LOST AT THE ENGINE'S CAS, NOT AT A READ ═══
 *
 * The pre-read below answers the SEQUENTIAL case kindly (`gate_already_terminal`, a 409 that names
 * the state). It is not the control. Two concurrent callers both read `open`, both compute, and
 * `transition`'s conditional UPDATE — `where current_state = <what we validated against>` — lets
 * exactly one through; the loser's zero-row update raises `stale_transition`, which this maps to
 * `stale_state`. A read-then-write would let both write, and A7 exists to pin that it does not.
 *
 * The evidence UPDATE is deliberately AFTER the transition, so the loser writes nothing at all.
 */
export async function satisfyGate(
  tx: Tx, actor: Actor, gateId: string, evidence: unknown, now: Date = new Date(),
): Promise<{ state: string; kind: string }> {
  const { gate, study } = await loadGate(tx, gateId);
  const before = await gateState(tx, gateId);
  if (before !== "open") {
    throw new RadiologyError(
      "gate_already_terminal", `the ${gate.kind} gate is already ${before}`, { gateId, state: before },
    );
  }
  const stored = await computeSatisfaction(tx, actor, gate, study, evidence, now);
  const { state } = await movedOrStale(tx, gate, "satisfied", actor);
  await tx.update(imagingSafetyScreenings)
    .set({ evidence: stored, satisfiedBy: actor.id, satisfiedAt: now })
    .where(eq(imagingSafetyScreenings.id, gateId));
  await emitGateEvaluated(tx, actor, study, gate.kind, "satisfied");
  return { state, kind: gate.kind };
}

/**
 * ═══ A2/A6 — THE KIND DECIDES WHETHER THERE IS A LANE, BEFORE ANYTHING IS READ ═══
 *
 * `form_f` and `identity_two_factor` are refused HERE — before the gate's own `waivable` column,
 * before the study type, before any definition, before any role. That ordering is the assertion:
 * A2 demands the refusal happen with an empty definition table, and A6 demands that a waived
 * identity gate can never make a study ready.
 */
export async function waiveGate(
  tx: Tx, actor: Actor, gateId: string, reason: string,
): Promise<{ state: string; kind: string }> {
  const { gate, study } = await loadGate(tx, gateId);

  if (NEVER_WAIVABLE_KINDS.includes(gate.kind as ImagingGateKind)) {
    throw new RadiologyError(
      "gate_not_overridable",
      gate.kind === "form_f"
        ? "the Form F gate has no waiver and no override: the PCPNDT Act contains no clause for a "
          + "busy evening, and a bypass a row could switch on is not a control (N2)"
        : "identity is never waived — an unidentified patient is an OVERRIDE with a reason, which "
          + "is a different act and leaves a different record",
      { kind: gate.kind },
    );
  }
  if (!gate.waivable) {
    throw new RadiologyError(
      "gate_not_overridable",
      `the ${gate.kind} gate is not waivable — the lane for "established, and we are proceeding `
      + `anyway" is the radiologist's override, which is evented`,
      { kind: gate.kind },
    );
  }
  if (reason.trim() === "") {
    throw new RadiologyError("reason_required", "a waiver must carry a reason", { kind: gate.kind });
  }

  const before = await gateState(tx, gateId);
  if (before !== "open") {
    throw new RadiologyError(
      "gate_already_terminal", `the ${gate.kind} gate is already ${before}`, { gateId, state: before },
    );
  }
  const { state } = await movedOrStale(tx, gate, "waived", actor, reason);
  await tx.update(imagingSafetyScreenings)
    .set({ evidence: { kind: "waiver", reason: reason.trim(), waivedBy: actor.id, waivedAt: new Date().toISOString() } })
    .where(eq(imagingSafetyScreenings.id, gateId));
  await emitGateEvaluated(tx, actor, study, gate.kind, "waived");
  return { state, kind: gate.kind };
}

/**
 * ═══ A3 — THE RADIOLOGIST'S OVERRIDE: A REASON, A RECORD AND AN EVENT ═══
 *
 * A3's mutant drops the reason, and what it costs is the whole control: *"benefit outweighs risk"*
 * becomes a click. The reason is checked BEFORE the transition so a blank one never reaches the
 * engine, and it rides both the `override` jsonb and the transition's own note.
 *
 * **The ROLE is enforced by `transition`, which is the plane the engine reads.** `open →
 * overridden` names `radiologist` alone, and `radiology.gates.override` is granted to `radiologist`
 * alone — the two planes are asserted to COINCIDE in `gates.test.ts`, which is finding F9's lesson
 * applied forward rather than a second check written here.
 */
export async function overrideGate(
  tx: Tx, actor: Actor, gateId: string, reason: string,
): Promise<{ state: string; kind: string }> {
  const { gate, study } = await loadGate(tx, gateId);

  if (NEVER_OVERRIDABLE_KINDS.includes(gate.kind as ImagingGateKind)) {
    throw new RadiologyError(
      "gate_not_overridable",
      "the Form F gate has no override lane at all: no emergency bypass exists under the PCPNDT "
      + "Act, and expressing that as an absent transition would not be enough — a definition is "
      + "DATA (N2)",
      { kind: gate.kind },
    );
  }
  if (reason.trim() === "") {
    throw new RadiologyError(
      "reason_required",
      "an override must carry a reason — \"benefit outweighs risk\" is a judgement somebody has to "
      + "be willing to write down (P1)",
      { kind: gate.kind },
    );
  }

  const before = await gateState(tx, gateId);
  if (before !== "open") {
    throw new RadiologyError(
      "gate_already_terminal", `the ${gate.kind} gate is already ${before}`, { gateId, state: before },
    );
  }
  const { state } = await movedOrStale(tx, gate, "overridden", actor, reason);
  await tx.update(imagingSafetyScreenings)
    .set({ override: { actorId: actor.id, reason: reason.trim() } })
    .where(eq(imagingSafetyScreenings.id, gateId));
  await emitGateEvaluated(tx, actor, study, gate.kind, "overridden");
  return { state, kind: gate.kind };
}

/** A7 — the engine's CAS is the single-winner control; its refusal is this module's `stale_state`. */
async function movedOrStale(
  tx: Tx, gate: GateRow, to: string, actor: Actor, note?: string,
): Promise<{ state: string }> {
  try {
    return await transition(tx, gate.workflowInstanceId, to, actor, note === undefined ? {} : { note });
  } catch (e) {
    if (e instanceof WorkflowError && e.code === "stale_transition") {
      throw new RadiologyError(
        "stale_state",
        `the ${gate.kind} gate was moved by somebody else while this was being recorded`,
        { gateId: gate.id, kind: gate.kind },
      );
    }
    throw e;
  }
}

/**
 * DD7 — every gate outcome is evented, including the ones nobody wants to look at. `evidenceRef` is
 * NULL rather than the evidence: a pregnancy declaration and a creatinine are clinical facts that
 * must not ride an event bus (`events.ts`'s own rule).
 */
async function emitGateEvaluated(
  tx: Tx, actor: Actor, study: StudyRow, kind: string,
  outcome: "satisfied" | "waived" | "overridden",
): Promise<void> {
  await appendEvent(tx, imagingGateEvaluated.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: { studyId: study.id, kind, outcome, evidenceRef: null, actorId: actor.id },
  }));
}

// ═══════════════════════════ readiness ═══════════════════════════

/**
 * ═══ A6 — `checked_in → ready` WHEN EVERY OPENED GATE IS TERMINAL, AND NOT ONE GATE SOONER ═══
 *
 * *"Terminal and not open"* is the whole predicate, and it is stated positively against
 * `IMAGING_TERMINAL_GATE_STATES` rather than as `!== 'open'`: the two are the same today and stop
 * being the same the moment a `deferred` or `expired` state is added to the gate machine, at which
 * point the negated form silently calls a deferred gate done.
 *
 * A6's mutant counts `satisfied` only, and its harm is not pedantry in either direction — an
 * OVERRIDDEN renal gate would keep a study un-ready for ever, so the floor would learn to satisfy
 * gates it should be overriding, which is the record P1 exists to create being destroyed by a
 * counting bug.
 *
 * IDEMPOTENT: a study already past `checked_in` is LEFT ALONE rather than refused, because the
 * caller is a console that does not know which gate was the last one.
 */
export async function evaluateReadiness(
  tx: Tx, studyId: string,
): Promise<{ state: string; open: string[] }> {
  const state = await studyState(tx, studyId);
  const gates = await studyGates(tx, studyId);
  const open = gates
    .filter((g) => !(IMAGING_TERMINAL_GATE_STATES as readonly string[]).includes(g.state))
    .map((g) => g.kind);
  if (state !== "checked_in" || open.length > 0) return { state, open };

  const study = (await (tx as unknown as Db).select({ instanceId: imagingStudies.workflowInstanceId })
    .from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0]!;
  const moved = await transition(tx, study.instanceId, "ready", { type: "system", id: "radiology.readiness" });
  await tx.update(imagingStudies).set({ status: "ready" }).where(eq(imagingStudies.id, studyId));
  return { state: moved.state, open: [] };
}

/**
 * The console's read: every gate with its state, plus whether the study is ready and what is
 * holding it. A GET must not transition, so this NEVER calls `evaluateReadiness` — it reports.
 *
 * ═══ F48 (CLOSE REVIEW) — IT TAKES AN ACTOR, AND IT LOGS ═══
 *
 * The first version took no actor and wrote no `phi_access_log` row, while `read.ts`'s three reads
 * logged every disclosure. **The gate list IS a disclosure**: `open: ["form_f", "pregnancy_screen"]`
 * says this patient is female, of an age the Act covers, and having a scan it covers. DD11 declared
 * the imaging surfaces PHI precisely so *"what did they actually see"* is answerable, and a read
 * that answers for one named study and leaves no row is the hole in that answer.
 *
 * It is logged under `imaging.study` — the same surface `studyView` uses — because it is a read of
 * one study, and inventing a fourth surface name for the same disclosure would make the log harder
 * to query rather than more precise.
 */
export async function readiness(
  exec: Db | Tx, actor: Actor, studyId: string,
): Promise<{ state: string; ready: boolean; gates: StudyGate[]; open: string[] }> {
  const state = await studyState(exec, studyId);
  const gates = await studyGates(exec, studyId);
  const owner = (await (exec as Db).select({
    patientId: imagingStudies.patientId, encounterNo: imagingStudies.encounterNo,
    accessionNo: imagingStudies.accessionNo,
  }).from(imagingStudies).where(eq(imagingStudies.id, studyId)))[0];
  if (owner) {
    await recordPhiAccess(exec as Db, {
      actor, patientId: owner.patientId, surface: "imaging.study",
      encounterId: owner.encounterNo, reason: `gate readiness for ${owner.accessionNo}`,
    });
  }
  const open = gates
    .filter((g) => !(IMAGING_TERMINAL_GATE_STATES as readonly string[]).includes(g.state))
    .map((g) => g.kind);
  /**
   * `ready` is the STUDY's state and not `open.length === 0`: a `scheduled` study has no gates at
   * all, so an emptiness test would report it ready before anybody had looked at the patient.
   */
  return { state, ready: state === "ready", gates, open };
}
