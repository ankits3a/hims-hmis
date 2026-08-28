import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { otCaseGates, otCases } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { transition } from "../../kernel/workflow/instances";
import { actorHoldsAnyRole } from "../../kernel/workflow/roles";
import { activeDefinition, criteriaFor } from "./definitions";
import { grantedShortfallPaise, heldPaise, requiredDeposit } from "./deposit";
import { consentEvidence, validateConsent } from "./consents";
import { OtError } from "./errors";
import { gateOverridden } from "./events";
import { caseState } from "./booking";
import type { CriteriaEntry } from "./definitions";
import type { PayerClass } from "./deposit";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 15 T4 / DD5 — **THE GATES: nine kinds, computed rather than typed, and one override lane.**
 *
 * ═══ WHAT MAKES A GATE A GATE ═══
 *
 * Every kind below is COMPUTED from evidence, never satisfied by a caller asserting it is satisfied.
 * That distinction is the whole phase: `npo: { satisfied: true }` is a checkbox, and a checkbox on a
 * pre-operative gate is a checkbox somebody ticks at 08:55 for a 09:00 list. What this module
 * accepts is the FACTS — two typed intake times, a marking's side, a hold ledger — and it does the
 * arithmetic itself.
 *
 * ═══ THE OVERRIDE LANE IS NOT UNIFORM, AND THAT IS DD5's RULING (A9) ═══
 *
 *   · **Clinical kinds** — `anaesthesia_review`, `npo`, `site_marking`, `mlc`, the two consents —
 *     may be overridden by TWO DISTINCT actors, one holding `surgeon` and one `anaesthetist`. N4's
 *     case: a 72-year-old ASA III the surgeon still wants as day-care.
 *   · **`escort` is NEVER overridable.** E-4 of §11.16-A: a day-care patient discharges to an adult,
 *     structurally. There is no clinical judgement that makes it safe to send a post-anaesthesia
 *     patient home alone, so there is no lane — not for two consultants, not for the MS.
 *   · **`deposit` is overridable ONLY through a granted `ot_deposit_exception`** (N12). The money
 *     rule is the owner's, and a clinical override of a money gate would put the two consultants
 *     under pressure they should not be under.
 *
 * A uniform override lane is the mutant, and it is the shape almost every implementation takes:
 * one `overrideGate` that checks two roles and two ids and applies to whatever it is handed.
 */

// ═══════════════════════════════ evidence schemas, per kind ═══════════════════════════════

const anaesthesiaReviewSchema = z.object({
  asaGrade: z.number().int().min(1).max(5),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().min(1),
  /** DD5 — valid N days; 30 for ASA I–II. Typed by the reviewer, checked against the list date. */
  validDays: z.number().int().positive().default(30),
});

const siteMarkingSchema = z.object({
  laterality: z.enum(["left", "right", "bilateral"]),
  markedBy: z.string().min(1),
  markedAt: z.string().min(1),
});

/**
 * A10 — TWO typed times, never one, and never a boolean. Solids and clear fluids have DIFFERENT
 * fasting rules (6 h and 2 h), so a single "last intake" field cannot express the commonest real
 * answer: tea at 07:30 and dinner at 22:00, for a 09:00 list, which is FINE.
 *
 * `plannedStart` is typed here rather than read from a column, and that is a disclosed deviation
 * (finding T4-a): the plan says NPO is *"computed against the planned start"*, and this phase has no
 * planned-start column — `ot_cases` carries `list_date` and `seq`, because theatre-time bands are
 * 15d's. So the coordinator who is looking at the list types the time the case is going, it is
 * stored on the gate's evidence, and the computation is auditable afterwards. A derived start from
 * `seq` would be scheduling this phase deliberately does not have.
 */
const npoSchema = z.object({
  plannedStart: z.string().min(1),
  lastSolidsAt: z.string().min(1),
  lastClearFluidsAt: z.string().min(1),
  attestedBy: z.string().min(1),
});

const escortSchema = z.object({
  name: z.string().min(1),
  relation: z.string().min(1),
  phone: z.string().min(1),
  idType: z.string().min(1),
  idLast4: z.string().min(1),
  ageYears: z.number().int().min(0),
  escortPatientId: z.string().min(1).optional(),
  notifyOk: z.boolean().default(false),
});

const mlcSchema = z.object({
  status: z.enum(["registered", "ruled_out"]),
  reference: z.string().min(1).optional(),
  decidedBy: z.string().min(1),
});

