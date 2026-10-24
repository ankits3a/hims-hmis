// events.ts — the module's complete catalog: EXACTLY these four names (§10.6 discipline)
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
const MODULE = "tariff";
export const tariffRevisionApplied = defineEvent("tariff.revision_applied", MODULE, z.object({
  versionId: z.string().min(1), versionNo: z.number().int().positive(),
  effectiveFrom: z.string().min(1), // ISO — dates ride events as strings
  approvalId: z.string().min(1), itemCount: z.number().int().nonnegative(),
}));
/**
 * Owner ruling 2026-10-05 (money): *"admin can change it directly."* A version put into use with no
 * approval, by `activateVersionDirectly` — a distinct event so the direct road is never mistaken
 * for the approved one, and the reason the person typed rides it.
 */
export const tariffRevisionAppliedDirectly = defineEvent("tariff.revision_applied_directly", MODULE, z.object({
  versionId: z.string().min(1), versionNo: z.number().int().positive(),
  effectiveFrom: z.string().min(1), itemCount: z.number().int().nonnegative(),
  direct: z.literal(true), note: z.string().min(1),
}));
export const configValidated = defineEvent("config.validated", MODULE, z.object({
  scope: z.literal("tariff"), ok: z.boolean(), errorCount: z.number().int().nonnegative(), caSigned: z.boolean(),
}));

/**
 * GO-LIVE SCREENS — one per service the bulk switch-on (`switchOnServices`) turns on: the record of who put which
 * price live. The single `PATCH /tariff/services/:id` writes no event (only `updated_by`/`updated_at`); the bulk
 * door writes this one per service, in the same transaction as the flag.
 */
export const tariffServiceSwitchedOn = defineEvent("tariff.service_switched_on", MODULE, z.object({
  serviceId: z.string().min(1), code: z.string().min(1),
  versionId: z.string().min(1), versionNo: z.number().int().positive(), pricePaise: z.number().int().positive(),
}));
