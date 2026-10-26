import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { resources } from "./resources";
import { tasks } from "./tasks";
import { users } from "./auth";

/**
 * HK-1 HOUSEKEEPING (issue #973, decision 0086) — areas and their door QR, checklists, contractors and staff, the shift
 * rota, scheduled rounds, the proof of each piece of work, and door requests. Read and written only by
 * `modules/housekeeping`. No money column anywhere (contractors get reports only, 0086) and no patient column: a door
 * request collects nothing about the person asking, and a photo is of the place.
 */

/** A versioned checklist: a new version is a new row on the same lineage; the old row stays for the work it proved. */
export const hkChecklists = pgTable(
  "hk_checklists",
  {
    id: text("id").primaryKey(),
    lineageId: text("lineage_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    /** `[{ id, text }]` in order. */
    items: jsonb("items").$type<{ id: string; text: string }[]>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("hk_checklists_lineage_version_ux").on(t.lineageId, t.version),
    check("hk_checklists_version_ck", sql`${t.version} >= 1`),
  ],
);

/** A place housekeeping looks after: one per resource. `qr_version` bumps to revoke the printed QR. */
export const hkAreas = pgTable(
  "hk_areas",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id").notNull().references(() => resources.id),
    areaClass: text("area_class").notNull(),
    /** The floor the place is on (the place itself when it is a floor), resolved when the area is defined. */
    floorId: text("floor_id").references(() => resources.id),
    checklistId: text("checklist_id").references(() => hkChecklists.id),
    photoNeeded: boolean("photo_needed").notNull().default(false),
    qrVersion: integer("qr_version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("hk_areas_resource_ux").on(t.resourceId),
    index("hk_areas_floor_idx").on(t.floorId),
    check("hk_areas_class_ck", sql`${t.areaClass} in ('A', 'B', 'C_toilet', 'C_public', 'D')`),
    check("hk_areas_qr_version_ck", sql`${t.qrVersion} >= 1`),
  ],
);

/** A housekeeping contractor (decision 0086: reports only, no bill deductions). */
export const hkContractors = pgTable(
  "hk_contractors",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("hk_contractors_name_ux").on(sql`lower(${t.name})`)],
);

/** A housekeeping person: in-house (no contractor) or a named contractor's, and their trained skills. */
export const hkStaff = pgTable(
  "hk_staff",
  {
    userId: text("user_id").primaryKey().references(() => users.id),
    contractorId: text("contractor_id").references(() => hkContractors.id),
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [check("hk_staff_skills_ck", sql`${t.skills} <@ array['critical', 'spill', 'terminal']::text[]`)],
);

/** One shift's rota. A newer published rota for the same shift supersedes the older. */
export const hkRotas = pgTable(
  "hk_rotas",
  {
    id: text("id").primaryKey(),
    shiftStartsAt: timestamp("shift_starts_at", { withTimezone: true }).notNull(),
    shiftEndsAt: timestamp("shift_ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    publishedBy: text("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("hk_rotas_shift_idx").on(t.shiftStartsAt, t.status),
    check("hk_rotas_status_ck", sql`${t.status} in ('draft', 'published', 'superseded')`),
    check("hk_rotas_window_ck", sql`${t.shiftEndsAt} > ${t.shiftStartsAt}`),
    check("hk_rotas_published_ck", sql`${t.status} = 'draft' or ${t.publishedAt} is not null`),
  ],
);

/** One person's place in a rota: a whole floor, a route of areas, or a section of beds. */
export const hkRotaPlaces = pgTable(
  "hk_rota_places",
  {
    rotaId: text("rota_id").notNull().references(() => hkRotas.id),
    userId: text("user_id").notNull().references(() => users.id),
    mode: text("mode").notNull(),
    floorId: text("floor_id").references(() => resources.id),
    areaIds: text("area_ids").array().notNull().default(sql`'{}'::text[]`),
    bedIds: text("bed_ids").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.rotaId, t.userId] }),
    check("hk_rota_places_mode_ck", sql`${t.mode} in ('floor', 'route', 'beds')`),
    check("hk_rota_places_shape_ck", sql`(${t.mode} = 'floor') = (${t.floorId} is not null)`),
  ],
);

/** A scheduled round of an area: one per area and slot; its task does the work. */
export const hkRounds = pgTable(
  "hk_rounds",
  {
    id: text("id").primaryKey(),
    areaId: text("area_id").notNull().references(() => hkAreas.id),
    slotStart: timestamp("slot_start", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    taskId: text("task_id").notNull().references(() => tasks.id),
    status: text("status").notNull().default("due"),
    missedAt: timestamp("missed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("hk_rounds_area_slot_ux").on(t.areaId, t.slotStart),
    uniqueIndex("hk_rounds_task_ux").on(t.taskId),
    index("hk_rounds_due_idx").on(t.dueAt).where(sql`${t.status} = 'due'`),
    index("hk_rounds_missed_idx").on(t.missedAt).where(sql`${t.status} = 'missed'`),
    check("hk_rounds_status_ck", sql`${t.status} in ('due', 'done', 'missed')`),
    check("hk_rounds_missed_ck", sql`${t.status} = 'done' or ((${t.status} = 'missed') = (${t.missedAt} is not null))`),
  ],
);

/**
 * The proof of one attempt at a task: the QR scanned, every checklist answer, the photo, and the company the person
 * worked for at that moment (a snapshot: a later change of contractor does not rewrite the record). Append-only in
 * practice: a failed check reopens the task and the rework is a new attempt.
 */
export const hkWork = pgTable(
  "hk_work",
  {
    taskId: text("task_id").notNull().references(() => tasks.id),
    attempt: integer("attempt").notNull(),
    doneBy: text("done_by").notNull(),
    company: text("company").notNull(),
    contractorId: text("contractor_id").references(() => hkContractors.id),
    scanAreaId: text("scan_area_id").notNull().references(() => hkAreas.id),
    qrVersion: integer("qr_version").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    checklistId: text("checklist_id").references(() => hkChecklists.id),
    answers: jsonb("answers").$type<{ itemId: string; ok: boolean }[]>().notNull(),
    photoKey: text("photo_key"),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.attempt] }),
    check("hk_work_attempt_ck", sql`${t.attempt} >= 1`),
  ],
);

/** A request raised from a door QR without a login. No patient detail; the address only as a keyed hash. */
export const hkDoorRequests = pgTable(
  "hk_door_requests",
  {
    id: text("id").primaryKey(),
    areaId: text("area_id").notNull().references(() => hkAreas.id),
    need: text("need").notNull(),
    taskId: text("task_id").notNull().references(() => tasks.id),
    addressHash: text("address_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("hk_door_requests_area_idx").on(t.areaId, t.createdAt),
    check("hk_door_requests_need_ck", sql`${t.need} in ('clean', 'toilet', 'spill', 'bin')`),
  ],
);
