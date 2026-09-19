# Phase PD — the Pharmacy Desk: one ticket, one screen

Lane `pharmacy-desk`, branch `lane/pharmacy-desk`.
Design canvas: <https://claude.ai/artifact/3fbfmgVtW1MqAYEsY8vBZQ> (board `Desk.dc.html`).
Owner's reference screens: `/opt/hmis-context/reference/2026-09-18-pharmacy-reference/` (six SVGs).

## 1. WHY

`/pharmacy/counter` works and nobody can bear to use it. It is 600 lines of conditional blocks in
the old Tailwind vocabulary, one vertical column that swaps entirely on `status`, with the queue as
a plain list beside it. The front desk got Desk One; the pharmacy did not.

The owner's instruction (2026-09-18) is explicit: build the pharmacy's `/counter` — three columns,
one ticket in hand, the queue on the right until you claim, then the bill in its place. Everything
below serves that sentence.

**The deeper reason is the one from the handoff.** Four prescribing-safety axes ship and ONE coded
diagnosis exists in this system's history. The counter is the other end of that pipe: until a
pharmacist can work a ticket end to end in under a minute, no doctor's prescription ever completes
a round trip, and none of the four books ever fires in anger.

## 2. DECIDED

Owner rulings are for money, procurement and law. Everything else below is the standard
Indian-corporate-hospital answer, taken and marked.

### The screen

- **PD-D1. One ticket in hand, five stages, no wizard.** `idle → found → working → payment → done`.
  The server's six states stay; the screen derives them. A pharmacist sees a checklist, not a
  pipeline.
- **PD-D2. The tick IS the pick.** Ticking a line reserves its batch. There is no separate
  "verify" button; `verifyDispense` fires once when every line is settled (ticked, substituted or
  declined), which is also when the `P` number is minted today.
- **PD-D3. Two columns per line: WHAT THE DOCTOR WROTE → WHAT YOU ARE GIVING.** Taken from the
  owner's reference (`pharmacy-rx-import.svg`). The doctor's brand plus the Indian sig shorthand
  (`1-0-1 × 5d`) plus the salt on the left; the dispensed product, batch, expiry, scan state on the
  right. A pharmacist's entire job is the gap between those columns.
- **PD-D4. An unresolved line stays in place.** A prescription line the catalogue could not match
  renders as an amber row with `choose ▾` inline — not a separate "add" control at the bottom. This
  is the owner's "a medicine in the prescription but not on screen". Adding a drug the prescription
  does NOT carry is a different act and is out of scope (§5). **DONE (PD-5b), E31–E34.**
- **PD-D5. The bill is the right rail and builds live.** It replaces the queue on claim. This is a
  DEPARTURE from Desk One's "pricing is not a stage, it is a column" (`dossier.tsx:21-27`), on the
  owner's instruction; the pharmacy's left rail is the patient's history instead.
- **PD-D6. Keys are the ones that exist.** `Q` line · `F8` command · `F2` agent · `S` slip ·
  `A` add · `1-4` tender · `Ctrl+⏎` take · `Esc` clear. `Ctrl+K`/`Ctrl+N` are banned by the owner's
  ruling of 2026-09-03 and `F12` is devtools. Every keycap drawn is bound; a keycap that lies is
  worse than none (`desk-one.tsx:1111-1123`).
- **PD-D7. Route `/pharmacy/desk` and `/pharmacy/desk/:dispenseNo`.** The owner's queue popup opens
  a ticket in a NEW TAB, which requires the ticket to be addressable. `/pharmacy/counter` stays
  until the desk replaces it, then redirects. **DECIDED (PD-3): the path carries the DISPENSE ID,
  not the number** — a waiting ticket has no number until verify (PD-D8), and an address that
  exists only after the second step cannot be the address of the first.
- **PD-D23. A click on the line claims through the `token` door.** The claim event pins
  `door ∈ {rx_qr, patient_qr, token, uhid}`, and widening an event contract to record "clicked a
  row" buys analytics nobody has asked for. The queue IS today's line of visits, which is what the
  token door means. DECIDED (PD-3).

