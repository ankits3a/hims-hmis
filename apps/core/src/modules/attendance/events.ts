import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

const MODULE = "attendance";
const count = z.number().int().nonnegative();

/**
 * EVERY PAYLOAD HERE IS COUNTS, IDS AND NAMES OF THINGS — never a mobile number, never an Aadhaar
 * digit, never a hash, never a secret. `events` is append-only: what goes in stays for good.
 */

/** One per sync run that changed something. Counts only. */
export const attendanceSynced = defineEvent("attendance.sync_completed", MODULE, z.object({
  punches: count, days: count, onDuty: count, staff: count, leaves: count, roster: count, holidays: count, shifts: count, linked: count,
}));

/** bioattend refused the key (401) or where we call from (403). At most one an hour — somebody must be told. */
export const attendanceSyncRefused = defineEvent("attendance.sync_refused", MODULE, z.object({
  status: z.number().int(),
  outcome: z.string().min(1),
}));

/** A machine-list person became an HMIS login's attendance record. */
export const attendancePersonLinked = defineEvent("attendance.person_linked", MODULE, z.object({
  pin: z.string().min(1),
  userId: z.string().min(1),
  source: z.enum(["mobile", "aadhaar"]),
}));

/** An administrator set or removed a person's Aadhaar or mobile on the Users screen. WHICH, never WHAT. */
export const userIdentityChanged = defineEvent("attendance.user_identity_changed", MODULE, z.object({
  userId: z.string().min(1),
  username: z.string().min(1),
  field: z.enum(["aadhaar", "mobile"]),
  change: z.enum(["set", "removed"]),
}));

/** Somebody read OTHER people's attendance (the committee's list, a person's days, a team). Counts only. */
export const attendanceRead = defineEvent("attendance.read", MODULE, z.object({
  view: z.enum(["today", "person", "team_today", "team"]),
  scope: z.enum(["all", "team"]),
  subjectPin: z.string().min(1).nullable(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  people: count,
  rows: count,
}));

/**
 * A person asked to meet the attendance manager about one of their own "Confirm" days, and what
 * became of it. The reason is a fixed code; the free-text notes stay in the row and out of the event.
 */
const requestPayload = z.object({
  requestId: z.string().min(1),
  userId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reasonCode: z.string().min(1),
});
export const meetingRequested = defineEvent("attendance.meeting_requested", MODULE, requestPayload.extend({ notified: count }));
export const meetingRequestSeen = defineEvent("attendance.meeting_request_seen", MODULE, requestPayload);
export const meetingRequestClosed = defineEvent("attendance.meeting_request_closed", MODULE, requestPayload.extend({
  how: z.enum(["closed", "resolved_by_correction"]),
}));

export const ATTENDANCE_EVENTS = [attendanceSynced, attendanceSyncRefused, attendancePersonLinked, userIdentityChanged, attendanceRead, meetingRequested, meetingRequestSeen, meetingRequestClosed] as const;
