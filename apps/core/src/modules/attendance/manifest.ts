import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * STAFF ATTENDANCE (owner 2026-10-09) — HMIS's copy of the attendance system ("bioattend").
 *
 * ONE permission. `attendance.all.read` is everyone's attendance, including the machine-listed
 * people who have no HMIS login: the owner's, and the Attendance Committee's (`attendance_committee`).
 *
 * There is deliberately NO `attendance.team.read` and no permission for one's own: a team is
 * COMPUTED from the caller (`teamOf` — unit heads and in-charges, their own people only), and every
 * signed-in person may read their own linked attendance. Neither can be granted to the wrong person
 * because neither is a grant.
 *
 * No menu (the screens are a later task), no subscription. Installed in the API only: the worker
 * runs the job (`syncAttendance`) and needs no permission to do it — the `roster` shape.
 */
export const ATTENDANCE_ALL_READ = "attendance.all.read";
/** The role a meeting request is sent to (`scripts/seed-roles.ts`). The owner assigns its members; no username is known here. */
export const ATTENDANCE_COMMITTEE_ROLE = "attendance_committee";

export const attendanceManifest: ModuleManifest = {
  key: "attendance",
  title: "Staff Attendance",
  menu: [],
  permissions: [ATTENDANCE_ALL_READ],
  subscriptions: [],
};