### The ticket

- **PD-D8. `P-1048` is a DISPLAY form, and the number moves earlier.** Today `dispense_no` is
  `P2609180048` (`kernel/episodes/series.ts:96-112`) minted at **verify** (`verify.ts:249`), so a
  waiting ticket has none. The queue cannot call a ticket by a number that does not exist. The
  series letter plus the daily serial renders as `P-1048`; `MED-4` is the precedent
  (`model.ts` `tokenLabel`). **Allocation moves to `enqueueDispense`.** OWNER RULING REQUESTED —
  this is a numbering series, adjacent to records; the fallback if refused is to call the queue by
  the OPD token (`T-14`), which already exists and is already on the patient's slip.
- **PD-D9. A claimed ticket names its holder.** Claim is already exclusive (CAS → 409
  `dispense_not_in_state`, `claim.ts:182`) but `QueueRow` carries no `claimedBy`, so a second
  pharmacist learns only by being refused. Add `claimedBy` + `claimedByName`; the row dims and says
  "Vikas has this". The row is NOT hidden — the owner wants it visible and marked.
- **PD-D10. ~~The queue says when it is incomplete.~~ MEASURED FALSE 2026-09-19 — and the real
  defect was the refusal, not the list.** `listQueue` does NOT drop a sealed patient:
  `getPatientSummaries` returns them RESTRICTED (alias, no name) and the row is listed. The FK on
  `pharmacy_dispenses.patient_id` means a summary can be missing only for a merge chain it cannot
  follow, so `hiddenCount` would be a field that is always zero — withdrawn. What IS wrong: the
  pharmacist who may not read sealed records sees the ticket and CLAIMING it answered
  `unknown_prescription` — *"prescription … not found"* — about a prescription that exists.
  **DECIDED (PD-1):** the claim refuses `permission_denied` with `detail.reason: "patient_restricted"`
  and names who can take it; the grant is not widened. The desk dims a `patient.restricted` row
  before the click (PD-3).

### The clinical gates

- **PD-D11. Consent is a control, not a formality.** `verifyDispense` refuses a generic
  substitution without `patientConsent: true` (`verify.ts:160`). The substitute sheet carries a real
  tick with the sentence the pharmacist must actually say.
- **PD-D12. A blocked substitution goes to a named human, and never to the same one.** Today
  `allergy_block` and `interaction_block` are terminal 409s worded "back to the doctor"
  (`verify.ts:197-220`) and pharmacy is the ONLY module with no `approval-types.ts`. Build one on
  the house pattern: `kernel/approvals`, with the lab's `same_actor` refusal
  (`lab/results.ts:430-470`) and PCPNDT's countersignature (`pcpndt/form-f.ts:464-483`) as the
  models. The ticket parks as `waiting_authorisation` and returns to the line; the next patient is
  not held up. **This is the largest new build in the phase.**
- **PD-D13. "Not checked" is never drawn as "clean".** A line whose salt has no attested moiety was
  read by none of the four books. It wears an amber "the books could not read this line", and the
  ticket header counts them. In production today that is most lines.

### The copilot

- **PD-D14. The autonomy ladder is DID / SUGGESTS / ASKS, and it is visible.**
  - **DID (undoable, stated):** chose the FEFO batch, computed the quantity from `days × frequency`,
    applied a benefit the rules already entitle, pre-checked every waiting ticket against the shelf.
  - **SUGGESTS (one tap, never auto):** the substitute, the transfer note, the tender mode, the
    Hindi sentence.
  - **ASKS (never acts):** anything needing consent, authorisation, or money.
- **PD-D15. Deterministic where it matters; the model only parses intent.** Stock, money, expiry,
  law and dose are computed and each answer names its source, exactly as Desk One's dock does
  (`desk-one.tsx:1055-1094`). The LLM is the identifier-masked intent parser already built on
  `lane/copilot` (`POST /copilot/ask`) and nothing else. A counter that invents a stock figure is
  worse than one with no agent.
