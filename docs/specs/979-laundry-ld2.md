---
issue: 979
status: approved
approved: 2026-10-27
---
# SPEC — Laundry LD-2: vendor per piece, recovery when below par, uniforms, piece tags, chemicals, licences (#979)

Status: APPROVED 2026-10-27 — owner 2026-10-27: specs yes (all defaults). Builds on LD-1 (#978, `docs/specs/978-laundry-floor.md`): the
ledger, vendor-mode batches (`routeToVendor`, `receiveFromLaundry` with short variances), quality check, and the empty
piece table `linen_pieces`. Rulings: decision 0087; the four money answers below are decision 0092.

## What

The vendor is paid for exactly the pieces it washed and returned, and the hospital knows what laundry costs.

- **Challans.** Every vendor batch leaves on an outward challan (items, counts, weight) and returns against it. At the
  dock each piece is accepted, refused as damaged or stained (back for free rewash), or recorded missing.
- **Per-piece money.** A rate card per item per vendor, with dates. The month's vendor bill is checked against accepted
  returns: pieces billed above pieces accepted are flagged. The checked bill becomes a payable in materials.
- **Monthly vendor report and recovery.** Per month: pieces sent, lost, damaged, batches late. If lost plus damaged is
  more than 0.5% of pieces sent, or late batches are more than 10% of batches, the vendor is below par and the system
  proposes a recovery at each lost or damaged piece's replacement cost. The owner or finance approves, edits or
  rejects it. At or within par, the report is shown and nothing is recovered.
- **Uniforms.** Staff in nurse, lab technician, OT and housekeeping roles (plus roles added in setup) are issued sets
  against their name. Exchange is one dirty for one clean. On exit, open uniforms show on the leaver's no-dues list.
- **Piece tags.** A piece can be registered with a tag (barcode or RFID). When a tag is scanned at any count, it moves
  that piece; bundles without tags keep hand counts. Both land in the same ledger.
- **Chemicals.** Stores issues detergent and chemicals to the laundry cost centre (materials issue). The plant read shows
  chemical used per kg washed per month, in-house against the vendor's per-kg cost.
- **Licences.** The wastewater (ETP) consent and the boiler licence carry an expiry date and show on the compliance
  calendar, red at 60 days.

## Decisions

- DECIDED (standard practice): turnaround is 24 hours for routine linen and 12 hours for theatre and rush batches;
  editable per vendor. A batch is late if any of it returns after its turnaround.
- DECIDED: below-par is computed on the calendar month on pieces sent to the vendor that month. A piece missing 7 days
  after its batch was due is lost; a piece the vendor returns later is reversed off the next report. A stained piece sent
  back for rewash counts as damaged only if quality check later condemns it.
- DECIDED: uniform entitlement is three sets per person (one worn, one in the wash, one spare); sizes in setup.
- DECIDED: a tag is unique across the hospital; a tag read on a piece already condemned is refused.
- DECIDED: no patient or staff name appears on a challan; uniforms carry staff id only.

## Owner rulings (money / law), 2026-10-27 — the recommended defaults, all accepted

1. **Replacement cost per piece.** Ruled: the last purchase price of that item from a stores goods receipt; if none,
   the price on the item master.
2. **Paying the vendor bill.** Ruled: the payable is the accepted-piece count times the rate card plus GST; a bill
   above that is held until stores approves the difference.
3. **Uniforms not returned on exit.** Ruled: they block the no-dues clearance; the cost is recovered from the final
   settlement at replacement cost less 1/12 per month of use (nothing after a year), with HR approval, and the
   appointment letter must say so (Payment of Wages Act deduction).
4. **Small-month floor for recovery.** Ruled: if fewer than 1,000 pieces went to the vendor that month, below-par uses
   lost plus damaged more than 5 pieces instead of 0.5%, so one piece cannot swing the test.

## Done means

- **D1** A vendor batch cannot leave without an outward challan of items, counts and weight; its return is recorded
  against that challan with each piece accepted, refused (damaged or stained) or missing.
- **D2** A monthly vendor report gives pieces sent, lost, damaged and late batches; with lost plus damaged above 0.5% of
  pieces sent, or late batches above 10%, it proposes a recovery at replacement cost per piece; at or within par it
  proposes none.
- **D3** A recovery takes effect only after the owner's or finance's approval, is never approved by its proposer, and a
  piece later returned is reversed on the next report.
- **D4** A vendor bill line for more pieces than were accepted that month is flagged; the payable equals accepted pieces
  times the rate card in force on the return date.
- **D5** A uniform exchange issues one clean set only against one dirty set; a leaver's unreturned sets show on the
  no-dues list.
- **D6** A tagged piece scanned at a count or round moves that piece in the ledger; an untagged bundle counted by hand
  moves the same totals; a condemned piece's tag is refused.
- **D7** The plant read shows chemical issued per kg washed for the month, from stores issues to the laundry cost centre.
- **D8** The wastewater consent and the boiler licence appear on the compliance calendar with their expiry, red within
  60 days.

## Known now

- LD-1 built vendor batches, short variances, quality check, holds and `linen_pieces` / `piece_id` (empty until tags).
- Materials has vendors, purchase orders, goods receipts, indents and payables; aerb has a compliance calendar for
  radiation licences, which the two plant licences join or mirror.

## Out of scope

- Buying the tags and readers; vendor tendering; ETP plant operation logs and effluent testing; boiler operating logs;
  staff payroll itself (only the no-dues line).