const depositSchema = z.object({
  /** N12 — the ONLY path to a satisfied gate below `required`. */
  exceptionApprovalId: z.string().min(1).optional(),
  implantEstimatePaise: z.number().int().min(0).default(0),
  sanctionedPaise: z.number().int().min(0).optional(),
  creditAvailablePaise: z.number().int().min(0).optional(),
  entitlementPaise: z.number().int().min(0).optional(),
});

/** NPO thresholds — one constant, one owner (16a DD5). Not configurable in this phase on purpose:
 *  6 h for solids and 2 h for clear fluids is the ASA fasting guideline every Indian OT runs. */
export const NPO_SOLIDS_HOURS = 6;
export const NPO_CLEAR_FLUIDS_HOURS = 2;
export const ADULT_AGE_YEARS = 18;

export type GateRow = typeof otCaseGates.$inferSelect;

async function loadGate(tx: Tx, gateId: string): Promise<{ gate: GateRow; kase: typeof otCases.$inferSelect; entry: CriteriaEntry }> {
  const gateRows = await tx.select().from(otCaseGates).where(eq(otCaseGates.id, gateId));
  const gate = gateRows[0];
  if (!gate) throw new OtError("unknown_case", `unknown gate ${gateId}`);
  const caseRows = await tx.select().from(otCases).where(eq(otCases.id, gate.caseId));
  const kase = caseRows[0]!;
  const criteria = await activeDefinition(tx, "criteria");
  const entry = criteriaFor(criteria, kase.procedureClass);
  if (!entry) {
    throw new OtError("criteria_refused", `"${kase.procedureClass}" is no longer in the ACTIVE whitelist`);
  }
  return { gate, kase, entry };
}

/** The gate's state, from its pinned instance — never mirrored on the row (DD4). */
export async function gateState(exec: Db | Tx, gateId: string): Promise<string> {
  const rows = (await exec.execute(sql`
    select w.current_state as "state" from ot_case_gates g
      join workflow_instances w on w.id = g.workflow_instance_id
     where g.id = ${gateId}
  `)).rows as { state: string }[];
  const found = rows[0];
  if (!found) throw new OtError("unknown_case", `unknown gate ${gateId}`);
  return found.state;
}

/** Every gate of a case, with its state. The read `evaluateReadiness` and the cockpit both use. */
export async function caseGates(
  exec: Db | Tx, caseId: string,
): Promise<{ id: string; kind: string; state: string; waivable: boolean }[]> {
  return (await exec.execute(sql`
    select g.id as "id", g.kind as "kind", w.current_state as "state", g.waivable as "waivable"
      from ot_case_gates g
      join workflow_instances w on w.id = g.workflow_instance_id
     where g.case_id = ${caseId}
     order by g.kind
  `)).rows as { id: string; kind: string; state: string; waivable: boolean }[];
}

function hoursBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 3_600_000;
}

/**
 * The per-kind computation. Returns the evidence blob to store, or throws.
 *
 * Every branch here is the answer to "what would make this gate a lie?", and the answers are not
 * symmetrical — which is why this is a switch and not a table of validators.
 */
