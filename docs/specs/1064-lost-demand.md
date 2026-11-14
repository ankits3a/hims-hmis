---
issue: 1064
status: built
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

## Built (2026-11-14)

Where the build is more precise than the text above:

- **Migration** `0233_lost_demand` (renumbered at merge): table `pharmacy_demand` (`item_id`, `medicine_id`,
  `typed_name`, `qty_asked_base`, `source`, `store_resource_id`, `dispense_id`, `short_book_entry_id`, `noted_by`,
  `noted_at`; no patient column); `pharmacy_short_book.asked_count` and `asked_qty_base` (0 on a row noted by hand)
  and source `counter`; `pharmacy_dispense_lines.declined_reason_code`.
- **Decline.** `verify.ts` `declineLine(..., now, { reasonCode })`, codes `not_in_stock`, `patient_declined`, `cost`,
  `other` (`DECLINE_REASON_CODES`); a caller sending words only declines as before and the words are never read as a
  code. Only `not_in_stock` records demand (the line's quantity, every batch of it), in the decline's transaction;
  declining the last line at the bill cancels the ticket and still records it. A line the catalogue cannot place is
  a typed name (the doctor's words). The code is kept on the line and in `dispense.line_declined`.
- **Short book.** `short-book.ts` `recordDemand`: one upsert under the open-item index raises the open entry's count
  and quantity (an entry noted by hand keeps its source) or opens one with source `counter`. Only demand for an item
  the hospital has raises it.
- **Walk-in counter.** `POST /pharmacy/retail/asked-for` (`pharmacy.retail.sell`), store PHARM-RETAIL by default. A
  typed name that is exactly an item's name or code counts as that item. The search's last row offers the note when
  nothing found can be sold (quantity 1); a tap on a row with none here offers it for that row. A `short_stock`
  refusal offers it at the quantity asked, and only when the shelf holds less than asked across all its batches.
- **Balance owed.** `pick.ts`: a line picked short for the shelf (not `short: "patient"`) records the owed quantity.
- **Report.** `GET /pharmacy/office/reports/missed-sales` (`pharmacy.reports.read`), `office-reports.ts`
  `officeMissedSales`; the 21st office report, on V, this month by default. Stock now = sellable (expired, recalled,
  reserved and frozen excluded) at PHARM-OPD, PHARM-RETAIL, PHARM-NDPS and the counters' loose trays; on order =
  approved, sent and part-received purchase orders to those stores; estimated value = quantity x the latest batch MRP
  per base unit (loose-MRP rounding), blank when no batch has an MRP. Typed names group by name in any case.
- **Desk.** The decline sheet's four pills set the code; typed words that read as a shortage are offered "not in
  stock", ticked. The separate short-book note after a decline is gone (the server does it). The reorder screen's
  short book says "patients asking · asked N times".