- **PD-D16. The agent speaks only on pine.** `.agchip` has no light variant, by design
  (`desk-one.css:144-159`). A suggestion rendered on paper is indistinguishable from a fact the
  hospital recorded.
- **PD-D17. It never:** decides a substitution, clears a check, touches a price or a tender, writes
  the H1 register, or puts a patient's name in a notification (DPDP, BYOD phones).

## 3. THE COPILOT'S USE CASES, IN VALUE ORDER

Each names the reader it needs. Nine of the eleven need no new server work.

| # | What it does | Rung | Reads |
|---|---|---|---|
| C1 | **Works the queue you have not reached.** Every waiting ticket's lines checked against the shelf, so the row says "all on shelf" / "Pantop short" / "cold chain" before you claim it. Turns discovery-at-the-window into planning, and is the single largest time saving on this screen. | DID | `availableQtyByItem` per queued line |
| C2 | **Pre-picks the batch and pre-computes the quantity.** FEFO batch chosen; qty from `durationDays × frequency`. The tick confirms rather than enters. | DID | `sellableBatchesByItem`, `RxLine` |
| C3 | **Proposes the substitute, already checked.** On a short line, `alternativesFor` filtered to equivalents in stock, each one re-run through `runRxChecks` against THIS patient, and only the clean ones offered — with the price difference per strip. | SUGGESTS | `alternativesFor` + `runRxChecks` |
| C4 | **Says the refusal in the patient's language.** Hinglish/Hindi for what the pharmacist must tell the person at the window. Phrasebook, not generation. | SUGGESTS | `pharmacyErrors` + phrasebook |
| C5 | **Drafts the transfer note** for anything out of stock, naming the store that holds it. | SUGGESTS | `reorderAdvice` |
| C6 | **Watches the clock.** "This reservation releases at 12:14." "This batch expires tomorrow — if he collects Saturday you must refuse and refund." | DID (states) | `PICK_RESERVATION_MINUTES`, batch expiry |
| C7 | **Watches the money.** Batch MRP above the DPCO ceiling; a membership or coupon the patient is entitled to that is not on the bill; change due. | DID (applies) / ASKS | `priceForBatch`, `fetchRecognition` |
| C8 | **Answers by lookup on `F2`,** English and Hinglish, each answer naming its source: *kitni amoxicillin bachi hai* → stock by name; *kiska paisa pending hai* → billed-not-collected; *ye batch kab expire hoga*. | ASKS | on-screen data + `/pharmacy/summary` |
| C9 | **Remembers the day.** "Third Pantoprazole you have declined today" — and after the fifth, offers the reorder line instead of the sentence. | SUGGESTS | `counterSummary` |
| C10 | **Composes the hand-over sentence** in Devanagari from the sig lines, for the pharmacist to say aloud. | SUGGESTS | `RxLine` + phrasebook |
| C11 | **Names what was not checked.** Counts the lines whose salts have no attested moiety and says so on the ticket, because silence there reads as a clean result. | DID (states) | `isReviewedComponent` |

**C3 DONE (PD-7), measured and cut:** every equivalent comes back put to THIS patient's four books
with the line swapped to it, judged by `refusalsOf` — the one function `verify` now refuses with — so
a blocked row names its book and cannot be chosen, and a partly-read one is never drawn clear.
*Measured:* an equivalent has the same salt set by construction, so its verdict is almost always the
original line's; the run stays per alternative because the allergy book also matches brand names.
*DEFERRED to C7:* the price difference per strip. The bill's price is billing's
`min(batch MRP, ceiling, contract)` decided at the bill; the rail already says the desk does no price
arithmetic; an out-of-stock original — the usual reason to substitute — has no batch to compare.
*Walked, and next:* Vijay's Mox line (allergy recorded after issue) shows nothing ON THE LINE until
the tick fires verify. `refusalsOf` can pre-check the ticket's own lines at the claim the same way —
the line would say "the check will stop this" before anyone walks to the shelf. Not built here.

## 4. EDGE CASES

Numbered because each one owes a test. **F** = must fail first against the code it guards.

