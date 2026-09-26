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

/**
 * THE OTHER HALF OF `emergency_elevation.used`, missing since Plan 02.
 *
 * The staffing spec's workforce mechanism 6 names the act as "loudly evented + MANDATORY REVIEW".
 * `emergency_elevation.used` was the loud half; nothing recorded that a human had ever looked. A
 * review that leaves no event is indistinguishable from no review at all once the row is updated,
 * so the disposition is evented like every other decision in this system.
 *
 * `roleKey` rides along rather than being joined for at read time: the grant row is swept and the
 * ROLE could later be deleted, and an audit line that cannot say WHAT authority was taken is not
 * an audit line.
 */
export const emergencyElevationReviewed = defineEvent(
  "emergency_elevation.reviewed",
  "auth",
  z.object({
    grantId: z.string(),
    userId: z.string(),
    roleKey: z.string(),
    reviewedBy: z.string(),
    note: z.string(),
  }),
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

// ══════════════════ WASA M-05 — THE AUTHENTICATION AUDIT STREAM ══════════════════
//
// TEN NEW TYPES, and adding types is the safe direction (the 11e note above). Before these, not
// one login, logout, terminal switch or TOTP act left an event: failures lived only in
// `auth_throttle`, which is deleted on success and pruned after an hour, so "who tried to sign in
// as the owner last night, and from where" had no answer at all.
//
// WHAT THEY CARRY. Every row names the client — `ip` (the address the ONE trusted proxy hop
// reported, `src/http-hardening.ts`) and `userAgent` (bounded) — because CERT-In and ASVS 7.1.3
// ask for the source of an authentication act, and `auth_sessions` now carries the same pair.
//
// WHAT THEY NEVER CARRY. No password, PIN, badge token, TOTP code or TOTP secret, ever — the GC3
// rule `user.credential_reset` keeps. And a FAILED attempt names the submitted username but never
// a user id or any "known/unknown" flag: its payload and actor are identical whether or not the
// username belongs to anybody, so the audit trail is not a membership oracle for whoever can read
// it. The actor on a failure is `system:auth`, because nobody was authenticated.
//
// Written from `auth-audit.ts`, called at the ROUTE layer (the controller and the step-up guard),
// never from inside `sessions.ts`, `identity.ts` or `totp.ts`.

const client = {
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
};

export const authLoginSucceeded = defineEvent(
  "auth.login_succeeded",
  "auth",
  z.object({
    userId: z.string(),
    sessionId: z.string(),
    method: z.literal("password"),
    terminalId: z.string().nullable(),
    ...client,
  }),
);

export const authLoginFailed = defineEvent(
  "auth.login_failed",
  "auth",
  z.object({
    method: z.enum(["password", "pin", "badge"]),
    /** As SUBMITTED, cut to 128 characters; `null` for a badge, which submits no username. */
    username: z.string().max(128).nullable(),
    terminalId: z.string().max(128).nullable(),
    ...client,
  }),
);

/** A terminal switch opens a session AND ends every other live one on that terminal — the count
 *  is the second half, and each ended session gets its own `auth.session_revoked`. */
const terminalSwitch = z.object({
  userId: z.string(),
  sessionId: z.string(),
  terminalId: z.string(),
  terminalSessionsRevoked: z.number().int(),
  ...client,
});
export const authPinSwitched = defineEvent("auth.pin_switched", "auth", terminalSwitch);
export const authBadgeSwitched = defineEvent("auth.badge_switched", "auth", terminalSwitch);

/**
 * A session ended by somebody OTHER than its holder. `userId` is the HOLDER — the person put out
 * of the terminal — and the envelope's actor is whoever caused it. The other revoking paths are
 * already evented with a count (`user.deactivated`, `user.credential_reset`,
 * `user.password_changed`); a holder ending their own session is `auth.logged_out`.
 */
export const authSessionRevoked = defineEvent(
  "auth.session_revoked",
  "auth",
  z.object({
    sessionId: z.string(),
    userId: z.string(),
    reason: z.enum(["terminal_switch"]),
    terminalId: z.string().nullable(),
  }),
);

export const authLoggedOut = defineEvent(
  "auth.logged_out",
  "auth",
  z.object({ userId: z.string(), sessionId: z.string(), ...client }),
);

/** A secret was MINTED (and any previous one replaced) — not yet active until `totp_confirmed`. */
export const authTotpEnrolled = defineEvent(
  "auth.totp_enrolled",
  "auth",
  z.object({ userId: z.string(), sessionId: z.string().nullable(), ...client }),
);

export const authTotpConfirmed = defineEvent(
  "auth.totp_confirmed",
  "auth",
  z.object({ userId: z.string(), sessionId: z.string().nullable(), ...client }),
);

export const authTotpVerified = defineEvent(
  "auth.totp_verified",
  "auth",
  z.object({
    userId: z.string(),
    sessionId: z.string(),
    via: z.enum(["verify_route", "step_up_header"]),
    ...client,
  }),
);

/** A code was SUBMITTED and refused. A step-up with no code at all is a prompt, not an attempt. */
export const authTotpFailed = defineEvent(
  "auth.totp_failed",
  "auth",
  z.object({
    userId: z.string(),
    sessionId: z.string().nullable(),
    stage: z.enum(["confirm", "verify_route", "step_up_header"]),
    ...client,
  }),
);

/** The M-05 catalogue, for the census in `test/auth-audit.e2e.test.ts`. */
export const AUTH_AUDIT_EVENTS = [
  authLoginSucceeded, authLoginFailed, authPinSwitched, authBadgeSwitched, authSessionRevoked,
  authLoggedOut, authTotpEnrolled, authTotpConfirmed, authTotpVerified, authTotpFailed,
] as const;
