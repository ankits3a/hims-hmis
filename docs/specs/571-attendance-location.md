---
issue: 571
status: built
approved: 2026-10-10
---
# SPEC — attendance location check (backup to the bioattend machine)

**Status:** APPROVED by the owner 2026-10-10 ("Go with option B. rest recommendations are good"). Not built.
**Module:** attendance (core) + staff app (apps/mobile). Own lane, e.g. `tools/lane.sh new attendance-location`.
**Decision record owed:** next free number in docs/decisions/ (0061 at the time of writing; check at merge).

## Owner's answers
- Centre: [hospital location, kept out of the repo]. Radius: [set by the owner, kept out of the repo].
- Machine has no punch but the app says "inside premises": **Option B**. The day stays Absent / Confirm. The
  committee sees the app mark as evidence and decides. An app mark never changes a day's word on its own.
  (This is a money ruling: attendance drives salary.)

## Spec
1. Attendance screen in the staff app gets a **"Mark attendance"** button: In, or Out if already marked In that day.
2. On the tap, the app asks location permission (first time only) and reads the position once, foreground only.
   Never background location.
3. The server compares the position to the centre and radius. Both are server settings, changeable without an app build.
4. The server stores the time, In/Out, one of inside / outside / location not shared / location doubtful, and the
   distance in metres. **Exact coordinates are never stored** (no column, event, log line or error).
5. Outside the radius: saved, flagged "outside premises". Permission refused: saved as "location not shared".
6. Android mock location (`mocked` on the reading): saved, flagged "location doubtful".
7. The machine stays the main record. App marks live in their own table, are never sent to bioattend, never
   overwrite a machine punch, and never change the day's word (Option B). Note MAP.md's invariant "nothing in
   att_* is typed by a person except a meeting request" must be updated.
8. Who sees what follows decision 0060: staff see their own mark as words ("Marked in · inside premises"); owner,
   MS and attendance committee see every mark with its flag beside the machine punches; unit heads and
   in-charges see their team.
9. Permission sentence, iPhone and Android: "HMIS checks your location once when you mark attendance, to confirm
   you are on hospital premises." iPhone: NSLocationWhenInUseUsageDescription only.
10. A numbered decision record with these points.

## Done means
- Inside the radius saves "inside"; one metre beyond it saves "outside"; refused permission saves "location not shared".
- No column, log line or event holds a latitude or longitude.
- No background-location permission on either platform; the iPhone asks only "while using the app".
- A machine punch and an app mark on the same day both show, and neither changes the other or the day's word.
- Unit heads see their team's marks; staff see only their own.
- Checked on a real iPhone (TestFlight) and an Android phone, inside and outside the campus.

## Traps known now
- `apps/mobile/__tests__/ios-config.test.ts` line ~64 pins that the iPhone build never names `NSLocation` or
  `expo-location`. The new feature must change that pin to allow exactly WhenInUse and still forbid Always/background.
- expo-location is a native module: it needs a new APK and a new iPhone build; an OTA update cannot carry it.
- Privacy policy ([the hospital's public privacy-policy page]) needs the location line before the iPhone build goes to Apple
  review; App Privacy answers in App Store Connect must add "Precise location — app functionality, not linked to tracking".
- The ios-setup lane (PR #557, draft) is not merged yet; build this on top of main, and coordinate the
  ios-config test if both touch it.
