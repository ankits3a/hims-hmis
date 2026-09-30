# Card recognition board: notes (/counter/instruments, 28-Sep-2026)

Layout: the card in hand on the left (printed number, plan, status, holder, benefits left as counts); the centre is a numbered flow (scan the card, pick one of today's visits, see what the bill will do, read the disclosure) with the pinned act "Take to the bill". The right column is one list of today's cards (GRACE / CARD / COUPON chips), with "Clocks running" collapsed below it.

## What changes and why
- **Nothing happened after "Recognise".** Step 2 picks one of the holder's visits today. The pinned act "Take to the bill" opens `/billing?encounterId=…` with the coupon codes already filled in. The server already honours a card that is linked to the patient: `resolveInstruments` finds it by patientId. On the money path a presented card code is treated as a coupon only (`codesAreCouponsOnly`), so a card that is not linked cannot be applied. The board sends it to Reconcile.
- **An expired card looked the same as an active one.** Status (`active/expired/suspended/cancelled`, `usable`) now leads, shown in brick red when the card cannot be used. It offers no apply act. The only act is "Bill at full rate".
- **The card code wrapped mid-code at 390px.** Every card and coupon code is one `white-space:nowrap` run in Plex Mono.
- **The 896px centred column wasted about 60% of a 1440px screen.** The screen now uses the station's three columns.
- **The screen did not say who the card belongs to.** The left lane shows the holder's name, age and sex, the UHID, and whether the card is linked to this patient.
- **Benefits were a bare list.** Each benefit shows visits left as a count, such as 3 of 4. No rupee figure appears (E-32).
- **An unknown card was a dead end.** "No match" offers grace honour (`POST /membership/grace-honor`, which needs an approval from `grace_honor.approve`).
- **Raw ISO dates** (`validTo.slice(0,10)`) are now shown as 31-Mar-2027. The server's disclosure sentence is still shown word for word.

## Needs server
1. **Holder on the recognition wire.** Recognition should return the holder's name and the linked patient's UHID, age and sex. Today only the lookup hit's `subtitle` carries the holder name, and recognition returns only `patientId`.
2. **Entitlement counters on the recognition wire.** Recognition should return granted, used and remaining for counters whose unit is `count`. `entitlementCountersOf` exists but is not exposed.
3. **"Cards today" list.** A per-counter feed of the day's recognitions and their outcome (applied, billed, expired, grace pending). No route exists. Lookups are only written to the search audit.
4. **Reason sentences for suspended and cancelled cards.** Coupons already have `unusableReason`. Memberships only have `status` and `usable`. The web can map these to sentences, so this item is optional.
5. **Web only, not server:** the billing counter should accept a `?coupon=` prefill, and the screen needs to read the patient's visits today from OPD.

## Questions for the owner
- **Rupee-balance benefits** (counter unit `paise`). Showing "₹1,250.00 left" would put a money figure on a counter screen, which E-32 forbids. The board's default is "balance left — see the bill". Should we keep that, or show the balance?
- **Expired card.** Card sales are off while O-15 is open, so the board tells the member to ask the card's issuer. Should the counter honour a card for a few days after it expires, or never?
