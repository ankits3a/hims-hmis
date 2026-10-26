# PLAN — Ward WM-1: shift assignment, ratio and acuity, in-charge cockpit (#982)

Spec: `docs/specs/982-ward-assignment.md` (approved 2026-10-26). Rulings: decision 0089. Lane `ward-982`, built on
`lane/ipd-train` (#967). It merges after #966 and #967 and stays dark behind `HMIS_MODULES_ON`. Paths are under
`apps/core/src/` unless they start with `apps/`, `packages/` or `docs/`.

## What exists (read from the train)
- `ipd/nursing-read.ts readMyShift` lists the whole ward. Its comment says assignment comes later.
- Nursing shifts are 08–14, 14–20 and 20–08 IST (`nursing.ts shiftOf`). A roster duty is 12 hours long, so one roster
  duty covers two nursing shifts.
- Roster positions `staff_nurse`, `ward_incharge` and `night_nursing_supervisor` exist (`roster/masters.ts`). Roster
  places use `whoIsAt(locationId)`, which needs `ROSTER_RESOLVER_ENABLED`.
- The RBAC roles `ward_nurse`, `nursing_supervisor` and `nursing_superintendent` exist. There is no in-charge, student or
  agency role.
- There is no acuity field and no "end my duty" act.
- Ward attributes carry `unitType` (no "private"), and there is no block resource kind.
- Notices go through `raiseNoticeIn` with a `sourceKey` that removes duplicates. The minute job is `sweepIpdNursing`.

## Decided (standard practice; none is money or law)

| Question | DECIDED |
|---|---|
| Ratio arithmetic | The ward ratio counts **patients per RN on duty**. A ventilated patient counts as needing their own RN (1:1). Acuity points are used to balance loads and to flag one nurse carrying more than 1.5 × the ward's per-nurse limit. A breach is ward-level: patients ÷ RNs on duty is above the table's value for that unit and that day or night. |
| Day and night | The table's day value applies to the morning and evening shifts; the night value applies to night. |
| Ventilated | A checkbox on the acuity record. |
| Private ratio | Set per ward through the `ratioUnit` ward attribute (general, private, hdu_icu or labour_nicu). The default comes from `unitType` and the majority bed class. A mixed ward uses its own unit. |
| Who is in-charge | A new RBAC role `ward_incharge` holding `ipd.nursing.assign`. `nursing_supervisor` holds it too. |
| Students | A new RBAC role `student_nurse`. A student cannot be a bed's only nurse. Medicine limits for students are WM-2. |
| Float pool | Listed by floor. The superintendent also sees the whole hospital. |
| End of duty | A ward sign-off record. It does not change the roster. |
| Unanswered EWS alert | Also notifies the assigned nurse, in addition to the existing doctor and fallback chain. |
| Before a ward's first publish | My shift keeps today's ward-wide list, labelled "no assignment yet". |
| Candidate nurses | Nurses on the roster at that ward (`whoIsAt` plus `dutyCovering`). If the resolver is off, the fallback is holders of the `ward_nurse` role, with a warning shown. |
| Publish deadline | 07:30, 13:30 and 19:30 IST. A late publish is allowed and flagged late. |

## Data (one migration, numbered at merge)
- `ipd_ward_shift_maps`: ward, shift date, shift key, status (draft, published or carried_over), who published it and
  when, which map it was carried from, and when the supervisor was told. Unique on (ward, date, shift).
- `ipd_ward_shift_staff`: map, user, kind (rn, student, incharge or float), the paired RN for a student, the home ward
  for a float, and when the person ended duty and why.
- `ipd_nurse_assignments`: map, bed, admission, nurse, student, valid from and to, reason for a change, and who changed
  it. A partial unique index allows one live row per (map, bed). Rows are append-only.
- `ipd_patient_acuity`: admission, shift date, shift key, level, points, ventilated, set by and when. A trigger makes it
  append-only.
- `ipd_ward_ratio_breaches`: one row per (ward, date, shift).
- No migration is needed for the ward attributes `ratioUnit` and an optional `nurseRatio`.

Shared files:
- contracts `ipd/nursing.ts`, and a new `ipd/nurse-ratio.ts`
- the event names in `IPD_NURSING_EVENT_NAMES`
- the intents in `intents-ward.ts`
- the permissions `ipd.nursing.assign` and `ipd.nursing.float`, the roles `ward_incharge` and `student_nurse`, plus
  `scripts/seed-roles.ts`, its test and the README prose
- the schema index
- `router.tsx`, `caddyfile-parity` and the Caddyfiles
- the en and hi locales
- `ipd/MAP.md`

## Slices (red acceptance tests `spec #982 Dk` first)
0. Red acceptance tests D1–D7 in `modules/ipd/acceptance/`.
1. **Ratio and acuity basics:** contracts, migration, the ratio defaults and the pure `ratioOf` and `loadOf` functions,
   with tests at the limits. Add the `set_acuity` act and an acuity step after the admission assessment.
2. **Assignment (D1):** draft, same as last shift, and publish. Publish refuses `bed_unassigned` and `student_alone`.
3. **Sweep (D2, D3):** carry over an unpublished map at shift start and tell the supervisor. Raise one notice per
   unassigned bed per shift.
4. **Mid-shift changes (D4):** `reassignBed` needs a reason and notifies both nurses. `endMyDuty` is refused with
   `beds_still_assigned` until every bed is with a named RN.
5. **Ratio breach (D5):** computed on publish, on reassign and in the sweep. One row, one event and one notice per ward
   per shift. It never touches admission or transfer code.
6. **Float (D6):** `moveFloatNurse` takes a reason. The moved nurse counts on the receiving ward, and a lowest-load
   list by floor helps the supervisor choose.
7. **Read models (D3, D7):**
   - the station shows nurse initials and acuity
   - My shift lists the nurse's own beds
   - the Beds board tile shows initials, and red when no nurse
   - a new Now card, "Ward needs you"
   - the EWS alert also reaches the assigned nurse
8. **Web:**
   - new `/ipd/ward/assign` and `/ipd/ward/cockpit` screens (1440)
   - extended `ipd-ward.tsx`, `ipd-my-shift.tsx` (adds "End my duty") and `ipd-beds.tsx`
   - then a browser walk at 390 and 1440 px against the design board
9. **Docs:** update `ipd/MAP.md`.

## Risks
- If the roster is not filled in, the candidate list falls back to every `ward_nurse`. Show that clearly.
- A 12-hour duty spans two maps. `endMyDuty` acts only on the current map.
- Sealed patients: the cockpit and notices use `whereWords` and `nowIdentities`.
- The sweep gains a step per ward. Keep it one transaction per ward, isolated.

## Verify
Targeted jest for ipd nursing, beds, transfers and the sweep, under the lock. Web vitest for the touched screens. Root
typecheck and lint, then `node tools/arch/gen.mjs`. CI runs the full suites. Stage after #967 is on staging.