async function computeSatisfaction(
  tx: Tx, actor: Actor, gate: GateRow, kase: typeof otCases.$inferSelect, entry: CriteriaEntry, raw: unknown,
): Promise<Record<string, unknown>> {
  switch (gate.kind) {
    case "anaesthesia_review": {
      const parsed = anaesthesiaReviewSchema.parse(raw);
      if (parsed.asaGrade > entry.asaMax) {
        throw new OtError(
          "gate_open",
          `ASA ${String(parsed.asaGrade)} exceeds the class maximum of ${String(entry.asaMax)} — a two-actor clinical override is the only way past this (N4)`,
          { asaGrade: parsed.asaGrade, asaMax: entry.asaMax },
        );
      }
      // DD5 — valid N days. The list date, not `now`: a review that expires the morning of surgery
      // must fail on the list date rather than on the day somebody happens to look at the gate.
      const reviewed = new Date(parsed.reviewedAt);
      const listDay = new Date(`${kase.listDate}T00:00:00+05:30`);
      const ageDays = (listDay.getTime() - reviewed.getTime()) / 86_400_000;
      if (ageDays > parsed.validDays) {
        throw new OtError(
          "gate_open",
          `the anaesthesia review is ${String(Math.floor(ageDays))} days old on the list date and is valid for ${String(parsed.validDays)}`,
        );
      }
      return { kind: "anaesthesia_review", ...parsed };
    }

    case "consent_procedure":
    case "consent_anaesthesia": {
      const consent = await validateConsent(tx, kase.id, raw);
      return consentEvidence(consent, actor);
    }

    /**
     * ═══ A7 — THE TRIPLE EQUALITY, COMPUTED HERE AND NOT TRUSTED ═══
     *
     * booking = consent = marking. All three, and the mutant compares the marking to the CASE only —
     * which passes the obvious fixture (case L, marking R) and lets through the one that matters:
     * **case L, consent R, marking L**, where the surgeon marked the side the booking says and the
     * patient consented to the other one. That is a wrong-side operation with a correct marking, and
     * it is exactly the sequence a two-way check cannot see.
     */
    case "site_marking": {
      const parsed = siteMarkingSchema.parse(raw);
      const consentGate = (await tx.select().from(otCaseGates)
        .where(and(eq(otCaseGates.caseId, kase.id), eq(otCaseGates.kind, "consent_procedure"))))[0];
      const consentLaterality = ((consentGate?.evidence as { consent?: { laterality?: string | null } } | null)
        ?.consent?.laterality) ?? null;
      const three = { case: kase.laterality, consent: consentLaterality, marking: parsed.laterality };
      if (three.case !== three.marking || three.case !== three.consent) {
        throw new OtError(
          "gate_open",
          `laterality disagrees — booking ${String(three.case)}, consent ${String(three.consent)}, marking ${three.marking} (A3/A7)`,
          three,
        );
      }
      return { kind: "site_marking", ...parsed };
    }

    /**
     * A10 — computed from TWO typed times against the planned start. `>=` on both, because a patient
     * fasted exactly six hours is fasted: the guideline is a minimum, and refusing the boundary
     * would cancel a correctly-prepared list.
     */
    case "npo": {
      const parsed = npoSchema.parse(raw);
      const start = new Date(parsed.plannedStart);
      const solidsHours = hoursBetween(start, new Date(parsed.lastSolidsAt));
      const fluidsHours = hoursBetween(start, new Date(parsed.lastClearFluidsAt));
      const failures: string[] = [];
      if (solidsHours < NPO_SOLIDS_HOURS) {
        failures.push(`solids ${solidsHours.toFixed(1)} h before the slot (needs ${String(NPO_SOLIDS_HOURS)} h)`);
      }
      if (fluidsHours < NPO_CLEAR_FLUIDS_HOURS) {
        failures.push(`clear fluids ${fluidsHours.toFixed(1)} h before the slot (needs ${String(NPO_CLEAR_FLUIDS_HOURS)} h)`);
      }
      if (failures.length > 0) {
        throw new OtError("gate_open", `NPO not met: ${failures.join("; ")} (N1)`, {
          solidsHours, fluidsHours, solidsRequired: NPO_SOLIDS_HOURS, fluidsRequired: NPO_CLEAR_FLUIDS_HOURS,
        });
      }
      return { kind: "npo", ...parsed, solidsHours, fluidsHours };
    }

    /**
     * DD12 — Σ open holds on THE ENCOUNTER against `required`, or a granted exception covering the
     * shortfall. Never `advanceOf`: F3's whole point is that a patient-level advance is not this
     * encounter's deposit.
     */
    case "deposit": {
      const parsed = depositSchema.parse(raw);
      const policy = await activeDefinition(tx, "deposit_policy");
      const cases = await tx.select().from(otCases).where(eq(otCases.encounterId, kase.encounterId));
      const quotePaise = cases.reduce((sum, c) => sum + c.quotePaise, 0);
      const required = requiredDeposit(policy, {
        payerClass: kase.payerClass as PayerClass,
        quotePaise,
        implantEstimatePaise: parsed.implantEstimatePaise,
        sanctionedPaise: parsed.sanctionedPaise,
        creditAvailablePaise: parsed.creditAvailablePaise,
        entitlementPaise: parsed.entitlementPaise,
      });
      const held = await heldPaise(tx, kase.encounterId);
      const allowedShortfall = await grantedShortfallPaise(tx, kase.encounterId, parsed.exceptionApprovalId ?? null);
      if (held + allowedShortfall < required) {
        throw new OtError(
          "deposit_shortfall",
          `deposit ${String(held)}p against a required ${String(required)}p; a granted ot_deposit_exception is the only way past this (N12)`,
          { requiredPaise: required, heldPaise: held, allowedShortfallPaise: allowedShortfall },
        );
      }
      return { kind: "deposit", requiredPaise: required, heldPaise: held, allowedShortfallPaise: allowedShortfall, ...parsed };
    }

    /** R-3.24 / N2 — an ADULT with a phone. A minor escort is refused; so is the patient herself. */
    case "escort": {
      const parsed = escortSchema.parse(raw);
      if (parsed.ageYears < ADULT_AGE_YEARS) {
        throw new OtError("escort_required", `the escort is ${String(parsed.ageYears)} and must be an adult (N2)`);
      }
      if (parsed.escortPatientId !== undefined && parsed.escortPatientId === kase.patientId) {
        throw new OtError("escort_required", "a patient cannot escort themselves (A7/N14)");
      }
      return { kind: "escort", ...parsed };
    }

    /** R-3.15 — RE-EVALUATED here, so a privilege revoked after booking bites before the knife. */
    case "privilege": {
      const privileges = await activeDefinition(tx, "privileges");
      const surgeon = privileges.surgeons.find((s) => s.surgeonId === kase.surgeonId);
      if (!surgeon || !surgeon.procedureClasses.includes(kase.procedureClass as CriteriaEntry["procedureClass"])) {
        throw new OtError(
          "privilege_refused",
          `surgeon ${kase.surgeonId} is no longer privileged for "${kase.procedureClass}" — the booking passed and the ACTIVE list has since changed`,
        );
      }
      return { kind: "privilege", surgeonId: kase.surgeonId, procedureClass: kase.procedureClass, reEvaluatedAt: new Date().toISOString() };
    }

    /** E5 — the MLC decision is RECORDED before wheel-in, either way. "Ruled out" is a decision. */
    case "mlc": {
      const parsed = mlcSchema.parse(raw);
      if (parsed.status === "registered" && parsed.reference === undefined) {
        throw new OtError("gate_open", "a registered MLC must carry its police reference (E5)");
      }
      return { kind: "mlc", ...parsed };
    }

    default:
      throw new OtError("gate_open", `no satisfaction rule for gate kind "${gate.kind}"`);
  }
}

