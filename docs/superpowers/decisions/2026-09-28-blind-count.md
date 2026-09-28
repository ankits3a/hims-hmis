# OWNER RULING 2026-09-28 — BLIND COUNT (money)

**Ruling.** The cashier must never see her own drawer's EXPECTED cash before she has submitted her
count — on any screen, card, API response or copilot answer. A supervisor / billing manager may still
see it. After the count is submitted (`closing` / `closed`) expected may be shown as before.

**How it is enforced.** At the server, in one rule: `mayReadExpectedCash` (`apps/core/src/modules/billing/sessions.ts`).
A drawer in `open` gives its live expected figure only to a holder of `billing.session.read` (the existing
"oversight of cashier sessions somebody else owns" grant — `billing_manager`, `owner`); no new permission.
Otherwise the figure is left out of the response entirely, not blanked.

| Surface | Who saw what before | Now |
| --- | --- | --- |
| `GET /me/desk` card `billing.myCollections` → stat `desk.billing.expectedCash` (`desk-provider.ts`; rendered by `desk.tsx`, `counter-figures.tsx`) | every drawer holder, her own live expected cash | stat absent before count unless `billing.session.read` |
| `GET /pharmacy/summary/mine` → `drawer.expectedCashPaise` (`pharmacy/shift.ts`; rendered by `pharmacy-desk/rails.tsx`) | the pharmacist, her drawer's live expected cash | key absent before count unless `billing.session.read`; the rail shows the float |

Checked and not leaking: `GET /billing/sessions/current` (the row's `expectedCashPaise` is null until
`beginClose` writes it, and nulled again on a recount); `GET /billing/sessions` (`billing.session.read`
only); the day report / staff drill / copilot `dayReport` tool (collections by tender, no expected figure);
the desk `facts` rollup (no expected figure).

**RULED (owner follow-up, 2026-09-28): "collected today" is blind too.** *"The cashier's 'collected
today', and a pharmacist's at their own counter, must also be hidden until their count is submitted,
because float plus collected reveals the expected cash. The receipt count may still show. Supervisors
(billing.session.read) still see it."* One rule, `collectionsBlind` (`billing/sessions.ts`): the
person holds an `open` drawer opened on or before the day asked about, and the viewer lacks
`billing.session.read` — then every collected amount is left out; counts stay.

| Surface | Now, while her drawer is uncounted |
| --- | --- |
| `GET /me/desk` card | `desk.billing.collected` and `desk.billing.cash` absent; `desk.billing.receipts` stays |
| `GET /me/report`, `/me/report.csv`, the printed day on `/counter/figures`, the copilot `dayReport` tool | no `billing.myCollections` section (all four read `loadReport`) |
| desk facts → `GET /me/brief` "today" | `billing.collectedPaise`, `cashPaise`, `upiPaise`, `cardPaise`, `invoicedPaise` absent (no `brief.collected` clause); counts stay |
| `GET /pharmacy/summary/mine` | `takenPaise` and `byMode` absent; the rail draws no money row |
| Desk One (`desk-one.tsx`) | the header pill no longer shows "+₹ cash taken" beside the float; the dock's drawer answer no longer says what has come in (both were a client-side tally of her own bills) |

Side effects, accepted: a nightly rollup of a day whose drawer is still open stores that day without
the money facts; the 3-day lookback re-rolls it once the count is in. A supervisor's staff brief of a
cashier (`/staff/:id/brief`) computes the live today with the subject as reader, so its today
"collected" clause is also absent until her count — the drill (`/staff/:id/drill`) and the stored days
are unaffected.

Not changed (raw rows, not a figure — flagged): `GET /billing/receipts` with no `patientId` lists every
receipt (total, change, session id) to any `billing.invoice.read` holder, a cashier included; a
determined cashier could sum her own session's rows. `GET /pharmacy/summary` gives the whole
counter's billed total, which equals one pharmacist's on a one-person counter. Closing either
changes a shared list/counter screen and is left for a separate ruling.
