import { sql } from "drizzle-orm";
import {
  boolean, check, index, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import type { SQL } from "drizzle-orm";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — HOW A PERSON IS REACHED, AND WHAT THEY HAVE AGREED TO
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `notifications` (Plan 10) stores WHO, WHICH template and WHEN it dies; it deliberately stores
 * no phone, no language and no channel preference, because those are contact TRUTH resolved at
 * send time. These two tables are where that truth lives for STAFF, and they follow the same
 * rule: a profile changed while a message waits is the one that gets used.
 */

/** Copied from `schema/ot.ts:153` with its warning: drizzle-kit renders a bound parameter as `$1`. */
function inList(column: SQL | unknown, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z][a-z0-9_]*$/.test(v)) {
      throw new Error(`inList: "${v}" is not a bare snake_case literal and cannot be inlined into DDL`);
    }
  }
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

/** RO-3: English is primary, Hindi next. Both templates exist before a class is switched on. */
export const REACH_LANGUAGES = ["en", "hi"] as const;
export type ReachLanguage = (typeof REACH_LANGUAGES)[number];

/**
 * The channels a staff reach ladder may climb, in the order RU-4 gives: the app first, then the
 * loud ones. `web_push` is the only one with a working adapter in phase one (RO-4); the other
 * two wait on the DLT header and the BSP templates and are a §8 follow-up.
 */
export const REACH_CHANNELS = ["web_push", "whatsapp", "sms"] as const;
export type ReachChannel = (typeof REACH_CHANNELS)[number];

export const DEFAULT_REACH_LADDER: readonly ReachChannel[] = ["web_push", "whatsapp", "sms"];

/**
 * ═══ ONE ROW PER PERSON WHO HAS AN OPINION, AND NO ROW FOR EVERYONE ELSE ═══
 *
 * A missing row is not a defect and is not backfilled: it means *the class default*, which is
 * code (`reach-defaults.ts`) rather than data. Seeding a row per user would freeze every
 * person's ladder at the moment the seed ran and make a class-wide change a data migration.
 */
export const userReachProfiles = pgTable(
  "user_reach_profiles",
  {
    userId: text("user_id").primaryKey().references(() => users.id),
    language: text("language").notNull().default("en"),
    /**
     * The ORDER the ladder climbs for this person. A text[] rather than a join table because it
     * is a short ordered list nobody queries across: the pump reads one person's ladder and
     * walks it by index, exactly as `notifications.rung` already indexes the patient ladder.
     */
    ladder: text("ladder").array().notNull().default(sql`'{web_push,whatsapp,sms}'`),
    /** R9 — the night supervisor and the CMO are woken; everybody else's budget applies. */
    quietExempt: boolean("quiet_exempt").notNull().default(false),
    /**
     * R2 — TCCCPR consent, captured at onboarding. NULL means nobody has asked yet, which is
     * different from "declined" and is why this is an instant rather than a boolean.
     */
    consentAt: timestamp("consent_at", { withTimezone: true }),
    /**
     * R1 — a ward phone is not a person. A shared number carries `seen` only: no decision, no
     * amount, no name. The flag lives on the PROFILE rather than being inferred from the number,
     * because two people can share one handset and only the roster knows it.
     */
    sharedPhone: boolean("shared_phone").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    check("user_reach_profiles_language_ck", inList(t.language, REACH_LANGUAGES)),
    /**
     * Every entry a real channel, and at least one entry. An empty ladder is a person nothing
     * can ever reach, which is a configuration mistake that looks exactly like "quiet".
     */
    check(
      "user_reach_profiles_ladder_ck",
      sql`cardinality(${t.ladder}) > 0 and ${t.ladder} <@ array['web_push','whatsapp','sms']::text[]`,
    ),
  ],
);

/**
 * ═══ ONE ROW PER BROWSER, NOT PER PERSON ═══
 *
 * A doctor has a phone, a desktop at the station and the machine in the OT corridor, and a push
 * that reaches only one of them reaches nobody. The pump sends to EVERY live subscription a
 * person holds; a 410 Gone from the push service revokes that one row and leaves the others.
 *
 * `endpoint` is UNIQUE across the table rather than per user: the browser mints it, two people
 * signing into one machine produce two different endpoints, and the same endpoint arriving for
 * a second user means the first has signed out of that browser.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    endpoint: text("endpoint").notNull(),
    /** The browser's public key and auth secret. Opaque to us; handed to the push library. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the push service answers 410 Gone. Revoked rows are kept: they are the record. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_ux").on(t.endpoint),
    /** The pump's own query: every live subscription of one person. */
    index("push_subscriptions_user_live_idx").on(t.userId, t.revokedAt),
  ],
);
