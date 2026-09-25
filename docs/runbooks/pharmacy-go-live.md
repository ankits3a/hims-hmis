# OPD dispense counter go-live runbook — Plan 16c

**Status, 2026-09-06: the module IS IN PRODUCTION and CANNOT DISPENSE ANYTHING.** That is not a
contradiction and it is the most important sentence here. `PharmacyModule` and all thirteen
`/pharmacy/*` routes have been serving since 12:35 UTC on 2026-09-06, and `deploy.sh` ran
`seed-pharmacy.js`, so the `PHARM-OPD` store and the `pharmacy_dispense` definition exist. **The
shelf is empty:** zero registered sale items, zero batches. Everything between "the routes answer"
and "a pharmacist hands medicine to a patient" is §2, and every row of it is a human act that no
deploy performs.

Read the phase doc's CLOSE (`docs/superpowers/plans/2026-09-02-phase1-16c-opd-dispense-counter.md`
§8) for what is proven by execution and what is not.

> **HOW THIS DOCUMENT TREATS NUMBERS.** Where a fact can be measured on the box, this runbook tells
> you to measure it rather than repeating a number that was true when it was written. A pinned count
> in a runbook is a diagnosis with a date on it, and this one has been wrong twice.

---

## 0. THE FOUR THINGS THAT WILL BITE YOU IF YOU SKIP THEM

**0.0 THIS IS NOT A PHARMACY-ONLY DEPLOY, AND THE THING IT BREAKS IS RADIOLOGY.**

Do not read "migration 0056 is additive and lands with the deploy" — the sentence this runbook
carried until 2026-09-06 — as one migration on a box that already has materials. **Read the count
first:**

```sql
select count(*) from drizzle.__drizzle_migrations;
```

A deploy that brings a pre-pharmacy box up to `0077` applies **0056 through 0077 — twenty-two
migrations** — and most are not pharmacy's:

| migrations | what they switch on |
|---|---|
| `0060`–`0065` | **AERB radiation safety.** `assertDeviceLicensed` begins REFUSING studies on any ionising machine with no filed licence. |
| `0057` | the UHID floor |
| `0066`–`0077` | lab plate maps; radiology contrast, bedside location, outside studies |

**File every ionising machine's AERB licence BEFORE this deploy, or radiology stops the next
morning** — see `docs/runbooks/radiation-safety-go-live.md`. The pharmacy is not the risk in this
deploy; the pharmacy is the reason someone runs it.

**0.1 Plan 14 (materials) must already be deployed.** The counter picks from `stock_batches` and
`stock_balances` and writes neither. Do not pin a migration number here — the `count(*)` above
answers it, and `standup:check pharmacy` names the row that fails if it is not true.

**0.2 GRANT THE ROLES, NOT ONLY THE PERMISSIONS** (the lab's §0 lesson). `queued → claimed` is a
workflow transition and the definition names ROLE KEYS `pharmacy` and `pharmacy_assistant`;
permissions are not consulted for it. A login with every `pharmacy.*` string and no role key reaches
every route and cannot claim.

**0.3 A registered pharmacist must hold `pharmacy`.** `pharmacy.dispense.scheduled` completes a
Schedule H/H1 dispense (Pharmacy Act 1948 §42) and `handOver` checks it in the database. The aide's
role (`pharmacy_assistant`) claims and picks and can complete an OTC-only dispense; it cannot verify
(that places the `medication` order, which needs `orders.place`) and cannot bill.

---

## 1. Preconditions (owner / administrator)

**The fastest instrument is the readiness census, and it already runs on every deploy:**

```bash
pnpm --filter @hmis/core standup:check pharmacy
```

It declares six pharmacy rows. Five are checkable; the sixth says itself that it is not.

| # | act | proof |
|---|---|---|
| 1 | Plan 14 deployed; `deploy.sh` ran `seed-materials.js` | `select count(*) from stock_batches` answers |
| 2 | `seed-pharmacy.js` ran (the `PHARM-OPD` store, the `pharmacy_dispense` definition) | census rows **`pharmacy_store_present`** and **`pharmacy_definition_active`** green |
| 3 | `seed-roles.js` ran: roles `pharmacy` and `pharmacy_assistant` exist | the census line in the deploy log |
| 4 | Assign `pharmacy` to the registered pharmacist(s) at `/admin/users`; `pharmacy_assistant` to the aide(s) | census row **`pharmacy_role_held`** green; the person can open `/pharmacy/desk` (`/pharmacy/counter` forwards there since parity P1) |
| 5 | **`materials_head` held by a human** — §2 rows 2 and 4 are theirs, not the pharmacist's | that person can open `/materials/items` |
| 6 | **`storekeeper` held by a human** — §2 row 5 is theirs | that person can open `/materials/grn` |
| 7 | **An ACTIVATED tariff version resolves today.** `previewDispenseBill` and `billDispense` both load a pricing context and throw `version_not_active` without one — and `seed-tariff` deliberately creates none | `select id, status, effective_from from tariff_versions where status = 'activated'` returns a row covering today |
| 8 | **The pharmacist can open a cashier drawer** (`billing.session.own`); billing refuses a tender with no open session | they can open a session at `/billing` |
| 9 | A CA has signed the GST rows | `select ca_signed from gst_settings where id = 'main'` → `true` |
| 10 | Every pharmacist who will verify or hand over Schedule H/H1 has a current state council registration on file (pharmacy P2) | census row **`pharmacist_council_number`**. The pharmacist in charge files each colleague's registration at `/pharmacy/pharmacists`; nobody files their own. **Without one, the counter's verify and every scheduled hand-over refuse with `pharmacist_not_registered`**, and the label prints the number. A login that holds `pharmacy` but is not a pharmacist (on this deployment `admin`) stays unregistered, and so cannot verify. That is the Act, not a fault. **Renewals (P15):** census row **`pharmacist_registration_not_lapsing`** is red while any registration ends within 60 days, and the register screen marks who ("renew within N days"). File the renewed certificate before the date, because the day after it, verify refuses that pharmacist. |

> **§1.9 WAS BLOCKED ON THE INCLUSIVE-VERSUS-EXCLUSIVE QUESTION. RESOLVED 2026-09-16 (pharmacy P1,
> `docs/superpowers/plans/2026-09-16-phase-pharmacy-p1-gst-inclusive-mrp.md`).**
> - The counter now prices every line **inclusive of GST**. The patient pays the printed MRP (or the
>   NPPA ceiling plus its GST, where that is lower), and the taxable value and CGST/SGST are carved
>   out of that amount.
> - Setting a real rate on a `pharmacy*` row no longer charges above the MRP; it only makes the
>   invoice report the tax that is inside the price.
> - **What remains for the CA is the rates themselves**: which slab each medicine is in, and the
>   `ca_signed` flag.
> - The treatment is the statute's (Legal Metrology: an MRP includes all taxes; DPCO: a ceiling is
>   notified before GST), taken under the owner's 2026-09-16 instruction to follow the Indian
>   standard.

