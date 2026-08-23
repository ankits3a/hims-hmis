import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

export const breakGlassUsed = defineEvent(
  "break_glass.used",
  "auth",
  z.object({
    grantId: z.string(),
    patientId: z.string().optional(),
    reason: z.string(),
    expiresAt: z.string(), // ISO timestamp
  }),
);

export const sodViolationBlocked = defineEvent(
  "sod.violation_blocked",
  "auth",
  z.object({
    pairKey: z.string(),
    actorAType: z.string(),
    actorAId: z.string(),
    actorBType: z.string(),
    actorBId: z.string(),
  }),
);

export const emergencyElevationUsed = defineEvent(
  "emergency_elevation.used",
  "auth",
  z.object({ grantId: z.string(), roleKey: z.string(), reason: z.string(), expiresAt: z.string() }),
);

export const tempRoleGranted = defineEvent(
  "temp_role.granted",
  "auth",
  z.object({
    grantId: z.string(),
    userId: z.string(),
    roleKey: z.string(),
    grantedBy: z.string(),
    kind: z.enum(["granted", "emergency"]),
    reason: z.string(),
    expiresAt: z.string(),
  }),
);

export const tempRoleExpired = defineEvent(
  "temp_role.expired",
  "auth",
  z.object({ grantId: z.string(), userId: z.string(), roleKey: z.string() }),
);

// ══════════════════ PLAN 11e D2 — THE USER-ADMINISTRATION AUDIT STREAM ══════════════════
//
// SEVEN NEW EVENT TYPES, AND ADDING TYPES IS THE SAFE DIRECTION. §2.86 poisoned a replayable
// history by TIGHTENING an existing type's schema, so every consumer replaying from cursor 0 hit
// rows its parser refused. New names poison nothing: a consumer that has never heard of
// `user.created` ignores it, and one that has, sees a valid stream from the first row.
//
// NO EVENT CARRIES CREDENTIAL MATERIAL. `user.credential_reset` names the KIND that was reset and
// the admin who did it, never the password, never the PIN, and never a hash — the same GC3 rule
// `seed-staff.ts` keeps for its transcript. The `actor` on the envelope is the acting admin in
// every case; `userId` in the payload is always the person ACTED UPON.

export const userCreated = defineEvent(
  "user.created",
  "auth",
  z.object({
    userId: z.string(),
    username: z.string(),
    fullName: z.string(),
    hasPin: z.boolean(),
    mustChangePassword: z.boolean(),
  }),
);

export const userDeactivated = defineEvent(
  "user.deactivated",
  "auth",
  // `sessionsRevoked` is the COUNT the same operation killed: deactivation and revocation are one
  // flow (D2), and an audit row that recorded only the flag would not say whether the person was
  // actually put out of the building.
  z.object({ userId: z.string(), username: z.string(), sessionsRevoked: z.number().int() }),
);

export const userReactivated = defineEvent(
  "user.reactivated",
  "auth",
  z.object({ userId: z.string(), username: z.string() }),
);

export const userCredentialReset = defineEvent(
  "user.credential_reset",
  "auth",
  z.object({
    userId: z.string(),
    username: z.string(),
    kind: z.enum(["password", "pin"]),
    // A password reset revokes; a PIN reset does not (Q3). The count says which happened without
    // the reader having to know the rule.
    sessionsRevoked: z.number().int(),
    mustChangePassword: z.boolean(),
  }),
);

/** Self-service. The actor and the subject are the same person — that is the whole distinction
 *  between this and `user.credential_reset`, and it is why they are two names. */
export const userPasswordChanged = defineEvent(
  "user.password_changed",
  "auth",
  z.object({ userId: z.string(), username: z.string(), otherSessionsRevoked: z.number().int() }),
);

export const roleAssigned = defineEvent(
  "role.assigned",
  "auth",
  z.object({
    assignmentId: z.string(),
    userId: z.string(),
    roleKey: z.string(),
    scopeType: z.string(),
    scopeId: z.string().nullable(),
  }),
);

export const roleRevoked = defineEvent(
  "role.revoked",
  "auth",
  z.object({
    assignmentId: z.string(),
    userId: z.string(),
    roleKey: z.string(),
    scopeType: z.string(),
    scopeId: z.string().nullable(),
  }),
);
