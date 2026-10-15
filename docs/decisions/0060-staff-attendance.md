---
type: decision
id: "0060"
title: "Staff attendance comes from the bioattend machine; a person's own screens show words, not times; three audiences read it; it ships switched off"
description: "The owner ruled how HMIS copies the attendance machine's records (bioattend), what each person and each manager sees, how people are matched, and that the sync stays off until ATTENDANCE_SYNC_ENABLED=true."
generated: { by: agent:claude, at: 2026-10-09 }
verified: []
status: stable
ruling: ruled
tags: [attendance, staff, mobile, privacy, users]
supersedes: []
superseded_by: []
sources: []
---
# 0060 — Staff attendance from the attendance machine

- **Date:** 2026-10-09   **Status:** Ruled
- **Area:** attendance, staff app, users

## What is ruled (owner, 2026-10-09)

1. **Words only on a person's own screens** — Present, Absent, Off, Partial, Leave. No punch times
   on a person's own day, week or month.
2. **Late is Present.** Coming late does not change the word.
3. **The day's rules do not apply** to the owner, admin, the medical superintendent, unit heads or
   the attendance committee.
4. **A forgotten evening punch** (one punch on a past day) shows **"Confirm"**, and the person may
   send a request-meeting to the attendance committee.
5. **Matching a person** to the machine is by **mobile number or Aadhaar only**.
6. **The plain Aadhaar number is never stored** — not in a column, event, log line or error; only
   the machine's keyed hash is compared.
7. **Who sees what:** the owner, the attendance committee and the medical superintendent see
   everyone; unit heads and in-charges see their own team; each staff member sees their own day,
   week and month.
8. **No second API client for staging.** Only production talks to the machine.
9. **Ships switched off**: no call is made until `ATTENDANCE_SYNC_ENABLED=true` (and the key file
   is present).

## How it is enforced

- One worker job, `syncAttendance` (every 120 s), beats but makes no call while off
  (`modules/attendance/sync.ts`); the signed webhook `POST /api/webhooks/bioattend` is the push path.
- Read routes `/attendance/*` answer by permission: `attendance.all.read` (owner, MS, committee),
  team reads for a unit head / in-charge, `/attendance/me` for oneself. No read route returns a
  mobile number or an Aadhaar hash.
- Meeting requests go to holders of the `attendance_committee` role.

## Decided while building (DECIDED — the owner may change any of these)

- Times on one's own screens can be turned on only with `ATTENDANCE_SELF_SHOWS_TIMES=true` (off by
  default, per ruling 1).
- Today reads "Not checked in / Checked in / Checked out" by punch count, before the day closes.
- Aadhaar is tried first, then a mobile number that matches exactly one active machine record.
