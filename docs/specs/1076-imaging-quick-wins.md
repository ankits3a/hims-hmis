---
issue: 1076
status: built
approved: 2026-11-14
---
# SPEC — Imaging quick wins: full list rows, contrast prefill, hand-over search and print, quieter access log (#1076)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM1 of the imaging programme #1075. Rulings: 0098.

## What

- List reads write one access row per patient per poll, awaited one by one (`read.ts` 203–206 and ten more readers).
- The worklist prints raw status, raw ISO time and the study code, and does not refresh (`radiology-worklist.tsx` 28, 136–143).
- The console asks for contrast agent and volume the prep bay already recorded (`room-console.tsx` 127–128; `contrast.ts` 306).
- The hand-over desk has no search, no refresh and no print (`radiology-reports.tsx`).
- A read-back typed in Devanagari can never match (`critical-ladder.ts` `contentWords` splits on `[^a-z]+`).
- `imaging_studies` has no index on `encounter_no`, which three joins use.
- List rows carry a name and a code only.

## Decisions

- **Access log.** A list read writes one row per reader, patient and surface per 30-minute window, in one statement. A patient new to that reader's list is logged at once. Opening one study, report, print or image set still logs every time. DD11 and F42 stand: one row per patient disclosed, never one row per read. The helper is a new `recordPhiAccessMany` beside the existing writer; the existing writer is unchanged. (Owner ruling 0098: a 30-minute window.)
- **Worklist.** Status as words, time in IST, study name, refresh every 30 s. It leaves the station switch in IM8.
- **Rows.** Worklist, reading, prep and release rows carry UHID, age, sex and study name; every list shows them.
- **Contrast.** The room view returns the agent and volume the prep bay recorded; the console shows them filled.
- **Hand-over.** One search box (name, UHID or accession) answered by the server, so it reaches reports past the list cap. The list refreshes. The report in hand has a Print button using the existing print view.
- **Print is recorded.** Each print appends `imaging.report_printed` (report, version).
- **Read-back.** The critical-term lexicon gains Devanagari forms, and the tokeniser reads Unicode letters. DECIDED: transliterated terms, because the report is in English.
- **Index** on `imaging_studies (encounter_no)`.
- DECIDED: the per-row dues lookup in the release register becomes one batched read; if that needs a new billing export it is additive (`invoiceSettlement` keeps its signature).
- **Contrast register reads** (administrations and reactions) go through the study reader, so they log access and follow the restricted-study rule like every other study read.

## Done means

- **D1** `worklist` called twice within 30 minutes by one reader over the same 20 patients leaves 20 access rows; a 21st patient on the second call adds exactly one.
- **D2** A second reader making the same call in that window gets their own 20 rows.
- **D3** On a fixture clock 31 minutes later, the same call by the first reader writes 20 new rows.
- **D4** `studyView` called twice in one minute writes two rows.
- **D5** `worklist`, `readingWorklist`, `prepBayList` and `releaseRegister` each return `uhid`, `ageYears`, `sex` and `studyTypeName` per row.
- **D6** (web) The worklist renders "Checked in", an IST clock time and the study name for a row whose wire values are `checked_in` and a UTC timestamp; neither raw value appears.
- **D7** `roomView` for a study with one recorded intravenous administration returns its agent and volume.
- **D8** (web) The console's contrast fields show that agent and volume without typing.
- **D9** `releaseRegister` with a UHID query returns that patient's report when it is older than the list cap.
- **D10** (web) The hand-over screen shows a Print button for the report in hand, and pressing it renders the print view.
- **D11** `reportPrintView` appends one `imaging.report_printed` event naming the report and version.
- **D12** `readBackNamesFinding` accepts a Devanagari read-back naming pneumothorax against an impression of "Right pneumothorax", and refuses "ठीक है सर".
- **D13** The database has an index on `imaging_studies.encounter_no`.
- **D14** Reading a study's contrast administrations or reactions writes an access row for that patient, and a restricted study's register is refused to a reader without access to it.

## Out of scope

- retiring the worklist (IM8); push (IM6a).

## Build notes

- **Files.** `kernel/phi/audit.ts` (SHARED) · radiology `read.ts`, `reading.ts`, `prep-bay.ts`, `bedside.ts`, `schedule.ts`, `ir.ts`, `critical-ladder.ts`, `override-requests.ts`, `mwl.ts`, `tele.ts`, `release.ts`, `room.ts`, `checks.ts`, `events.ts` · `kernel/db/schema/radiology.ts` and a migration (SHARED) · web `radiology-worklist.tsx`, `radiology-reports.tsx`, `room-console.tsx`, the list markup in reception, room and reading, `lib/radiology-api.ts` · locales (SHARED).
- **Migration** yes (index only). **Permissions** none. **Size** M. **Depends on** nothing.

## As built (2026-11-14)

- The hand-over desk prints through its own route (`GET /radiology/release/reports/:id/print`, on `radiology.schedule`, the desk's grant): the current released version only, refused while the patient's copy is held for dues. Same print view, access row and `imaging.report_printed` event as the reading room.
- A search reaches every released report, not only the 30-day register: at most 50, newest first. A confidential patient is found by the name the reader is shown.
- The new list UHID is blank for a confidential patient read without clearance (the room console's rule).
- The 30-minute window covers the eleven list readers named above. Follow-ups, the doctor's results inbox, the PACS inbox and the access-log review still log every read.
