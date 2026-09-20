import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { roles, users } from "./auth";
import { resources } from "./resources";

/**
 * PLAN 20 T1 — THE ROSTER: who is MEANT to be on, as windows of time, behind a publication gate.
 *
 * ═══ WHY IT IS ITS OWN SCHEMA FILE AND ITS OWN MODULE (D1) ═══
 *
 * Radiology's on-call radiologist, the lab's critical ladder, the mini-OT's anaesthetist, the duty
 * manager and — in a teaching hospital — every clinical unit's residents owe rows to the same two
 * tables. A roster owned by whichever department shipped first becomes that department's by
 * accident; this is 18c's argument for `aerb`, applied again. It reads `auth.users`, `auth.roles`
 * and `resources` and nothing of any department's.
 *
 * ═══ A SHIFT IS A WINDOW, NOT A DAY (D7) ═══
 *
 * A night duty runs 20:00 → 08:00 and an admitting unit's take runs 08:00 → 08:00; both cross IST
 * midnight, and every date defect this repository has shipped has been a day-boundary defect. So
 * there is NO `date` column in this file. Everything is `[starts_at, ends_at)` in instants, and the
 * resolver (T2) takes an instant and never asks what day it is. An assignment belongs to the period
 * its START falls in; its end may run past the period's end (31 October's night ends in November).
 *
 * ═══ DRAFT UNTIL PUBLISHED; A RE-PUBLISH IS A NEW VERSION (D3) ═══
 *
 * `ot_lists` is the precedent (C2) and the tariff versions before it: a half-entered roster that
 * silently started answering "who is on call" is worse than no roster. Only a PUBLISHED period's
 * assignments are `effective`, and only effective rows are ever read by a resolver. Publishing v2
 * supersedes v1 in the same transaction — there is no instant at which both, or neither, answer.
 *
 * ═══ `effective` IS DENORMALISED ON PURPOSE ═══
 *
 * "Is this row live?" is a fact about the row's PERIOD. It is copied onto the assignment because
 * the one invariant that must be unrepresentable — ONE PERSON PHYSICALLY IN TWO PLACES — is an
 * EXCLUDE constraint, and a constraint cannot look through a foreign key. Two drafts of October
 * legitimately hold the same person in the same slot; only live rows may not collide. `publishPeriod`
 * is the single writer of this column, inside the transaction that flips the period's status.
 *
 * ═══ PRESENCE AND CALL ═══
 *
 * A consultant on 24-hour call who also sits in OPD is not double-booked; that is what on-call
 * MEANS. `presence` = physically at a station; `call` = reachable. Only presence × presence is a
 * clash, so the exclusion constraint is partial on `mode = 'presence'`.
 *
 * ═══ THE COLUMNS THAT LOOK EARLY ═══
 *
 * `unit_id`, `location_resource_id`, `kind`, `batch_ref`, `topic`, `swap_of_id`, `source` are
 * nullable and unused by T1–T7. They are here because phase 20-U (the unit system of a teaching
 * hospital; owner rulings RU-1, RU-2 of 2026-09-20) needs them and a nullable column on an empty
 * table costs nothing, while a retrofit onto a live kernel-adjacent table is a migration plus a
 * census change in every lane (the `resources.site_id` argument, DD3). `unit_id` is plain text:
 * `clinical_units` does not exist until 20-U U1, and gains its FK there.
 *
 * ═══ THE EXCLUSION CONSTRAINT IS HAND-WRITTEN SQL ═══
 *
 * drizzle-kit does not model `EXCLUDE`. `roster_assignments_no_double_presence_excl` is appended to
 * the generated migration by hand (it needs `btree_gist` for text equality under gist, created in
 * the same file — `pg_trgm` and `unaccent` in 0021 are the precedent for an extension in a
 * migration). It is therefore invisible to the snapshot: a later `generate` neither recreates nor
 * drops it, and `roster.test.ts` is what proves it exists.
 */

export const ROSTER_PERIOD_STATUSES = ["draft", "published", "superseded"] as const;
export type RosterPeriodStatus = (typeof ROSTER_PERIOD_STATUSES)[number];

/** What a period's roster covers. `hospital` carries no `scope_id`; the others must. */
export const ROSTER_SCOPE_TYPES = ["hospital", "department", "unit", "role_family"] as const;
export type RosterScopeType = (typeof ROSTER_SCOPE_TYPES)[number];

export const ROSTER_ASSIGNMENT_MODES = ["presence", "call"] as const;
export type RosterAssignmentMode = (typeof ROSTER_ASSIGNMENT_MODES)[number];

export const ROSTER_ASSIGNMENT_KINDS = ["duty", "teaching"] as const;
export type RosterAssignmentKind = (typeof ROSTER_ASSIGNMENT_KINDS)[number];