## 2. Master data — and it is FOUR people, not one

The previous version of this table was headed "(chief pharmacist)". **Three of its five rows return
403 to that role.** Each row now names the role key that can actually perform it.

| # | act | who | where | proof |
|---|---|---|---|---|
| 1 | Every medicine the counter sells is a formulary medicine with its `schedule_flag` set (`OTC`/`H`/`H1`; `X` is refused at the counter in 16c) | `pharmacy` | `/formulary` | none unclassified among sale items |
| 2 | Each such medicine has a drug ITEM (class `drug`, base unit = the unit dispensed, a strip/pack UoM, HSN) | **`materials_head`** | `/materials/items` | the item lists its medicine |
| 3 | Register each item for sale — this creates its tariff service `RX-<code>` in the slab's category | `pharmacy` | `/pharmacy/items` | census row **`pharmacy_item_present`**; it moves to "Registered" |
| 4 | Where an NPPA ceiling applies, record it on the item (`ceiling_paise` per pack) | **`materials_head`** | materials price regulation | the bill preview shows the ceiling winning where MRP exceeds it |
| 5a | **Capture** the GRN | **`storekeeper`** | `/materials/grn` | the challan is captured |
| 5b | **QC** the lines (`grn.qc`) | **`storekeeper`** | `/materials/grn` | lines accepted, or rejected with a reason |
| 5c | **Post** it into `PHARM-OPD` with batch, expiry and the printed MRP per pack | **`storekeeper`** | `/materials/grn` | census row **`pharmacy_batch_in_stock`**; the counter shows "N available" |

> **2.5 CHECK THE PER-TABLET PRICE BEFORE YOU POST, BECAUSE NOTHING ELSE WILL.** The counter bills
> per BASE unit — per tablet — and the GRN takes the MRP per PACK. QC compares one with the other, and
> **its only upper bound is a government ceiling that most items do not have** (`qc.ts` rule 7 fires
> only where `ceiling_paise` is on file, and nothing seeds one). Rule 6 catches an MRP *below* cost;
> there is no symmetric rule above it.
>
> **The error that costs a patient real money is entering the STRIP price against the TABLET unit.**
> ₹120 a strip of ten is ₹12.00 a tablet. Type `120` with the MRP unit set to `tablet` and every
> patient is billed **ten times** the right price — it passes QC, it posts, and the first person who
> notices is at the counter with a bill.
>
> So before posting, do the division yourself and say it out loud:
>
> ```
>   MRP per pack ÷ units per pack = the price ONE tablet will be billed at
>   ₹120.00 ÷ 10 = ₹12.00        <- is that what the strip's printed MRP implies?
> ```
>
> **An MRP that does not divide is NOT an error any more (owner's loose-MRP ruling, 2026-09-22).**
> ₹35.50 on a strip of 15 is 236.67 paise a tablet. Enter the MRP exactly as printed, per strip; QC
> compares it with cost exactly (no rounding), and the counter bills **a full strip at exactly ₹35.50
> and a loose tablet at ₹2.36** (the share rounded DOWN — never above MRP). 20 tablets = ₹35.50 +
> 5 × ₹2.36 = ₹47.30; the bill shows it as `20 × ₹2.36` plus a `1 × ₹0.10` line for the strip. Do
> NOT hand-divide or round the MRP yourself. QC's `mrp_unconvertible` now means only that the MRP's
> unit is missing or is not one of the item's units — fix the unit.

**2.2 THE GST SLAB (P16).** Since 22 September 2025, medicines (HSN 3003/3004) are **5%**, and the 36
drugs listed in Notification 9/2025-Central Tax (Rate), Lists 3 and 4, are **nil**. A combination is
nil only if every ingredient is on the list. Supplements sold as wellness products (HSN 2106) are
18% and are classified in the item master, not by this rule.

`/pharmacy/items` shows every drug item against that rule. It lists slabs that are blank, slabs
that differ, and sale items still billing at the rate they had when they were registered. **Apply**
fills the blanks and brings the sale items back to their slab; ticking the box also replaces the
slabs that differ. The same from a shell, dry run first:

```bash
node dist/scripts/set-drug-gst-slabs.js --as <a pharmacist login>            # prints the plan
node dist/scripts/set-drug-gst-slabs.js --as <a pharmacist login> --apply    # writes it
```

Census row **`pharmacy_gst_slab_set`** is red until every active drug item has a slab and every
sale item follows it. The bill carves the GST out of the MRP, so a slab never changes what the
patient pays; it changes what the invoice reports as tax. **Show the CA the list before go-live.**
A blank slab still bills as exempt.

> **"N available" is not a raw stock count.** It is what the pick will actually honour: recalled
> batches and batches whose printed expiry has PASSED are excluded, and reserved and frozen
> quantities are subtracted. So the counter's figure is legitimately SMALLER than
> `select sum(qty_on_hand)`, and the difference is expired or recalled stock still physically on the
> shelf. If the two disagree by a lot at go-live, look for expired batches to quarantine — not for a
> bug. `/pharmacy/reorder` lists them by batch under **"Expired, still on the shelf"**. Its
> near-expiry table lists the batches that will expire before the counter sells them (P8). **The census row `pharmacy_batch_in_stock` currently uses the RAW balance**, so it can read
> green on a box where the counter still refuses every line.

## 3. The seat drill (pharmacist + aide, 20 minutes, one real prescription)

1. A doctor issues an e-Rx with an OTC line, an H1 line, one brand you do not stock, **and one
   SOS / PRN line**.
2. Scan the slip's QR at `/pharmacy/desk` → the Rx appears QUEUED with the patient's allergies.
   Try the token (`T-n`) and the UHID: the same row.
3. **Take this Rx** (aide may). Quantities prefill from dose × frequency × days; edit one.
   **The SOS line's quantity starts BLANK and that is correct** — `prefillQtyBase` returns null for
   `sos`, `prn`, "as needed", "when required", for any non-integer duration and for any frequency
   outside its known list. The counter does not guess; the pharmacist types it. Left blank, the line
   is refused with `qty_required`.
4. Decline the unstocked line with a reason. Pick a generic equivalent for the OTC line and tick
   consent. **Verify & place order** (pharmacist): the `P` number appears; an allergy recorded after
   the Rx was issued blocks here — that is correct, send the patient back to the doctor.
5. **Pick from shelf** (aide may): FEFO's earliest batch **that is still IN DATE**. Try a quantity
   larger than that batch — the counter asks for a partial with a reason or a named batch.
   **Then prove the expiry guard, because it is the one that matters most and it is invisible from
   the screen:** GRN an EXPIRED batch of a stocked item and pick that item again. The expired batch
   must NOT be offered and must not be counted in "N available". Name it explicitly and the counter
   refuses with `batch_expired`, saying which date it died on.
6. The bill preview: MRP per unit, ceiling where lower, GST by slab. **Take payment & bill**
   (pharmacist; needs the open cashier session from §1.8).
7. **Hand over**: the aide is refused on the H1 line; the pharmacist must confirm the person by
   today's token or the phone's last four. **The Hand over button stays disabled until that box has
   a value** — the field states its requirement rather than refusing after the click. Then the ledger
   is debited, the H1 register row exists (`select * from pharmacy_reg_h1`), and the label prints
   (read §3.9 before promising anyone a roll).
8. Read back: `stock_balances` for the batch went down by exactly the dispensed quantity; the invoice
   lists the lines; `orders` carries a `medication` order with items `completed`.

> **3.9 THE BILL AND LABELS PRINT FROM THE DESK, ON THE 80 mm ROLL (parity P1, 2026-09-24).** The
> old `/pharmacy/counter` printed an A5 sheet by `window.print()`; it is retired and forwards to the
> desk. After a hand-over the desk sends the bill and one label per medicine to the logical
> destination **`pharmacy_thermal`** through the server's print relay (`kernel/printing`,
> 72 mm printable, continuous). Map that destination to the pharmacy's CUPS queue in the relay's
> config (`tools/print-relay/README.md`). Until a relay has claimed any job in the last 24 hours (or a
> `pharmacy_thermal` job in the last 7 days) the desk prints the SAME documents from the browser and
> says so once. `⋯ → Reprint` on the done screen sends a second copy.

