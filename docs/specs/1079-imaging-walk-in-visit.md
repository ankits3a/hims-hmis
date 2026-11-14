---
issue: 1079
status: built
approved: 2026-11-14
---
# SPEC — Imaging-only walk-in visit for outside referrals (#1079)

Status: APPROVED 2026-11-14 by the owner ("go ahead"), from the imaging module review. Slice IM2b of the imaging programme #1075. Rulings: 0098.

## What

- An outside-referred patient needs an OPD visit before imaging can be ordered (`place.ts` requires `V…` or `D…`; the desk door's own header says the visit's doctor stays answerable). The lab solved the same problem with its own walk-in visit.

## Decisions

- `openImagingWalkinInTx` in `opd`, the lab opener's twin: a `V` visit of type `imaging`, department `RAD`, under the radiologist of record, one open imaging walk-in per patient per day.
- No consult fee, ever (decision 0003 ruling 2).
- The desk's act `placeWalkInOrder` opens the visit and places the order in one transaction, under `external_prescription`, with the referrer's name and registration typed from the slip.
- DECIDED: imaging on the patient's own request stays refused (`selfOrderable: false`); the referral is the radiation justification and, for ultrasound, the PCPNDT referral.
- The visit joins no OPD queue and appears in no OPD report.
- Needs one department row `RAD` at stand-up (runbook line, not a migration).

## Done means

- **D1** `placeWalkInOrder` for a patient with no visit today creates one `V` visit of type `imaging` with no consult fee line, and one imaging order under an outside prescription.
- **D2** A second call the same day reuses the open visit.
- **D3** That visit is absent from the default OPD visit list.
- **D4** The call without a referrer name and registration is refused.

## Out of scope

- Nothing beyond the decisions above.

## Build notes

- **Files.** `modules/opd/encounters.ts`, `opd/index.ts` (additive export; `opd` is widely imported, coordinate) · radiology `desk.ts`, `place.ts` · web `imaging-desk-door.tsx` · locales (SHARED) · `docs/runbooks/radiology-go-live.md`.
- **Migration** no. **Permissions** none. **Size** S–M. **Depends on** IM2; run after IM3 (both touch `place.ts`).

## As built

- **Acts.** opd `openImagingWalkinInTx` (exported from `opd/index.ts`, additive: `RAD_DEPARTMENT_CODE`, `IMAGING_VISIT_TYPE`); radiology `desk.ts` `placeWalkInOrder` (`POST /radiology/desk/walk-in-order`, optional `Idempotency-Key`) and `deskWalkInView` (`GET /radiology/desk/walk-in`: the priced book and the RAD radiologists). Contract `imagingDeskWalkInOrderBody`.
- **DECIDED — the radiologist of record** is the lab's rule, shared: the sole active `opd_doctors` row in `RAD`, or the one the desk names; two or more and none named is refused. The lab and imaging walk-ins now use one `doctorOfRecordInTx`. The order's answerable clinician is that radiologist.
- **DECIDED — reuse** reads the department AND `type = 'imaging'`, open (not completed or abandoned), same IST day, across the merge chain, under an advisory lock. A doctor named on a reused visit is ignored.
- **DECIDED — permissions.** Route `radiology.orders.place`; the act also needs `radiology.schedule`, so only a desk seat opens a walk-in visit.
- **DECIDED — `place.ts` unchanged.** The order goes through `placeImagingOrder` on the walk-in's transaction (the `followups.ts` idiom), so every placement guard is the one the visit leg meets.
- The desk door's visits of today now include the patient's imaging walk-in (never a lab or pharmacy visit). OPD's refusals map to HTTP in `radiology-http.ts`, as `lab-http.ts` maps them.
- Web: the door's "no visit today" carries the outside-slip leg (`imaging-walk-in.tsx`), reusing the door's study card with a `place` override; the door then opens the returned visit.
- Runbook: `RAD` and its radiologist are precondition 8 in `docs/runbooks/radiology-go-live.md`.
