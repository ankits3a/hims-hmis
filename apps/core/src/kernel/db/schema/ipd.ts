import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { resources } from "./resources";

/**
 * E1.1 (#718) — IPD's bed facts that are not the bed itself (spec SPEC-ipd-core §4.1).
 *
 * WHY TABLES AND NOT `resources.attributes`: the kernel's bed vocabulary has no `reserved` or "block on release"
 * status, and adding one is a kernel edit. A reservation and a block are each a thing with its own life — who,
 * until when, ended how — that the 2-hour lapse job, the board and the goal queries read, and that two desks race
 * for. A partial unique index per table makes "one live reservation per bed" and "one live block per bed" a
 * database fact, not a read-then-write hope. The bed's kernel status stays `available` while reserved; the board
 * overlays `reserved` from here.
 *
 * `bed_id` references the kernel `resources` row. `admission_id` and `patient_id` are plain text: the admission
 * table arrives with ipd-admit, and `patients` is another module's table.
 */
export const ipdBedReservations = pgTable(
  "ipd_bed_reservations",
  {
    id: text("id").primaryKey(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    admissionId: text("admission_id").notNull(),
    patientId: text("patient_id").notNull(),
    /** active → released (a person) | lapsed (the 2-hour job) | consumed (the patient was put on the bed). */
    status: text("status").notNull(),
    reservedBy: text("reserved_by").notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
  },
  (t) => [
    uniqueIndex("ipd_bed_reservations_live_bed_ux").on(t.bedId).where(sql`${t.status} = 'active'`),
    index("ipd_bed_reservations_due_idx").on(t.expiresAt).where(sql`${t.status} = 'active'`),
    index("ipd_bed_reservations_admission_idx").on(t.admissionId),
    check("ipd_bed_reservations_status_ck", sql`${t.status} in ('active', 'released', 'lapsed', 'consumed')`),
  ],
);

export const ipdBedBlocks = pgTable(
  "ipd_bed_blocks",
  {
    id: text("id").primaryKey(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    /** pending_release (asked on an occupied bed) → active (bed blocked) → ended | cancelled. */
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    note: text("note").notNull(),
    expectedReturnAt: timestamp("expected_return_at", { withTimezone: true }).notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endNote: text("end_note"),
  },
  (t) => [
    uniqueIndex("ipd_bed_blocks_live_bed_ux").on(t.bedId).where(sql`${t.status} in ('pending_release', 'active')`),
    check("ipd_bed_blocks_status_ck", sql`${t.status} in ('pending_release', 'active', 'ended', 'cancelled')`),
    check(
      "ipd_bed_blocks_reason_ck",
      sql`${t.reason} in ('maintenance', 'infection_control', 'deep_clean', 'staff_shortage', 'other')`,
    ),
  ],
);

/**
 * One row per patient per bed: who lies on the bed, for which admission, billed at which class. The kernel bed row
 * holds the occupancy triad (`occupant_type` `ipd_admission`, `occupant_ref` the admission id); this row holds what
 * the kernel does not know — the patient (room gender, board initials) and the billed class with its 48-hour
 * protection (§4.2), which ipd-charges reads night by night. Ended when the bed is released or the patient moves.
 */
export const ipdBedStays = pgTable(
  "ipd_bed_stays",
  {
    id: text("id").primaryKey(),
    bedId: text("bed_id").notNull().references(() => resources.id),
    admissionId: text("admission_id").notNull(),
    patientId: text("patient_id").notNull(),
    bedClass: text("bed_class").notNull(),
    billedClass: text("billed_class").notNull(),
    protectedUntil: timestamp("protected_until", { withTimezone: true }),
    classChange: text("class_change"),
    startedBy: text("started_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedBy: text("ended_by"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ipd_bed_stays_open_bed_ux").on(t.bedId).where(sql`${t.endedAt} is null`),
    uniqueIndex("ipd_bed_stays_open_admission_ux").on(t.admissionId).where(sql`${t.endedAt} is null`),
    index("ipd_bed_stays_patient_idx").on(t.patientId),
    check("ipd_bed_stays_class_change_ck", sql`${t.classChange} is null or ${t.classChange} in ('upgrade', 'downgrade')`),
  ],
);