> **A PICKED DISPENSE THAT IS ABANDONED FOR 30 MINUTES IS CANCELLED BY THE SERVER, AND THE STOCK
> GOES BACK ON THE SHELF.** `PICK_RESERVATION_MINUTES = 30`, swept every 60 seconds by the worker job
> `sweepExpiredPharmacyPicks`. This is deliberate — an abandoned pick used to hold `qty_reserved` for
> ever — but at go-live it WILL look like a dispense vanishing on its own. Tell the counter staff
> before day one: if the patient leaves to fetch money and comes back after half an hour, re-scan the
> same prescription and a fresh dispense is queued. Nothing is lost.
>
> **A BILLED dispense is never swept.** Once money has moved the medicine belongs to the patient and
> the stock stays held for them.

> **3.10 A BATCH CAN EXPIRE BETWEEN THE BILL AND THE COLLECTION, AND THE COUNTER NOW REFUSES IT.**
> Because a billed dispense is never swept, a patient who pays at 21:00 on a batch's last valid day
> and collects the next morning meets `batch_expired_before_collection`. The stock stays on the
> shelf and the dispense stays `billed`, **and the bill is already PAID.**
> - Quarantine the strip.
> - Then, since pharmacy P5, **cancel the dispense with a refund** from the billed dispense's red
>   panel: reason, and "genuine".
> - That one act frees the reserved stock, credits the invoice in full, and files the refund request.
> - The patient takes the credit-note number to billing, where an approver approves the refund and
>   the cashier pays the voucher.
> - If the patient still wants the medicine, scan the prescription again. That starts a fresh
>   dispense, which picks from a batch still in date.
> - Only a registered pharmacist (P2) holding `billing.credit_note.issue` and
>   `billing.refund.request` can do it.

> **3.11 A SEALED PACK COMES BACK (pharmacy P6, doc 16 O-7).**
> - Open the handed-over dispense.
> - Enter the quantity per line in base units: whole strips only.
> - Tick "sealed and intact" only after you have inspected the pack yourself.
> - Give the reason and press **Accept return**.
> - The pack goes back into `PHARM-OPD` on its own batch, and the invoice is credited for exactly
>   that quantity; tax and any discount are pro-rated.
> - The refund request goes to billing's approver, and the patient takes the credit-note number to
>   the billing desk.
> - Refused:
>   - after 7 days;
>   - a cut strip;
>   - a cold-chain, frozen or narcotic item;
>   - a batch with under 30 days to expiry, or recalled. Quarantine that one instead.
>   - more than was dispensed, net of earlier returns.

## 4. What refuses, and why — all 81 codes

