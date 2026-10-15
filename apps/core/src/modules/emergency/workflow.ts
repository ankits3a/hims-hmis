import { ER_INTENTS } from "@hmis/contracts";
import { defineWorkflow } from "../../kernel/workflow/definition";
import type { ErActorKind, ErCatalogueIntent, ErEpisodeState } from "@hmis/contracts";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";

/**
 * ER lane 1 (#808) — THE ER EPISODE WORKFLOW (spec SPEC-emergency §1; spec v4.6 §10.2: one workflow instance per
 * episode, mirrored in `er_episodes.state`). Every edge names the spec §2 act that drives it, so the matrix and the
 * catalogue cannot drift. Lane 1 drives only the arrival edges; the later lanes contract the acts named on the rest.
 *
 * DECIDED (lane 1, standard Indian corporate-hospital practice; no owner ruling needed):
 * - An episode starts at `arrived`. The spec's `expected` is a pre-alert row (`er_pre_alerts`), not an episode state —
 *   one ambulance call may bring several patients, and a call that never arrives must not mint an ER number.
 * - `arrived → brought_dead` is terminal and separate (the body arrived; no treatment episode).
 * - A patient seen at once in resus skips formal triage: `arrived → in_treatment` (assign_er_doctor).
 * - Every way out ends in `departed` with an outcome on the row (discharged, admitted, referred out, LAMA, absconded,
 *   LWBS, died). LWBS can only happen before a doctor has seen the patient (arrived, triaged).
 * - Change class A (owner + medical superintendent approve; a third person activates), like the IPD admission.
 */
export const ER_EPISODE_WORKFLOW_DEF_KEY = "er_episode";

/**
 * Actor kinds → the hospital's role keys. `er_nurse` is the casualty nurse (seeded by lane 1). A device's act reaches
 * the engine as `system`; an agent never transitions — its proposal is confirmed by a person.
 */
export const ER_ACTOR_ROLE_KEYS: Record<ErActorKind, readonly string[]> = {
  desk: ["front_office", "front_office_supervisor"],
  er_nurse: ["er_nurse"],
  doctor: ["doctor"],
  supervisor: ["front_office_supervisor"],
  duty_manager: ["duty_manager"],
  device: ["system"],
  agent: [],
};

export type ErEpisodeTransition = { from: ErEpisodeState; to: ErEpisodeState; intent: ErCatalogueIntent };

export const ER_EPISODE_TRANSITIONS: readonly ErEpisodeTransition[] = [
  // ── arrival (lane 1) ──
  { from: "arrived", to: "brought_dead", intent: "record_brought_dead" },
  // ── triage and care (lanes 2, 3) ──
  { from: "arrived", to: "triaged", intent: "triage" },
  { from: "arrived", to: "in_treatment", intent: "assign_er_doctor" },
  { from: "triaged", to: "in_treatment", intent: "assign_er_doctor" },
  // ── disposition (lane 5) ──
  { from: "in_treatment", to: "disposition_decided", intent: "decide_disposition" },
  { from: "disposition_decided", to: "departed", intent: "discharge_from_er" },
  { from: "disposition_decided", to: "departed", intent: "hand_to_unit" },
  { from: "disposition_decided", to: "departed", intent: "refer_out" },
  { from: "arrived", to: "departed", intent: "record_lwbs" },
  { from: "triaged", to: "departed", intent: "record_lwbs" },
  { from: "triaged", to: "departed", intent: "record_abscond" },
  { from: "in_treatment", to: "departed", intent: "record_abscond" },
  { from: "disposition_decided", to: "departed", intent: "record_abscond" },
  { from: "in_treatment", to: "departed", intent: "record_lama" },
  { from: "disposition_decided", to: "departed", intent: "record_lama" },
  { from: "arrived", to: "departed", intent: "record_er_death" },
  { from: "triaged", to: "departed", intent: "record_er_death" },
  { from: "in_treatment", to: "departed", intent: "record_er_death" },
  { from: "disposition_decided", to: "departed", intent: "record_er_death" },
];

/**
 * The actor kinds behind each catalogue act. Lane 1's come from their contracts; the later lanes' are the spec's
 * stated actors (§2, §4) until their contracts replace them.
 */
const LATER_ACTORS: Partial<Record<ErCatalogueIntent, readonly ErActorKind[]>> = {
  triage: ["er_nurse", "doctor"],
  assign_er_doctor: ["er_nurse", "doctor"],
  decide_disposition: ["doctor"],
  discharge_from_er: ["doctor"],
  hand_to_unit: ["doctor"],
  refer_out: ["doctor"],
  record_lwbs: ["er_nurse", "doctor", "desk"],
  record_abscond: ["er_nurse", "doctor", "duty_manager"],
  record_lama: ["doctor", "duty_manager"],
  record_er_death: ["doctor"],
};

function actorsOf(intent: ErCatalogueIntent): readonly ErActorKind[] {
  const contracted = (ER_INTENTS as Record<string, { actors: readonly ErActorKind[] } | undefined>)[intent];
  return contracted?.actors ?? LATER_ACTORS[intent] ?? [];
}

/** The roles that may drive `from → to` (any act on that edge). */
function rolesFor(from: ErEpisodeState, to: ErEpisodeState): string[] {
  const roles = new Set<string>();
  for (const t of ER_EPISODE_TRANSITIONS) {
    if (t.from !== from || t.to !== to) continue;
    for (const a of actorsOf(t.intent)) for (const r of ER_ACTOR_ROLE_KEYS[a]) roles.add(r);
  }
  return [...roles];
}

const recordOnly = (minutes: number) => ({ minutes, alerting: "record_only" as const });
const edges = [...new Map(ER_EPISODE_TRANSITIONS.map((t) => [`${t.from}>${t.to}`, t] as const)).values()];

export const erEpisodeWorkflowDefinition: WorkflowDefinition = defineWorkflow({
  key: ER_EPISODE_WORKFLOW_DEF_KEY,
  title: "Emergency episode",
  changeClass: "A",
  initialState: "arrived",
  states: [
    // Door-to-triage ≤ 5 min (spec §3.2). Recorded only in lane 1: the board shows the clock; lane 2's triage clock
    // raises the task on the roster ladder (`escalationRecipients`), never a colour alone.
    { name: "arrived", sla: recordOnly(5) },
    { name: "triaged", sla: recordOnly(120) },
    // Disposition decision ≤ 4 h (spec §3.2).
    { name: "in_treatment", sla: recordOnly(240) },
    // Decision-to-bed ≤ 2 h (spec §3.2); lane 5 climbs it to the bed manager and the MS.
    { name: "disposition_decided", sla: recordOnly(120) },
    { name: "departed", terminal: true },
    { name: "brought_dead", terminal: true },
  ],
  transitions: edges.map((t) => ({ from: t.from, to: t.to, roles: rolesFor(t.from, t.to) })),
});
