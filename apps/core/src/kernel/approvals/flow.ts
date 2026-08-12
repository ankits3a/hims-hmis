import { z } from "zod";
import { defineWorkflow } from "../workflow/definition";
import type { SlaSpec, WorkflowDefinition } from "../workflow/definition";

/**
 * Approval flows are workflow-definition DATA (owner decision 2026-08-13, Q1a): every
 * approval request runs as an instance of `approval_<typeKey>`, so SLA timers and
 * escalation ladders come from Plan 03's shipped engine — this plan writes no timer code.
 * The builder emits the one canonical shape; defineWorkflow validates it before return,
 * so every definition (and every test fixture) built here is valid by construction.
 */
export const APPROVAL_DEF_PREFIX = "approval_";

const rungSchema = z.object({
  afterMinutes: z.number().int().positive(),
  toRole: z.string().min(1),
});

const specSchema = z.object({
  typeKey: z.string().regex(/^[a-z][a-z0-9_]*$/, "typeKey must be lowercase snake_case"),
  title: z.string().min(1),
  approverRole: z.string().min(1),
  closureSlaMinutes: z.number().int().positive(), // E-18: every request type names a closure SLA
  escalation: z.array(rungSchema).optional(),
  changeClass: z.enum(["A", "B", "C"]).default("C"),
});

export type EscalationRung = z.infer<typeof rungSchema>;
export type ApprovalFlowSpec = z.input<typeof specSchema>;

export function approvalFlowDefinition(spec: ApprovalFlowSpec): WorkflowDefinition {
  const s = specSchema.parse(spec);
  // alerting is always "active": a record_only state never climbs the ladder (Plan 03
  // runDueTimers), and E-18's overdue escalation is the entire point of the closure SLA.
  // Notification noise control lives in Plan 10's matrices, not here.
  const sla: SlaSpec = { minutes: s.closureSlaMinutes, alerting: "active" };
  if (s.escalation && s.escalation.length > 0) {
    sla.escalation = s.escalation.map((r) => ({ afterMinutes: r.afterMinutes, toRole: r.toRole }));
  }
  return defineWorkflow({
    key: `${APPROVAL_DEF_PREFIX}${s.typeKey}`,
    title: s.title,
    changeClass: s.changeClass,
    initialState: "pending",
    states: [
      { name: "pending", sla },
      { name: "granted", terminal: true },
      { name: "rejected", terminal: true },
    ],
    transitions: [
      { from: "pending", to: "granted", roles: [s.approverRole] },
      { from: "pending", to: "rejected", roles: [s.approverRole] },
    ],
  });
}