`errors.ts` declares 81, and `modules/pharmacy/runbook-parity.test.ts` fails if this heading or the
table falls behind it. The table used to name 13, and the drill above provokes several of the
missing ones. Every code's patient-facing sentence is in `apps/web/src/locales/en.json` under
`pharmacyErrors.*`; that file and `errors.ts` are pinned against each other in BOTH directions by
`apps/web/src/lib/error-strings.test.ts`.

| refusal | meaning | act |
|---|---|---|
| `permission_denied` | the login lacks the permission the route names | check the ROLE, not only the permission (§0.2) |
| `unknown_item` · `not_found` · `unknown_dispense` · `unknown_line` · `unknown_prescription` | the id does not resolve | re-scan; the row may have been superseded |
| `not_a_drug` | the item's class is not `drug` | register the right item |
| `sale_item_exists` · `unknown_sale_item` · `sale_item_inactive` | already registered, not registered, or deactivated | §2.3 |
| `price_unknown` | the batch has no MRP (in one of the item's units) and no ceiling | record the GRN's MRP per pack, or fix its unit |
| `gst_slab_unknown` | `gst_rate_bps` is not nil / 5 / 12 / 18 % | correct the item (§2.2) |
| `prescription_superseded` | the doctor re-issued the Rx | take the new one |
| `dispense_not_in_state` · `line_not_open` | the act does not match the row's state | re-read the queue |
| `schedule_x_not_dispensed_here` | a Schedule X line — 16d's double custody | back to the doctor / the IPD pharmacy |
| `unresolved_medicine` | the line names no medicine the formulary knows | back to the doctor |
| `substitution_not_allowed` | the prescriber marked `noSubstitution` | dispense as written, or call the doctor |
| `consent_required` | a generic substitution without the patient's consent ticked | ask, then tick |
| `allergy_block` · `interaction_block` | the re-check hit something the prescriber did not override | back to the doctor |
| `authorisation_not_needed` | the doctor was asked to authorise a refusal the check does not raise on that line | ask about the refusal the line actually shows |
| `authorisation_not_pending` · `unknown_authorisation` | the request was already decided, or does not exist | read the decision on the ticket |
| `invalid_short_book_entry` · `unknown_short_book_entry` · `short_book_resolved` | a short-book note with no real drug name or a zero quantity; a row that is gone; a row already ordered, received or dismissed | name the drug; re-read `/pharmacy/reorder` |
| `nothing_to_print` | the desk asked for the bill and labels before the ticket was billed | take the money first; the paper follows the hand-over |
| `invalid_shelf_location` | a rack label longer than 24 characters — the line cannot print it | shorten it ("R-12", "rack 3 · shelf 2") |
| `duplicate_block` · `drug_disease_block` | the medicine chosen for a line nobody could place repeats a moiety already prescribed; or a coded diagnosis forbids a line and no prescriber ruled on it (a reading, or a diagnosis coded after issue) | choose another, decline the line, or back to the doctor |
| `qty_required` | a line's quantity is blank — SOS/PRN and unknown frequencies do not prefill | type the quantity (§3.3) |
| `store_missing` | `seed-pharmacy` did not run | §1.2 |
| `scheduled_needs_pharmacist` | the aide tried to complete an H/H1 dispense | call the pharmacist |
| `identity_confirmation_required` · `identity_mismatch` | a scheduled hand-over without, or with a wrong, token / phone last-4 | ask the person |
| `pharmacist_not_registered` | verify, or a Schedule H/H1 hand-over, by a login with no current state council registration on file (P2) | the pharmacist in charge files it at `/pharmacy/pharmacists`; until then a registered pharmacist does the act |
| `self_registration` · `not_a_pharmacist_role` · `invalid_registration` · `registration_expired` · `registration_in_use` · `registration_ended` | filing or ending a registration: one's own, for someone without the `pharmacy` role, a blank or malformed field, a lapsed certificate, a number already on file for someone else, or a row already ended | a colleague files it; assign the role first; file the renewed certificate; end the wrong row first |
| `nothing_to_dispense` | every line is declined | cancel the dispense instead |
| `batch_not_saleable` | the named batch cannot be sold | pick again |
| `short_stock` | the earliest IN-DATE batch cannot cover the line; the message gives both numbers | partial with a reason, or name a batch that covers it |
| `batch_expired` | a batch was NAMED and its printed expiry has passed | quarantine it; pick again without naming a batch |
| **`batch_expired_before_collection`** | in date at the pick, expired before the patient collected | §3.10 — quarantine; cancel with a refund at the counter (P5), then scan the Rx again if the patient still wants it |
| `reason_required` | a paid dispense cancelled with no reason the refund approver can read | type the reason |
| `return_window_closed` · `return_not_sealed` · `return_cut_strip` · `return_not_accepted` · `return_short_expiry` · `return_exceeds_dispensed` | a sales return outside O-7: more than 7 days after the hand-over (or the walk-in sale), not attested sealed, a cut strip, a cold-chain/frozen/narcotic item, a batch too near expiry or recalled, or more than was dispensed or sold | §3.11 (counter), §9 (walk-in) — refuse the return; quarantine a short-dated or recalled batch |
| `fefo_override_unavailable` | a named batch is the wrong item, is recalled, or cannot cover the quantity | check the carton, or let FEFO choose |
| `slip_not_confirmed` | the prescription was typed from the doctor's paper slip and nobody has checked it against the slip | check the lines against the slip (the photo on the visit, or the patient's paper), confirm, then bill |
| `invalid_day` · `invalid_range` | the counter's day (P7) or the H1 register's period (P9) is not a real date, runs backwards, or covers more than 31 days | choose the date or the month again |
| `scan_unknown` · `scan_wrong_item` · `scan_batch_unknown` · `scan_batch_mismatch` | a pack scanned at the pick (P13): a code no item carries, another medicine's pack, a batch the counter does not hold, or a printed expiry that disagrees with the books | register the barcode at `/materials/items`, or pick without scanning; put the wrong pack back; check the GRN |
| `invoice_not_settled` | the money moved BACK after billing — a reversed allocation or a credit note | send the patient to the billing desk; the drug does not leave unpaid |
| `retail_licence_missing` · `retail_licence_lapsed` · `invalid_retail_licence` | the walk-in counter (P19) has no Form 20/21 licence recorded, or none covering today; or the licence form was incomplete or its dates run backwards | §9 — the pharmacist in charge records the (renewed) licence |
| `retail_store_missing` | `seed-pharmacy` did not create `PHARM-RETAIL` | §1.2 |
| `prescription_required` · `invalid_prescription` | a walk-in Schedule H/H1 line with no outside prescription captured; or the prescriber's name, registration number or address is blank, or the date is after today | §9 — capture the prescription, or remove the line |
| `registration_not_permitted` · `duplicate_suspected` | registering a walk-in customer without `patients.register`; or someone already registered closely matches | find the customer by mobile or UHID; pick the match, or confirm they are someone new |
| `unknown_retail_sale` | the walk-in sale id, or the bill number typed to take a pack back, does not resolve | re-open it from the day's list, or read the number off the bill again (a counter dispense's bill is returned at the counter, §3.11) |
| `document_store_unavailable` | the prescription photo could not be written: the document store (`DOCUMENT_STORE_PATH`) is not writable. Nothing was sold | IT: in production the image owns `/var/lib/hmis/documents` and the `hmis_prod_documents` volume is mounted there; check the mount (the API logs a `DOCUMENT_STORE_PATH is not writable` warning at boot), then sell again |
| `sheet_invalid` · `sheet_already_entered` | a paper dispense (P20) scanned from something that is not a downtime kit's receipt sheet, or a sheet already entered | §10 — scan the QR on the receipt sheet; open the entry already made |
| `invalid_dispense_time` · `not_in_downtime` · `backfill_window_closed` | the time on the sheet is in the future, before the kit was printed, outside a declared outage, or more than 7 days ago | §10 — check the time written on the sheet; an older sheet is an incident for the pharmacist in charge |
| `batch_required` · `unknown_pharmacist` | a paper line without its batch, or a person named as handing it over who is not pharmacy staff | copy the batch from the sheet; name the pharmacist who was on duty |

