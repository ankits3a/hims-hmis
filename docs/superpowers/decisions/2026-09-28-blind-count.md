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

**Open for the owner (money — not decided here).** The desk card and the pharmacy strip still show
"cash collected today" beside the float. For a single-session day with no refunds, float + cash
collected ≈ expected. A strict blind count would hide cash-collected too; that removes the cashier's
own collections view, so it is left for an owner ruling.
