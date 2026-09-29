import { approvalGranted } from "../../kernel/approvals/events";
import { WorkflowError } from "../../kernel/workflow/instances";
import { IMAGING_GATE_OVERRIDE_APPROVAL_TYPE } from "./approval-types";
import { RadiologyError } from "./errors";
import { applyGrantedGateOverride } from "./override-requests";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/** The consumer key `radiologyManifest` declares and the worker's consumers map is keyed by. */
export const RADIOLOGY_APPROVAL_GRANTED_CONSUMER = "radiology.approval_granted";

/**
 * ═══ PLAN 18-S RS10 T3 — A GRANT GIVEN IN THE KERNEL'S `/approvals` INBOX APPLIES ITSELF ═══
 *
 * RS5 filed the prep bay's "please override" as a kernel approval (`imaging_gate_override`) and
 * applied the grant only through radiology's own decide route — so a radiologist who granted it from
 * the hospital-wide inbox left the patient in the bay until somebody pressed *grant* again at the
 * radiology screen (RS5 "moved later"). This consumer closes that: on `approval.granted` for that
 * type it runs the SAME apply half the route runs (`applyGrantedGateOverride`) — the approval
 * re-read on execute, the existing `overrideGate` as the approver, the approver's note as the reason,
 * readiness re-evaluated.
 *
 * **Idempotent under at-least-once**: a gate already terminal (the route applied it first, or this
 * is a redelivery) is left alone. **A refusal is final, not retried**: a never-override kind
 * (`form_f`, the side), a reason carrying a §5(2) term, a gate that closed another way — each is a
 * domain answer, and a consumer that threw on it would be redelivered forever. It is swallowed and
 * the gate stays open for a human at the bay; anything else (a lost connection) is thrown and retried.
 */
export function approvalGrantedConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== approvalGranted.name) return;
    const payload = approvalGranted.payloadSchema.parse(e.payload);
    if (payload.typeKey !== IMAGING_GATE_OVERRIDE_APPROVAL_TYPE) return;
    try {
      await applyGrantedGateOverride(db, { type: "user", id: payload.decidedBy }, payload.approvalId, payload.note);
    } catch (err) {
      if (err instanceof RadiologyError || err instanceof WorkflowError) return;
      throw err;
    }
  };
}