**Six refusals the counter surfaces that are NOT pharmacy's**, and staff will meet them:
`version_not_active` (§1.7) · `no_open_session` (§1.8) · `billing_not_configured` ·
`unsettled_issue_refused` · `insufficient_stock` · `batch_frozen` (a recall — DD14 refuses the
movement itself, which is why the pharmacy layer never needed its own recall check).

## 5. The pilot window

Run the counter beside the existing process, not instead of it. The counter's own line
(P7, `GET /pharmacy/summary`) shows the day: handed over, waits, backlog, declines, refunds,
returns. The reorder list (P4, P8) is the stock-out and near-expiry view. Everything else below is
still a daily query.

| harvest | why it matters |
|---|---|
| `dispense.queued` vs `dispense.handed_over`, same day (the day strip's "not collected N of M", P14) | prescriptions that reached the counter and never left it |
| `dispense.line_declined` grouped by reason | what the shelf does not carry. The day strip names the top reason, and `/pharmacy/reorder` is the list |
| `dispense.cancelled` with an expiry reason | abandoned picks; if this is high, the 30-minute sweep is surprising people |
| `batch_expired_before_collection` refusals | paid-and-uncollected; each one is a credit note somebody must raise |
| `short_stock` refusals per item | the stock-out list |
| a **blind count** of `PHARM-OPD` each week (`/materials/counts`, scheduled by the materials head, counted by a storekeeper) | the ledger and the shelf agreeing, line by line, with sales during the count reconciled. A variance is booked only after the medical superintendent approves it (the head asks on the count's review; the MS decides in the approvals inbox; the head books it) |

**Close the window when the last three are empty for a week.**

## 6. Executed on UAT — **NOT YET RUN**

Nothing in this runbook has been performed anywhere. This section is where that is recorded, and it
is a GATE: the phase is not complete until every row carries a date and an initial.

| # | act | who | done (date / initials) | what you saw |
|---|---|---|---|---|
| 1 | migration count read BEFORE the deploy (§0.0) | | | count = |
| 2 | AERB licences filed for every ionising machine (§0.0) | | | |
| 3 | deploy reached 8/8 | | | |
| 4 | `standup:check pharmacy` — RED rows copied here verbatim | | | |
| 5 | `pharmacy` and `pharmacy_assistant` each held by a real human (§1.4) | | | |
| 6 | `materials_head` and `storekeeper` held (§1.5, §1.6) | | | |
| 7 | an activated tariff version resolves today (§1.7) | | | |
| 8 | pharmacist opened a cashier drawer (§1.8) | | | |
| 9 | formulary medicines classified (§2.1) | | | |
| 10 | drug items created (§2.2) | | | |
| 11 | `gst_rate_bps` set from the CA's slab list and READ BACK (§2.2) | | | |
| 12 | sale items registered (§2.3) | | | |
| 13 | NPPA ceilings recorded where they apply (§2.4) | | | |
| 14 | GRN captured / QC'd / posted (§2.5a–c) | | | |
| 14b | **per-tablet price checked by hand before posting (§2.5)** — record the figure | | | |
| 15 | drill 1–4: scan, take, decline, verify | | | |
| 16 | drill 5: FEFO pick **and the expired-batch proof** | | | |
| 17 | drill 5: the SOS line's blank quantity met and typed | | | |
| 18 | drill 6: billed at the previewed payable | | | |
| 19 | drill 7: aide refused, pharmacist confirmed identity, H1 row exists | | | |
| 20 | drill 8: ledger, invoice and order read back | | | |
| 21 | **deliberate 30-minute abandonment** — the pick self-cancelled and the stock returned | | | |
| 22 | label printed — record the PAPER SIZE it actually came out on (§3.9) | | | |

**Defects log** — anything seen here that this runbook does not predict:

| # | what happened | what was expected | raised as |
|---|---|---|---|

## 7. Rollback — taking the counter out of service

No migration is reversed and no table is dropped.

1. Remove `PharmacyModule` from `apps/core/src/app.module.ts` and `pharmacyManifest` from
   `kernel/modules/manifests.ts`, then deploy. Every `/pharmacy/*` route 404s and the nav links go
   with them.
2. **Do NOT drop `pharmacy_reg_h1`, `pharmacy_retail_sales`, `pharmacy_retail_sale_lines` or
   `pharmacy_retail_licences`.** The walk-in tables are sale records and the H1 register now holds
   walk-in rows too. **Do NOT drop `pharmacy_reg_h1`.** It is the Schedule H1 register — a statutory record under the
   Drugs and Cosmetics Rules that a Drugs Inspector may ask for years later. The same holds for
   `pharmacy_dispenses`, `pharmacy_dispense_lines` and every `stock_ledger` row the counter wrote:
   they are the medical and financial record of medicine that reached a patient.
3. Stock reserved by an in-flight pick is released by `sweepExpiredPharmacyPicks` within 30 minutes,
   or by cancelling each `picked` dispense. **A `billed` dispense is not swept** and must be settled
   by the billing desk.

## 8. Not in 16c (do not look for it)

IPD indents and ward stock; NDPS and Schedule X custody; returns of cold-chain, frozen and
narcotic items (sealed ambient packs come back since P6, §3.11, and at the walk-in counter since
P19b, §9; a billed dispense never collected is cancelled with a refund since P5, §3.10); cold chain;
antimicrobial stewardship; the doctor ping on a held line; repeat dispensing; home delivery; a Replenishment agent
that ORDERS (P4 and P8 give the reorder list, a read that proposes and moves nothing); realtime on
the counter (it polls every 10 s).

**The H1 register has a reader since P9.** `/pharmacy/registers/h1` shows a month of it, in the
order the entries were written, and prints it with the rule, the period, a line for the drug licence
number and the pharmacist's signature. It needs `pharmacy.register.read` (the `pharmacy` role, the
pharmacist in charge, the medical superintendent and the owner). Every patient it shows is logged as
a PHI access.

**Who prints the unredacted copy (P17).** A sealed patient's name and address print only for
holders of `pharmacy.register.read_sealed`:
- the pharmacist in charge (role `pharmacy_incharge`, held with `pharmacy`), who is named on the
  drug licence and produces the register to the inspector;
- the medical superintendent;
- the owner.
Every sealed row they read is logged as a sealed access. Other pharmacists see the alias, marked
"sealed record". To let the `admin` login print it, give `admin` the `owner` role at `/admin/users`.

**The patient's copy of the bill is printed at the counter since P10.** A billed or handed-over
dispense shows **Print bill**. It opens billing's own printed invoice (letterhead, lines, tax heads,
settlement, signed QR) with a batch table added (drug, batch, expiry, quantity) and "Dispensed by …
· Reg. …". The counter steps aside while the bill is on screen. `billing.invoice.read`, which
`pharmacy` already holds, is the grant it uses. For a patient who paid and could not collect (§3.10),
the same bill shows what was paid, and the credit note is billing's.

