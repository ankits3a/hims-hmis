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

| `GET /billing/receipts` with no `patientId` | refused (403 `receipt_filter_required`) to anyone without `billing.session.read`, drawer open or not; with a `patientId` it answers as before — every web caller (`billing-dues.tsx`, `billing-office.tsx`) names the patient |
| `GET /pharmacy/summary` | `billedPaise` absent for a pharmacist whose own drawer is uncounted (`counterSummaryFor`); counts stay; the strip and the rail draw no money |

`/staff/:id/brief` computes the live today with the VIEWER as reader (`factsForWindow`'s optional
trailing `reader`, kernel/desk/rollup.ts — additive; every other caller unchanged), so a drawer
supervisor still reads a cashier's collected today; the cashier's own `/me/brief` stays blind.

Side effect, accepted: a nightly rollup of a day whose drawer is still open stores that day without
the money facts; the 3-day lookback re-rolls it once the count is in.

**DECIDED (2026-09-28): the blind count hides TOTALS and EXPECTED figures, not the individual
transactions a cashier or pharmacist handled** — reprints, lookups and the retail day list need them,
and standard counter practice is the same. So these stay as they are:
- `GET /billing/invoices` — the invoice list, amounts included, to `billing.invoice.read` holders.
- `GET /pharmacy/retail/sales` — the walk-in counter's day list, each sale's amount and seller included.
