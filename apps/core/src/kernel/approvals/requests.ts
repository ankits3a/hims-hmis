import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../events/append";
import { getActiveDefinition } from "../workflow/definitions";
import { startInstance } from "../workflow/instances";
import { approvals } from "../db/schema";
import { approvalRequested } from "./events";
import { cumulativeAmount, istDayWindow } from "./cumulative";
import { ApprovalError, getApprovalType } from "./types";
import type { UrgencyClass } from "./types";
import type { Tx } from "../db/client";

export type ApprovalRequestInput = {
  typeKey: string;
  subject: { type: string; id: string };
  patientId?: string;
  encounterId?: string;
  payeeId?: string;
  amountPaise?: number; // integer PAISE — never floats near money
  requestNote?: string;
  actFirst?: boolean; // E-15 act-first-review-after (needs type.actFirstAllowed + a note)
};

/**
 * Files an approval request as a workflow instance of approval_<typeKey> (owner decision
 * Q1a): Plan 03 schedules the closure-SLA timer and climbs the escalation ladder — this
 * function writes no timer code. Runs on the CALLER'S transaction so consumer plans
 * (billing, Plan 08) file requests atomically with their own state change.
 */
export async function requestApproval(
  tx: Tx,
  requester: Actor,
  input: ApprovalRequestInput,
): Promise<{ approvalId: string; instanceId: string }> {
  if (requester.type !== "user") {
    throw new ApprovalError("user_actor_required", "only user actors may request approvals (agent requesters are the Plan 12 seam; a system requester has no SoD identity)");
  }
  const type = await getApprovalType(tx, input.typeKey);
  if (!type) throw new ApprovalError("unknown_type", `unknown approval type ${input.typeKey}`);

  const actedFirst = input.actFirst === true;
  if (actedFirst && !type.actFirstAllowed) {
    throw new ApprovalError("act_first_not_allowed", `type ${type.typeKey} does not allow act-first (E-15: per-type capability)`);
  }
  if (actedFirst && (input.requestNote ?? "").trim() === "") {
    throw new ApprovalError("note_required", "an act-first request must carry a justification note (E-15)");
  }
  if (input.amountPaise !== undefined) {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new ApprovalError("invalid_amount", "amountPaise must be a positive integer (paise)");
    }
    if (input.patientId === undefined && input.payeeId === undefined) {
      throw new ApprovalError("amount_needs_target", "a money request needs patientId or payeeId for C-12 aggregation");
    }
  }

  const active = await getActiveDefinition(tx, type.defKey);
  if (!active) throw new ApprovalError("definition_not_active", `no active workflow definition ${type.defKey}`);
  const slaMinutes = active.parsed.states.find((s) => s.name === "pending")?.sla?.minutes;
  if (slaMinutes === undefined) {
    // Defense in depth: T3's registry refuses such definitions at registration time.
    throw new ApprovalError("definition_mismatch", `definition ${type.defKey} carries no SLA on "pending"`);
  }
  // Drift guard: approval_types is insert-only and was validated against the version active
  // at REGISTRATION. If a later version changed the approver role, fail loud here — a new
  // request must not snapshot a role the pinned instance will refuse at decision time.
  // (In-flight items are unaffected: version pin + row snapshot stay consistent.)
  for (const to of ["granted", "rejected"] as const) {
    const t = active.parsed.transitions.find((x) => x.from === "pending" && x.to === to);
    if (!t || !t.roles.includes(type.approverRole)) {
      throw new ApprovalError(
        "definition_mismatch",
        `type ${type.typeKey} names approver role "${type.approverRole}" but the active definition does not allow it on pending→${to}`,
      );
    }
  }

  // C-12 snapshots — today's cumulative INCLUDING this request (IST calendar day,
  // pending+granted). Report-only: thresholds are the consumer plans' CA-configured data.
  const window = istDayWindow(new Date());
  let cumulativePatientPaise: number | undefined;
  let cumulativePayeePaise: number | undefined;
  if (input.amountPaise !== undefined && input.patientId !== undefined) {
    cumulativePatientPaise =
      (await cumulativeAmount(tx, { typeKey: type.typeKey, patientId: input.patientId, window })) +
      input.amountPaise;
  }
  if (input.amountPaise !== undefined && input.payeeId !== undefined) {
    cumulativePayeePaise =
      (await cumulativeAmount(tx, { typeKey: type.typeKey, payeeId: input.payeeId, window })) +
      input.amountPaise;
  }

  const { instanceId } = await startInstance(tx, type.defKey, {
    type: input.subject.type,
    id: input.subject.id,
    ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
    ...(input.encounterId !== undefined ? { encounterId: input.encounterId } : {}),
  });

  const approvalId = newId();
  await tx.insert(approvals).values({
    id: approvalId,
    typeKey: type.typeKey,
    instanceId,
    requesterId: requester.id,
    approverRole: type.approverRole,
    urgencyClass: type.urgencyClass,
    actedFirst,
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    patientId: input.patientId,
    encounterId: input.encounterId,
    payeeId: input.payeeId,
    amountPaise: input.amountPaise,
    cumulativePatientPaise,
    cumulativePayeePaise,
    requestNote: input.requestNote,
  });

  await appendEvent(
    tx,
    approvalRequested.make({
      actor: requester,
      correlationId: instanceId, // §10.5: correlation = the workflow instance
      ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
      ...(input.encounterId !== undefined ? { encounterId: input.encounterId } : {}),
      payload: {
        approvalId,
        typeKey: type.typeKey,
        requesterId: requester.id,
        approverRole: type.approverRole,
        // The column is plain text in the schema; the zod payload re-validates at runtime.
        urgencyClass: type.urgencyClass as UrgencyClass,
        actedFirst,
        slaMinutes,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        ...(input.payeeId !== undefined ? { payeeId: input.payeeId } : {}),
        ...(input.amountPaise !== undefined ? { amountPaise: input.amountPaise } : {}),
        ...(cumulativePatientPaise !== undefined ? { cumulativePatientPaise } : {}),
        ...(cumulativePayeePaise !== undefined ? { cumulativePayeePaise } : {}),
      },
    }),
  );

  return { approvalId, instanceId };
}
