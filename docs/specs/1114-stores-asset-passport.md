---
issue: 1114
status: approved
approved: 2026-11-19
---
# SPEC: Stores S4, the asset passport: one QR per unit, holder and place, AMC, calibration, condemnation (#1114) — APPROVED by owner 2026-11-19 (decision 0101)

Slice S4 of the Stores & Procurement programme (`docs/specs/stores-programme.md`). Written to decision 0099 Q3
(ruled 2026-11-18): a QR tag on all medical equipment at any value, and on IT and furniture worth ₹5,000 or more;
cheaper durables stay counted per department (S1 `durable`); AMC, warranty and calibration dates live in HMIS with
reminders; depreciation stays in Tally, and HMIS sends cost and put-to-use date. Needs S1 (#1111), S2 (#1112) and
S2c (#1119), all built. Owner's bar (programme §0A): auditable, flawless experience, one flowing journey.

## What exists (verified in `stores-s3` on 2026-11-19; file and symbol)

- `items.class` admits `asset`; `items.serial_tracked` exists (`kernel/db/schema/materials.ts` `items`). No table
  holds one row per physical unit. S1's `items.track_mode` has `expensed`, `shelf`, `durable`; S1 decision 4
  reserved `tagged` for this slice.
- A `durable` item cannot be "Used" (S1 `use.ts` `recordShelfUse`); it leaves a shelf only by return or
  condemnation, and no condemnation exists.
- Write-off reasons are `expiry`, `damage`, `recall` only (`materials/write-offs.ts` `WRITE_OFF_REASONS`; the
  database CHECK `stock_write_offs_reason_ck`). Raising and posting need `materials.writeoffs.manage`
  (`raiseWriteOff`, `postWriteOff`). The approver is `materials_stock_adjustment` (the medical superintendent,
  `materials/approval-types.ts`). A posted write-off must carry a disposal agency, a manifest number and a
  handover date (`stock_write_offs_posted_ck`). **S4 keeps this approval and this CHECK; it adds signatures before
  them and bypasses neither.**
- `item_categories` has no flag column (`kernel/db/schema/materials.ts` `itemCategories`). `items_track_mode_ck`
  admits `expensed`, `shelf`, `durable` only. Every ledger row names a batch (`stock_ledger.batch_id` NOT NULL).
- A non-returnable gate pass takes `ref_type` `supplier_return` or `write_off` only
  (`kernel/db/schema/stores.ts` `stores_gate_passes_ref_type_ck`); S2c reserved a scrap-sale value for S4.
- Radiology owns the resource kind `device` (`radiology/kinds.ts`); a second claim fails at boot
  (`duplicate_kind`).
- The role `biomedical_engineer` exists and holds only `ops.interface.manage` (`scripts/seed-roles.ts`). There is
  no accounts role; the TallyPrime export is held by `billing_manager` (`pharmacy.tally.export`).
- Maintenance (free-text item tags) exists only on the unmerged IPD train (#967).
- The tower's red-card strip and the S3 chaser sweep are `stores/tower.ts` `boardCards` and `stores/chaser.ts`
  `runStoresChaser` (rides `sweepStaffNotices`, every minute).

## The flow (one journey per actor, end to end)

1. **Storekeeper, at the GRN.** A GRN line for a tagged item (say 3 monitors) posts as today. The line then shows
   "Tag 3 units / 3 यूनिट टैग करें". The keeper scans each serial barcode (or types the serial), and HMIS prints one QR
   label per unit. Make and model come from the item master, cost and supplier from the GRN line. The units sit at
   `GEN-MAIN` with status "In store". Nothing else is typed.
2. **Department, by ticket.** The ward raises an ordinary S2 ticket. At pick, the keeper scans the unit labels
   (that is the pick: no unit, no issue). The porter carries as today. The receiver confirms; the passport says
   "In use · ICU-2" and the put-to-use date is the receipt day unless biomedical records an installation date.
3. **Biomedical engineer, once per unit.** Opens the passport by scan and fills only what the system cannot know:
   warranty end, AMC/CMC contract (picked from S5's awarded service POs when they exist, else typed dates and the
   supplier from the list), calibration due date and certificate, and the link to a radiology or lab device when
   there is one.
4. **Anyone, any day.** Scans the label. The passport opens on one screen: what it is, where it is, who holds it,
   status word, next due date, last five events. A unit found in the wrong place shows "Belongs to ICU-2 / ICU-2 का
   है" and one button, **Found here / यहाँ मिला**: the owning in-charge gets one notice with the place. The books
   do not move (the unit never left ICU-2's shelf on the ledger); the owner collects it and scans it at home.
5. **Fault.** The in-charge taps "Report fault / खराबी बताएँ" on the passport (one line of text). Biomedical sees it
   on a Now card, opens a repair, and if it leaves the building raises a returnable gate pass from the passport
   (S2c, prefilled). On return, the guard's entry scan and the engineer's "Repaired / ठीक हुआ" close the repair.
   The third fault in 30 days puts "Replace? / बदलें?" on the passport and the materials head's card.
6. **Reminders.** AMC and warranty ending in 30 days, calibration due in 15 days: one notice each to biomedical
   and the materials head; overdue is a red card on the tower. The passport carries the word.
7. **Verification.** Once a year per department (half-yearly for medical equipment), the in-charge and a
   storekeeper walk with the phone and scan. Closing the round lists "Not seen / नहीं मिला" and "Wrong place / गलत
   जगह". Not seen for 30 days after the round becomes a loss proposal; the committee signs it like a condemnation
   (reason "lost") and the unit ends as "Written off / बट्टे खाते". A unit found later is brought back by an event,
   never by editing the write-off.
8. **Condemnation.** The HOD or biomedical proposes (reason from a list). Each committee seat (user HOD, biomedical
   for medical equipment, accounts, materials head) signs once on the phone, in any order. The medical
   superintendent then approves the write-off (the approval that exists today), and the owner also approves above
   the value line (ruled, decision 0101 Q5). An objection stops it with a reason. The unit reads "Condemned / नाकारा". Disposal by
   the materials head (scrap sale, buy-back, e-waste recycler) posts the write-off and raises the non-returnable
   gate pass; the guard's exit scan ends the unit's life: "Disposed / निपटाया".
9. **Accountant.** Once a month opens "Asset additions / नई संपत्ति" and "Assets removed / हटाई संपत्ति" and
   downloads one file each (cost, put-to-use date, category, department, GRN and bill numbers; for removals the
   condemnation and sale amount) for Tally's fixed-asset register. Depreciation is Tally's.
10. **Giving a unit to another department.** The holding in-charge taps **Transfer / दूसरे विभाग को दें** and picks
    the department; the receiving in-charge scans the unit to accept. Two different people, as for any movement.
11. **Look back.** Any permitted reader opens the passport's timeline or `storesAuditPack({unit})`: every event
    with who, where, when and why, from tagging to disposal.

## Decisions

1. **What gets a tag (ruled 0099 Q3).** A new category flag `tag_rule` on `item_categories`:
   `always` (a new seeded top category "Medical equipment", and "Biomedical spares" items that are whole devices),
   `from_value` (IT and peripherals; Furniture and fixtures), `never` (all others).
   - An item under `always` is `track_mode: tagged` (a new value on `items_track_mode_ck`); every batch of it is
     tagged at any value.
   - An item under `from_value` stays `durable` on the master. The decision is made **per GRN line, and a GRN
     line of such an item always opens its own batch**: unit cost before GST of ₹5,000 or more makes the batch
     tagged, otherwise it is counted. One append-only row per GRN line (`stores_tag_decisions`: batch, rule, unit
     cost, threshold, result) records it, so a later change of the threshold never rewrites the past.
   - So the same chair bought at ₹4,800 and later at ₹5,200 gives one counted batch and one tagged batch on the
     same shelf, both correct. "Tagged" below always means a tagged batch.
2. **Units.** `stores_asset_units`: one row per physical unit, written once: item, tag number, serial, make, model,
   GRN line, batch, unit cost (paise, ex-GST, from the GRN line), supplier, created by, created at. The row never
   changes; every later fact is a unit event. A corrected serial or model is an event `corrected` with before and
   after, and the passport shows the latest.
3. **Tag numbers.** Series `AST` + yymm + 6 digits (`kernel/episodes/series.ts` style). The QR carries the tag
   number only. The typed fallback is the last four digits, searched first among units held by the reader's
   departments, then hospital-wide; two matches show both (name · place) to pick from. Nobody types a full number.
4. **Unit events** (`stores_asset_unit_events`, append-only by trigger): `tagged`, `placed`, `moved`, `installed`,
   `out_on_pass`, `back`, `fault_reported`, `repair_opened`, `repair_closed`, `warranty_set`, `contract_set`,
   `calibrated`, `device_linked`, `verified_seen`, `tag_voided`, `retagged`, `condemn_proposed`, `condemn_signed`,
   `condemn_objected`, `condemned`, `disposed`, `corrected`, `loss_proposed`, `written_off`, `found`,
   `seen_elsewhere`, `transfer_proposed`, `transferred`, `regulator_paper`. **Place, holder, status and due dates are derived from
   events, never stored** (programme I4). The latest place-bearing event wins.
5. **Units ride the ledger, never beside it.** A tagged unit is one base unit of its batch in `stock_ledger`.
   - Issue from a tagged batch through an S2 ticket requires the unit tags on the line (`units_required`); the
     picker's scans choose the batch. The receipt writes `placed` for each named unit at the shelf, in the
     receipt's transaction.
   - A gate pass for a tagged batch names the units; the exit and entry scans write `out_on_pass` / `back`.
   - Invariant (tested): for every tagged batch and every store, the count of live units whose derived place is
     that store equals the batch's ledger balance there. A nightly check (`assetLedgerCheck`) raises a card on any
     difference; it never "fixes" either side.
6. **Put-to-use date** = the `installed` date if biomedical records one (≤ today, ≥ GRN date), else the first
   `placed` day at a department shelf. Units sitting in `GEN-MAIN` have none. It is the date Tally depreciates
   from.
7. **Warranty, AMC/CMC, calibration.**
   - Warranty: an end date, read from the PO or typed once per GRN line for all its units.
   - AMC/CMC: a contract event naming the supplier, start, end, kind (AMC: labour; CMC: labour and parts) and
     the service PO when S5 exists. Visits are recorded as `repair_closed` with outcome `preventive`.
   - Calibration: done on, due on, agency, and the certificate as an uploaded document (the vendor-document store
     precedent, `materials/vendors.ts` `addVendorDocument`). Only measuring and therapeutic equipment carries a
     calibration due (a category-level flag `needs_calibration`).
   - Reminders: AMC/CMC and warranty 30 days before end; calibration 15 days before due; each one notice, once
     (idempotent source key). Overdue calibration shows "Calibration overdue / कैलिब्रेशन बाकी" on the passport and a
     tower red card. HMIS does not lock the device: the HOD withdraws it (NABH practice), and the passport records
     "Withdrawn / उपयोग बंद" as a `moved` to the department's hold.
8. **Repairs before maintenance exists.** `reportFault` (department in-charge, one line), `openRepair` and
   `closeRepair` (biomedical; outcome repaired / not repairable / preventive). When the maintenance module lands,
   its tickets name the unit id and write these same events through the stores intent; it keeps no unit table.
   Three `fault_reported` in 30 days raise "Replace?".
9. **Devices.** `linkDevice(unitId, deviceResourceId)` by biomedical. The passport shows the radiology or lab
   device's status read-only. Stores never declares the `device` kind and never writes a device status.
10. **Duplicate and lost tags.** A tag already bound is refused. A unit with two live tags keeps one; the other is
    voided with a reason. A lost tag is reprinted with a new number and the old one voided; scanning a voided tag
    answers "Tag replaced / टैग बदला गया" and opens the unit.
11. **Opening sweep (go-live).** Existing equipment is tagged department by department: search the master (never
    free text), serial, make, model, cost if known, put-to-use date or year if known. Each unit posts one opening
    ledger row at its shelf with no charge (materials `postOpeningBalances`, additive path). Cost unknown is
    allowed and marked "Cost unknown / लागत अज्ञात" for accounts to fill once from their fixed-asset register; the
    fill is an event.
12. **Verification rounds.** `startVerification(departmentId)` → scans → `closeVerification`. Medical equipment
    every 6 months, everything else yearly (DECIDED, NABH FMS practice). A unit not seen 30 days after closing
    becomes a `loss_proposed` card for the committee; nothing is written off by itself.
13. **Condemnation.** Proposed by the HOD or biomedical, with a reason (beyond economical repair, obsolete,
    damaged beyond repair, lost).
    - **Seats, each signs once, any order:** the user department's HOD; accounts; the materials head; and, for
      medical equipment, biomedical. Seats are filled by role. A proposal is refused while a seat has no holder
      (`committee_seat_empty`, naming the seat), and one person never fills two seats on one proposal. An absent
      HOD signs through a dated delegation (S5 decision 11); the medical superintendent does not stand in here,
      because the final approval is theirs.
    - **Then the approval that exists today:** `materials_stock_adjustment` (the medical superintendent), raised
      by the stores intent once every seat has signed. S4 never posts a write-off without it.
    - **Then the owner**, when the unit's original cost is above the value line or unknown. Ruled (decision 0101 Q5): the owner also approves when the unit's original cost is above ₹50,000 or unknown, the same line as the PO tiers.
    - **Objection.** Any seat may object with a reason; the proposal reads "Objected / आपत्ति" and stops. The unit
      stays in use. A fresh proposal is a new row naming the old one.
    - A condemned unit refuses issue, transfer, tag and returnable pass, and moves to the `CONDEMNED` hold store.
    - **Lost.** A `loss_proposed` unit takes the same seats and approvals with reason "lost". It ends "Written
      off / बट्टे खाते" with no gate pass; the write-off's agency and manifest fields carry "lost" and the inquiry
      note's number (a police report number when theft is suspected: DECIDED). `markFound` later appends `found`
      and re-enters the unit through the opening path naming that write-off; nothing is edited.
14. **Disposal** (the materials head, who holds `materials.writeoffs.manage`). One of:
    - **Scrap sale** (`stores_scrap_sales`: buyer from the supplier list, amount, accounts' receipt reference and
      the sale invoice number). DECIDED on the ruled quote bands: one buyer up to ₹25,000 expected value; three
      written bids above, the highest wins; the owner approves above ₹5 lakh.
    - **Buy-back** against a new purchase (the S5 PO reference and the buy-back amount).
    - **E-waste recycler** for IT and electrical: an authorised recycler only, with its certificate (E-Waste
      (Management) Rules).
    Disposal posts the write-off with the new reason `condemned` (additive CHECK value; the buyer or recycler is
    the disposal agency, the sale invoice or certificate number the manifest, the exit day the date) and raises a
    non-returnable gate pass whose `ref_type` is `scrap_sale` or `write_off`. Materials refuses `condemned` on any
    store that is not a Stores store, so pharmacy can never pick it.
    - **Tax on the sale is the accountant's.** A scrap sale or buy-back is a taxable sale; the tax invoice is made
      in the accounts system and HMIS records its number and amount. HMIS computes no GST or TCS on it.
    - **An IT unit that stored data needs a wipe or destruction certificate before its pass can be raised** (DPDP
      Act duty to erase).
    - **Regulated equipment** (decision 18) needs the regulator's paper first.
15. **Export to Tally.** `assetAdditions(month)` and `assetRemovals(month)`: CSV plus a print, one row per unit,
    under `stores.assets.export`. Additions carry cost before GST, the GST amount, whether input credit was taken
    (from S6's mark on the bill line, blank until S6), put-to-use date, category, department, GRN number, and the
    supplier's bill number and date. Removals carry the condemnation number, reason, sale or buy-back amount and
    the sale invoice number. HMIS computes no depreciation and no book value; freight and installation added to
    an asset's cost are the accountant's entry.
16. **Who.** `stores.assets.manage` (biomedical engineer, materials head): tag, contracts, calibration, link,
    repairs. `stores.assets.read` (materials head, biomedical, medical superintendent, stores auditor, owner);
    a department's shelf-grant holders read their own units. `stores.assets.condemn` (committee signers; the HOD at
    department scope). `stores.assets.export` (the accounts role). A new role `accounts_officer` (seeded with no
    holders) is added here if S4 lands before S5/S6, with the same key and title they use.

17. **Transfer between departments.** `proposeUnitTransfer(unitId, toShelfId)` by a shelf-grant holder of the
    holding department; `acceptUnitTransfer` by a shelf-grant holder of the receiving department, by scanning the
    unit. It is a materials transfer shelf to shelf in the stores intent, so the ledger and the cost centre move
    together. The proposer cannot accept (`own_transfer`). An open transfer shows "On its way to <dept>".
18. **Regulated equipment.** An item flag `regulated_by` (`radiation` | `ultrasound` | none), set by biomedical.
    For such a unit, a returnable pass, a transfer to another site and any disposal are refused until the
    regulator's approval or intimation is uploaded on the passport (`regulator_paper_needed`): the radiation
    regulator's decommissioning or transfer approval for X-ray, CT and similar; the district authority's
    intimation for an ultrasound machine (PC-PNDT). HMIS records the paper; it files nothing with the regulator.
19. **Equipment is not monthly spend.** A tagged unit received by a department is shown on the tower and in S5's
    budget as "Equipment received / उपकरण मिला", apart from the month's consumable spend, and never counts toward
    the 80 % and 100 % warnings (DECIDED: capital and running cost are budgeted apart).

## Audit by construction

- Every S4 act appends one `stores.act_recorded` event with actor, role, time, unit, store(s), before/after and
  reason, in the act's transaction.
- `stores_asset_units`, `stores_asset_unit_events`, `stores_tag_decisions`, the condemnation signatures and
  `stores_scrap_sales` refuse
  UPDATE and DELETE in the database (the 0239 trigger pattern). A correction is a new event naming the one it
  corrects.
- Place and status are derived, so they cannot disagree with events; the ledger invariant (decision 5) is checked
  nightly and by test.
- `storesAuditPack` gains `{unit}`: tagging, every move with its ticket, passes, repairs, calibrations, signatures
  and disposal, in `seq` order; each export writes one event.
- Every agent proposal (none in S4 beyond the existing concierge) goes through the copilot ledger.

## Done means

Each id is one acceptance test that calls intents, passes `now` in (no real clock) and is red against `main`.
"Refused" always means the named code and no row written.

- **D1** `tagUnits` on a GRN line of 3 units of a "Medical equipment" item creates 3 units with 3 distinct tags
  and queues 3 labels. Issuing from that batch on a ticket without naming units is refused (`units_required`).
- **D2** For a `from_value` category: a GRN line at ₹4,999 per unit before GST writes a tag decision "counted" and
  `tagUnits` on it is refused; a line at ₹5,000 writes "tagged" and its issue requires tags. A "Medical equipment"
  line at ₹500 requires tags. With both batches of one item on one shelf, D4's invariant holds for the tagged
  batch and the counted batch is used as a `durable`.
- **D3** Binding a tag already bound is refused (`tag_bound`). `voidTag` then `retag` leaves exactly one live tag;
  scanning the voided tag returns the unit with "Tag replaced".
- **D4** After a ticket delivers a unit to shelf B, `assetPassport` gives place B and B's department, and the unit
  is in no other place. `assetLedgerCheck` returns no difference; after one extra ledger row is posted for the
  batch without a unit, it returns exactly that batch and store, one tower card is raised, and no row is changed.
- **D5** A returnable gate pass for a unit makes the passport read "Out: repair, due <date>"; with `now` one day
  past the due date it reads "Overdue"; the entry scan returns it to its store.
- **D6** A unit whose AMC ends in 30 days produces one notice to biomedical and the materials head, and none on the
  next sweep. A calibration past due is listed by `assetsDue` and as a tower red card.
- **D7** The third `fault_reported` within 30 days raises one "Replace?" card; two faults raise none. `openRepair`
  then `closeRepair` (repaired) returns the status word to "In use".
- **D8** A unit linked to a radiology device shows the device's status read-only. The stores manifest declares no
  `device` kind (the boot collector lists none).
- **D9** `closeVerification` for a department lists units not scanned in the round and units scanned at a shelf
  other than their derived place. `reportFoundHere` by another department's shelf-grant holder writes one event
  and one notice to the owning in-charge and no ledger row.
- **D10** `proposeUnitTransfer` then `acceptUnitTransfer` by a holder of the receiving department moves the place,
  the ledger balance and the cost centre together; acceptance by the proposer is refused (`own_transfer`).
- **D11** A condemnation with one seat unsigned, or without the `materials_stock_adjustment` grant, or (above the
  ₹50,000 line of decision 0101 Q5, or cost unknown) without the owner, stays pending and posts nothing. A second signature by the same
  person is refused. A proposal while the accounts seat has no holder is refused (`committee_seat_empty`). An
  objection sets "Objected" and the unit can still be issued.
- **D12** A condemned unit is refused for issue, transfer, tag and returnable pass. An IT unit marked as holding
  data is refused disposal without a wipe certificate; a `regulated_by` unit is refused disposal and a returnable
  pass without the regulator's paper (`regulator_paper_needed`).
- **D13** Disposal by scrap sale posts one write-off (reason `condemned`, with buyer, invoice number and date) and
  allows one non-returnable pass with `ref_type: scrap_sale`; after the exit scan the passport reads "Disposed"
  and `assetRemovals(month)` lists the unit with its reason and sale amount.
  `raiseWriteOff` with reason `condemned` on a pharmacy store is refused, and an `expiry` write-off there returns
  the same view as before S4.
- **D14** Thirty days after a round, each unseen unit has one `loss_proposed` card and no ledger row. After the
  seats and approvals, one write-off posts, the passport reads "Written off", and no gate pass exists. `markFound`
  then adds a `found` event and one opening row naming the write-off; the write-off row is unchanged.
- **D15** `assetAdditions(month)` lists every unit put to use that month with cost before GST, GST amount,
  put-to-use date, category, department, GRN number and bill number and date; the sum of cost equals the units'
  costs; each export writes one event.
- **D16** An opening-sweep unit posts one opening ledger row with no cost centre; cost unknown is accepted and
  listed under "Cost unknown"; a second opening of the same unit is refused.
- **D17** (audit) Every S4 act appends one event. UPDATE and DELETE on `stores_asset_units`,
  `stores_asset_unit_events`, `stores_tag_decisions` and the condemnation signatures are refused by the database.
  `storesAuditPack({unit})` lists the unit's life in `seq` order with actor and role.
- **D18** A shelf-grant holder of department A scanning department B's unit sees only name, tag, "Belongs to B"
  and "Found here"; no cost, contract or history. A tagged unit received by a department adds nothing to S3's
  `departmentSpendByMonth` for that month and is listed under "Equipment received".
- **D19** (web, 390 px) Scan opens the passport on one screen with the status word, place, holder and next due
  date, with no horizontal scroll; "Report fault" is reachable in ≤ 2 taps.
- **D20** (web, 16:9) `/stores/assets` shows the Register, Due, Verification, Condemnation and Exports tabs at
  1366 × 768; every status is a word.

## Screens

Phone 390 px, no horizontal scroll; `/stores/assets` 16:9 (fits 1366 × 768). Every status is a word, never colour
alone. Notices are a few words on one line. Strings are verbatim, English / Hindi. Loading is grey rows with no
text. "No connection / कनेक्शन नहीं" on any screen when the connection drops.

- **Passport (phone, from a scan).** Header: item name · tag (last four shown large) · status word. Status words:
  In store / स्टोर में, In use / उपयोग में, Out: repair / मरम्मत को बाहर, Overdue / समय निकला, Under repair / मरम्मत
  में, Withdrawn / उपयोग बंद, Condemned / नाकारा, Disposed / निपटाया, Missing / नहीं मिला, Written off / बट्टे खाते, On its way / रास्ते में. Rows: place · holder
  department · put-to-use date · warranty / AMC / calibration each with a date and a word (OK / ठीक, Due soon /
  जल्द बाकी, Overdue / बीत गया) · last five events. Primary: **Report fault / खराबी बताएँ**. Biomedical also sees
  **Add details / जानकारी जोड़ें**. Cost shows only to `stores.assets.read`. Refused: "Not your department: ask <in-charge> / आपका विभाग नहीं: <in-charge> से कहें" (S2's `whoToAsk`). Foreign unit: "Belongs to ICU-2 / ICU-2 का है" with **Found here / यहाँ मिला** (done: "ICU-2 told / ICU-2 को
  बताया"). The holding in-charge also sees **Transfer / दूसरे विभाग को दें**; the receiver's card reads "Unit to
  accept / यूनिट स्वीकारें" with **Accept / स्वीकारें**; refused: "Your own transfer / आपका अपना ट्रांसफ़र". Voided tag: "Tag
  replaced / टैग बदला गया".
- **Tag units (store, after a GRN line).** Rows: unit 1..n · serial box (scan or type). Primary: **Tag and print /
  टैग और प्रिंट**. Refused: "Tag already used / टैग पहले से लगा", "Serial already exists / सीरियल पहले से है". Done:
  "Labels printed / लेबल छपे".
- **Department assets (phone).** One row per unit: name · last four · status word. Filter chips: All / सभी, Due /
  बाकी, Out / बाहर. Empty: "No tagged assets / कोई टैग वाली संपत्ति नहीं".
- **Report fault (sheet).** One line of text, optional photo. Primary: **Send / भेजें**. Done: "Fault reported /
  खराबी दर्ज". Biomedical Now card: "Faults to see / देखनी हैं खराबियाँ".
- **Verification round (phone).** Header: department · seen n of m. Camera open; each scan ticks a row. Primary:
  **Close round / राउंड बंद करें**. Result rows: "Not seen / नहीं मिला", "Wrong place / गलत जगह". Done: "Round
  closed / राउंड बंद".
- **Condemnation (phone, signer).** Rows: unit · reason · cost · age · repairs in 12 months · signatures so far.
  Primary: **Sign / हस्ताक्षर करें**; secondary "Object / आपत्ति" (reason). Refused: "Already signed / पहले ही
  हस्ताक्षर", "Wipe certificate needed / डेटा मिटाने का प्रमाण ज़रूरी", "Regulator paper needed / नियामक का कागज़
  ज़रूरी", "No accounts member yet / लेखा सदस्य तय नहीं" (names the empty seat). Words: Pending / बाकी, Objected /
  आपत्ति, Approved / मंज़ूर. Done: "Signed / हस्ताक्षर हुआ".
- **`/stores/assets` (web).** Tabs: Register / रजिस्टर, Due / बाकी, Verification / सत्यापन, Condemnation / नाकारा,
  Exports / निर्यात. One primary per tab: Tag units, (none), Start round, Propose, Download. Empty: "Nothing yet /
  अभी कुछ नहीं". Refused: "No permission / अनुमति नहीं".
- **Notices, verbatim.** "AMC ends in 30 days / AMC 30 दिन में खत्म", "Warranty ends in 30 days / वारंटी 30 दिन में
  खत्म", "Calibration due / कैलिब्रेशन बाकी", "Replace? / बदलें?", "Asset not seen / संपत्ति नहीं मिली",
  "Condemnation to sign / नाकारा पर हस्ताक्षर करें", "Your unit is elsewhere / आपकी यूनिट दूसरी जगह", "Unit to accept /
  यूनिट स्वीकारें".
- **Tower red cards (added to S3's strip).** "Calibration overdue / कैलिब्रेशन बाकी", "AMC lapsed / AMC खत्म",
  "Missing asset / संपत्ति गायब", "Units ≠ ledger / यूनिट ≠ लेजर".

## Budgets

- Scan to passport ≤ 1 s. Report fault ≤ 2 taps plus one line. Tagging a GRN line of 10 units ≤ 2 min.
- A verification round of 100 units ≤ 15 min of walking; each scan ticks in ≤ 300 ms.
- Units-versus-ledger difference: 0 (checked nightly; any difference is a card the same night).
- Calibration overdue on a medical device: 0 days (reminder at −15 days).

## Edge cases

1. **A tagged unit is received short in transit.** S2's short stays in IN-TRANSIT against the last custodian, by
   unit: the receiver scans the units that arrived; the missing tag is the short.
2. **Serial unreadable or absent** (a chair). Serial is optional for furniture and IT accessories; the tag is the
   identity.
3. **A kit or set** (a monitor with its cables). One unit per main device; accessories are `durable` counts.
4. **A device on loan from a supplier (demo or consignment).** Not tagged as a hospital asset; a returnable gate
   pass records its exit. Out of scope beyond that.
5. **Department merged or renamed.** Units follow the shelf; history stays (S1 edge case 15).
6. **Unit moved without a ticket** (wheeled to another ward). Verification shows "Wrong place"; the fix is "Found
   here" (it goes home) or a Transfer (it stays), never an edit of the place.
7. **Cost changes after a supplier credit note.** The unit's cost stays the GRN cost; the credit note is S6's and
   Tally's.
8. **A biomedical engineer outsourced** (AMC firm's technician). They do not log in; biomedical records their visit.
9. **Patient data on a device** (monitor, ultrasound, PC). Disposal needs the wipe certificate (decision 14).
10. **Condemned but not yet disposed for months.** The unit sits in a `CONDEMNED` hold store (an
    `ensureTransitStore`-style materials store, additive), visible on the tower's count, never issued.
11. **Copilot question with a tag number.** The masker already masks `AST` + 10 digits as an identifier; no
    concierge intent for assets ships in S4 (out of scope).
12. **The HOD is away for a month.** A dated delegation (S5) or the proposal waits; the card shows whose
    signature is missing, so it is never a silent stall.
13. **An X-ray tube or a radioactive source inside a condemned unit.** Decision 18: no pass without the
    regulator's approval; the unit waits in `CONDEMNED`.
14. **A leased or donated unit.** Tagged with cost 0 and the word "Leased / किराये पर" or "Donated / दान"; a leased
    unit is returned on a non-returnable pass against the lease, never condemned or sold.

## Out of scope

- Depreciation, book value, revaluation (Tally, ruled). Insurance of assets. The maintenance module's work orders
  and PPM scheduling (IPD train); S4 ships only fault, repair and preventive-visit events.
- Buying the AMC (S5) and paying it (S6). Asset concierge intents. RFID (laundry's later issue). The native
  staff-app scan screen and its offline queue.

## Build notes

- **Files.** Stores: `assets.ts` (tag, events, passport, derive), `asset-contracts.ts`, `verification.ts`,
  `condemnation.ts`, `asset-exports.ts`, label print renderer, desk providers ("Faults to see", "Condemnation to
  sign"), tower card kinds (additive in `tower.ts`), chaser reminders (in `runStoresChaser`, no new job name).
  Web: passport, department assets, tag units, verification, condemnation, `/stores/assets`.
- **Materials, additive only:** write-off reason `condemned` (CHECK value and `WRITE_OFF_REASONS`, refused off
  Stores stores; pharmacy never sends it), `items_track_mode_ck` value `tagged`, a `CONDEMNED` store helper, an
  opening-balance path per unit, an optional `unitIds` on the issue line for stores tickets (pharmacy passes
  none), and "a tagged GRN line opens its own batch" (confirm in `materials/grn.ts` before building).
- **Two PRs.** **S4a** (`Refs #1114`): tag rule and decisions, units and events, passport, pick and receipt by
  unit, gate-pass units, transfer, found here, reminders, repairs, device link, verification, opening sweep,
  additions export (D1–D10, D15, D16, D18–D20). **S4b** (`Closes #1114`): condemnation, loss,
  disposal, regulated equipment, scrap sales, removals export, audit pack (D11–D14, D17).
- **Migration** one per PR. S4a: `item_categories.tag_rule`, `item_categories.needs_calibration`,
  `items.regulated_by`, the `tagged` value on `items_track_mode_ck` (shared table), `stores_tag_decisions`,
  `stores_asset_units`, `stores_asset_unit_events`, `stores_asset_verifications` (append-only by trigger). S4b:
  `stores_condemnations` (+ signatures), `stores_scrap_sales` (append-only), the CHECK value on
  `stock_write_offs_reason_ck`, and the `scrap_sale` value on `stores_gate_passes_ref_type_ck`. A CHECK change on
  a pharmacy table is a shared change: no existing row is touched, and D13 pins pharmacy's write-off.
- **Permissions** `stores.assets.manage`, `stores.assets.read`, `stores.assets.condemn`, `stores.assets.export`
  (4), role `accounts_officer` (if first). Grants to `biomedical_engineer` grow. Seed-roles pins and README prose.
- **Shared files:** `scripts/seed-roles.ts` + test, `kernel/db/schema/index.ts`, `apps/core/drizzle/**`, router,
  locales (run the i18n-keys test), caddyfile parity (new `/stores/assets` routes), the seed of the new top
  category in `seedStoresMasters`.
- **Size** L, in two PRs. **Depends on** S1, S2, S2c (built). **Coordinates with** the IPD train's maintenance (#967) and
  radiology's `device` kind.