**Careful with "the Expiry Watchman":** the automation that WATCHES SHELF STOCK for approaching
expiry and raises ALERTS is not in 16c. The reorder screen READS it (P8): what will expire at the
counter before it sells, and expired stock still on the shelf. But three expiry behaviours ARE, and they are not it — FEFO
excludes already-expired batches from every pick (§3.5), `sweepExpiredPharmacyPicks` cancels
abandoned PICK RESERVATIONS after 30 minutes, and hand over refuses a batch that expired after it was
picked (§3.10). Do not read this line as "16c does nothing about expiry".

## 9. The walk-in retail counter (P19)

Doc 16 §3.1b and register row R-174. A walk-in sale is not a dispense: it has no visit and no doctor
in this hospital, so it places no order. It uses the same stock ledger, price rule, GST slab, billing,
register of pharmacists and H1 register as the counter. Phase doc
`docs/superpowers/plans/2026-09-17-phase-pharmacy-p19-retail-sales.md`.

| step | who | where | done when |
|---|---|---|---|
| 9.1 | `seed-pharmacy.js` (every deploy) creates the `PHARM-RETAIL` store, kept by `pharmacy` and `pharmacy_assistant` | deploy | census row **`pharmacy_retail_store_present`** green |
| 9.2 | **Record the retail licence**: the Form 20 and Form 21 numbers, valid from and to, and the pharmacist in charge named on it. A renewal is a new entry | **`pharmacy_incharge`**, the MS or the owner | `/pharmacy/retail-licence` | census row **`pharmacy_retail_licence`** green; the counter's banner goes away |
| 9.3 | Stock the shelf: post the goods receipt into `PHARM-RETAIL` as §2 step 5c does for `PHARM-OPD`, or send it from the main store at **Stock transfers** and have a pharmacist confirm what arrived there (the storekeeper who sent it cannot, and only pharmacy staff receive into a pharmacy store). The OPD counter's shelf is never sold from | **`storekeeper`** sends; **`pharmacy`** confirms | `/materials/grn` or `/materials/transfers` | the walk-in screen shows "N available" |
| 9.4 | Sell | **`pharmacy`** | `/pharmacy/retail` | a paid bill, printed from the sale |

**Until 9.2 is done every walk-in sale refuses** (`retail_licence_missing`), and the day after the
licence ends it refuses again (`retail_licence_lapsed`). Selling to the public without a Form 20/21
licence is an offence under the Drugs and Cosmetics Act 1940 §18(c). The OPD counter is unaffected.

**At the counter:**
- **Every bill names a registered person.** Find the customer by mobile or UHID, or register them
  there (name, sex, age, mobile). A close match is shown and never attached automatically: pick it,
  or confirm the customer is someone new. There is no anonymous sale, because the cash limit is
  counted per person per day.