### The ticket
- **E1** Two pharmacists claim one ticket. Exclusive already; the loser must see WHO, not a 409. **F**
- **E1b** ~~Nothing after the claim checks the claimer.~~ **MEASURED, NOT A DEFECT (PD-4).** The
  PD-3 walk showed Vikas's ticket rendered as Anita's, and a holder-only guard on verify / decline /
  pick looked like its server half. It is not: `t4.test.ts` pins the ASSISTANT model — an aide
  claims and picks, a registered pharmacist performs the check the Act reserves, and the H1 register
  names the one who checked — and the guard turned that suite, the P2 registration suite and the
  HTTP e2e red. Two people on one claimed ticket is the design. The defect was the SCREEN, fixed in
  PD-3 (the desk names the holder and offers nothing to press). E6's exit exists already and is
  pinned in `holder.test.ts`: cancel with a reason, and the slip scans back into the line.
- **E2** The doctor reissues while you hold v1. A *queued* v1 is cancelled by `enqueueDispense`; a
  *claimed* v1 survives and dies at verify with `prescription_superseded` — the worst possible
  timing, after the strips are pulled. The screen must learn of v2 when it lands and offer a
  one-tap switch. **F**
- **E3** ~~A sealed or alias patient's ticket is absent from this pharmacist's queue entirely.~~
  **Measured false:** it is listed under the alias. The defect was the claim's "not found" for a
  real prescription (PD-D10 as amended). Pinned both ways in `queue.test.ts`. **F** (the refusal)
- **E3b** The same false sentence at the SCAN: `findAtCounter`'s `rx_qr` door answers
  `reason: "not_found"` for a validly SIGNED QR whose patient is sealed to this reader
  (`claim.ts`, `rx === null` after `verifyPrescriptionQr` succeeded). Needs a new `reason` the screen
  renders, i.e. a locale string — **owed by PD-3**, which touches the locales and router anyway. **F**
  **DONE in PD-3:** the QR door answers `reason: "restricted"` and the desk says whose clearance the
  ticket needs. `getDispense`'s `unknown_dispense` for an invisible patient is NOT the same defect
  and is left alone on purpose: it is the house rule that an id is not a capability (the 07a read
  gate), where a signed slip in the patient's hand is proof the prescription exists.
- **E4** One encounter carries v1-claimed and v2-queued at once — two rows, one patient. They must
  read as the same person, not a duplicate.
- **E5** A prescription with no dispensable line (all Schedule X, or all free-text non-drugs) →
  `nothing_to_dispense`, and the ticket must not sit in the queue looking workable.
- **E6** A ticket for a patient who never comes. Nothing sweeps a claimed-but-unbilled ticket except
  the 30-minute pick reservation; a claim with no pick holds nothing and can sit all day.

### Stock
- **E7** Stock goes between the copilot's pre-check and the tick — another window took the last
  strip. The tick must fail loudly and re-offer, never silently pick a different batch. **F**
- **E8** FEFO offers a batch that expires tomorrow and the patient may collect on Saturday. Warn at
  the PICK, where a different batch can still be chosen — not at hand-over, where it is a refund.
- **E9** Partial: 6 sellable of 10 prescribed. Reason required, and the slip must say "6 of 10".
- **E10** `scan_wrong_item` — a hard refusal that blocks the pick while it stands, not a warning.
- **E11** `scan_batch_unknown` / `scan_batch_mismatch` — the pack is real, the batch is not ours.
- **E12** Expired stock sitting on the shelf that every pick silently refuses. Invisible unless the
  screen says so.
- **E13** Reservation expires mid-ticket (30 min, swept every 60 s) — the dispense is CANCELLED under
  the pharmacist. The screen must catch the state change, not fail on the next write. **F**

### Clinical
- **E14** A substitute trips allergy or a severe interaction → PD-D12's authorisation, not a wall.
  (C3: the sheet now says so BEFORE the choice — the row is blocked and names the book.)
- **E15** A salt with no attested moiety → "not checked", never a green tick (PD-D13). **F**
- **E16** `rxLine.noSubstitution` → the substitute control is disabled AND says why.
- **E17** Schedule X → refused at claim, at verify and at hand-over, and never offered as an
  alternative (`verify.ts` C2, the 16c close-review finding).
