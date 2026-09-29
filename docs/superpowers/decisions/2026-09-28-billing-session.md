# Cashier session screen — board port decisions (UX-AUDIT 2026-09-28)

Screen: `/billing/session` (`apps/web/src/screens/billing-session.tsx`), permission `billing.session.own`.
Boards: `docs/design/2026-08-29-opd-counter-flow-v2/BillingEdge.dc.html` (right panel) and
`docs/design/2026-08-29-opd-counter-flow/BillingCounter.dc.html` (drawer strip).

## DECIDED — the blind count wins over the board's "If you closed the drawer now" figures

BillingEdge's card prints "Cash receipted ₹24,150 … Drawer should hold ₹24,650", and directly under it
the board's own note says "the expected total stays hidden until you have typed yours". Both cannot
be true. The blind count is the money control, and a test pins it: the expected figure is not rendered
before the cashier submits her count. So the card keeps its rows and withholds every figure the expected
cash could be worked out from:

| Board row           | On screen                                                                       |
|---------------------|---------------------------------------------------------------------------------|
| Opening float       | shown (she typed it when she opened the drawer)                                 |
| Cash receipted      | replaced by **Receipts taken** (a count)                                        |
| Refunds paid out    | **count** of cash vouchers paid from this drawer, not the amount                |
| Refunds still held  | shown (issued, unpaid cash vouchers are not in the expected until they are paid) |
| Drawer should hold  | "shown after your count"                                                        |

The drawer strip does the same thing. The board has "collected so far ₹18,450 across 47 receipts".
The screen shows "47 receipts taken" and leaves out the rupee total, because at a cash-heavy counter
the collected total is the expected cash minus the float.

The new read `GET /billing/sessions/current/open-items` never carries a cash figure. The e2e test pins
its six keys and checks that neither the cash taken nor the expected total appears in the response.

## DECIDED — what "Open on this drawer" shows

These rows come from data that exists today:

- **UPI/card payment not yet confirmed**: a non-cash tender still `captured`, meaning no settlement statement has reconciled it yet.
- **Statement disputes**: a non-cash tender marked `mismatched`. This row is red.
- **Cash refunds queued**: issued, unpaid cash refund vouchers across the hospital.
- **Bills part-paid, awaiting balance**: invoices this drawer's receipts were allocated to that are still `partial` under the ledger's own `settlementState`. The list shows up to 20, and the count covers all of them.

Rows with nothing in them are hidden. When every row is empty, the panel says "Nothing is open on this drawer."

The board also has "UPI debited, never confirmed" with "Receipt on her evidence" and "Re-check gateway"
actions, and an "Ayushman Bharat — nothing to collect" row. Neither has a gateway-status source or a
per-drawer scheme source in the data model today, so they are **not built**. The unconfirmed UPI row is
information only.

## Open finding (not changed here)

The home desk card `billing.myCollections` (`apps/core/src/modules/billing/desk-provider.ts`) shows the
cashier her own **collected**, **cash** and live **expected cash** (`desk.billing.expectedCash`) while the
drawer is open. That breaks the blind count on a different screen. It is a server-side presentation
change in a module shared across lanes, so it was left alone here and needs an owner decision.
