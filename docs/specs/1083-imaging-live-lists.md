---
issue: 1083
status: built
approved: 2026-11-14
---
# SPEC — Imaging lists update live over the realtime gateway (#1083)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM6a of the imaging programme #1075. Rulings: 0098.

## What

- Every radiology list polls at 30–60 s; a STAT order can sit that long unseen. The gateway exists and radiology is not on it.

## Decisions

- `radiology/realtime.ts` declares topic spaces and a router, registered in `radiology.module.ts` as lab does.
- Topics: `imaging:floor` (new imaging order, booking, booking change, gate result, acquisition), `imaging:read` (acquisition, release, critical flagged or acknowledged, reading claimed), `imaging:release` (release, hand-over, media request). Each space is gated by the grant its screen already needs.
- Desk, prep, rooms, reading and hand-over refetch on a frame. Polling stays at 60 s as the fallback, as the gateway's own header requires.

## Done means

- **D1** The router maps an acquisition event to `imaging:floor` and `imaging:read`, and a lab event to nothing.
- **D2** A user without `radiology.worklist.read` cannot subscribe to `imaging:floor`.
- **D3** An imaging `order.placed` maps to `imaging:floor`; a lab one does not.
- **D4** (web) The room list refetches when a frame arrives on its topic.

## Out of scope

- phone push (alerts already do it); the hall display.

## Build notes

- **Files.** radiology `realtime.ts` (new), `radiology.module.ts`, `index.ts` · web reception, prep, room, reading, reports screens (one hook each).
- **Migration** no. **Permissions** none. **Size** S. **Depends on** IM1; easiest after IM2 and IM3 merge (same screens).

## As built (2026-11-14)

- One topic space, `imaging`, on `radiology.worklist.read`. The gateway reads a topic's space from the text before its first colon, so `imaging:floor`, `imaging:read` and `imaging:release` share that one grant. Every seeded role that works one of the five screens holds it, and frames carry ids and codes only. Giving the reading room and the hand-over desk their own grant needs a change to the kernel gateway; it is not in this slice.
- Routed: an imaging `order.placed`, `imaging.study_scheduled`, `imaging.booking_changed`, `imaging.gate_evaluated` to the floor; `imaging.study_acquired` to the floor and reading; `imaging.report_published` to reading and hand-over; `imaging.critical_flagged`, `imaging.critical_acknowledged` and `imaging.image_viewed` (opening the images is the reading claim) to reading; `imaging.report_handed_over` and `imaging.media_requested` to hand-over.
- The worker creates the study a moment after `order.placed`, so a screen reads its list on that frame and once more 4 s later.
- A frame refetches only the screen's list queries (exact keys), never the study in hand. Polls are unchanged (prep, rooms, hand-over 30 s; reading 60 s); the desk, which had none, now polls every 60 s.
