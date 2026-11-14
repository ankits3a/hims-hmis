---
issue: 1064
status: approved
approved: 2026-11-14
---
# SPEC — Medicines asked for but not supplied: lost demand and the missed-sales report (#1064)

Status: APPROVED 2026-11-14 by the owner ("Yes, build" with the defaults).

## What

A line declined at the OPD desk keeps only free text, and a walk-in patient who asks for a medicine the counter does
not stock leaves no trace. The short book (`pharmacy/short-book.ts`) is typed by hand, so the medicines patients ask
for most and do not get are never counted. Source: P0 item 3 of the pharmacy software study of 2026-11-14.

## Decisions (DECIDED by the agent)

- **Where demand is recorded.** (a) An OPD desk decline with the reason "Not in stock". The decline gets a short
  reason list: not in stock, patient declined, cost, other (typed); free text stays allowed. (b) The walk-in counter:
  a search that finds no stock, or a line larger than the stock (`short_stock`), offers "Note as asked for" with the
  quantity. A name that is not in the catalogue may be typed. (c) A line picked short that leaves a balance owed.
- **One demand row each:** medicine (or typed name), quantity asked in base units, store, source (`desk_decline`,
  `counter_search`, `counter_short`, `balance_owed`), who, when, and the ticket or sale when there is one. No patient
  name is stored on the row or shown on the report.
- **Short book.** Each demand for a catalogue medicine adds to the short book with source `counter`; while that
  medicine has an open entry, the entry's asked count and quantity rise instead of a new line being added.
- **Report** "Missed sales" in the office reports: by medicine for a date range, times asked, quantity, estimated
  value (last batch MRP, else blank), stock now, open PO quantity; typed names not in the catalogue listed apart for a
  new-item request. Same right as the sales report.

## Done means

- **D1** Declining a desk line as "Not in stock" records a demand row and a short-book entry with source counter.
- **D2** Declining a line for any other reason records no demand.
- **D3** At the walk-in counter, "Note as asked for" after a search with no stock records a demand and a short-book
  entry; a typed name not in the catalogue records a demand without a short-book entry.
- **D4** The same medicine asked for three times while its short-book entry is open leaves one entry with the asked
  count 3 and the quantities summed.
- **D5** A line picked short with a balance owed records a demand for the owed quantity.
- **D6** The Missed sales report lists each medicine with times asked, quantity, estimated value, stock now and open
  PO quantity, and the typed names apart.