- **E18** Schedule H1 → the identity box at hand-over starts EMPTY. A prefilled box is the second
  confirmation already answered — the C3 finding from the same review. **F**
- **E19** The patient is a child / the dose is weight-based — the sig shorthand has no strength per
  kg. Show the doctor's text verbatim rather than a shorthand that drops it.
- **E31** A line the claim could not place is RESOLVED, not substituted. **MEASURED (PD-5b):** `verify`
  refused any medicine on such a line ("a substitute needs a resolved original"), so the amber row's
  own sentence — *decline it, or choose what it is* — offered an act that did not exist. DONE: the
  pharmacist's reading goes to `verify` as `dispensedMedicineId` with NO consent (nothing the doctor
  named is replaced), the line records `resolved`, and `dispense.line_resolved` names the resolver.
  `noSubstitution` does not forbid it — the sheet says "choose exactly the medicine written". **F**
- **E32** The books re-run on the reading: an allergy the prescriber never saw stops it at the check,
  on the line, exactly as for a prescribed medicine. **F**
- **E33** Schedule X is neither offered by the shelf search nor accepted at the check. **F**
- **E34** "Unplaced" is decided by the CLAIM's own resolution, never by the shape of the body: a
  medicine the doctor named, or the catalogue placed from the words, keeps the consent rule. The
  search is `GET /pharmacy/dispenses/:id/lines/:idx/shelf` under `pharmacy.dispense.place`, at the
  ticket's own store, and answers only for an unplaced line; `/pharmacy/downtime/shelf` stays the
  downtime clerk's and was not widened. **F**
- **E35** A reading that repeats a moiety already on the prescription (Crocin named, the unplaced
  line read as Calpol) → `duplicate_block` on the line the pharmacist chose. **MEASURED (PD-5b):**
  `verify` re-ran all four books and GATED only allergy and severe interaction; for a substitute
  (same salts) the other two were met at issue, for a reading they were met by nobody. **F**
- **E36** A reading a coded diagnosis contraindicates (severe) → `drug_disease_block`; a prescriber's
  override on that line and that ruling still counts (the doctor wrote the moiety and ruled). **F**
- **E37** **DECIDED (PD-5b):** a diagnosis coded AFTER the issue stops a doctor-named line too — the
  drug×disease twin of D9's allergy-recorded-after-issue, and the same answer: a severe
  contraindication nobody ruled on is not handed over. Hard duplicates need no such rule: they are
  same-prescription only, so a doctor-named pair was already met at issue. **F**
  **Known limit, not fixed here:** the one shelf search (`searchShelfAt`, shared with retail and
  downtime) matches brand, item code and item name — not the salt. "paracetamol" finds Calpol only if
  an item's name says so. The sheet seeds the search from the doctor's words minus the dosage form
  (`Tab. Zincovit` → `Zincovit`); a salt match belongs to the search, for all three counters at once.
  **Walked (PD-5b), two defects past green suites:** (1) the seeded `PCM` search answered *"nothing
  matches — decline the line"* while Calpol stood on the shelf; the sentence now says the search reads
  brand names and codes, not salts, and to try the brand. (2) The open line menu drew the amber note's
  control a second time; the menu now offers the other act only when the note does not (which also
  removed PD-5's doubled "give an equivalent" on an empty line). Demo ticket twelve (`Tab PCM 500`,
  Kamla Devi) is the placeable one; Rekha Singh's `Ascoril LS syrup` is the one to decline.

### Money
- **E20** Short tender → `invoice_not_settled`, refused by billing, not by this screen.
- **E21** ~~No cash drawer open → cash is not a tender.~~ **Measured (PD-6): no drawer → NO tender.**
  `receipts.ts` and `invoices.ts` call `requireOpenSession` for every receipt, UPI and card included,
  so the rail says so before a key is pressed and offers the way to open one.
