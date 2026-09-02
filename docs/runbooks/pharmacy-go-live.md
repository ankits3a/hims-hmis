# OPD dispense counter go-live runbook — Plan 16c

**Status: the module is CODE-COMPLETE and NOT DEPLOYED.** Nothing here has been run against
production. It is the ordered list of acts that turn the shipped module into a working counter,
each naming who performs it and what proves it worked. Read the phase doc's CLOSE
(`docs/superpowers/plans/2026-09-02-phase1-16c-opd-dispense-counter.md` §8) first: it says what is
proven by execution and what is not.

---

## 0. THE THREE THINGS THAT WILL BITE YOU IF YOU SKIP THEM

1. **Plan 14 (materials) must be deployed first.** The counter picks from `stock_batches` and
   `stock_balances` and writes neither; a box without migration `0034`+ has no shelf to pick from.
   Migration `0056` is additive and lands with the deploy.
2. **GRANT THE ROLES, NOT ONLY THE PERMISSIONS** (the lab's §0 lesson). `queued → claimed` is a
   workflow transition and the definition names ROLE KEYS `pharmacy` and `pharmacy_assistant`;
   permissions are not consulted for it. A login with every `pharmacy.*` string and no role key
   reaches every route and cannot claim.
3. **A registered pharmacist must hold `pharmacy`.** `pharmacy.dispense.scheduled` completes a
   Schedule H/H1 dispense (Pharmacy Act 1948 §42) and `handOver` checks it in the database. The
   aide's role (`pharmacy_assistant`) claims and picks and can complete an OTC-only dispense; it
   cannot verify (that places the `medication` order, which needs `orders.place`) and cannot bill.

---

## 1. Preconditions (owner / administrator)

| # | act | proof |
|---|---|---|
| 1 | Plan 14 deployed; `deploy.sh` ran `seed-materials.js` | `select count(*) from stock_batches` answers |
| 2 | `deploy.sh` ran `seed-tariff.js` (the four `pharmacy*` GST slab rows) and `seed-pharmacy.js` (the `PHARM-OPD` store, the `pharmacy_dispense` definition) | `select code from resources where kind='store'` lists `PHARM-OPD`; `select key,status from workflow_definitions where key='pharmacy_dispense'` reads `active` |
| 3 | `seed-roles.js` ran: roles `pharmacy` (19 grants) and `pharmacy_assistant` (5) exist with **no holders** | the census line in the deploy log |
| 4 | Assign `pharmacy` to the registered pharmacist(s) at `/admin/users`; `pharmacy_assistant` to the aide(s) | the person can open `/pharmacy/counter` |
| 5 | A CA has signed the GST slab rows (`seed-tariff`'s `DEV PLACEHOLDER` comments name each) | the `gst_config` rows carry the signed rates |

## 2. Master data (chief pharmacist)

| # | act | where | proof |
|---|---|---|---|
| 1 | Every medicine the counter sells is a formulary medicine with its `schedule_flag` set (`OTC`/`H`/`H1`; `X` is refused at the counter in 16c) | `/formulary` | none unclassified among sale items |
| 2 | Each such medicine has a drug ITEM (class `drug`, base unit = the unit dispensed, a strip/pack UoM, `gst_rate_bps`, HSN) | `/materials/items` | the item lists its medicine |
| 3 | Register each item for sale — this creates its tariff service `RX-<code>` in the slab's category | `/pharmacy/items` | it moves from "not yet registered" to "Registered" |
| 4 | Where an NPPA ceiling applies, record it on the item (`ceiling_paise` per pack) | materials price regulation | the bill preview shows the ceiling winning where MRP exceeds it |
| 5 | GRN stock INTO `PHARM-OPD` (or transfer to it) with batch, expiry and the printed MRP per pack | `/materials/grn` | `/pharmacy/counter` shows "N available" on a claimed line |

## 3. The seat drill (pharmacist + aide, 20 minutes, one real prescription)

1. A doctor issues an e-Rx with an OTC line, an H1 line and one brand you do not stock.
2. Scan the slip's QR at `/pharmacy/counter` → the Rx appears QUEUED with the patient's allergies.
   Try the token (`T-n`) and the UHID: the same row.
3. **Take this Rx** (aide may). Quantities prefill from dose × frequency × days; edit one.
4. Decline the unstocked line with a reason. Pick a generic equivalent for the OTC line and tick
   consent. **Verify & place order** (pharmacist): the `P` number appears; an allergy recorded after
   the Rx was issued blocks here — that is correct, send the patient back to the doctor.
5. **Pick from shelf** (aide may): FEFO's earliest batch. Try a quantity larger than that batch —
   the counter asks for a partial with a reason or a named batch.
6. The bill preview: MRP per unit, ceiling where lower, GST by slab. **Take payment & bill**
   (pharmacist; needs an open cashier session — `billing.session.own`).
7. **Hand over**: the aide is refused on the H1 line; the pharmacist must confirm the person by
   today's token or the phone's last four; then the ledger is debited, the H1 register row exists
   (`select * from pharmacy_reg_h1`), the labels print (70 × 40 mm roll, browser print).
8. Read back: `stock_balances` for the batch went down by exactly the dispensed quantity; the
   invoice lists the lines; `orders` carries a `medication` order with items `completed`.

## 4. What refuses, and why

| refusal | meaning | act |
|---|---|---|
| `store_missing` | `seed-pharmacy` did not run | §1.2 |
| `unknown_sale_item` | the drug item is not registered for sale | §2.3 |
| `price_unknown` | the batch has no MRP that divides into its base unit and no ceiling | fix the pack unit on the item or the GRN's MRP |
| `schedule_x_not_dispensed_here` | a Schedule X line — 16d's double custody | back to the doctor / the IPD pharmacy |
| `allergy_block` / `interaction_block` | the re-check on the dispensed medicine hit something the prescriber did not override | back to the doctor |
| `scheduled_needs_pharmacist` | the aide tried to complete an H/H1 dispense | call the pharmacist |
| `identity_confirmation_required` / `identity_mismatch` | a scheduled hand-over without, or with a wrong, token / phone last-4 | ask the person |
| `short_stock` | FEFO's earliest batch cannot cover the line | partial with a reason, or name a batch |

## 5. Not in 16c (do not look for it)

IPD indents and ward stock; NDPS and Schedule X custody; returns and credit notes; cold chain;
antimicrobial stewardship; the doctor ping on a held line (the counter DECLINES and the patient
walks back); walk-in retail and outside prescriptions; repeat dispensing; home delivery; counts;
the Expiry Watchman and Replenishment automations; realtime on the counter (it polls every 10 s).
