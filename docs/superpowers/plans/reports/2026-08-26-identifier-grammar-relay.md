# Relay — the identifier grammar (UHID + episode numbers), landed 2026-08-26

**Commit:** `1bff417` · **Migrations:** `0024_uhid_format`, `0025_episode_numbers` · **Next free migration: 0026.**
**Status: SHIPPED AND LIVE.** Production migrated and re-minted on 2026-08-26.

This note exists because this work landed from a session running in the **same checkout** as Plan 09's
pipeline, and the two collided once already (see §5). Read §2 before you write a test that inserts an
encounter, an appointment, or a patient.

---

## 1. What changed, in one paragraph each

**UHID.** `CRK-00000001-7` → `U12345013`. The format is now
`<PREFIX><7-digit serial><Verhoeff check digit>` — nine characters, no separators. The prefix is still
DATA (`registration_config.uhid_prefix`, owner-gated Class A); production runs `U`, and the test suites
deliberately keep seeding `HMS`, which is what proves nobody hardcoded the letter into `formatUhid`.
Verhoeff survived the trim (Plan 05 Q6, re-affirmed by the owner) and the serial paid for it by losing a
digit. **Serials 1–1,234,500 are reserved and carry NO MEANING** — the owner initially wanted that band
to mark VIPs and membership holders and was talked out of it; the full reasoning is in
`modules/patients/uhid.ts` and it is the part most likely to be "helpfully" re-added. VIP is
`patients.is_confidential`; membership is Plan 09's instrument record. Both revocable; a UHID is not.

**Episode numbers.** New, and there was nothing before it: an encounter and an appointment carried only a
ULID, and the token number repeats every day for every doctor, so a printed prescription named no visit at
all. The grammar is `<letter><YYMMDD><4-digit daily serial>` — `V2608250147`. `V` (visit) and `A`
(appointment) are allocated today; `L` (lab order), `S` (lab specimen), `R` (radiology order) and `P`
(pharmacy dispense) are **reserved in the vocabulary only**, so those plans inherit this grammar instead of
inventing one each. The series table is keyed by a series-key STRING, so they need no schema change to join.

---

## 2. Landmines — read this before writing tests

1. **`opd_encounters.visit_no` and `opd_appointments.appointment_no` are `NOT NULL` and `UNIQUE`.** Any
   fixture that inserts one of those rows *directly* now needs a value. Twelve existing sites were patched
   with a `VFX-${id}` / `AFX-${id}` convention (unique by construction, obviously a fixture, greppable).
   Going through `openVisit` / `bookAppointment` needs nothing — they allocate.
   - Subtlety worth keeping: in `schema/opd.test.ts` the four appointment rows carry **distinct** numbers
     on purpose. Give two of them the same number and the row that is *supposed* to fail on
     `opd_appointments_slot_ux` fails on the number index instead, and the test still passes — for the
     wrong reason.

2. **`truncateAll` now clears `episode_series`.** It has no FK in either direction so it takes its own
   statement (the `auth_throttle` / `search_audit` precedent). This was a real bug, not a precaution: the
   counter leaked between tests and made the second test in a file read `V2608250006` where it expected
   `0001`. **Any future table a test asserts counts on has to go in there.**

3. **Anything asserting the old UHID shape breaks.** `/^HMS-\d{8}-\d$/` is now `/^HMS\d{8}$/`. Opaque
   fixture strings like `"HMS-00000001-5"` were left alone — nothing parses them — so only real shape
   assertions needed touching.

4. **`UHID_PREFIX` accepts 1–5 uppercase letters** (was 2–5). `seed-registration.ts`.

5. **Migrations 0024 and 0025 are taken.** Two things drizzle-kit generated that were *not* usable as-is,
   both of which will bite the next person the same way:
   - `ALTER SEQUENCE … START WITH` does **not** move a live counter. It only changes what a future bare
     `RESTART` rewinds to. 0024 needs its guarded `setval` or registration is dead on arrival.
   - `ADD COLUMN … NOT NULL` with no default **fails outright** on a table that already holds rows. 0025
     adds both columns nullable, backfills in pure SQL, moves the counters past the backfill, and only
     then applies `NOT NULL` and the unique indexes.

---

## 3. Rules the code enforces, so don't "simplify" them away

