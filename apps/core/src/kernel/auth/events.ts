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