export const ROSTER_ASSIGNMENT_SOURCES = ["manual", "import", "proposer", "academic"] as const;
export type RosterAssignmentSource = (typeof ROSTER_ASSIGNMENT_SOURCES)[number];

const auditColumns = {
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const rosterPeriods = pgTable(
  "roster_periods",
  {
    id: text("id").primaryKey(),
    scopeType: text("scope_type").notNull(),
    /** Opaque until the org masters exist — `role_assignments.scope_id`'s posture, same reason. */
    scopeId: text("scope_id"),
    title: text("title").notNull(), // "October 2026 — Orthopaedics Unit II": what a human calls it
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(), // exclusive
    /** Monotonic per (scope, starts_at) — a re-publish is a NEW version, never an edit. */
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByPeriodId: text("superseded_by_period_id").references((): AnyPgColumn => rosterPeriods.id),
    siteId: text("site_id").notNull().default("main"), // `events.site_id` / `resources.site_id`, DD3
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("roster_periods_scope_start_version_ux")
      .on(t.siteId, t.scopeType, sql`coalesce(${t.scopeId}, '')`, t.startsAt, t.version),
    /** At most ONE published roster answers for a scope and a start. The supersede is what keeps it so. */
    uniqueIndex("roster_periods_one_published_ux")
      .on(t.siteId, t.scopeType, sql`coalesce(${t.scopeId}, '')`, t.startsAt)
      .where(sql`${t.status} = 'published'`),
    index("roster_periods_status_window_idx").on(t.status, t.startsAt, t.endsAt),
    check("roster_periods_status_ck", sql`${t.status} in ('draft', 'published', 'superseded')`),
    check("roster_periods_scope_type_ck", sql`${t.scopeType} in ('hospital', 'department', 'unit', 'role_family')`),
    check("roster_periods_scope_id_ck", sql`(${t.scopeType} = 'hospital') = (${t.scopeId} is null)`),
    check("roster_periods_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("roster_periods_version_ck", sql`${t.version} >= 1`),
    /** The publication pair: both, or neither — and published/superseded rows always carry them. */
    check(
      "roster_periods_published_ck",
      sql`(${t.status} = 'draft') = (${t.publishedAt} is null) and (${t.publishedAt} is null) = (${t.publishedBy} is null)`,
    ),
    check("roster_periods_superseded_ck", sql`(${t.status} = 'superseded') = (${t.supersededAt} is not null)`),
  ],
);

export const rosterAssignments = pgTable(
  "roster_assignments",
  {
    id: text("id").primaryKey(),
    periodId: text("period_id").notNull().references(() => rosterPeriods.id),
    userId: text("user_id").notNull().references(() => users.id),
    /** The role this person answers AS in the window — what `whoIsOn(roleKey, at)` keys on (T2). */
    roleKey: text("role_key").notNull().references(() => roles.key),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(), // exclusive
    mode: text("mode").notNull().default("presence"),
    kind: text("kind").notNull().default("duty"),
    /** 20-U: the clinical unit this duty is done FOR. Plain text until `clinical_units` exists (U1). */
    unitId: text("unit_id"),
    /** Where the person is to be found: the OPD room, the ward, the theatre — or, on call, the duty room. */
    locationResourceId: text("location_resource_id").references(() => resources.id),
    /** 20-U D8 — a teaching commitment's batch and topic; the academic module's to own later. */
    batchRef: text("batch_ref"),
    topic: text("topic"),
    /** 20-U U6 — the assignment this one replaced, when it came from a swap or a cover. */
    swapOfId: text("swap_of_id").references((): AnyPgColumn => rosterAssignments.id),
    source: text("source").notNull().default("manual"),
    note: text("note"),
    /** See the header: true exactly while this row's period is PUBLISHED. One writer: `publishPeriod`. */
    effective: boolean("effective").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("roster_assignments_period_idx").on(t.periodId),
    index("roster_assignments_user_window_idx").on(t.userId, t.startsAt, t.endsAt),
    /** The resolver's read (T2): "who holds this role at this instant" — live rows only. */
    index("roster_assignments_role_window_idx").on(t.roleKey, t.startsAt, t.endsAt).where(sql`${t.effective}`),
    check("roster_assignments_window_ck", sql`${t.endsAt} > ${t.startsAt}`),
    check("roster_assignments_mode_ck", sql`${t.mode} in ('presence', 'call')`),
    check("roster_assignments_kind_ck", sql`${t.kind} in ('duty', 'teaching')`),
    check("roster_assignments_source_ck", sql`${t.source} in ('manual', 'import', 'proposer', 'academic')`),
  ],
);
