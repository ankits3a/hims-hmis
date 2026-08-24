import { api, ApiError } from "./api";

/**
 * PLAN 11e T6 — THE USER-ADMINISTRATION WIRE CONTRACT, transcribed from `users-admin.controller.ts`
 * and `roles-admin.controller.ts` exactly as `ops-api.ts` and `billing-api.ts` transcribe theirs:
 * this file DESCRIBES the shape those routes ship, it does not re-derive or widen it.
 *
 * IT MINTS NO POLICY. The ten-character floor, the username rule and the PIN's shape live in
 * `kernel/auth/password-policy.ts` and are enforced by the server; this client sends what was
 * typed and RENDERS the refusal. A second copy of the floor here would be a rule that drifts from
 * the one that actually decides — and the drift would surface as a screen refusing a password the
 * server would have accepted, or worse, the reverse.
 */

// ───────────────────────────── users (T3) ─────────────────────────────

export type WireUserRole = {
  assignmentId: string;
  roleKey: string;
  scopeType: string;
  scopeId: string | null;
};

/** `GET /admin/users`'s row. No credential material: `hasPin` says one EXISTS, nothing more. */
export type WireAdminUser = {
  id: string;
  username: string;
  fullName: string;
  active: boolean;
  hasPin: boolean;
  mustChangePassword: boolean;
  roles: WireUserRole[];
};

/**
 * `fullAdministrators` is the count of active users holding the WHOLE `auth.*` set at hospital
 * scope, computed by the server from the takeover rule's own helper (11f D2). The client never
 * derives it: a second derivation here would be the §2.89 defect in a second language.
 */
export function listUsers(): Promise<{ users: WireAdminUser[]; fullAdministrators: number }> {
  return api("GET", "/admin/users");
}

/** `auth.users.manage`. The new account always lands in the forced-change state (D2). */
export function createUser(body: {
  username: string; fullName: string; password: string; pin?: string;
}): Promise<{ id: string }> {
  return api("POST", "/admin/users", body);
}

export function deactivateUser(id: string): Promise<{ sessionsRevoked: number }> {
  return api("POST", `/admin/users/${id}/deactivate`);
}

export function reactivateUser(id: string): Promise<void> {
  return api("POST", `/admin/users/${id}/reactivate`);
}

/** Revokes every session the target holds and sets must-change. The count is what came back. */
export function resetPassword(id: string, newPassword: string): Promise<{ sessionsRevoked: number }> {
  return api("POST", `/admin/users/${id}/password-reset`, { newPassword });
}

/** Revokes NOTHING and forces NO password change — the two flows differ, deliberately (Q3). */
export function resetPin(id: string, newPin: string): Promise<void> {
  return api("POST", `/admin/users/${id}/pin-reset`, { newPin });
}

// ───────────────────────────── roles (T4) ─────────────────────────────

export function assignRole(
  id: string,
  body: { roleKey: string; scopeType: "hospital" | "floor" | "department"; scopeId?: string },
): Promise<{ assignmentId: string }> {
  return api("POST", `/admin/users/${id}/roles`, body);
}

export function revokeRole(id: string, assignmentId: string): Promise<void> {
  return api("DELETE", `/admin/users/${id}/roles/${assignmentId}`);
}

// ───────────────────────── self-service (T2) ─────────────────────────

export function changePassword(body: { currentPassword: string; newPassword: string }): Promise<void> {
  return api("POST", "/auth/change-password", body);
}

// ─────────────────────────── error helpers ───────────────────────────
//
// A SEPARATE FUNCTION OVER THE SAME `ApiError` SHAPE rather than an import from `ops-api.ts` —
// `billing-api.ts:179` states the reason and `ops-api.ts` repeats it: so "align the two error
// conventions" can never become a one-line temptation. These routes answer in three shapes:
// `{code, problems}` for a policy refusal, `{code, message}` for a named refusal
// (`admin_lockout`, `username_taken`, `user_not_found`, `password_change_required`,
// `current_password_incorrect`), and Nest's own `{statusCode, message}` for a 403 on a missing
// permission or a zod 400.

export type WirePolicyProblem = { code: string; message: string };

/** The machine `code`, or null — screens branch on this, never on the status. */
export function adminErrorCode(e: unknown): string | null {
  if (e instanceof ApiError) {
    const body = e.body as { code?: unknown } | null;
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return null;
}

/** The policy problems a `password_policy` refusal carries, or [] when it is a different refusal. */
export function adminPolicyProblems(e: unknown): WirePolicyProblem[] {
  if (!(e instanceof ApiError)) return [];
  const body = e.body as { problems?: unknown } | null;
  if (!Array.isArray(body?.problems)) return [];
  return body.problems.filter(
    (p): p is WirePolicyProblem =>
      typeof p === "object" && p !== null && typeof (p as { message?: unknown }).message === "string",
  );
}

/** The displayable text of a failed admin call. Policy problems join into one sentence. */
export function adminErrorMessage(e: unknown): string {
  const problems = adminPolicyProblems(e);
  if (problems.length > 0) return problems.map((p) => p.message).join("; ");
  if (e instanceof ApiError) {
    const body = e.body as { message?: unknown; code?: unknown } | null;
    if (typeof body?.message === "string" && body.message !== "") return body.message;
    if (Array.isArray(body?.message)) {
      return body.message
        .map((issue) =>
          typeof issue === "object" && issue !== null && "message" in issue
            ? String((issue as { message: unknown }).message)
            : String(issue),
        )
        .join("; ");
    }
    if (typeof body?.code === "string" && body.code !== "") return body.code;
  }
  return String(e);
}

/**
 * TRUE when this failure is the forced-credential-change gate (11e D1). `login.tsx` reads it to
 * route into `/change-password` instead of the shell; it is a 403 whose message is exactly
 * `password_change_required`, and the message IS the contract — `AuthGuard` throws a bare
 * `ForbiddenException` with that string.
 */
export function isPasswordChangeRequired(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 403) return false;
  const body = e.body as { message?: unknown } | null;
  return body?.message === "password_change_required";
}
