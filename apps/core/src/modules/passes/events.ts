import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * E1.3 (#720) — the pass acts' events. Ids, kinds and counts only: no holder name, no phone, no token (a token in the
 * event log would be a working pass in every reader's hands). Scans are not events: `pass_scans` keeps every one.
 */
const MODULE = "passes";
const id = z.string().min(1);

export const passesIssued = defineEvent("passes.issued", MODULE, z.object({
  admissionId: id, passIds: z.array(id).min(1), kind: z.string(),
}));
export const passRevoked = defineEvent("pass.revoked", MODULE, z.object({
  admissionId: id, passId: id, reason: z.string(), replacedBy: id.nullable(),
}));
export const passesExpired = defineEvent("passes.expired", MODULE, z.object({
  admissionId: id, passIds: z.array(id), reason: z.string(), causationEvent: z.string().nullable(),
}));
export const passesPaused = defineEvent("passes.paused", MODULE, z.object({
  admissionId: id, passIds: z.array(id), scope: z.enum(["visitors", "all"]),
}));
export const passesResumed = defineEvent("passes.resumed", MODULE, z.object({ admissionId: id, passIds: z.array(id) }));
export const passesMoved = defineEvent("passes.moved", MODULE, z.object({
  admissionId: id, passIds: z.array(id), wardId: id,
}));
export const passCustodySet = defineEvent("pass_custody.set", MODULE, z.object({
  admissionId: id, custody: z.boolean(), revokedPassIds: z.array(id),
}));
