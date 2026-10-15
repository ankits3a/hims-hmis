/**
 * "ADD YOUR AADHAAR" — THE SHAPE BOTH SCREENS READ (owner 2026-10-09). Pure TypeScript with no
 * imports, like `attendance-view.ts`: the web shell's sticker and the phone's home card read it, and
 * the phone (outside the pnpm workspace) reads it by path — so it must never import zod.
 *
 * The server (`apps/core/src/modules/attendance/me-identity.controller.ts`) is the judge of every
 * rule. What is here is only what a screen needs to draw: the answer's shape, whether twelve digits
 * have been typed (to enable Save), and which one-line notice follows a save.
 */

export type SelfLinkState = "linked" | "not_linked" | "two_matches";

/** `GET /me/identity` and the answer to `POST /me/identity`. */
export type SelfIdentity = {
  aadhaarConfigured: boolean;
  /** `XXXX XXXX 0124`, or null. Never the number. */
  aadhaar: string | null;
  attendance: SelfLinkState;
  /** Draw the sticker while this is true. */
  needsAadhaar: boolean;
};

/** Twelve digits typed, spaces and hyphens allowed. Only enables Save; the server checks the number. */
export function aadhaarTyped(raw: string): boolean {
  return /^\d{12}$/.test(raw.replace(/[\s-]/g, ""));
}

/** The one-line notice after a save: "Attendance linked", or "Saved · attendance team will match". */
export function savedNotice(state: SelfLinkState): "linked" | "saved" {
  return state === "linked" ? "linked" : "saved";
}

/** The refusals a save can meet, by code. Anything else is "try again". */
export const SELF_IDENTITY_REFUSALS = ["aadhaar_invalid", "aadhaar_locked", "aadhaar_key_not_configured", "too_many_attempts"] as const;
export type SelfIdentityRefusal = (typeof SELF_IDENTITY_REFUSALS)[number] | "failed";

export function selfRefusal(code: string | null): SelfIdentityRefusal {
  return (SELF_IDENTITY_REFUSALS as readonly string[]).includes(code ?? "") ? (code as SelfIdentityRefusal) : "failed";
}
