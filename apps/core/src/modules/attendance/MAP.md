---
type: module-notes
title: "attendance — module notes"
description: "Why and traps of the staff-attendance copy: the bioattend client, the one sync job, the signed webhook, linking by mobile or Aadhaar, the read routes for three audiences, and meeting requests."
resource: apps/core/src/modules/attendance
tags: [attendance]
generated: { by: agent:claude, at: 2026-10-09 }
verified: []
stale_after: 2027-01-09
---
# attendance — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/attendance.md`. Paths are relative to `apps/core/src/modules/attendance/` unless they
start with a module name, `kernel/`, `scripts/` or `apps/`. Citations name a file and a symbol, never a line number.
Update this file in the same PR when you change a flow, an invariant or a trap below.
The contract this module implements is bioattend's API guide of 2026-10-09 (kept outside the repository).

## 1. Purpose
HMIS keeps a COPY of the hospital's attendance system ("bioattend") and serves it to three audiences: every
signed-in person (their own days), unit heads and in-charges (their own team), and the owner, the Medical
Superintendent and the Attendance Committee (everyone, including machine-listed people with no login here).
Nothing in the `att_*` tables is typed by a person except a meeting request.

## 2. Key files (owner of what)
- `client.ts` — `createBioattendClient`: eight GETs, named outcomes (`BioattendOutcome`), retry only 429 / 503 /
  network, its own per-minute budget. An error carries an outcome, a status and a path — never the key.
- `secrets.ts` — `secretFromFile`: the three secret FILES, re-read when they change. `describeAttendance` is the
  boot line.
- `sync.ts` — `syncAttendance`, the one job (`kernel/worker/jobs.ts`, every two minutes), staged by cadence.
  `storePunches` (insert-or-ignore on id) and `storeDays` (never overwrites a locked row).
- `linking.ts` — `decideLinks` (pure) and `linkPeople`: Aadhaar first, else a mobile exactly one active machine
  person and one active login share. `linkStates` is the Users screen's word per login.
- `aadhaar.ts` — `aadhaarHash`: bioattend's keyed hash, key HEX-DECODED. `webhook.ts` —
  `verifyBioattendWebhook`: secret used AS TEXT. Both are pinned by the guide's test vectors.
- `reads.ts` — every read view, `dayWord` / `selfWord` (the words a person sees of their own day), `readRange`.
- `requests.ts` — meeting requests about a `confirm` day; `closeCorrected` is the sync's half.
- `attendance.controller.ts`, `users-identity.controller.ts`, `webhook.controller.ts` — the routes.
- `scripts/bioattend-stub.ts` — the test double: the eight endpoints, a signed webhook, a fixed fixture.

## 3. Invariants
- OFF means zero outbound calls: no readable API key file, or `ATTENDANCE_SYNC_ENABLED` not true, and
  `syncAttendance` returns before a client exists.
- Dates and times are IST strings end to end (`ist.ts`). A date is never a JS `Date`; "now" becomes an IST date once.
- The plain Aadhaar number is stored nowhere: not a column, an event, a log line or an error. `users` holds the
  hash and the last four digits.
- No read route returns a mobile number or an Aadhaar hash: `reads.ts` selects neither column.
- A link (`att_staff.user_id`) is 1:1 and is never re-pointed by code; a staff refresh cannot unlink.
- The pull's cursor (`att_sync_state`, stage `punches`) is moved only by the pull. The webhook never moves it.
- A person's own attendance is words, not times, unless `ATTENDANCE_SELF_SHOWS_TIMES` is true — the times are
  absent from the payload, not hidden by the app. `/attendance/person/<own pin>` answers the same self shape
  unless the caller holds `attendance.all.read`.
- A notice about a meeting request carries fixed wording and nobody's attendance.

## 4. Traps
- The two secrets are keyed OPPOSITE ways: the Aadhaar key is hex-decoded, the webhook secret is not.
- The webhook's signature is over the RAW body. `app.bootstrap.ts` keeps the raw bytes for that one path
  (`SIGNED_WEBHOOK_PATHS`); an e2e app built without `configureApp` has no raw body and answers 401.
- Leaves, roster and holidays are REPLACED for the window read, not upserted: a leave cancelled upstream must go.
- `teamOf` (`kernel/desk/home.controller.ts`) never puts a person on their own team.
- Today's three states are by COUNT of the day's punches (the guide says direction is unreliable). A night shift's
  out-punch is the first punch of its calendar date, so that morning reads "checked in" until the evening punch.
- One unparseable row in a bioattend page fails that stage with `bad_response` and the cursor stays put — visible in
  `/attendance/sync-state`, by design, rather than a silent skip.
- A regenerated lane migration needs the lane's test databases dropped (drizzle skips on timestamp alone).