- **Unscheduled and OTC medicines** sell without a prescription.
- **Schedule H and H1** sell only on a prescription the customer brings. Type the prescriber's name,
  registration number and address and the prescription's date, and photograph it; the photo is filed
  on the customer's record. Only a pharmacist with a current council registration completes such a
  sale. Stamp the paper prescription as dispensed. Every H1 line is written to the H1 register with
  the outside prescriber's name and address.
- **Schedule X** is not sold here.
- **A customer recorded allergic** to a line, or a severe interaction with their current medicines,
  refuses the sale: refer them to their prescriber. There is no override at this counter.
- Each line takes one batch, earliest in-date first. A quantity the first batch cannot cover is
  refused with what it holds: sell less, or add a second line.

**A sealed pack comes back (P19b).** At `/pharmacy/retail`, under "Take back a sealed pack", type the
bill number and find the sale. The rules are the counter's (§3.11), counted from the time of the sale:
- within **7 days**, sealed and intact (inspect it and tick the box), in whole strips;
- never a cold-chain, frozen or narcotic item, and never a batch recalled or under 30 days to expiry
  (quarantine it instead);
- never more than was sold on the line, less what already came back. The screen shows both numbers.

Say why, and whose reason it is: the customer no longer needs it, or the counter sold the wrong item.
Only a pharmacist with a current council registration accepts it. The pack goes back on the shelf it
was sold from, a credit note is raised for exactly that quantity, and the refund waits for billing's
approval; the cashier pays it by voucher. **A return does not need a current retail licence**: it
sells nothing, and a restocked pack cannot be sold again until the licence is current. The H1
register keeps its row, as at the counter; the return is recorded against the sale.

A paper dispense (§10) is returned the same way, by its bill number, into the counter it left from.

**The leakage report (P12) reads either counter** since P19b. At `/pharmacy/leakage`, choose
"Walk-in retail (PHARM-RETAIL)" to see a walk-in bill whose stock and money do not agree (it is named
by its bill number), and stock that left the walk-in shelf with no sale behind it. A paper dispense
is a sold line in its counter's report, not stock "consumed outside a dispense".

## 10. Paper dispenses after an outage (P20)

When the duty manager declares **downtime** at `/ops/mode`, the counters keep working on paper.
- **Before an outage.** Keep a downtime kit printed from `/ops/downtime-kit` at each counter, with
  **receipt** sheets for the desks `pharmacy-counter` and `pharmacy-retail`. Every sheet carries a
  serial and a signed QR.
- **During the outage.** Write each dispense on its own receipt sheet:
  - the patient's name and UHID (or name, age and mobile);
  - each medicine with its **batch** and quantity;
  - the time;
  - who handed it over;
  - the amount and how it was paid;
  - for Schedule H/H1, the prescriber's name, registration number and address, and the
    prescription's date.

  Keep the cash with the sheets.
- **After recovery**, at `/pharmacy/downtime` (**`pharmacy`**, permission `pharmacy.downtime.enter`),
  enter each sheet within **7 days**:
  1. Scan the sheet's QR. The screen says which desk it came from, or that it was already entered.
  2. Choose the counter the medicine left from, and type the time on the sheet.
  3. Name who handed it over.
  4. Find or register the customer.
  5. Add each line with the batch written on the sheet.
  6. For Schedule H/H1, add the prescription details and a photo of the sheet or prescription.
  7. Enter what was paid. Stamp the sheet "entered" and file it.

**What the entry does:**
- Stock leaves the named batch **at the time on the sheet**.
- The H1 register is written with that date and the handing-over pharmacist's registration number.
- The invoice is issued **at entry**, with a number from the day of entry. The sheet's serial is a
  reconciliation key, not an invoice number.

**What it refuses:**
- a sheet that is not a kit receipt;
- a sheet entered twice;
- a time outside the declared outage, before the kit was printed, or in the future;
- a batch that had expired by the time on the sheet;
- a Schedule H/H1 line without its prescription, or handed over by someone with no council
  registration that day;
- a walk-in counter sheet with no retail licence that day.

**What it only records:** an allergy or interaction the entry finds. The medicine has already been
taken, so the pharmacist in charge follows up with the patient.

**A queued OPD prescription that was dispensed on paper** stays in the counter's queue. Cancel it
there with the reason "dispensed on paper, sheet N", so it is not dispensed twice.

## 11. Buying — purchase orders (parity P2)

Everything here is at **`/pharmacy/office`** (permission `materials.po.raise`, held by
`materials_head` and `pharmacy`). `deploy.sh` runs `seed:materials`, which registers the two
approval types an order needs (`pharmacy_po_approval_registered`).

- **Assign an approver.** `materials_head` approves every order up to ₹50,000, GST included. The
  owner approves anything above. Both limits are defaults the owner may change
  (`materials/config.ts`). Nobody approves an order they drafted or submitted.
  `pharmacy_po_approver_held` stays RED until an active person holds `materials_head`.
- **Set levels.** On `/pharmacy/reorder`, give each regularly bought drug a min, reorder and max,
  in tablets or other base units. At or below the reorder level the list suggests
  `max − (on hand + on order)`.
- **Let the agent draft.** Say "order karo" at the desk (F2), or press **Make the drafts** in the
  office. The agent writes one draft order per supplier, from:
  - the reorder list;
  - the open short book.

  Each item is priced at its last goods-receipt rate and addressed to its last supplier. An item
  nobody has supplied is left for you to give a vendor. Check quantities and rates, then press
  **Submit**.
- **Approve, then send.** The approver presses **A** on the order, or decides it in `/approvals`.
  Rejecting it needs a reason and returns it to draft. Print the approved order (the page saves as
  PDF), send it to the supplier, and press **Send**.
- **Receive against it.** At `/materials/grn`, choose the vendor and then its order. The lines
  fill in with what is still owed. The gate refuses:
  - the person who approved the order;
  - more than 2% over the ordered quantity (free goods go on their own line);
  - an item the order does not carry.

  Less than ordered leaves the order part received, and the rest stays open.

