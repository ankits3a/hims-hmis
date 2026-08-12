import {
  pgTable, text, integer, boolean, timestamp, primaryKey, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    fullName: text("full_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    pinHash: text("pin_hash"),
    badgeVersion: integer("badge_version").notNull().default(0),
    active: boolean("active").notNull().default(true),
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
