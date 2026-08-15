import { defineWorkflow } from "../../kernel/workflow/definition";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";

export const OPD_VISIT_DEF_KEY = "opd_visit";
export const OPD_VISIT_STATES = ["registered", "waiting", "in_consultation", "awaiting_results", "completed", "abandoned"] as const;
export type OpdVisitState = (typeof OPD_VISIT_STATES)[number];

/**
 * The OPD encounter state machine as workflow-definition DATA (spec §10.1 P1 / §10.2). Class A (D-15): a patient-journey
 * flow — owner + medical superintendent two-key at activation. Go-live: POST /workflow/definitions with exactly this JSON
 * (GET /opd/definition serves it), two approvals, activation by a third user. Tests: test/helpers/opd.ts.
 * §10.3: every non-terminal state carries an SLA; the OPD wait is the go-live ACTIVE alert.
 */
export const OPD_VISIT_DEFINITION_JSON = {
  key: OPD_VISIT_DEF_KEY,
  title: "OPD visit",
  changeClass: "A",
  initialState: "registered",
  states: [
    { name: "registered", sla: { minutes: 20, alerting: "record_only" } },
    { name: "waiting", sla: { minutes: 45, alerting: "active", escalation: [{ afterMinutes: 15, toRole: "front_office_supervisor" }, { afterMinutes: 30, toRole: "duty_manager" }] } },
    { name: "in_consultation", sla: { minutes: 60, alerting: "record_only" } },
    { name: "awaiting_results", sla: { minutes: 240, alerting: "record_only" } },
    { name: "completed", terminal: true },
    { name: "abandoned", terminal: true },
  ],
  transitions: [
    { from: "registered", to: "waiting", roles: ["vitals_desk", "nurse", "doctor"] },
    { from: "waiting", to: "in_consultation", roles: ["doctor"] },
    { from: "in_consultation", to: "completed", roles: ["doctor"] },
    { from: "in_consultation", to: "awaiting_results", roles: ["doctor"] },
    { from: "awaiting_results", to: "waiting", roles: ["front_office", "vitals_desk", "nurse", "doctor"] },
    { from: "registered", to: "abandoned", roles: ["front_office", "front_office_supervisor"] },
    { from: "waiting", to: "abandoned", roles: ["front_office", "front_office_supervisor"] },
    { from: "awaiting_results", to: "abandoned", roles: ["front_office", "front_office_supervisor"] },
  ],
};

export function opdVisitDefinition(): WorkflowDefinition {
  return defineWorkflow(OPD_VISIT_DEFINITION_JSON);
}
