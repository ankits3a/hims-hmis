# Merge review (/merge) — board notes, 28-Sep-2026 (draft for approval)

Grounded in origin/main after PR #355: `apps/web/src/screens/merge-review.tsx`,
`apps/core/src/modules/patients/merge.ts`, `approval-types.ts`, `patients.controller.ts`,
`kernel/approvals/approvals.controller.ts`.

**Who does what, per the code.** A holder of `patients.merge` (the MRD officer) requests the merge.
The approval type `patient_merge` goes to the **Medical Superintendent** (owner ruling 26-Aug-2026,
urgent, 240-minute SLA). The requester can never approve their own request (checked when the
decision is made). Once the MS grants it, a `patients.merge` holder runs the merge. The
RegistrationEdge board says "the MRD Officer approves", which is older than the 26-Aug ruling; this
board follows the code.

## What changes and why
- **Allergies shown as a bare "0"**: each allergy is now listed with substance, reaction and severity
  (from `GET /patients/:id/allergies`). Severe ones are brick red. Allergies on the record being
  closed are tagged "→ moves to A", because allergies are one of only two things the merge carries over.
- **Date of birth shown as 1986-03-12**: every date reads DD-Mon-YYYY with the age beside it. A
  year-only date of birth is labelled as year only.
- **No board**: the screen now uses the house three-column layout. The menu is in the header. The
  left lane holds the pair of records in hand. The centre is a four-step flow (pick, compare, which
  survives, reason) with one pinned act. The right side is one list of merge requests with no tabs,
  and "Clocks running" sits below it, collapsed.
- **The merge rule was hidden**: the left lane says what the merge does before the request is sent.
  Allergies and guardians move to the surviving record. The photo stays on the closed record. The
  closed UHID still opens the surviving record. The closed record's mobile and address are NOT
  copied, so staff edit the surviving record afterwards.
- **The survivor was chosen with a bare radio button**: the surviving column is marked with a green
  edge through the whole table, and each choice gives its reason (older record, more visits,
  verified ABHA).
- **Status showed a raw word** ("granted", "pending", "rejected"): it now shows "Run merge", the time
  left against the 4-hour line, or "Refused" with the MS's note.
- **The approver had no view on this screen**: the MS opens a request and sees the comparison as it
  was captured at request time, the requester's reason, and a required note, with Approve and
  Refuse side by side. The Approvals inbox keeps working.
- **Kept from PR #355**: the block on picking one record as both A and B (it now also names the merge
  that joined them), age/sex/DOB/masked mobile/district in search results, Change, and A/B stacked
  per field on phones.

## Needs server
1. **A list of merge requests**: `GET /patients/merge-requests?status=…`, returning names, UHIDs,
   who asked, when, the approval status, the time left and the MS's note. Today there is only
   `GET /merge-requests/:id`, and the approvals worklist needs `approvals.requests.read`.
2. **Unblock a record after a refusal**: a refused approval leaves the row `status='requested'`, and
   the partial unique index `patient_merge_requests_pending_loser_ux` then blocks that record from
   ever being requested again. On refusal the server must close the request (for example with a
   `rejected` status). This is a real defect, not only missing polish.
3. **Visit count and last visit** for each record in the comparison.
4. **Registered-at**: the counter or source where each record was created, and the source chip
   (DESK / LAB / IPD / MRD) naming where the request came from.
5. **The same-record refusal** names the merge that joined the two records (the `resolvedFrom`
   chain plus the date of that merge).
6. **Duplicate suggestions for the copilot**: records with the same mobile and year of birth under
   different UHIDs.
7. **Allergies in the approver's view**: the frozen snapshot holds patient rows only, so allergies
   are read live and labelled "now".
8. **Approve/Refuse on /merge**: this reuses `POST /approvals/:id/approve|reject` (note required,
   `approvals.requests.decide`). The screen needs the approval id on the merge-request view; the row
   has `approvalId`.

## Questions for the owner
- **Q1, Aadhaar as evidence**: should a merge ever record the last four digits of the Aadhaar that
  was seen, or never? Aadhaar Act §29 restricts storing it; the board assumes never.
- **Q2, sealed (confidential) records**: does merging one need the MS to break the glass first, or
  is the MS's approval enough?

Breakpoints: below 1280 the requests list becomes a drawer ("Requests · 5"); below 1100 the nav
becomes a Menu button (drawn on the phone artboard).
