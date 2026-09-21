import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

// Plan 08.5 D8 — two new catalog names, module "alerts". Catalog additions, no version bumps.
//
// EVERY FIELD HERE IS ON A PUBLIC SURFACE BY CONSTRUCTION: the tail fans `alert.raised` to the
// per-user topic `alerts:<userId>`, so the payload reaches a browser. No patient identity may
// appear in either payload (Global Constraint 6, spec §14's public-surface rule) — the refs are
// structural (`workflow_instance` / instanceId) and the recipient reaches the patient only
// through permission-checked routes.

export const alertRaised = defineEvent(
  "alert.raised",
  "alerts",
  z.object({
    alertId: z.string(),
    userId: z.string(), // the topic key: realtime.ts routes on this field
    kind: z.string(),
    refType: z.string(),
    refId: z.string(),
    sourceEventId: z.string(),
  }),
);

export const alertRead = defineEvent(
  "alert.read",
  "alerts",
  z.object({
    alertId: z.string(),
    userId: z.string(),
  }),
);

/**
 * PHASE O T3 — the third name, and the first one that says a HUMAN acted rather than that the
 * machine noticed. T1 consumes it to cancel a `respond` timer; the realtime tail fans it on
 * `alerts:<userId>` so the acknowledger's OTHER tab clears without waiting for its next poll.
 *
 * SAME PUBLIC-SURFACE RULE AS `alert.raised`, and it bites harder here because this payload is
 * written from a form: `kind` is a closed vocabulary, `ownedUntil` is an instant, the two ref
 * fields are structural, and `ack_note` — the one free-text column T3 adds — is DELIBERATELY NOT
 * CARRIED. A note is the acknowledger's own words and stays in the row that permission-checked
 * reads reach; it never goes onto a browser topic (V19's ids-codes-instants-and-minutes rule).
 */
export const alertAcknowledged = defineEvent(
  "alert.acknowledged",
  "alerts",
  z.object({
    alertId: z.string(),
    userId: z.string(), // the topic key: realtime.ts routes on this field
    kind: z.enum(["seen", "owned", "handed_over"]),
    ownedUntil: z.string().optional(),
    handedToUserId: z.string().optional(),
    refType: z.string().nullable(),
    refId: z.string().nullable(),
  }),
);
