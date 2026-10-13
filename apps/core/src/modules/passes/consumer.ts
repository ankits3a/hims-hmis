import { z } from "zod";
import { IPD_TRANSFER_ACCEPTED_EVENT_NAME, admissionPlace } from "../ipd";
import { PASSES_ADMISSION_CONSUMER } from "./consumer-name";
import { expireAdmissionPasses, movePassesToCurrentWard } from "./passes";
import type { PassEndReason } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DispatchedEvent, Handler } from "../../kernel/events/subscriptions";

export { PASSES_ADMISSION_CONSUMER };

/** The stay-ending event → the reason the passes expire with. */
const END_REASON: Record<string, PassEndReason> = {
  "ipd.admission.discharged": "discharged",
  "ipd.admission.lama": "lama",
  "ipd.admission.absconded": "absconded",
  "ipd.admission.deceased": "deceased",
};

/** Only the admission id is read: the emitting lanes own the rest of their payloads. */
const Payload = z.looseObject({ admissionId: z.string().min(1) });

/**
 * `passes.admission` — the four stay-ending events expire every live pass of the admission AT ONCE (one transaction,
 * `expireAdmissionPasses`), with the event's own `occurredAt` as the end time (a replayed event computes the same
 * answer); a refer-out arrives as `discharged` and is recorded `transferred_out` when IPD says so. A ward transfer's
 * acceptance moves the live passes to the admission's current ward. Both acts are idempotent: the dispatcher delivers
 * at least once, and its 5,000-seq look-back re-reads recent history for a fresh cursor — a second delivery finds
 * nothing live and writes nothing.
 */
export function passesAdmissionConsumer(db: Db): Handler {
  return async (e: DispatchedEvent): Promise<void> => {
    const parsed = Payload.safeParse(e.payload);
    if (!parsed.success) return;
    const { admissionId } = parsed.data;
    if (e.name === IPD_TRANSFER_ACCEPTED_EVENT_NAME) {
      await movePassesToCurrentWard(db, admissionId, e.occurredAt);
      return;
    }
    let reason = END_REASON[e.name];
    if (reason === undefined) return;
    if (reason === "discharged" && (await admissionPlace(db, admissionId))?.state === "transferred_out") reason = "transferred_out";
    await expireAdmissionPasses(db, { admissionId, reason, at: e.occurredAt, causationEvent: e.eventId });
  };
}
