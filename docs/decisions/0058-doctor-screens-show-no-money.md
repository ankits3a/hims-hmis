---
type: decision
id: "0058"
title: "A doctor's screen shows no money; a patient the desk let through unpaid is an ordinary patient to the doctor; the desk gets a 'To collect' list"
description: "The owner removed every payment mark from doctor-facing screens, retired the doctor's 'held for payment' list and 'open unpaid' override, and asked for a desk-side list so let-through patients are still collected from."
generated: { by: agent:claude, at: 2026-10-09 }
verified: []
status: stable
ruling: ruled
tags: [opd, doctor, billing, front-desk, mobile]
supersedes: []
superseded_by: []
sources: []
---
# 0058 — No money on a doctor's screen

- **Date:** 2026-10-09   **Status:** Ruled
- **Area:** opd, doctor, billing, front desk

## The owner's words (2026-10-09)

> "make sure that Doctor will not see 'paid' written or marked against any patient name or id. This is
> a hospital not a clinic. Doctor will see the patient name in his queue only when the patient have
> paid the amount in terms of tele-consultation or future appointment."

> "Remove these too: Doctor's screens must not show money."

> "walk-in rule, a (desk let through → patient shows in doctor's line, no mark)"

> "'To collect' list for desk, with money-off-doctor release: yes. Hide test prices from doctor on
> website: No."

## What is ruled

1. **No doctor-facing screen shows a payment state** — no paid / unpaid word, mark, colour, held
   list, banner or amount beside a patient, on the phone or the website.
2. **Walk-ins the desk let through unpaid** (the desk's fee bypass, with its reason and audit,
   unchanged) are ordinary patients to the doctor: they sit in the line in their place and the
   doctor may call, consult, prescribe and complete without being asked anything about money. The
   doctor's own "open unpaid" override is retired. A visit neither paid nor let through is still
   stopped at the vitals door.
3. **Tele-calls and future appointments** are gated by absence: an unpaid one is not in the
   doctor's queue at all (decision record for tele-call appointments).
4. **The desk gets a "To collect" list** — every visit let through and still unsettled, today and
   the last seven days, whatever its state — on Desk One and the billing counter (website) and Desk
   One (phone), with a count card on the desk's and cashier's home. A cashier's home card shows a
   count, never a sum (blind count).
5. **The one exception:** the prices beside tests in the website's advised-tests picker stay
   visible to the doctor.

## How it is enforced

- The server does not send fee status, bypass or override fields to a caller without a desk or
  billing permission (`opd/fee-view.ts`); `GET /billing/to-collect` answers 403 to a doctor.
- A guard test in each app renders the doctor's line, patient page and consult screen and fails on
  any money word; the web test exempts exactly the advised-tests picker.

## Decided while building (DECIDED — the owner may change any of these)

- Visit-kind labels on doctor screens lose their fee words ("Renewal · follow-up lapsed", not
  "fresh fee due").
- The skip reason "At the billing counter" stays: it names a place.
- Old app builds that still call the "open unpaid" route are answered, so they do not break.

## Consequence the owner was told

Before this, an unpaid patient sat in the doctor's "held" list — a visible reminder. That reminder
is gone from the doctor's side by design; the "To collect" list is what replaces it.