- **One encounter = one visit number, including same-day re-entry.** A patient sent back through the queue
  after results is on the *same* visit — `reEnterVisit` appends an `opd_queue_entries` row against the
  existing encounter and reuses the token. Minting a second `V` there would attach those results to a visit
  that never ordered them. Asserted in `encounters.test.ts`.
- **Appointments number on the SLOT's date, not the booking instant.** Booked Sunday for a Monday slot reads
  `A2608170001`. A reschedule mints a NEW number (it is a new row); the old row keeps its own.
- **`episode_series` is a separate table from the GST `document_series`.** The two counters answer to
  different authorities: GST demands a gapless per-fiscal-year serial, clinical counters do not, and nobody
  tidying a clinical counter should be one typo from resetting a statutory one. **Do not merge them.**
- **`allocateUhid` enforces the reserved floor in code**, not merely on the sequence — a restore or a stray
  `RESTART` can put the counter below it, and then registration would quietly issue reserved numbers.
- **`formatUhid` and `formatEpisodeNo` both refuse out-of-range serials** rather than over-padding. Serial
  10,000,000 would silently produce an eight-digit body and a permanently invalid id.

---

## 4. Known gap, deliberately left open

**Search BY episode number is not implemented.** Adding it to `appointmentSearchProvider` looked cheap and
is not: that provider routes text through patient names to obtain patient ids, and *that path is what
applies the confidentiality gate* — the one this phase's own independent review flagged as CRITICAL 1. A
number lane has to bypass both the name path and the ±7-day default window while still sealing confidential
patients. That is a design piece with a privacy trap in it, and its natural moment is when lab or radiology
creates real demand. Today an episode number is printed, stored and unique; it is not a search key.

UHID search, by contrast, *is* complete: full id, lowercase, bare digits, leading serial without the check
digit, any trailing run of 4+ digits, and any of those with stray spaces or hyphens.

---

## 5. The shared-checkout collision — what happened, and what to do differently

Plan 09 T8's commit `927afc6` swept ~90 lines of this lane's **uncommitted** README content plus the
`rx.visitNo` locale key into itself; `b0d046b` then reverted them as scope creep. That revert was correct
from T8's side — it was removing work it had accidentally absorbed — but the net effect was that finished
documentation was deleted from the working tree while its own session was mid-test-run.

All of it was recovered from `927afc6` and verified byte-for-byte before `1bff417`. **It is back on purpose.
Please don't re-revert it** — the README's "UHID format" and "Episode numbers" sections describe code that
is now committed and live.

Two habits that would have prevented it, worth adopting on both sides:
- **Commit early, in small pieces.** A large dirty tree in a shared checkout is the hazard; neither session
  can tell whose uncommitted lines are whose.
- **Stage explicitly — never `git add -A` / `git commit -a`** in this checkout. Name your paths.
- Also: two sessions running jest concurrently corrupt each other's full-suite runs (they share
  `hmis_test_<worker>`). Check `ps` for a running jest before believing a broad failure.

---

## 6. Production state after this landed

| | before | after |
|---|---|---|
| UHID prefix | `CRK` | `U` |
| Patients | 21, `CRK-00000001-7`… | 21, `U12345013` … `U12345218` (serials 1234501–1234521) |
| Old ids | — | parked in `legacy_uhid` (the D-43 column, empty since Plan 05, for exactly this) |
| QR cards | valid | `qr_version` bumped — cards printed under the old format now fail verification rather than resolving to a number their patient no longer has |
| Encounters | 8, no number | `V2608240001`–`V2608240008` |
| Appointments | 4, no number | `A2608240001`… (their own service dates) |

Re-minting is a **one-time commissioning tool**, not a maintenance one — every patient row at the time was
synthetic (owner-confirmed). `remint:uhids` is idempotent on FORMAT but not on PREFIX: it selects rows that
do not already parse as a current-format UHID, so running it before `seed:registration` would stamp everyone
with the old prefix in a shape it then declines to revisit. Order is in the README.

Verified before deploy: `pnpm verify` exit 0 — 2,016 tests (core 1,748 / web 247 / contracts 21), typecheck
and lint clean. Off-site pgBackRest recovery point taken at 01:35:54 UTC immediately before the migration.
