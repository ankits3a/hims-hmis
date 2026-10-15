---
type: decision
id: "0062"
title: "The staff app can mark attendance with a one-time location check; an app mark is evidence for the committee and never changes the day's word"
description: "The owner approved a 'Mark attendance' button in the staff app as a backup to the bioattend machine: one foreground location reading per tap, checked against a 200 m circle round the campus centre, stored as a word and metres with no coordinates, and shown beside the machine's record without changing it (Option B)."
generated: { by: agent:claude, at: 2026-10-10 }
verified: []
status: stable
ruling: ruled
tags: [attendance, staff, mobile, privacy, location, money]
supersedes: []
superseded_by: []
sources: []
---
# 0062 — Attendance location check (a backup to the machine)

- **Date:** 2026-10-10   **Status:** Ruled
- **Area:** attendance, staff app

## What is ruled (owner, 2026-10-10)

1. **"Mark attendance"** on the staff app's attendance screen: In, or Out after an In that day.
2. **One reading, foreground only.** The tap asks location permission the first time and reads the
   position once. Never background location.
3. **Centre 25.6892879, 85.2301486; radius 200 m** (the owner changed it from 300 m). Both are
   server settings, changeable with no app build.
4. **Stored:** the time, In/Out, one of *inside premises* / *outside premises* / *location not
   shared* / *location doubtful*, and the distance in whole metres. **Exact coordinates are never
   stored** — no column, event, log line or error.
5. Outside the radius: saved and flagged "outside premises". Permission refused (or no reading):
   saved as "location not shared". Android's mocked reading: saved as "location doubtful".
6. **Option B (a money ruling — attendance drives salary).** The machine stays the main record. An
   app mark lives in its own table, is never sent to bioattend, never overwrites a machine punch and
   **never changes the day's word**. A day the machine calls Absent stays Absent; the Attendance
   Committee sees the app mark as evidence and decides.
7. **Who sees what** follows decision 0060: staff see their own mark as words ("Marked in · inside
   premises"); the owner, the Medical Superintendent and the Attendance Committee see every mark with
   its flag beside the machine's record; unit heads and in-charges see their team's.
8. **Permission sentence**, iPhone and Android: "HMIS checks your location once when you mark
   attendance, to confirm you are on hospital premises." iPhone: `NSLocationWhenInUseUsageDescription`
   only.

## How it is enforced

- `POST /attendance/me/marks` (`modules/attendance/attendance.controller.ts`) takes the reading or
  null; `placeOf` (`modules/attendance/marks.ts`) reduces it to a place and metres before anything is
  written. Table `att_app_marks` has no coordinate column; event `attendance.app_marked` carries the
  place and metres only. A refused body answers `bad_body` and never echoes what it held.
- Settings `ATTENDANCE_SITE_LAT`, `ATTENDANCE_SITE_LNG`, `ATTENDANCE_SITE_RADIUS_M`
  (`kernel/config.ts`), defaulting to the owner's values.
- Read routes add `marks` / `appMark`: words on the self routes, time + place + metres on the
  committee and team routes. Nothing in `att_punches` or `att_days` is touched.
- The phone (`apps/mobile/src/attendance/location.ts`) calls only foreground permission and
  `getCurrentPositionAsync`; `app.config.ts` removes the plugin's Always/motion keys on the iPhone and
  blocks `ACCESS_BACKGROUND_LOCATION` and `FOREGROUND_SERVICE_LOCATION` on Android
  (`__tests__/location-config.test.ts` runs the plugins and reads the result).
- Tests: `marks.test.ts` (200 m inside, 201 m outside), `test/attendance-marks.e2e.test.ts` (every
  done-means check that a server can prove), `apps/mobile/__tests__/attendance-mark.test.tsx`.

## Decided while building (DECIDED — the owner may change any of these)

- **A mark needs a linked person.** A login with no machine record gets `not_linked` (409) and the app
  shows no button: there is nothing for the mark to stand beside.
- **At most six marks a person a day**, then 429.
- **A second tap within a minute returns the first mark**, so a double tap is not an Out.
- **Inside means the distance, rounded to whole metres, is at most the radius** (200 m inside, 201 m
  outside). GPS accuracy is not stored or used.
- The button shows only while the period on screen includes today. Managers see the newest mark of
  the day as a tag on the Today and My team lists ("App ✓", "App: outside", …).
- Android shows the owner's sentence in the app before the system prompt (Android's prompt cannot
  carry custom text); the iPhone's own prompt carries it.

## Owed outside the code

- crkmch.com/privacy-policy.html must name the location check before the iPhone build goes to
  Apple review; App Store Connect's App Privacy must add "Precise location — app functionality,
  not used for tracking" (it IS linked to the person: the mark is theirs).
- expo-location is native: it ships in a new APK and a new iPhone build (app 0.16.0), not an OTA
  update. Checked on a real iPhone (TestFlight) and an Android phone, inside and outside campus.
