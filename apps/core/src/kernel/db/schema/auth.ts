import { sql } from "drizzle-orm";
import {
  pgTable, text, integer, boolean, timestamp, primaryKey, index, uniqueIndex, check,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    fullName: text("full_name").notNull(),
    /**
     * ═══ FD-29 — THE STAFF ID (owner, 2026-09-06: *"We should have staff-ID in the schema"*) ═══
     *
     * `EMP-` + four digits, unique, held by EVERY member of staff — nurse, technician, cashier,
     * front-office clerk, doctor. Before this column the only identifiers a person had in this
     * system were a ULID and a LOGIN NAME, which is why paper and audit lines that must name a human
     * had nothing better to print than `anshuman.prasad`. A login is half a credential; an employee
     * number is what an institution actually issues.
     *
     * MINTED at `createUser` so it can never be missing, and OVERRIDABLE so a hospital that already
     * runs an HR numbering scheme prints ITS number rather than a second one invented here.
     *
     * ═══ IT IS NOT `opd_doctors.code`, AND THE TWO ARE NOT DUPLICATES ═══
     *
     * A doctor has both, on purpose, the way a real medical college does: `staff_code` is their
     * EMPLOYMENT identity (attendance, payroll, the ID card) and `opd_doctors.code` is their
     * PRESCRIBER identity, which is what a clinical document names — the prescription prints
     * `DR-0114`, not an employee number. They are 1:1 today and could be collapsed; that is a
     * decision about what a hospital's paper should say, not a schema tidy-up, so it is left open.
     */
    staffCode: text("staff_code").notNull(),
    // Staff/owner external messaging (Plan 10). Normalized 10-digit Indian mobile — the SAME
    // convention as patients.phone (schema/patients.ts) — and NULLABLE: a phoneless owner simply
    // degrades to the in-app alert that already ships. No collection flow exists in this phase;
    // numbers are deployment data, seeded per hospital.
    phone: text("phone"),
    passwordHash: text("password_hash").notNull(),
    pinHash: text("pin_hash"),
    badgeVersion: integer("badge_version").notNull().default(0),
    // WASA L-06 — when the CURRENT badge version was issued; `resolveBadge` refuses a badge older
    // than `BADGE_MAX_AGE_DAYS` from here. `rotateBadge` writes it with the version bump. The
    // DEFAULT is the migration path: every row that exists when the column lands carries that
    // instant, so a badge printed before it keeps working for one max age from the deploy.
    badgeIssuedAt: timestamp("badge_issued_at", { withTimezone: true }).notNull().defaultNow(),
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
  (t) => [uniqueIndex("users_username_ux").on(t.username), uniqueIndex("users_staff_code_ux").on(t.staffCode)],
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

/**
 * ═══ MOBILE M6a — THE PHONES A PERSON IS SIGNED IN ON (owner 2026-10-06: staff use PERSONAL phones) ═══
 *
 * One row per (person, app install). `device_id` is an identifier the staff app makes up when it is
 * installed and sends with its sign-in; it is a LABEL, not a credential — nothing is granted for
 * presenting one, and a session is still a password. What the row buys is the list an administrator
 * reads in `/admin/users`: which phones hold a session for this person, what they are, when they
 * were last opened — and one button to end a lost phone's session without resetting the password.
 *
 * `model`, `os_version` and `app_version` are what the phone SAYS it is (bounded text, never
 * trusted). `last_ip` is the client address at the last sign-in or app open (WASA M-05's column,
 * per phone). The browser's sessions have no row here: `auth_sessions.device_row_id` stays NULL.
 */
export const authDevices = pgTable(
  "auth_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    deviceId: text("device_id").notNull(),
    model: text("model"),
    osVersion: text("os_version"),
    appVersion: text("app_version"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastIp: text("last_ip"),
    /**
     * MOBILE M6b — where a notification for this phone is sent (the FCM registration token the app
     * was given). NULL = this phone takes none: never asked, declined, or signed out. It is an
     * ADDRESS and a capability — never logged, never returned by any route, never put in an event.
     */
    pushToken: text("push_token"),
    pushTokenAt: timestamp("push_token_at", { withTimezone: true }),
    /** The language the phone's app is in; the generic sentence a notification carries is said in it. */
    pushLanguage: text("push_language").notNull().default("en"),
    /** The categories this phone's owner switched off on it (`PUSH_CATEGORIES`). Empty = all on. */
    pushMuted: text("push_muted").array().notNull().default(sql`'{}'`),
  },
  (t) => [
    uniqueIndex("auth_devices_user_device_ux").on(t.userId, t.deviceId),
  ],
);

/**
 * ═══ MOBILE M6b — WHAT WAS SENT TO A PHONE, WITHOUT WHAT IT SAID ═══
 *
 * One row per (alert, phone) the sender finished with: `sent` (FCM accepted it) or `gone` (FCM said
 * the address is dead, and the token was cleared). It is the dedupe unit — a redelivered
 * `alert.raised` finds the row and sends nothing — the per-person rate limit's count, and the
 * record an administrator's "send a test" leaves (`alert_id` NULL). It holds a category and a
 * phone; it holds no title, no body and no token.
 */
export const phonePushSends = pgTable(
  "phone_push_sends",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    deviceRowId: text("device_row_id").notNull().references(() => authDevices.id),
    /** `alerts.id`, or NULL for an administrator's test. No FK: an alert's retention is its own. */
    alertId: text("alert_id"),
    category: text("category").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("phone_push_sends_alert_device_ux").on(t.alertId, t.deviceRowId),
    index("phone_push_sends_user_at_idx").on(t.userId, t.createdAt),
    check("phone_push_sends_outcome_ck", sql`${t.outcome} in ('sent', 'gone')`),
  ],
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
    /**
     * WASA M-05 — where the session was opened from: the client address the ONE trusted proxy hop
     * reported (`req.ip`, see `src/http-hardening.ts`) and the browser's User-Agent, bounded at
     * 512 characters. NULLABLE: every session before this column has neither, and a session opened
     * outside HTTP (a test, a script) has no client. Written by `auth-audit.ts` at the route.
     */
    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
    /** Mobile M6a — the phone this session was opened on (`auth_devices`). NULL for a browser session. */
    deviceRowId: text("device_row_id").references(() => authDevices.id),
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
    /**
     * WASA M-10 — the print destinations this agent may CLAIM (`POST /print/claim`). Empty = the
     * agent is not a print relay and the queue refuses it outright; a relay is served only the
     * intersection of what it asks for and what is listed here, so a leaked lab-bridge key or a
     * second site's relay cannot drain another printer's rendered PHI. Set at creation
     * (`AGENT_PRINT_DESTINATIONS` on `scripts/create-agent.ts`) or later with
     * `scripts/set-agent-print-destinations.ts`. The migration that added it granted every agent
     * that had ever claimed a job the destinations declared at that time — see its header.
     */
    printDestinations: text("print_destinations").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex("agents_name_ux").on(t.name), uniqueIndex("agents_key_ux").on(t.apiKeyHash)],
);

