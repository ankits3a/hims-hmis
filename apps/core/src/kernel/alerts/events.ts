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
