# /pharmacy/retail — the walk-in counter wears the Pharmacy Desk (DECIDED 2026-09-28)

**Status: DECIDED** (UX-AUDIT 2026-09-28; not an owner ruling — no money, procurement or law changes).

## The question

The real-Chromium audit of 2026-09-28 found `/pharmacy/retail` ("Walk-in sales") to be one
full-width stacked column: customer, cart and today's list one under another, the sell button below
the fold, a priced cart showing only "To pay", returns sitting in the middle of a sale, a list with
no customer names, "Scan or paste QR payload…" wording, no typeahead, a US-format prescription date
and an amount prefilled as "212.4".

`/pharmacy/desk` already implements the approved board (`docs/design/2026-09-18-pharmacy-desk/Desk.dc.html`).
Should a walk-in sale be a mode of that desk, or its own screen?

## Decided: its own route, the desk's frame

A walk-in sale stays at `/pharmacy/retail`, rebuilt in the Pharmacy Desk's frame and language —
the `.d1` paper-and-pine seat, the desk's header row and pills (registration, drawer, store, clock),
the 296 px left lane for the person in hand, a centre with one numbered flow and a pinned action
bar, and a 352 px right column for the day's list. It reuses the desk's primitives (`desk-one.css`,
`paper-pine.css`, `pharmacy-desk.css`), its money and expiry formatting (`rupees`, `expiryLabel`)
and its header strings, so the two screens read as one product.

It is **not** folded into `pharmacy-desk.tsx` as a ticket mode, because:

1. **Different object, different state machine.** A desk ticket is a dispense against this
   hospital's OPD prescription: claim → verify → pick → bill → hand over, each a server state with
   its own guard, hold and idempotency key. A walk-in sale is one atomic server act
   (`POST /pharmacy/retail/sales`) with no ticket, no claim and no hold, sold from a different
   store (`PHARM-RETAIL`, Form 20/21 licence) with a customer who may be registered in the same
   transaction. A "walk-in ticket" would be a fake dispense the desk's every branch must learn to
   skip.
2. **Different permission and licence.** The desk is `pharmacy.dispense.*`; the counter is
   `pharmacy.retail.sell` and shuts when the retail licence lapses. One screen would have to hide
   half of itself by permission — the pattern the owner rejected on the front desk.
3. **Different counter.** The owner's precedent is one desk *per counter*. The OPD window and the
   walk-in window are two counters with two stores and two licences; each gets one screen, and both
   now wear the approved design ("keep the new design, not the old one").
4. **Lane safety.** Three other lanes are editing `screens/pharmacy-desk/**` today. Reusing its
   styles and helpers by import, rather than editing it, keeps this change off their files.

## What the rebuild keeps exactly

Schedule H/H1 lines still need the outside prescription (prescriber's name, registration number,
address, date, photo) before the sell button opens; Schedule X is still refused by the server; every
bill still names a registered person (found, or registered in the sale with the near-match check);
allergy and severe-interaction hits still block the sale, other interactions still show; every
server refusal is still shown as its sentence; returns keep every rule (7 days, sealed and intact,
whole strips, not cold-chain, billing approves the refund) and move behind their own entry point in
the right column instead of sitting inside the sale.

## Additive server fields (no signature change)

- `POST /pharmacy/retail/preview` lines gain `price` — rate, GST inside the MRP, amount — read from
  billing's own preview through the pharmacy bill's `displayDraft` (one row per drug).
- `GET /pharmacy/retail/sales` rows gain `customer` via `getPatientSummaries`, the display read the
  pharmacy queue already names patients with; a restricted customer comes back without a name.

## Layout at each width

≥ 1280: three columns. Below 1280 the day's list becomes a drawer opened from the header. Below 768
the customer lane stacks above the flow and the action bar is fixed to the bottom of the screen.