export const userTotp = pgTable("user_totp", {
  userId: text("user_id").primaryKey().references(() => users.id),
  secretSealed: text("secret_sealed").notNull(), // AES-256-GCM sealed; never plaintext at rest
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  // WASA M-02 (ASVS 2.8.4) — the RFC 6238 time-step of the last ACCEPTED code for this secret. A
  // code is accepted only for a strictly later step, so none can be spent twice. NULL until the
  // first acceptance, and reset to NULL by every (re-)enrolment: it is a fact about a secret.
  lastUsedStep: integer("last_used_step"),
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
    /**
     * THE REVIEW TRIO, AND IT EXISTS BECAUSE THE LOUD EVENT LANDED WHERE NOBODY LOOKS.
     *
     * `emergency_elevation.used` has been evented since Plan 02 and the staffing spec's mechanism
     * 6 names the act as "loudly evented + MANDATORY REVIEW". The review half was never built:
     * `break_glass_grants` carried `reviewed_at`/`reviewed_by`/`review_note` and a
     * `GET /auth/break-glass/pending` queue, and this table — the one recording a person handing
     * THEMSELVES a role — carried nothing. A self-elevation was therefore auditable only by
     * someone who already knew to go reading the event log.
     *
     * NULLABLE, AND EVERY EXISTING ROW STAYS NULL. That is the correct migration state rather
     * than a convenience: a grant taken before this column existed genuinely has not been
     * reviewed, so it belongs in the queue the day the queue appears.
     *
     * THEY LIVE ON THE WHOLE TABLE, NOT ONLY ON `kind = 'emergency'`. An admin-granted temp role
     * is a lesser act — somebody else with `auth.temp_role.grant` chose it — but the columns cost
     * nothing there, and a future ruling that wants those reviewed too needs no migration. What
     * is scoped to `emergency` is the QUEUE (`pendingElevationReviews`), not the storage.
     */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"), // actor id; no FK, matching break_glass_grants.reviewed_by
    reviewNote: text("review_note"),
  },
  (t) => [
    index("temp_role_grants_user_idx").on(t.userId),
    index("temp_role_grants_expiry_idx").on(t.expiresAt),
    // The pending-review queue's read: `kind = 'emergency' and reviewed_at is null`. Mirrors
    // `break_glass_review_idx`, widened by `kind` because this table holds both grant kinds.
    index("temp_role_grants_review_idx").on(t.kind, t.reviewedAt),
  ],
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
    kind: text("kind").notNull(), // 'login' | 'pin' | 'totp' | 'badge' (`ThrottleKind`)
    // the SUBMITTED username (login, pin), the session's user id (totp) or the user id a badge
    // CLAIMS (badge) — trimmed and lower-cased (`throttleSubject`)
    subject: text("subject").notNull(),
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