- **E21b** FOUND BY THE PD-6 WALK: billing refuses every non-cash tender without a settlement
  reference (`tender_ref_required`) and the canvas drew no field for it — the first UPI payment on
  the dev day was refused. The rail asks for the UTR / the card approval code. DONE (PD-6).
- **E22** `price_unknown` — the stock is fine and the line cannot be billed. Two different problems
  that look identical to a pharmacist unless the sentence separates them.
- **E23** Batch MRP above the DPCO ceiling → the ceiling wins and the screen says which of the three
  prices won (`price_winner`).
- **E24** A membership that is expired or unverified → print the SERVER's reason, never an invented
  one (`stages.tsx:2384-2396`).
- **E25** Paid, uncollected, batch expires overnight → `batch_expired_before_collection`; the exit is
  a refund needing `billing.refund.request`, which this seat may not hold. The refusal must name who
  can.
- **E26** The network drops between "Received payment" and the response. Idempotency key per ticket;
  a retry must not double-charge. **F**

### Process
- **E27** Save draft → the reservation is still running. The confirmation names the deadline.
- **E28** A transcribed prescription (FD-31) that is not slip-confirmed → `slip_not_confirmed`
  blocks billing. The screen must ask for the attestation at the START, not at the till.
- **E29** Downtime mode → the paper path (`/pharmacy/downtime`), not this screen.
- **E30** `DOCUMENT_STORE_PATH` unset (true on every deployment today) → "See the slip" must degrade
  to a sentence, not an error.

## 5. NOT IN THIS PHASE

- Adding a drug the prescription does not carry. A pharmacy does not add to a doctor's order; that
  is a new prescription and it belongs to the doctor.
- IPD indents, ward stock, NDPS double custody.
- The back-office URL (purchase / inventory / returns / reports / imports). It federates fifteen
  screens that already exist — 9 `/pharmacy/*`, 5 `/materials/*`, `/formulary/admin` — and is its
  own phase.
- Retail and downtime, which keep their own screens.
- The GST slab on the demo shelf. `seed-pharmacy-demo.ts` deliberately leaves it null and says "when
  the ruling lands, this is one line" — the ruling HAS landed (P1 inclusive MRP, P16 slabs), so that
  line is now owed, but it is a money change and belongs in a phase that can prove it.

## 6. THE CUT

| Task | What | New server work |
|---|---|---|
| **PD-0** | **The demo QUEUE.** Synthetic patients, seen encounters, prescriptions, tickets — behind the existing production door. | seed only |
| **PD-1** | `claimedBy` + `claimedByName` on the queue row and on the lost claim's 409; a sealed ticket refused as restricted, not "not found" (PD-D9, PD-D10 as amended; E1, E3) | reader |
| **PD-2** | The ticket number at open (PD-D8) — gated on the owner | series |
| **PD-3** | The desk shell: routes, three columns, stages, left dossier | web |
| **PD-4** | The line list: two columns, tick-is-pick, sig shorthand, scan (E7–E13) | web |
| **PD-5** | Substitute with consent and pre-checked alternatives (C3; E14, E16) | web |
| **PD-5b** | Resolve an unplaceable line: the ticket's shelf search and `verify`'s resolution (PD-D4; E31–E34) | verify + reader |
| **PD-6** | The bill rail, tender, save draft (E20–E27) | web |
| **PD-7** | The copilot: the queue pre-check reader and the dock (C1, C2, C8) | reader |
| **PD-8** | The slip overlay (E30) | web |
| **PD-9** | Authorisation for a blocked substitution (PD-D12; E14) | approvals |

PD-0 first: nothing below it can be seen, demonstrated or browser-walked without a queue.

## 7. PICKED FROM THE MARKET REFERENCE

The owner supplied 17 screenshots of **Healthray** (`pharmacy.healthray.com`), a shipping Indian
pharmacy product, on 2026-09-19 — archived at
`/opt/hmis-context/reference/2026-09-19-healthray-pharmacy/` with an index. It is a retail-shaped
product with a hospital bolted on; its counter is a spreadsheet, not a prescription. So its LAYOUT
is not the model. Six things in it are, and each one is a gap in ours.

### Taken into this phase

