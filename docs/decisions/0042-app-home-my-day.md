# 0042 — The staff app opens on "My day": what needs you now, approvals from the card, a team card for supervisors

- **Date:** 2026-10-07   **Status:** Ruled — what was open is closed by 0043
- **Area:** mobile, approvals, billing, roster, security (auth)

## Decision

- Owner: *"the first screen of each staff mobile show My-day page, card view. The first screen shows analytics of the
  staff work and also what's urgent and what's important. If anything has to be approved and is pending and clock is
  running then it should be shown there."*
- Owner, on the proposal (three layers: needs you now / my day / my work): *"go with your recommendations and draw
  the board. Analytics depth: last 30 days. Approvals from the card: comfortable approving money items. Comparisons
  between staff: start with their own numbers. However supervisors see their team's by adding another card in their
  dashboard."* On the board: **"approved, go ahead and build it"** — with its five recommendations:
  1. A fingerprint before every money approval from the phone.
  2. Every money item the web inbox allows may be approved from the phone (discounts, refunds, price changes,
     credit, purchase orders).
  3. Deadlines: refunds and discounts 2 h, price changes 24 h, a cover request by the duty's start. Amber at half
     the time, red when over.
  4. The team card is for unit heads, the billing manager and the nursing in-charge — their own people only.
  5. The old list of screens becomes "My work" at the bottom; nothing is removed.
- The owner's own home is hospital-wide (OPD today by department, collected today, who is on duty, every approval).

## DECIDED around the ruling (not ruled; the owner may overturn)

- **The fingerprint, on a server that cannot see one.** A decision that arrives on a PHONE session, on a request
  that moves money, needs a step-up on that same session inside two minutes (`POST /auth/step-up`, evented
  `auth.step_up`). The phone's fingerprint check is reported by the signed-in, linked phone; a phone with none
  enrolled, or a person who cancels it, types the account password, which the server checks against the same throttle
  as sign-in. A browser session is untouched: the web inbox decides as before.
- **"Money"** is any request carrying an amount, plus price changes, credit extensions, cash variance and a vendor's
  bank change (`isMoneyApproval`).
- **Deadlines for kinds the ruling does not name**, by one test — is a patient standing at a counter while it waits?
  Then 2 h (credit, an unpaid release, a deposit exception, a restricted antimicrobial); paperwork 24 h (purchase
  orders, payment runs, stock, definitions, merges). An unknown kind has no deadline and shows only its age.
- **Who is whose.** No reporting-line table exists, so none is invented: a supervising ROLE sees the roles under it
  (`billing_manager` → cashiers; `front_office_supervisor` → front office, vitals desk, slip desk, scribe — there
  is no nursing in-charge role, so the OPD floor's supervisor carries the nurses; `pharmacy_incharge` → pharmacy
  staff; `ot_incharge` → theatre and recovery nurses), and a UNIT HEAD sees the current members of the units they
  head. Counts only, never a patient; `/me/team` takes no user id.
- **Composed on the phone.** The home is built from reads the app already makes for each screen (the doctor's line,
  the bench, the slips, the roster, the approvals inbox, the person's own brief), each asked only with its
  permission and each failing soft. The rules — which five lead, what the clock says — are one file shared with the
  server (`packages/contracts/src/app-home.ts`).
- **Blind count holds** (0014): a cashier's Collected tile reads "After your count" with the receipt count.
- **Nothing is approved offline, and nothing is queued.** The last home stays on screen with "as of HH:MM".

## Still open

**Closed by decision 0043 (round two), except the long-press shortcuts.** As round one left it:

- An overdue approval raising its own alert (bell and phone category "Approvals") is not built; the card turns red.
- The front desk's "still waiting" and "to re-book" cards, the scribe's "line the doctor sent back", and paper
  consultations on the phone (the card says they open on the computer) are not built.
- Long-press shortcuts on the app icon need a native module and wait for the next APK.

## Why

A phone is opened for a minute at a time. The first thing it shows should be what is waiting on this person and how
long it has waited, then how their day is going — not a list of modules.
