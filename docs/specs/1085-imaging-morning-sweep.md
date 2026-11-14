---
issue: 1085
status: approved
approved: 2026-11-14
---
# SPEC — Imaging morning sweep: no-shows, reminders, HOD digest, register completeness, film/CD queue (#1085)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM6c of the imaging programme #1075. Rulings: 0098.

## What

- No-show is manual, so yesterday's empty bookings stay open. The HOD has live views but no morning summary. PCPNDT and AERB gaps are found by looking, not by a daily check. Unprinted film and CD requests have no queue of their own.

## Decisions

- Everything here rides the existing 08:00 IST radiology job. DECIDED: no new worker job (each one costs a census sweep).
- Every automated act is written by the actor `radiology-automation`, appends the act's normal event, and leaves one row in `imaging_automation_runs` (kind, day, counts). A second run for the same day does nothing.
- That actor is refused by every clinical act: gate satisfy, waive and override; sign; critical acknowledge; placing an order.
- **Switches.** `imaging_automation_settings` holds one row per automation. A holder of `radiology.definitions.manage` turns one off or on with a reason; the change appends `imaging.automation_switched`. Patient reminders start off, and stay off until the WhatsApp and SMS templates are approved (ruling 0098).
- **No-show.** A booking of yesterday that was never checked in becomes a no-show with the reason "not arrived"; its message is expired; it is listed for rebooking. On the day, the desk's Clocks show a booking 30 minutes past its slot with a one-tap no-show (the desk's own act).
- **Reminders** (when switched on): one message the day before a slot booked two or more days ahead; one when a follow-up comes due. Generic words, never the study or the finding, as the existing templates rule.
- **Digest.** One row per day and a bell to the department head: studies and turnaround by modality, repeat rate, doses above the reference level without a reason, reports unread over 24 h, open criticals, overdue follow-ups, no-shows, machines down, register gaps. Counts and minutes only, read from the existing functions; no names; no generated text.
- **Completeness.** For yesterday: every Form F study has a recorded form with no missing field and a verification; every ionising study has a dose row; every dose above the reference level has a reason. Gaps are listed by accession in the HOD's Quality view; the PCPNDT in-charge and the RSO get a bell with a count. Nothing is corrected automatically.
- **Media queue.** Unprinted film and CD requests, oldest first, as a list on the hand-over station.
- **Paid no-show** (ruling 0098): no automatic refund. The invoice stays good for a rebooking of the same study within 30 days; a refund goes through billing's existing refund path.

## Done means

- **D1** The sweep marks yesterday's never-arrived booking a no-show by the automation actor with a booking-changed event, and leaves a checked-in one alone.
- **D2** (web) A booking 30 minutes past its slot and not arrived appears in the desk's Clocks with a no-show control.
- **D3** With reminders on, the sweep queues exactly one reminder for a slot tomorrow that was booked three days ago; a second run queues none.
- **D4** With reminders off, it queues none.
- **D5** Running the digest twice for one day leaves one digest row.
- **D6** The digest's per-modality counts equal the north-star read for that day, and the row contains no patient name or UHID.
- **D7** A Form F study acquired yesterday whose form lacks a field is listed as a gap; a complete one is not.
- **D8** An ionising study acquired yesterday with no dose row is listed as a gap.
- **D9** Turning `no_show_sweep` off with a reason makes the next sweep mark nothing and appends the switch event.
- **D10** The automation actor is refused by gate satisfy, waive and override, by sign, by critical acknowledge and by placing an order.
- **D11** The media queue returns unprinted requests oldest first and omits printed ones.
- **D12** A paid study marked no-show by the sweep and rebooked within 30 days is authorised by its original invoice and raises no new invoice.

## Out of scope

- same-day automatic slot release; refunds; DICOM print and CD burning.

## Build notes

- **Files.** radiology new `automation.ts`, `digest.ts`, `completeness.ts`, `chasers.ts`, `schedule.ts`, `followups.ts`, `release.ts`, `gates.ts`, `report-signature.ts`, `criticals.ts`, `place.ts`, `events.ts`, `radiology-supervisor.controller.ts` · `kernel/worker/jobs.ts` (SHARED, kernel: the existing 08:00 registration's body) · `kernel/notify/templates.ts` and its pinned key list (SHARED, kernel) · `kernel/db/schema/radiology.ts` and a migration (SHARED) · web `radiology-hod.tsx`, `radiology-reception.tsx`, `radiology-reports.tsx` · locales (SHARED).
- **Migration** yes: `imaging_automation_runs`, `imaging_automation_settings`. **Permissions** none. **Size** L. **Depends on** IM2, IM4, IM7a.
