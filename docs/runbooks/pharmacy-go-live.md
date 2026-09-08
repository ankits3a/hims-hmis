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
| 4 | Assign `pharmacy` to the registered pharmacist(s) at `/admin/users`; `pharmacy_assistant` to the aide(s) | census row **`pharmacy_role_held`** green; the person can open `/pharmacy/counter` |
| 5 | **`materials_head` held by a human** — §2 rows 2 and 4 are theirs, not the pharmacist's | that person can open `/materials/items` |
| 6 | **`storekeeper` held by a human** — §2 row 5 is theirs | that person can open `/materials/grn` |
| 7 | **An ACTIVATED tariff version resolves today.** `previewDispenseBill` and `billDispense` both load a pricing context and throw `version_not_active` without one — and `seed-tariff` deliberately creates none | `select id, status, effective_from from tariff_versions where status = 'activated'` returns a row covering today |
| 8 | **The pharmacist can open a cashier drawer** (`billing.session.own`); billing refuses a tender with no open session | they can open a session at `/billing` |
| 9 | A CA has signed the GST rows | `select ca_signed from gst_settings where id = 'main'` → `true` |
| 10 | The pharmacist's state council registration number is on file | **the census CANNOT check this** — it is not modelled anywhere in the schema. Keep the certificate in the counter's file. |

> **§1.9 IS BLOCKED ON AN OWNER RULING AS OF 2026-09-06 — DO NOT SET PHARMACY GST RATES YET.**
> The four `pharmacy*` `gst_config` rows are seeded `exempt: true` beside a
> `DEV PLACEHOLDER — CA sign-off required (§19)` comment. While they stay exempt the counter bills
> exactly the printed MRP, which is the correct amount to the patient. **`pricing.ts` computes
> `netPaise = taxableBase + cgst + sgst` — GST ADDED ON TOP — and the taxable base for a pharmacy
> line is the printed MRP, which is tax-inclusive by statute. So signing a non-zero rate into those
> rows before the treatment question is settled makes the counter charge ABOVE the printed MRP.**
> Owner ruling R-2 answered *which slab*; it never asked inclusive-versus-exclusive.

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
> per BASE unit — per tablet — and the GRN takes the MRP per PACK. QC divides one by the other, and
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
> **And when the counter refuses `price_unknown` or QC says `mrp_unconvertible`, you are being asked
> to hand-divide** — ₹85 on a strip of 12 has no whole-paisa answer. Enter the per-tablet figure you
> chose and multiply it back before you accept it: ₹7.08 × 12 = ₹84.96, ₹7.09 × 12 = ₹85.08. Neither
> is ₹85, and which one the hospital sells at is a decision, not a rounding.

**2.2 THE GST SLAB IS SET BY NO SCREEN, AND A NULL SLAB IS SILENTLY EXEMPT.** `/materials/items`
collects neither `gst_rate_bps` nor HSN — 207 lines, zero occurrences of either. `createItem` writes
`gstRateBps: null`, and `gstCategoryFor`'s `?? 0` maps null to the `pharmacy_exempt` category. The
only writer is `PATCH /materials/items/:id`. Read back what you actually have:

```sql
select code, gst_rate_bps from items where class = 'drug' order by code;
```

**Leave it null until the owner rules** (§1.9). A null slab bills exactly the printed MRP.

> **"N available" is not a raw stock count.** It is what the pick will actually honour: recalled
> batches and batches whose printed expiry has PASSED are excluded, and reserved and frozen
> quantities are subtracted. So the counter's figure is legitimately SMALLER than
> `select sum(qty_on_hand)`, and the difference is expired or recalled stock still physically on the
> shelf. If the two disagree by a lot at go-live, look for expired batches to quarantine — not for a
> bug. **The census row `pharmacy_batch_in_stock` currently uses the RAW balance**, so it can read
> green on a box where the counter still refuses every line.

## 3. The seat drill (pharmacist + aide, 20 minutes, one real prescription)

1. A doctor issues an e-Rx with an OTC line, an H1 line, one brand you do not stock, **and one
   SOS / PRN line**.
2. Scan the slip's QR at `/pharmacy/counter` → the Rx appears QUEUED with the patient's allergies.
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

> **3.9 THE LABEL PRINTS ON A5, NOT ON A 70 × 40 mm ROLL.** The component styles a 70 × 40 mm div,
> but the only `@page` rule in the tree is `size: A5 portrait` inside a global `@media print` block,
> and `DispenseLabel` declares none of its own. Expect one A5 sheet with the labels stacked. Do not
> buy a roll printer on the strength of the sentence that used to be here.

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
> shelf, the dispense stays `billed` — **and the bill is already PAID, with no way to cancel it from
> this counter.** Quarantine the strip and send the patient to the billing desk for a credit note.
> The refund path is 16d's; this is the honest state until it lands.

## 4. What refuses, and why — all 33 codes

`errors.ts` declares 33; the table here used to name 13, and the drill above provokes several of the
missing ones. Every code's patient-facing sentence is in `apps/web/src/locales/en.json` under
`pharmacyErrors.*`; that file and `errors.ts` are pinned against each other in BOTH directions by
`apps/web/src/lib/error-strings.test.ts`.

