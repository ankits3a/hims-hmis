---
type: decision
id: "0043"
title: "App home, round two: the board built whole — the header, the desks' cards, paper consultations on the phone, \"ask the desk to re-check\""
description: "The app-home board is built whole: the header, the desks' cards, paper consultations on the phone and 'ask the desk to re-check'."
generated: { by: agent:claude, at: 2026-10-07 }
verified: []
status: stable
ruling: ruled
tags: [mobile, opd, approvals, roster, auth]
supersedes: []
superseded_by: []
sources:
  - { id: pr-526, resource: "https://github.com/ankits3a/hims-hmis/pull/526", title: "feat(home, opd, mobile): app home round two — the header, the desks' cards, paper consultations on the phone, ask the desk to re-check (owner 2026-10-07)" }
  - { id: pr-521, resource: "https://github.com/ankits3a/hims-hmis/pull/521", title: "feat(mobile, home): the staff app opens on My day — needs you now, approvals from the card behind a fingerprint, 30 days, a team card (owner 2026-10-07)" }
---
# 0043 — App home, round two: the board built whole — the header, the desks' cards, paper consultations on the phone, "ask the desk to re-check"

- **Date:** 2026-10-07   **Status:** Ruled (built)
- **Area:** mobile, opd, approvals, roster, auth

## Decision

- The owner approved the app-home board one-to-one (0042: **"approved, go ahead and build it"**) and has a standing
  rule: *close open items completely*. Round one (PR #521) left parts of the board unbuilt; this record closes them.
  Nothing here is a new ruling — it is the same board, finished, with the choices the build had to make written down.

## DECIDED around the ruling (not ruled; the owner may overturn)

- **The header names the person.** `/auth/me` now carries the caller's own full name and role keys. The line under
  the name is a doctor's department and unit, "Hospital · all departments" for whoever reads the whole hospital, else
  the role that says most about their day, in words. The username shows only where the account has no name.
- **"Ask the desk to re-check"** is the state the scribe's "line the doctor sent back" card needed. The treating
  doctor sends what the desk typed back with a required reason (`POST /opd/paper/visits/:id/recheck`); it lands on
  the desk scribe's screen and phone card; the desk's next save answers it, or its "I have looked again" with an
  optional note. One open ask per visit; asking again replaces the reason. It holds nothing — the patient is gone and
  the pharmacy has the lines; "Correct it" remains the doctor's road when a medicine must change now.
- **A held medicine is decided on the phone, never typed.** Each held line: give it with the doctor's reason, or do
  not give it. That is the web's "Correct it" with the typed lines left exactly as they stand; the server re-runs
  every check. The phone adds no medicine and edits none in this round.
- **A "no" to a cover request carries a reason; a "yes" may.** The roster's answer takes an optional note
  (`answer_note`), shown to whoever asked. The server leaves it optional because the web's Yes / No send none; the
  phone requires it on "no".
- **An approval past its time tells its deciders once** (bell and phone, category "Approvals", a fixed sentence with
  no patient, amount or requester). Only a deadline that passed within the last hour is announced, so the first run
  after a deploy does not buzz for every old request. The asker is never told to hurry their own request.
- **The "Approvals" notification switch is offered to a phone that says it knows it** (`?knows=`), not by build
  number — another session cuts the builds.
- **What I asked for** (`GET /approvals/mine`): the requester's own pending requests and today's answers — a status
  and an amount. An answer stays on the home until the person taps OK; the phone remembers which (ids only).
- **The front desk's cards are counts.** "Patients you opened still waiting" comes from the person's own report rows
  (registered or waiting), with the oldest clock; "appointments to re-book" from the stranded bookings from today on,
  due by the day they are for. No name is on either card.
- **The last home survives a closed app — as counts only.** Kind, count and clock of each card and the three tiles,
  in the Keystore-backed store, under the user's id, dropped at log-out. No patient, colleague, note or amount is
  written; a cold card has no button.
- **A notification's tap lands on its card.** The payload stays two closed words; the link `approvals` opens the
  home with the approval cards marked, and opens the sheet when exactly one is waiting.
- **A unit head's team** is read by the roster's own word (`role_in_team = 'head'`). Round one asked for
  `'unit_head'`, which no row carries — found by the test this round owed.
- **The owner's hospital view** needs `staff.reports.read`; `owner` and `medical_superintendent` already hold it.

## Still open

- Long-press shortcuts on the app icon need a native module and wait for the next APK.
- The desk scribe TYPES on the computer; the phone's two scribe cards say where. A phone scribe seat is not built.
- A doctor cannot add or edit a medicine from the phone's paper list (see above).

## Why

A board the owner approved is the specification. A card that says "open the computer" is the gap the board was
drawn to close.

## Source

- Decision 0042; PR #521 (round one) and this round's PR.
- `apps/core/src/modules/opd/paper-consult.ts`, `apps/core/src/kernel/approvals/overdue.ts`,
  `apps/core/src/kernel/auth/profile.ts`, `apps/mobile/src/home/*`, `apps/mobile/src/screens/{paper-consults,alerts}.tsx`.