export async function satisfyGate(
  tx: Tx, actor: Actor, gateId: string, evidence: unknown,
): Promise<{ state: string }> {
  const { gate, kase, entry } = await loadGate(tx, gateId);
  const before = await gateState(tx, gateId);
  if (before !== "open") {
    throw new OtError("gate_already_terminal", `gate ${gate.kind} is already ${before}`);
  }
  const stored = await computeSatisfaction(tx, actor, gate, kase, entry, evidence);
  const { state } = await transition(tx, gate.workflowInstanceId, "satisfied", actor);
  await tx.update(otCaseGates)
    .set({ evidence: stored, satisfiedBy: actor.id, satisfiedAt: new Date() })
    .where(eq(otCaseGates.id, gateId));
  return { state };
}

/** DD5 — only the kinds THIS CLASS's criteria mark waivable. `waivable` is snapshotted at booking. */
export async function waiveGate(
  tx: Tx, actor: Actor, gateId: string, reason: string,
): Promise<{ state: string }> {
  const { gate } = await loadGate(tx, gateId);
  if (!gate.waivable) {
    throw new OtError(
      "gate_not_overridable",
      `the ${gate.kind} gate is not waivable for this procedure class — the criteria decide, per class (DD5)`,
    );
  }
  if (reason.trim() === "") throw new OtError("gate_not_overridable", "a waiver must carry a reason");
  const before = await gateState(tx, gateId);
  if (before !== "open") throw new OtError("gate_already_terminal", `gate ${gate.kind} is already ${before}`);
  const { state } = await transition(tx, gate.workflowInstanceId, "waived", actor, { note: reason });
  await tx.update(otCaseGates)
    .set({ evidence: { kind: "waiver", reason, waivedBy: actor.id, waivedAt: new Date().toISOString() } })
    .where(eq(otCaseGates.id, gateId));
  return { state };
}

/** DD5 — the kinds a two-actor clinical override may reach. `escort` and `deposit` are NOT here. */
export const CLINICALLY_OVERRIDABLE_KINDS = [
  "anaesthesia_review", "consent_procedure", "consent_anaesthesia", "site_marking", "npo", "mlc",
] as const;

