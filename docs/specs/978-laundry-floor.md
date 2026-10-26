---
issue: 978
status: approved
approved: 2026-10-26
---
# SPEC — Laundry LD-1: laundry floor, rounds, bed-ready link, holds (#978)

Status: APPROVED 2026-10-26 by the owner. It extends the linen module (#728, decision 0072). The owner's rulings for
laundry are in decision 0087. Vendor, uniforms, piece tags, chemicals and licences are LD-2 (#979).

## What

The hospital runs an in-house laundry plant and a vendor. Housekeeping and laundry meet at six hand-offs: bed
turnover, terminal clean, spill, collection, mops and shortage. This spec builds the plant side and those hand-offs.

- **Rounds.** Pickup and delivery rounds run per floor on the task engine. The ward and the runner both sign the count.
  Infected linen moves as sealed bags, counted as bags and never opened.
- **Soiled room.** Ordinary linen is sorted and counted by item. Infected linen is weighed in its sealed bag. Theatre
  sets, baby linen, mops, kitchen linen and uniforms each travel in their own stream.
- **Plant.** Washers, dryers, the calender and the boiler are machines. Each batch records its machine, program,
  temperature reached and chemical dosed. A breakdown raises a repair ticket, and the queue is routed to the vendor.
- **Quality check.** Each piece passes, is rewashed, is mended, or is condemned (two people). Clean stock goes to the
  linen store, and theatre sets go to CSSD.
- **Bed-ready link.** A bed is ready only when it is cleaned and made. If the ward shelf is short of a set, the bed
  shows "waiting for linen" and a rush top-up is raised. Rush demand comes from the day's planned discharges and the
  OT list at 09:00.
- **Holds.** Linen of an MLC patient, of a chemotherapy patient within 48 hours of a dose, or of a radioactive-iodine
  patient is blocked from laundry. Each hold is released by its owner: police hand-over, the clock, or the RSO.

## Decisions

- DECIDED by standard practice: clean and soiled never share a trolley or a lift trip. No patient name appears on any
  bag, batch or board. A correction is a new ledger entry, never an edit.
- The data carries an optional piece identity from day one, so the barcode or RFID tags (owner, 0087) slot in later.

## Done means

- **D1** A pickup is recorded only with both signatures, or as "runner only" if the ward does not sign. Infected bags
  are never counted by piece.
- **D2** An infected batch and an ordinary batch never share a machine cycle. An infected batch that misses its
  temperature or time cannot be released and goes to rewash.
- **D3** A bed cleaned on a ward short of a set shows "waiting for linen", not ready. The rush top-up clears it.
- **D4** Linen under an MLC, chemotherapy or radioactive hold cannot enter a pickup or a batch until its owner
  releases the hold.
- **D5** A machine marked down takes no new batch. Its work shows as "send to vendor".
- **D6** Every movement, including a quality-check rewash, mend or condemn, lands in the existing ledger. Weekly loss
  stays one sum.
- **D7** Theatre sets go from laundry to CSSD with a CSSD signature. Baby linen never shares a batch with adult linen.
