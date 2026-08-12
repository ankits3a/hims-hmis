import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// The plan's complete event surface — three catalog names (§10.6 P7+kernel), module
// "approvals". correlationId on every emission = the backing workflow instance id (§10.5).
// sla.breached / escalation.triggered for approval flows are Plan 03's, module "workflow".

const urgency = z.enum(["routine", "urgent", "emergency"]); // E-15 classes (owner decision 2026-08-13)

export const approvalRequested = defineEvent(
  "approval.requested",
  "approvals",
  z.object({
    approvalId: z.string(),
    typeKey: z.string(),
    requesterId: z.string(),
    approverRole: z.string(),
    urgencyClass: urgency, // Plan 10's gateway routes the interrupting channel from this
    actedFirst: z.boolean(), // E-15 act-first-review-after, loud in the payload
    slaMinutes: z.number().int().positive(), // E-18 closure SLA, for Plan 10's matrices
    subjectType: z.string(),
    subjectId: z.string(),
    payeeId: z.string().optional(),
    amountPaise: z.number().int().positive().optional(),
    cumulativePatientPaise: z.number().int().positive().optional(), // C-12 snapshot incl. this request
    cumulativePayeePaise: z.number().int().positive().optional(),
  }),
);

const decisionPayload = z.object({
  approvalId: z.string(),
  typeKey: z.string(),
  requesterId: z.string(),
  decidedBy: z.string(),
  note: z.string().min(1), // §8: approve/reject with note — runtime-trimmed upstream (T5)
  urgencyClass: urgency,
  actedFirst: z.boolean(), // a rejected acted-first item is an after-the-fact rejection (consumer domain)
});

export const approvalGranted = defineEvent("approval.granted", "approvals", decisionPayload);
export const approvalRejected = defineEvent("approval.rejected", "approvals", decisionPayload);
