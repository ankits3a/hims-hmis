---
status: built
approved: 2026-11-12
---
# SPEC — A test for one sex is not offered to, or done for, the other (owner 2026-11-12)

## What

The owner asked why the urine pregnancy test could be done for a male patient. The catalogue already marked the
analyte female-only, but only the full lab bench checked that mark. The owner chose all three fixes:

1. **Quick bench** (desk and phone): starting a test for one sex, or saving such a parameter, is refused for a
   patient recorded as the other sex, with "UPT is only for female patients and this patient is recorded as male —
   check the patient".
2. **Pickers** hide such tests for a patient recorded as the other sex: the doctor's consult (web and phone), the
   scribe, the lab desk's chips and search, the quick bench's test search, and the phone's lab counter.

## Decisions

- A lab ORDER is not refused on the server. The full bench already refuses such a result at entry, and lets a
  second person vouch when the registration is wrong (17d T1); refusing the order would remove that road.

- A test is for one sex when every one of its parameters carries the same `applies_to_sex` (UPT female, PSA male).
  A panel that mixes is not.
- A patient recorded as `other` or `unknown` is never refused or filtered, as the full bench already decides.
- Shared rule: `packages/contracts/src/lab-sex.ts`. Server list: `apps/core/src/modules/lab/test-sex.ts`, served at
  `GET /ordering/sex-specific-tests` (`tariff.read`) and as `forSex` on the lab catalogue search, the common chips and
  the quick catalogue.

## Done means

- Server acceptance: `apps/core/src/modules/lab/acceptance/test-sex-2026-11-12.test.ts`.
