import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, date, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * ═══ STAFF ATTENDANCE — HMIS'S COPY OF WHAT THE ATTENDANCE SYSTEM ("bioattend") SAYS ═══
 *
 * Owner, 2026-10-09: staff see their own attendance, the owner and the Attendance Committee see
 * everyone's, unit heads and in-charges their own team's. These tables are a COPY, written by one
 * job (`syncAttendance`) and one webhook, and read by `modules/attendance`. Nothing here is typed by
 * a person and nothing here is invented: each column is a field of the bioattend API guide
 * (2026-10-09), under the guide's own name.
 *
 * ALL DATES AND TIMES ARE IST WALL-CLOCK, AS BIOATTEND SENDS THEM. A date is a `date` read as a
 * string; a time of day or a punch instant is TEXT (`08:58`, `2026-10-09 08:58:12`). None of them is
 * ever a JS `Date`, so none can slide a day across midnight UTC. The only `timestamptz` columns are
 * HMIS's own clock: when a row was received or last changed.
 *
 * `pin` is bioattend's staff id and the key that joins every table. It is deliberately NOT a foreign
 * key between them: a punch can arrive by webhook before the half-hourly staff read has seen the person.
 */
export const attStaff = pgTable(
  "att_staff",
  {
    pin: text("pin").primaryKey(),
    name: text("name").notNull(),
    dept: text("dept"),
    post: text("post"),
    gender: text("gender"),
    /** As bioattend holds it. Personal data: used for linking, returned by NO read route. */
    mobile: text("mobile"),
    status: text("status").notNull(),
    joiningDate: date("joining_date", { mode: "string" }),
    dateOfLeaving: date("date_of_leaving", { mode: "string" }),
    workDays: text("work_days"),
    /** bioattend's keyed hash of the person's Aadhaar, or null. Returned by NO read route. */
    aadhaarHash: text("aadhaar_hash"),
    /** The HMIS login this person is — 1:1, set by `linkPeople` and never re-pointed by it. */
    userId: text("user_id").references(() => users.id),
    linkSource: text("link_source"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    /** Why this person could not be linked automatically (a name from `LINK_PROBLEMS`), or null. */
    needsAttention: text("needs_attention"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("att_staff_user_ux").on(t.userId),
    index("att_staff_aadhaar_idx").on(t.aadhaarHash),
    check("att_staff_link_source_chk", sql`${t.linkSource} is null or ${t.linkSource} in ('mobile', 'aadhaar')`),
    check("att_staff_link_pair_chk", sql`(${t.userId} is null) = (${t.linkSource} is null)`),
  ],
);

/** Raw punches, a LOG keyed by bioattend's own id: insert-or-ignore, never updated, never withdrawn. */
export const attPunches = pgTable(
  "att_punches",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    pin: text("pin").notNull(),
    /** `YYYY-MM-DD HH:MM:SS`, IST, exactly as sent. */
    ts: text("ts").notNull(),
    /** The calendar date of `ts` (its first ten characters). */
    day: date("day", { mode: "string" }).notNull(),
    direction: text("direction"),
    verify: text("verify"),
    device: text("device"),
    origin: text("origin"),
    receivedVia: text("received_via").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("att_punches_pin_day_idx").on(t.pin, t.day),
    check("att_punches_via_chk", sql`${t.receivedVia} in ('pull', 'webhook')`),
  ],
);

/** One row per person per day employed — the day-level truth. A `locked` row is final and is never overwritten. */
export const attDays = pgTable(
  "att_days",
  {
    pin: text("pin").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    firstIn: text("first_in"),
    lastOut: text("last_out"),
    hoursWorked: doublePrecision("hours_worked"),
    otMinutes: integer("ot_minutes"),
    shiftName: text("shift_name"),
    status: text("status").notNull(),
    dayType: text("day_type"),
    locked: boolean("locked").notNull().default(false),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pin, t.date] }), index("att_days_date_idx").on(t.date)],
);

export const attLeaves = pgTable(
  "att_leaves",
  {
    pin: text("pin").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    reason: text("reason"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pin, t.date] }), index("att_leaves_date_idx").on(t.date)],
);