| refusal | meaning | act |
|---|---|---|
| `permission_denied` | the login lacks the permission the route names | check the ROLE, not only the permission (§0.2) |
| `unknown_item` · `not_found` · `unknown_dispense` · `unknown_line` · `unknown_prescription` | the id does not resolve | re-scan; the row may have been superseded |
| `not_a_drug` | the item's class is not `drug` | register the right item |
| `sale_item_exists` · `unknown_sale_item` · `sale_item_inactive` | already registered, not registered, or deactivated | §2.3 |
| `price_unknown` | the batch has no MRP that divides into its base unit and no ceiling | fix the pack unit on the item, or the GRN's MRP |
| `gst_slab_unknown` | `gst_rate_bps` is not nil / 5 / 12 / 18 % | correct the item (§2.2) |
| `prescription_superseded` | the doctor re-issued the Rx | take the new one |
| `dispense_not_in_state` · `line_not_open` | the act does not match the row's state | re-read the queue |
| `schedule_x_not_dispensed_here` | a Schedule X line — 16d's double custody | back to the doctor / the IPD pharmacy |
| `unresolved_medicine` | the line names no medicine the formulary knows | back to the doctor |
| `substitution_not_allowed` | the prescriber marked `noSubstitution` | dispense as written, or call the doctor |
| `consent_required` | a generic substitution without the patient's consent ticked | ask, then tick |
| `allergy_block` · `interaction_block` | the re-check hit something the prescriber did not override | back to the doctor |
| `qty_required` | a line's quantity is blank — SOS/PRN and unknown frequencies do not prefill | type the quantity (§3.3) |
| `store_missing` | `seed-pharmacy` did not run | §1.2 |
| `scheduled_needs_pharmacist` | the aide tried to complete an H/H1 dispense | call the pharmacist |
| `identity_confirmation_required` · `identity_mismatch` | a scheduled hand-over without, or with a wrong, token / phone last-4 | ask the person |
| `nothing_to_dispense` | every line is declined | cancel the dispense instead |
| `batch_not_saleable` | the named batch cannot be sold | pick again |
| `short_stock` | the earliest IN-DATE batch cannot cover the line; the message gives both numbers | partial with a reason, or name a batch that covers it |
| `batch_expired` | a batch was NAMED and its printed expiry has passed | quarantine it; pick again without naming a batch |
| **`batch_expired_before_collection`** | in date at the pick, expired before the patient collected | §3.10 — quarantine, and the billing desk raises a credit note |
| `fefo_override_unavailable` | a named batch is the wrong item, is recalled, or cannot cover the quantity | check the carton, or let FEFO choose |
| `invoice_not_settled` | the money moved BACK after billing — a reversed allocation or a credit note | send the patient to the billing desk; the drug does not leave unpaid |

**Six refusals the counter surfaces that are NOT pharmacy's**, and staff will meet them:
`version_not_active` (§1.7) · `no_open_session` (§1.8) · `billing_not_configured` ·
`unsettled_issue_refused` · `insufficient_stock` · `batch_frozen` (a recall — DD14 refuses the
movement itself, which is why the pharmacy layer never needed its own recall check).

## 5. The pilot window

Run the counter beside the existing process, not instead of it. The module emits nine events and
**nothing in the system reads any of them**, so the harvest is a daily query, not a dashboard.

| harvest | why it matters |
|---|---|
| `dispense.queued` vs `dispense.handed_over`, same day | prescriptions that reached the counter and never left it |
| `dispense.line_declined` grouped by reason | what the shelf does not carry — the replenishment list nobody has yet |
| `dispense.cancelled` with an expiry reason | abandoned picks; if this is high, the 30-minute sweep is surprising people |
| `batch_expired_before_collection` refusals | paid-and-uncollected; each one is a credit note somebody must raise |
| `short_stock` refusals per item | the stock-out list |
| `material.consumed` vs `stock_balances` | the ledger and the shelf agreeing |

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
| 11 | `gst_rate_bps` READ BACK and left null pending the ruling (§2.2) | | | |
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
2. **Do NOT drop `pharmacy_reg_h1`.** It is the Schedule H1 register — a statutory record under the
   Drugs and Cosmetics Rules that a Drugs Inspector may ask for years later. The same holds for
   `pharmacy_dispenses`, `pharmacy_dispense_lines` and every `stock_ledger` row the counter wrote:
   they are the medical and financial record of medicine that reached a patient.
3. Stock reserved by an in-flight pick is released by `sweepExpiredPharmacyPicks` within 30 minutes,
   or by cancelling each `picked` dispense. **A `billed` dispense is not swept** and must be settled
   by the billing desk.

## 8. Not in 16c (do not look for it)

IPD indents and ward stock; NDPS and Schedule X custody; **returns, refunds and credit notes** (which
§3.10 now needs); cold chain; antimicrobial stewardship; the doctor ping on a held line; walk-in
retail and outside prescriptions; repeat dispensing; home delivery; counts; the Replenishment
automation; realtime on the counter (it polls every 10 s).

**No READ surface for the H1 register.** `pharmacy_reg_h1` is written by `handOver` and read by
nothing — no route, no screen, no export. Until 16d it is read with `psql`, and that is the only way
to answer an inspector.

**No patient's copy of the pharmacy invoice.** `billDispense` issues a real invoice with real tax
heads and `daily-close` folds it into GSTR-1, so the tax side is intact — but no screen in the
application renders an already-issued invoice, and `kernel/printing/enqueue.ts` declares four
documents, none of them an invoice. §3.10 makes this worse rather than better: a patient who has paid
and cannot collect needs a document showing what they paid for.

**Careful with "the Expiry Watchman":** the automation that WATCHES SHELF STOCK for approaching
expiry and raises alerts is not in 16c. But three expiry behaviours ARE, and they are not it — FEFO
excludes already-expired batches from every pick (§3.5), `sweepExpiredPharmacyPicks` cancels
abandoned PICK RESERVATIONS after 30 minutes, and hand over refuses a batch that expired after it was
picked (§3.10). Do not read this line as "16c does nothing about expiry".
