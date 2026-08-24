import {
  pgTable, text, integer, boolean, timestamp, primaryKey, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    fullName: text("full_name").notNull(),
    // Staff/owner external messaging (Plan 10). Normalized 10-digit Indian mobile — the SAME
    // convention as patients.phone (schema/patients.ts) — and NULLABLE: a phoneless owner simply
    // degrades to the in-app alert that already ships. No collection flow exists in this phase;
    // numbers are deployment data, seeded per hospital.
    phone: text("phone"),
    passwordHash: text("password_hash").notNull(),
    pinHash: text("pin_hash"),
    badgeVersion: integer("badge_version").notNull().default(0),
    active: boolean("active").notNull().default(true),
    // PLAN 11e D1 — the forced-credential-change flag, and it lives on the USER rather than on the
    // session on purpose: it is a fact about the credential, so it must survive every session the
    // credential can open, including one opened on another terminal a second later.
    //
    // DEFAULT FALSE, and that is a migration decision rather than a style one: production carries
    // sixteen live users whose passwords nobody is resetting in this migration, and a default of
    // true would lock all sixteen out of every route at once (`AuthGuard`, guards.ts) the moment
    // 0018 applied. The flag is written TRUE by the two acts that make it true — admin user
    // creation and admin password reset (`users-admin.controller.ts`) — and cleared by exactly one
    // act, `POST /auth/change-password`.
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_username_ux").on(t.username)],
);

export const roles = pgTable("roles", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One-way mirror of ModuleRegistry.allPermissions() — exists only for FK integrity.
export const permissions = pgTable("permissions", {
  permission: text("permission").primaryKey(),
  module: text("module").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: text("role_key").notNull().references(() => roles.key),
    permission: text("permission").notNull().references(() => permissions.permission),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permission] })],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    roleKey: text("role_key").notNull().references(() => roles.key),
    scopeType: text("scope_type").notNull(), // 'hospital' | 'floor' | 'department'
    scopeId: text("scope_id"), // null for hospital scope; opaque code until org masters exist
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("role_assignments_user_idx").on(t.userId)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    terminalId: text("terminal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    secondFactorAt: timestamp("second_factor_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_ux").on(t.tokenHash),
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_terminal_idx").on(t.terminalId),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    apiKeyHash: text("api_key_hash").notNull(),
    killSwitch: boolean("kill_switch").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agents_name_ux").on(t.name), uniqueIndex("agents_key_ux").on(t.apiKeyHash)],
);

export const userTotp = pgTable("user_totp", {
  userId: text("user_id").primaryKey().references(() => users.id),
  secretSealed: text("secret_sealed").notNull(), // AES-256-GCM sealed; never plaintext at rest
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
});

export const sodPairs = pgTable("sod_pairs", {
  pairKey: text("pair_key").primaryKey(),
  description: text("description").notNull(),
});

export const tempRoleGrants = pgTable(
  "temp_role_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    roleKey: text("role_key").notNull().references(() => roles.key),
    grantedBy: text("granted_by").notNull(), // actor id; equals userId on emergency self-elevation
    kind: text("kind").notNull(), // 'granted' | 'emergency'
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    expiredEventAt: timestamp("expired_event_at", { withTimezone: true }), // set when temp_role.expired emitted
  },
  (t) => [index("temp_role_grants_user_idx").on(t.userId), index("temp_role_grants_expiry_idx").on(t.expiresAt)],
);

export const breakGlassGrants = pgTable(
  "break_glass_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    patientId: text("patient_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
  },
  (t) => [index("break_glass_user_idx").on(t.userId), index("break_glass_review_idx").on(t.reviewedAt)],
);
/**
 * PLAN 11g / DD4 — THE CREDENTIAL PATHS' BACKOFF STATE, AND THE KEY IS THE WHOLE DESIGN.
 *
 * The 2026-08-24 synthetic smoke test put five consecutive wrong passwords through
 * `POST /auth/login` and got 401, 401, 401, 401, 401 — then the correct one, immediately. No
 * delay, no counter, nothing recorded anywhere. `POST /auth/switch/pin` is the sharper half of
 * the same hole: a FOUR-DIGIT pin is a 10,000-value keyspace.
 *
 * `subject` IS THE SUBMITTED USERNAME, NORMALISED — NOT A `users.id`, AND THERE IS NO FK. Three
 * things follow from that, and all three are the point:
 *   - an attempt against a username that does not exist is throttled identically to one against a
 *     username that does, so the 429 cannot be used to ENUMERATE accounts;
 *   - spraying invented usernames costs the same as spraying real ones;
 *   - no row here can be orphaned by a user deletion, and none needs a truncate ordering (it
 *     joins no existing group in `test/helpers/db.ts` because it points at nothing).
 *
 * `kind` separates `login` from `pin` so a poisoned password counter cannot close the terminal
 * switch, which is the path a clinician uses at a shared desk mid-shift.
 *
 * IT IS BACKOFF STATE, NOT LOCKOUT STATE. `retry_after` is an instant that passes on its own;
 * nothing here requires an administrator to clear it, deliberately — production has exactly ONE
 * full administrator (runbook O1, open), and a credential state whose only repair is a person who
 * may be asleep is the failure shape Plan 11e existed to end.
 */
export const authThrottle = pgTable(
  "auth_throttle",
  {
    kind: text("kind").notNull(), // 'login' | 'pin'
    subject: text("subject").notNull(), // the SUBMITTED username, trimmed and lower-cased
    failures: integer("failures").notNull().default(0),
    // The rolling window's anchor: failures older than the window do not count toward the
    // threshold, so a person who fumbles twice a month is never near it.
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).notNull(),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull(),
    // NULL until the threshold is crossed. An instant, not a duration: it is what the 429's
    // Retry-After is derived from, and it expires without anybody acting.
    retryAfter: timestamp("retry_after", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.subject] })],
);