## 12. Paying suppliers — bills, payables and the payment run (parity P3)

Everything here is at **`/pharmacy/office`, the Pay side** (the Buy | Pay switch at the top). Bills
need `materials.bills.manage` (`materials_head`, `pharmacy`); runs need `materials.payments.prepare`
and `materials.payments.record` (`materials_head`, `pharmacy_incharge`). `deploy.sh` runs
`seed:materials`, which registers `materials_payment_run_approval`
(`pharmacy_payment_run_approval_registered`).

- **Assign the people.** The owner authorises every payment run (`pharmacy_payment_authoriser_held`
  is RED until an active person holds `owner`). Somebody other than the owner records the run paid
  (`pharmacy_payment_recorder_held` is RED until an active person holds `materials_head` or
  `pharmacy_incharge`). Nobody authorises a run they prepared, and whoever authorised a run cannot
  record it paid.
- **Enter the bill.** Each posted goods receipt without a bill shows under *Bills to enter or match*.
  Open it: the agent has filled in what the gate accepted at the order's rate and GST. Type the
  vendor's bill number and date, change any line the vendor billed differently, and press ⏎.
- **The match.** A line's value may differ from received × order rate by 1% or ₹10, whichever is
  larger (a default the owner may change). Beyond that, or with a different GST rate, more billed
  than received, or a received item left off, the bill is *held for match*. The materials head
  opens it, sees why line by line, and accepts the difference with a reason — never on a bill they
  entered. A matched bill is booked with **A**.
- **Due dates.** An MSME vendor (`msme_class` set on the vendor) is due within 45 days of the goods'
  acceptance, sooner if their terms say so (MSMED Act s.15). Other vendors are due their payment
  terms after the bill date (30 days when none are recorded).
- **The payment run.** Press **D** (Make the draft), or say "payment run bana do" at the desk (F2).
  The agent lists every bill due within the week, overdue first, MSME vendors first. A vendor whose
  bank details changed in the last 7 days is left out until the cooling-off ends. Tick **Full** or
  type a part payment per bill, then **Submit for the owner**. The owner authorises it in
  `/approvals`.
- **Record it paid.** After paying through the bank, open the run and, per vendor, choose the mode,
  type the UTR or cheque number, and press **Mark paid**. Cash to one vendor in one day stops at
  ₹10,000 (Income-tax Act s.40A(3)); anything more goes by bank.
- **Payables.** Press **P** for ageing (0–30 / 31–60 / 61–90 / 90+ days) and the Supplier Summary;
  a supplier opens its ledger. Both export CSV.

## 13. Returns — expiry to the supplier, the credit, destruction and recalls (parity P4)

Everything here is at **`/pharmacy/office`, the Returns side** (Buy | Pay | Returns). Returns need
`materials.returns.manage` (`materials_head`, `pharmacy`) and the head's `materials.returns.approve`;
the vendor's credit note needs `materials.bills.manage`; write-offs need `materials.writeoffs.manage`
(`materials_head`, `pharmacy_incharge`); recalls need `materials.recall.manage` (`materials_head`,
`pharmacy_incharge`). `deploy.sh` runs `seed:materials`, which registers `materials_stock_adjustment`,
the write-off's approval (`pharmacy_writeoff_approval_registered`).

- **Assign the people.** The materials head approves every return (`pharmacy_return_approver_held` is
  RED until an active person holds `materials_head`); nobody approves a return they drafted, and
  whoever approved it does not dispatch it. The medical superintendent approves every destruction
  write-off (`pharmacy_writeoff_approver_held` is RED until an active person holds
  `medical_superintendent`).
- **The expiry report.** Press **E**. Presets: expired, next 30 / 60 / 90 days, or a custom range.
  *Item-wise* lists each store's batch with its quantity in packs and tablets, MRP, cost value, the
  supplier (the hospital's OPENING STOCK and TRIAL STOCK show as such), the last day it may go back,
  and the return or write-off already raised. *Supplier-wise* groups the same rows by supplier with
  what can still go back. Both export CSV.
- **The return window** (a default the owner may change): a vendor takes an expired batch back up to
  90 days after its expiry (`vendors.expiry_return_days` sets a vendor's own), and a batch within 90
  days of expiry any time. A recalled batch goes back whatever its date.
- **The agent's drafts.** Press **D** (or say "expiry return bana do" at the desk, F2). The agent
  lists one return per vendor at the GRN's cost and the purchase's GST, and apart from it what can
  only be destroyed. Untick a vendor to leave it out; **Make the drafts** writes DRAFTS only.
- **Approve, dispatch.** The head opens a draft and presses **A**. Somebody else presses **D**
  (*Dispatch and issue the debit note*) when the goods leave: the stock goes out of the store and our
  debit note (`MDN…`) is issued with the vendor's GSTIN and the CGST + SGST or IGST reversal. **P**
  prints it to go with the goods.
- **The vendor's credit note.** When it arrives, open the return, type the vendor's credit note
  number, date and amount, and record it. Less than our debit note needs the reason, and the materials
  head. The credit is set off on the next payment run (the run grid's Credit column; Payable = Total −
  Credit) and appears in the supplier's ledger. A return the vendor will never credit is closed by the
  head with the reason (⋯).
- **Destruction (BMW Rules 2016).** Press **W**: the agent's "cannot go back" list for a store. Tick
  and count what goes, and send it to the medical superintendent, who approves it in `/approvals`. When
  the common treatment facility collects it, open the write-off, type the agency, its manifest or
  challan number and the date, and press *Hand over and write off*. Print the manifest for the file.
- **Recall.** Press **R**, find the item, pick the batch, say which alert (CDSCO / manufacturer / our
  own) and why: the batch freezes in every store. Its sheet shows where it still sits and who it was
  dispensed to (names and phone numbers for the callback; reading the list is logged). *Return it to
  the supplier* drafts its return in one tap; a batch nobody can take back is destroyed with a
  write-off. Close the recall when no store holds any of it.
