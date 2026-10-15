import { approvalRejected } from "../../kernel/approvals/events";
import { MERGE_APPROVAL_TYPE, settleRefusedMerges } from "./merge";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

/** The consumer key `patientsManifest` declares and the worker's consumers map is keyed by. */
export const PATIENTS_APPROVAL_REJECTED_CONSUMER = "patients.approval_rejected";

/**
 * #653 — A REFUSED MERGE CLOSES ITS REQUEST AT REFUSAL TIME.
 *
 * The approvals engine is a kernel and cannot call this module, so a Medical Superintendent's refusal
 * of a `patient_merge` approval left the merge request `requested` until something read it
 * (`settleRefusedMerges` in `merge.ts`, the lazy close). This is the approvals → patients hook: on
 * `approval.rejected` for that type it runs the same settle, scoped to that one approval, so the
 * request is `refused` (and its record free to be asked again) without anyone opening it.
 *
 * The lazy close stays as the backstop. Idempotent under at-least-once delivery: the settle is one
 * conditional UPDATE on `status = 'requested'`, so a redelivery touches nothing. No audit row of its
 * own: the refusal's audit is the kernel's `approval.rejected`, with the MS's note, and the request
 * row points at it through `approval_id`.
 */
export function approvalRejectedConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    if (e.name !== approvalRejected.name) return;
    const payload = approvalRejected.payloadSchema.parse(e.payload);
    if (payload.typeKey !== MERGE_APPROVAL_TYPE) return;
    await settleRefusedMerges(db, { approvalId: payload.approvalId });
  };
}
