---
issue: 1082
status: built
approved: 2026-11-14
---
# SPEC — Imaging copilot: 14 tools, Hindi and Hinglish cues, four confirmed acts (#1082)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM5 of the imaging programme #1075. Rulings: 0098.

## What

- `manifest.ts` declares no `copilotTools` and no `copilotIntents`; five other modules do.
- No radiology screen passes the station shell's `copilot` slot; `opd-desk.tsx` is the only station that does.
- The masker does not know the accession shape.

## Decisions

- Fourteen intents under `radiology.*`, declared in `copilot-tools.ts`, `copilot-intents.ts` and `copilot-acts.ts`, in the same shape as `doctor-desk` and `roster`.
- DECIDED: cue-routed only in this spec (no `menu` entry). The phrasebook decides; no model is on the path, and the recorded chooser answers of the frozen eval set are untouched. Adding menu entries later needs a re-record and is its own issue.
- Each tool returns an answer key and parameters; counts and times are parameters read from the module's own functions. New keys go into the contracts list and both locales, in short words.
- Cues in English, Hindi (Devanagari) and Hinglish for every intent.
- The masker learns the accession shape, so "X… ka report ready hai?" reaches no model with the number in it.
| Intent | Kind | Permission | Wraps |
|---|---|---|---|
| `radiology.my_list` | read | `radiology.worklist.read`, also `radiology.reports.write` | worklist, reading list, prep list by the asker's seat |
| `radiology.study_status` | read, needs patient | `radiology.worklist.read` | study view and readiness: which gate is open, which seat fixes it |
| `radiology.next_slot` | read | `radiology.schedule` | `proposeSlot` (IM2) by modality |
| `radiology.overdue_reads` | read | `radiology.reports.write` | reading list past target |
| `radiology.open_criticals` | read | `radiology.criticals.ack` | critical call board |
| `radiology.report_ready` | read, needs patient | `radiology.schedule` | release register and the dues hold |
| `radiology.machine_status` | read | `radiology.worklist.read` | device list |
| `radiology.numbers` | read | `radiology.metrics.read` | north star for a day |
| `radiology.followups_due` | read | `radiology.reports.write`, also `radiology.reports.read` | follow-up board, or the doctor's own |
| `radiology.draft_report` | draft, needs patient | `radiology.reports.write` | `proposeDraft` (IM4); answers "draft ready" with a link |
| `radiology.book_slot` | act | `radiology.schedule` | `scheduleStudy` |
| `radiology.move_or_no_show` | act | `radiology.schedule` | `rescheduleStudy`, `markNoShow` |
| `radiology.mark_acted` | act | `radiology.reports.read` | `markActedUpon`; the note is the doctor's own typed words |
| `radiology.request_film_cd` | act | `radiology.schedule` | `requestMedia` |
- The four acts follow propose → confirm (spec 580): `recheck` re-reads the slot, the study state or the report version; `apply` calls the module act; `verify` reads the row back.
- A question about a patient with several studies today answers with the list, and an act proposes one option per study.
- Never a tool: order, sign, co-sign, amend, any gate act, critical flag or acknowledge, hand-over, unpaid release, taking money (18-S plan, "Rules every phase keeps").
- `RadiologyStation` passes the `copilot` slot. Desk, Rooms, Reading, Hand-over and HOD mount the dock; with someone in hand the list folds to its one line, as the shell already does.

## Done means

- **D1** The boot collector lists the fourteen radiology intents, each with a declared permission.
- **D2** Thirty phrases (ten each in English, Hindi and Hinglish) route to their intents by the phrasebook alone.
- **D3** `radiology.overdue_reads` answers "not permitted" for a receptionist and, for a radiologist, a count equal to the reading list's overdue rows.
- **D4** `radiology.study_status` for a patient held at an open kidney gate answers that gate and the prep bay as the fixing seat.
- **D5** A question containing an accession number is masked before routing and the accession comes back as the subject.
- **D6** `radiology.book_slot`: with the slot taken between propose and confirm, confirm answers "state changed" and books nothing.
- **D7** `radiology.book_slot` confirmed on a free slot books it and writes one act row.
- **D8** `radiology.mark_acted` confirmed by a doctor who is not the treating doctor is refused; by the treating doctor it stamps the report with the typed note.
- **D9** `radiology.move_or_no_show` confirmed marks the study no-show with the typed reason.
- **D10** `radiology.request_film_cd` confirmed writes one media request.
- **D11** The contracts answer-key list contains every radiology key the tools return.
- **D12** The radiology intents declared `act` are exactly those four.
- **D13** (web) The reading room with a study in hand renders the copilot column and the list folded to one line.

## Out of scope

- chooser menu entries; the phone app; any model text.

## Build notes

- **Files.** radiology `copilot-tools.ts`, `copilot-intents.ts`, `copilot-acts.ts` (new), `manifest.ts` · `packages/contracts/src/copilot.ts` (shared package) · locales (SHARED) · `kernel/copilot/mask.ts` (SHARED, kernel) · a new eval items file under `kernel/copilot/acceptance/eval/` (add only; existing items are locked) · web `radiology-station.tsx` and five screens.
- **Migration** no. **Permissions** none. **Size** L. **Depends on** IM7a (schemas), IM2 (`proposeSlot`), IM4 (my list, draft).