/** `dept` null = a holiday for everyone; a department name = that department only; `cancelled` = it works that day. */
export const attHolidays = pgTable(
  "att_holidays",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    date: date("date", { mode: "string" }).notNull(),
    name: text("name").notNull(),
    dept: text("dept"),
    cancelled: boolean("cancelled").notNull().default(false),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("att_holidays_date_idx").on(t.date)],
);

export const attShifts = pgTable("att_shifts", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  dept: text("dept"),
  checkinTime: text("checkin_time"),
  checkoutTime: text("checkout_time"),
  crossesMidnight: boolean("crosses_midnight").notNull().default(false),
  graceMinutes: integer("grace_minutes"),
  kind: text("kind"),
  weeklyOffDays: text("weekly_off_days"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The planned shift or day off per person per day. `start_time`/`end_time` are the guide's `start`/`end`. */
export const attRoster = pgTable(
  "att_roster",
  {
    pin: text("pin").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    shiftName: text("shift_name"),
    startTime: text("start_time"),
    endTime: text("end_time"),
    off: boolean("off").notNull().default(false),
    holiday: text("holiday"),
    leave: boolean("leave").notNull().default(false),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.pin, t.date] }), index("att_roster_date_idx").on(t.date)],
);

/** Who bioattend says is in right now — replaced whole on every run. An estimate from punch counts (the guide says so). */
export const attOnDuty = pgTable("att_on_duty", {
  pin: text("pin").primaryKey(),
  inSince: text("in_since"),
  device: text("device"),
  asOf: text("as_of").notNull(),
});

/**
 * Where the sync stands, one row per stage (`punches`, `today`, `reference`, `months`, `refused`).
 * `cursor` is the punches stage's alone: the highest punch id the PULL has stored (the webhook never
 * moves it — its delivery starts at "now", and a cursor it advanced would skip the history between).
 * `last_error` is an outcome name and a status, never a URL with a key and never a response body.
 */
export const attSyncState = pgTable("att_sync_state", {
  stage: text("stage").primaryKey(),
  cursor: bigint("cursor", { mode: "number" }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastOutcome: text("last_outcome"),
  lastError: text("last_error"),
  /** A stage's own small memory: the IST date the nightly re-read last finished for. */
  note: text("note"),
});

/**
 * ═══ "CONFIRM" — A DAY WITH ONE PUNCH, AND THE REQUEST TO MEET ABOUT IT (owner 2026-10-09) ═══
 *
 * "Staff who forgets evening punch … day then reads a warning sign/icon 'Confirm'. Tapping confirm
 * -> shows error reason to the staff and shows request meeting button to raise a requst to meet with
 * attendance manager." One row per request a person raises about one of their OWN days. It goes to
 * the holders of the Attendance Committee role — never to a username.
 *
 * `reason_code` is a fixed key (`one_punch_only` today; the set is open for later reasons), never
 * free text. `note` and `close_note` are the only free text, each at most 200 characters.
 * `resolved_by_correction` is written by the SYNC, not a person: bioattend corrected the day.
 * At most one request per person per day is open or seen at a time (the partial unique index).
 */
export const attMeetingRequests = pgTable(
  "att_meeting_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    pin: text("pin").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    seenBy: text("seen_by").references(() => users.id),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    closedBy: text("closed_by").references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeNote: text("close_note"),
  },
  (t) => [
    uniqueIndex("att_meeting_requests_active_ux").on(t.userId, t.date).where(sql`${t.status} in ('open', 'seen')`),
    index("att_meeting_requests_status_idx").on(t.status, t.createdAt),
    index("att_meeting_requests_pin_date_idx").on(t.pin, t.date),
    check("att_meeting_requests_status_chk", sql`${t.status} in ('open', 'seen', 'closed', 'resolved_by_correction')`),
    check("att_meeting_requests_note_chk", sql`(${t.note} is null or char_length(${t.note}) <= 200) and (${t.closeNote} is null or char_length(${t.closeNote}) <= 200)`),
  ],
);
