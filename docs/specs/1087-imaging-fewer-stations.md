---
issue: 1087
status: built
approved: 2026-11-14
---
# SPEC — Imaging: fewer stations per seat (#1087)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM8 of the imaging programme #1075. Rulings: 0098.

## What

- Thirteen stations in the switch. The worklist duplicates the desk queue, the room list and the reading list. Diary is the desk's second view; portable is already linked from Rooms; the hall display is a television.

## Decisions

- **Worklist** leaves the menu and the switch. Its address sends each person to their own list: the desk for a scheduler, Rooms for a radiographer, Reading for a reporter.
- The override requests it carried move to the reading room as an "Override asks" entry with grant and refuse, using the existing decide route. The "Form F missing" link at the console points to the ultrasound station.
- **Diary** becomes a header view of the Desk; **Portable** a header view of Rooms. Their old addresses still work.
- **Hall display** leaves the switch. It keeps its menu entry (the kiosk role needs a door) and the Desk gets an "Open hall display" link.
- The two legacy study and report addresses open the same study in Rooms or Reading.
- Result: reception works Desk and Hand-over; a radiographer or nurse Prep and Rooms; a radiologist Reading.
- DECIDED: redirects rather than deletions, so printed slips, bookmarks and alert links keep working.

## Done means

- **D1** (web) The station switch for a receptionist's grants shows Desk and Hand-over, and no Worklist, Diary or Display.
- **D2** (web) The diary address renders the Desk with the diary view selected.
- **D3** (web) The portable address renders Rooms with the portable view selected.
- **D4** (web) The worklist address lands a radiographer on Rooms and a reporter on Reading.
- **D5** The manifest menu lists neither worklist, diary nor portable.
- **D6** (web) The reading room shows an override request with grant and refuse controls that call the decide route.
- **D7** (web) The legacy report address opens that study in the reading room.

## Out of scope

- any change to Setup, USG, Radiation safety or HOD.

## Build notes

- **Files.** radiology `manifest.ts` · `apps/web/src/router.tsx` (SHARED) · `radiology-station.tsx`, reception, diary, room, portable, reading, worklist, study and report screens, `room-console.tsx` · locales (SHARED) · the nav parity tests that pin the menu.
- **Migration** no. **Permissions** none. **Size** M. **Depends on** IM2, IM3, IM4, IM5 (last).
