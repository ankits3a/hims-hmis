---
issue: 1081
status: built
approved: 2026-11-14
---
# SPEC — Imaging reading room: draft autosave, reading claim, reading pools, drafted sections with sources (#1081)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM4 of the imaging programme #1075. Rulings: 0098.

## What

- A draft is saved only on Save or Sign (`radiology-reading.tsx` 652); a closed tab loses it.
- Drafts record no author (`imaging_reports` has no such column).
- "Dr X is reading" exists only after images are opened in a configured PACS (`reading.ts`, `views.ts`).
- One list of up to 300 for every reader; roster has no subspecialty data.
- The drafter is called only by the legacy report screen (`radiology-report.tsx` 96); its provenance is one object per proposal.

## Decisions

- **Autosave.** `autosaveDraft` runs 5 s after typing stops and on leaving the study. It overwrites the reader's own working draft and stamps `drafted_by` and `autosaved_at`. A new version is cut on Save, on Sign, and when the working draft is older than 10 minutes. Reopening the study restores the reader's working draft. Nothing is autosaved over a signed report or over another reader's draft.
- **Claim.** Opening a study in the reading room claims it (`claimReading`): `reading_claimed_by`, `reading_claimed_at`, event `imaging.reading_claimed`. It shows as "Dr X is reading", lapses 60 minutes after the last open or autosave, and ends at signature. It is a label, not a lock; taking over is one tap and the event names who was there. It needs no PACS.
- **Pools.** The signatories book gains optional `reading_pools` (name, modalities, optional body parts, readers). DECIDED: in the book that already says who may sign, so no new governed kind and no roster change. At acquisition the study is stamped with its pool (L4). A consultant may assign a study to a named reader.
- **My list** is the default: my pools, studies assigned to me, and unpooled studies. **All** is one header view away. Each list is still sorted, never filtered further.
- **Drafter.** Opening an unreported study prepares a draft (L1): technique as today, and a comparison line from the latest signed prior of the same modality and body part (study, date, accession). Findings and impression are never drafted.
- **Provenance per section.** Each drafted section records its source rows (dose record, contrast register, study type, prior report). The screen shows a chip per drafted section; a section the reader edits loses its chip.
- **Numbers.** Every number in a drafted section must appear in a source row its chip names; a proposal that fails is refused, like the PCPNDT lockout.
- **Draft history** (ruling 0098): every draft version is kept for the record's retention period; nothing is purged at signature.

## Done means

- **D1** Two autosaves within 10 minutes leave one draft version holding the second text, with `drafted_by` the reader.
- **D2** An autosave 11 minutes after the first cuts a second version and leaves the first unchanged.
- **D3** The reading context returns the reader's working draft after an autosave.
- **D4** An autosave on a study whose report is signed is refused and writes nothing.
- **D5** After reader A claims a study, reader B's list shows A as reading, with no PACS configured and no image view recorded.
- **D6** A claim 61 minutes old is not shown; B's take-over appends an event naming A.
- **D7** Acquisition of a CT stamps the pool the published book maps CT to; with no pools published the pool is empty.
- **D8** "My list" for a CT-pool reader returns CT studies and studies assigned to them, and no MRI-pool study; "All" returns both.
- **D9** The proposed draft carries a comparison line naming the latest prior's date and accession, with that report as the section's source; with no prior the section is empty.
- **D10** A drafter fixture that emits a number absent from its named source rows is refused.
- **D11** (web) Typing and waiting calls autosave once; a drafted section shows a chip; editing it removes the chip.
- **D12** (web) Opening an unreported study shows the technique filled without any press.

## Out of scope

- a model-backed drafter (DPIA first), voice dictation, a lighter second factor, an embedded viewer.

## Build notes

- **Files.** radiology `report-authoring.ts`, `reading.ts`, `drafter.ts`, `definitions.ts`, `acquisition.ts`, `events.ts`, `radiology-reading.controller.ts`, `radiology-reports.controller.ts` · `kernel/db/schema/radiology.ts` and a migration (SHARED) · web `radiology-reading.tsx`, `lib/radiology-reading-api.ts` · contracts `radiology.ts` · locales (SHARED).
- **Migration** yes: `imaging_reports.drafted_by`, `autosaved_at`; `imaging_studies.reading_pool`, `assigned_reader_id`, `reading_claimed_by`, `reading_claimed_at`. **Permissions** none (assignment under the existing `radiology.reports.amend`). **Size** L. **Depends on** IM1, IM7a.