/**
 * A8/A9 — the two-actor clinical override.
 *
 * TWO DISTINCT actor ids, one holding `surgeon` and one holding `anaesthetist`, a reason, and an
 * incident-class event. The distinct-id check is what the mutant drops, and dropping it makes the
 * two-key rule satisfiable by one consultant entering their own id twice — which is not an override,
 * it is a single doctor deciding alone with a form that says two.
 */
export async function overrideGate(
  tx: Tx, actor: Actor, gateId: string,
  input: { surgeonId: string; anaesthetistId: string; reason: string },
): Promise<{ state: string }> {
  const { gate, kase } = await loadGate(tx, gateId);

  // The KIND decides whether there is a lane at all, before anybody's roles are read.
  if (gate.kind === "escort") {
    throw new OtError(
      "gate_not_overridable",
      "the escort gate has no override lane at all: a day-care patient discharges to an adult, structurally (E-4 of §11.16-A)",
    );
  }
  if (gate.kind === "deposit") {
    throw new OtError(
      "gate_not_overridable",
      "the deposit gate is not clinically overridable — a granted ot_deposit_exception is the only path (DD12/N12)",
    );
  }
  if (gate.kind === "privilege") {
    throw new OtError(
      "gate_not_overridable",
      "privileging is not overridable: an unprivileged surgeon is a credentialing decision, not a clinical one (R-3.15)",
    );
  }
  if (!(CLINICALLY_OVERRIDABLE_KINDS as readonly string[]).includes(gate.kind)) {
    throw new OtError("gate_not_overridable", `the ${gate.kind} gate has no override lane`);
  }

  if (input.surgeonId === input.anaesthetistId) {
    throw new OtError(
      "same_actor",
      "an override needs TWO people: the surgeon and the anaesthetist must be different actors (DD5)",
      { surgeonId: input.surgeonId },
    );
  }
  if (input.reason.trim() === "") throw new OtError("gate_not_overridable", "an override must carry a reason");

  if (!(await actorHoldsAnyRole(tx, input.surgeonId, ["surgeon"]))) {
    throw new OtError("same_actor", `${input.surgeonId} does not hold the surgeon role`);
  }
  if (!(await actorHoldsAnyRole(tx, input.anaesthetistId, ["anaesthetist"]))) {
    throw new OtError("same_actor", `${input.anaesthetistId} does not hold the anaesthetist role`);
  }

  const before = await gateState(tx, gateId);
  if (before !== "open") throw new OtError("gate_already_terminal", `gate ${gate.kind} is already ${before}`);

  const { state } = await transition(tx, gate.workflowInstanceId, "overridden", actor, { note: input.reason });
  await tx.update(otCaseGates)
    .set({ override: { surgeonId: input.surgeonId, anaesthetistId: input.anaesthetistId, reason: input.reason } })
    .where(eq(otCaseGates.id, gateId));
  await appendEvent(tx, gateOverridden.make({
    actor, patientId: kase.patientId, encounterId: kase.encounterId,
    payload: {
      caseId: kase.id, gateId, kind: gate.kind,
      surgeonId: input.surgeonId, anaesthetistId: input.anaesthetistId, reason: input.reason,
    },
  }));
  return { state };
}

/** The three TERMINAL gate states. A gate in any of them is done; `open` is not. */
export const TERMINAL_GATE_STATES = ["satisfied", "waived", "overridden"] as const;

/**
 * ═══ A6 — `listed → ready` WHEN EVERY GATE IS TERMINAL, AND NOT ONE GATE SOONER ═══
 *
 * The mutant counts `satisfied + open` as done, and its discriminating input is eight of nine gates
 * satisfied: the shipped code leaves the case `listed` and the mutant flips it to `ready`, which is
 * a case that can be wheeled in with an open consent.
 *
 * It is called after every `satisfyGate` and is IDEMPOTENT — a case already past `listed` is left
 * alone rather than refused, because the caller is a UI that does not know which gate was last.
 */
export async function evaluateReadiness(
  tx: Tx, caseId: string,
): Promise<{ state: string; open: string[] }> {
  const state = await caseState(tx, caseId);
  const gates = await caseGates(tx, caseId);
  const open = gates.filter((g) => !(TERMINAL_GATE_STATES as readonly string[]).includes(g.state)).map((g) => g.kind);
  if (state !== "listed" || open.length > 0) return { state, open };

  const rows = await tx.select().from(otCases).where(eq(otCases.id, caseId));
  const moved = await transition(tx, rows[0]!.workflowInstanceId, "ready", { type: "system", id: "ot.readiness" });
  return { state: moved.state, open: [] };
}