- **PD-D18. A line says WHERE THE DRUG IS.** Their sale grid and item master both carry a `Loc.`
  column — `rack 3`, `R-12`, `P1`. The pharmacist's slowest act is walking to the shelf, and nothing
  in our system tells them where to walk: `items` has no bin. Add a store-scoped rack location and
  print it on the line, beside the batch. This is the highest-value pick and it is small.
- **PD-D19. Say when this batch's MRP is not last batch's.** Their entry row carries `OLD MRP` and
  `MRP DIFF`. We compute `price_winner` across batch MRP, DPCO ceiling and tariff, which answers
  "what may we charge" and not "why is this more than last month" — which is the question actually
  asked at the window, by the patient, out loud.
- **PD-D20. A draft you cannot find again is not saved.** Their toolbar has `Drafts` beside
  `Save Draft`. PD-6 gains the list.
- **PD-D21. Cost and margin are a PERMISSION, not a column.** Their Sale module gates seventeen acts
  separately, `View Profit` among them (also `Edit GST`, `Edit Discount`, `Bill Lock`,
  `Change Bill Date`). A counter pharmacist has no business seeing landed cost by default. Ours
  currently has no margin surface at all — this decides it before one appears by accident.
- **PD-D22. The patient's GSTIN belongs on the bill.** Their patient panel carries `GST No.`; a
  patient buying on a company's account needs it for input credit, and it is a field, not a feature.

### Taken, but not here

- **The short book.** Their stock alert has two sources: `Stock Alert` (below minimum) and
  **`Short Book`** — what somebody asked for and we did not have. Our declines record the refusal
  against a prescription; a short book records unmet DEMAND, which is what procurement needs and
  what a decline cannot be read as. → the reorder/procurement phase.
- **Expiry grouped by SUPPLIER, with a "credit note created" flag.** Theirs has an `Item Wise` and a
  `Supplier Wise` tab, because expired stock goes back to whoever sold it. Ours sorts by date, which
  answers "what dies first" and not "who takes it back". → the shelf phase, and it needs the
  purchase-return document materials has deferred.
- **An amendment shown as the DOCUMENT, before and after.** Their activity log's `Changes` opens
  `Old Receipt | New Receipt` side by side — whole bills, not a field diff. We hold an append-only
  event ledger and can render exactly this, and it is a far better answer than a JSON changelog to
  "what did this person change". → the reports phase.
- **Min/Max per item,** beside our computed cover. A pharmacist's floor is a human override of an
  average, and the two are complementary rather than rival.

### Deliberately NOT taken

- **Their entry model at THIS counter.** Type item → batch → qty → Enter, with the committed line
  dropping below, is genuinely fast — and it is right for a counter where nobody knows what is
  coming. At a prescription counter the lines are already known, so a checklist beats an entry grid.
  It IS the right model for `/pharmacy/retail`, which exists; recorded there, not here.
- **Negative stock.** Their stock alert shows `-498`, `-16`, `-1`. `stock_balances` has a
  non-negative CHECK and keeps it: a shelf that can go negative is a shelf nobody can count.
- **Margin on the line by default** — see PD-D21.
- **Merge Items.** Tempting against a 103,383-row catalogue, and merging rows that carry stock,
  ledger history and dispense records is a data migration, not a button.

### Their back office, as a checklist for the second URL

Their `Initialization` menu is the most complete list of what a pharmacy back office contains that
we have seen: Stores · Users · Privileges · Stocks · Purchase Order · Stock Order · Transfer Stock ·
Receive Stock · Department Stock Transfer · Label Print · Print Setting · Patient Deposit ·
Purchase Credit Note · Other Voucher · Online Sales Order · Order Processing · Additional Bulk
Discount · Payer Company Master · Department Master · Profiler · Pharmacy Expense · Settings ·
Message Configuration · Option Tags · Add Initial Data. Their `Reports` menu is 28 items, of which
**Tally export, operator-wise collection, non-moving, top-selling, loss booking and the GST
register** are the ones we have no answer to. Both are input to the back-office phase, not to this
one.
