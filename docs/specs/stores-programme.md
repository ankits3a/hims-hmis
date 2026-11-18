---
programme: stores-and-procurement
status: approved
issue: milestone "Stores & procurement", #1111–#1117
approved: 2026-11-18
---
# Stores & Procurement: the programme — APPROVED by owner 2026-11-18 (decision 0099)

Non-drug master stock, movement tracking and purchasing for the whole hospital. Pharmacy stays separate.
This file is the overview. The slice specs are docs/specs/1111 to 1113 (S1–S3); S4–S7 are outlines in the appendix, and the five owner questions are in
decision 0099. Public-scrub rules apply to every file here: no staff names, patient data, IPs,
server names, supplier names, supplier rates or security findings.

## 0. What the owner asked (2026-11-18)

- One master register of every material the hospital needs, down to a dustbin. Every department, including
  housekeeping, gets its material from it.
- Every movement can be traced like a parcel: which ticket, where it came from, where it went, which staff member
  handed it to which, and when.
- A control tower of materials run by the procurement department, with AI agents as co-pilots.
- Pharmacy stays separate. Only non-drug items are in scope.

## 0A. Owner's bar (2026-11-18): auditable, flawless experience, one flowing journey

Owner, while approving: "Not just operation speed and accuracy is important but it should be auditable. More than
that user experience is something I cannot compromise with. The flow of the whole module is important."

**The flow, one ticket's life.** Every slice is judged against this journey, not screen by screen:

1. **Shelf low.** The ward or housekeeping in-charge sees a Now card ("8 items low on 4B"), or the planner has
   already drafted the refill. One tap opens the draft with quantities filled; a third tap sends it.
2. **HOD.** One notice; approve or decline in 2 taps from the notice. Nothing else to type.
3. **Store.** The approved ticket is already on the keeper's "To pick" list, sorted by floor. Pick, then issue; the
   issue voucher and the label QR print.
4. **Porter.** Scan to take, scan to hand over (2 taps each). The ticket shows whose hands it is in, with a clock.
5. **Receiver.** Quantities come prefilled with what was issued; confirm in ≤ 3 taps. A short line is one tap to
   report; the gap stays against the last holder until found, returned or lost.
6. **Close.** The department is charged; the requester got exactly three notices (approved, on the way,
   delivered); the tower lane moves by itself.
7. **Look back.** Anyone permitted opens the ticket timeline and sees every step: who, where, when, and why.

No step asks for something the system already knows, no screen is a dead end, and the next step is ready before the
person reaches it. **Before S1 code, the full journey is drawn as a clickable board (phone 390 px and the 16:9 tower)
for the owner to walk; the build follows the board** (see verify-UI-against-the-board practice).

**Auditable by construction (DECIDED, applies to every slice):**

- Every stores act writes its domain event (`kernel/events`) with the actor, the time, the store(s), the item,
  the quantity before and after, and the reason. Nothing is edited or deleted: a correction is a new reversing row
  that names the row it corrects.
- The ledger, the hand-off log and the approval stamps are append-only; the database refuses UPDATE and DELETE on
  them.
- Offline scans keep both the phone's time and the server's receipt time; the timeline shows both when they differ
  by more than 5 minutes.
- Every agent proposal and every confirmed act is in the copilot ledger (#575) with the named person who confirmed.
- **Audit pack:** for any ticket, item, person, store or date range, one export (print and CSV) lists every
  movement and signature in order; the internal auditor and an NABH surveyor read it without help.

## 1. Scope

**In.** All non-drug items: general stores and sundries, housekeeping and sanitation, stationery and printed
forms, electrical, plumbing and civil, IT and peripherals, furniture and fixtures, biomedical spares, and
low-value durables such as dustbins, buckets and chairs. Also department shelves, request tickets, custody,
gate passes, the control tower, tagged assets, buying, paying, and the agents.

**Out.** Medicines and anything pharmacy dispenses or sells. The pharmacy counters, the NDPS cabinet, and the
pharmacy's own reorder list and copilot.

**Waiting for the owner.** Patient-billable non-drug items (surgical consumables, implants), lab reagents,
medical gases and X-ray film wait for Q1. Linen and uniforms and canteen provisions wait for Q5. Until the
owner answers, stores does not register items in those groups.

## 2. What already exists (verified in the repo on 2026-11-18; file and symbol cited)

The materials engine handles every item class and is live under pharmacy since 2026-11-14:
- **Items.** `items` with `class` checked against `ITEM_CLASS_VALUES` (`kernel/db/schema/materials.ts`):
  consumable, consumable_dated, reagent, implant, stationery, linen, gas, asset and service. There is no category
  column and no tracking mode. `serial_tracked` exists. The `BATCH_MANDATORY_CLASSES` policy
  (`materials/config.ts`) does not require a batch for non-drug classes, so a dustbin can be received without one.
- **Stores.** These are registry `store` resources (`materials/stores.ts` `createStore`, which takes `parentId`
  and `attributes`). `attributes.custodianRoles` names who receives into a store. `IN-TRANSIT` is a real store
  (`TRANSIT_STORE_CODE`).
- **The ledger.** `stock_ledger` is append-only and written only through `postMovements` (`materials/ledger.ts`).
  `MovementInput.costCenter` exists, but no caller sets it. The reasons are grn, issue, receive, consume, return
  and adjust. Only pharmacy (`trays.ts`, `handover.ts`, `retail.ts`) and the OT consignment consumer post
  `consume`. **No intent records a department's use of non-drug stock.**
- **Transfers.** Every transfer has two signatures (`materials/transfers.ts` `issueStock` → IN-TRANSIT →
  `receiveStock`, with `issuedBy` ≠ `receivedBy`; the refusal code is `transfer_self_receipt`). A short receipt
  leaves the rest in IN-TRANSIT with status `discrepancy`. **Nothing resolves a discrepancy.** The header says
  "resolution is 14c's", and no resolve function exists.
- **Indents.** These are `materials/indents.ts` (requested → issued | rejected | cancelled). One indent becomes
  one transfer. There is no approval step. Indent numbers are `MIN` + yymmdd + 4 digits
  (`kernel/episodes/series.ts`).
- **Purchasing.** POs are tiered (`approvalTierFor`: the head approves up to `PO_HEAD_APPROVAL_LIMIT_PAISE` =
  ₹50,000, the owner above). Then come GRN with gate QC, the 2% price check (decision 0096), the 3-way bill match,
  payment runs (the owner authorises), supplier returns, counts, write-offs (`WRITE_OFF_REASONS` = expiry, damage,
  recall; there is no "lost"), and vendors with the 7-day bank-change cooling-off and blacklist (decision 0027).
  `MSME_MAX_PAYMENT_DAYS` = 45. `item_stock_levels` holds min/reorder/max per item and store; writing it with
  `setStockLevel` needs `materials.po.raise`.
- **Roles.** `storekeeper` and `materials_head` are seeded with no holders. `materials.grn.qc` is held by
  `pharmacy` and `materials_head`, so in practice only pharmacists sign QC today. main has no HOD, porter, nurse
  or security role.
- **Screens.** Every materials screen is a page of `/pharmacy/office`; the old `/materials/*` paths redirect
  there (`apps/web/src/router.tsx` `toOffice`). Vendors, payables and payment runs are hospital-wide and not
  filtered by class.
- **Agents.** Reorder logic and agent PO drafts belong to pharmacy (`pharmacy/replenishment.ts`,
  `purchase-drafts.ts`). Copilot tools exist for pharmacy and five other modules. materials has none.
- **Three kernel facts the design must respect:**
  - `usersHoldingRole` ignores scope (`kernel/workflow/roles.ts`). `custodianRoles` therefore cannot tell one
    department's in-charge from another's.
  - The approvals kernel has one `approverRole` per type and no department scope (`kernel/approvals/types.ts`).
  - `hasPermission(…, "department", { departmentId })` does enforce scope, and roster uses it
    (`roster/access.ts`).
- **The copilot masker** reads any `[A-Za-z]{1,5}\d{10}` as an identifier (`kernel/copilot/mask.ts`), so it
  masks an indent number such as MIN2611180042.
- **The `device` kind** is claimed by radiology for the whole hospital (`radiology/kinds.ts`). A second claim
  fails at boot (`duplicate_kind`).
- **Unmerged, dark (draft PR #967, the IPD train).** It contains a shared task engine (`tasks`), porters
  (`transport`: sample and document runs), `linen` (its own `linen_items` and `linen_movements`), `housekeeping`
  and `maintenance` (free-text item tags). It also has the roles `support_staff` (porter skill),
  `security_guard`, `nursing_supervisor`, `ward_nurse` and `services_supervisor`. IPD stays off production until
  every module is built (owner 2026-10-13).

## 3. The architecture rule: one item master, one ledger

- **A new leaf module, `stores`.** It imports `materials` only through its `index.ts`, as the lint rule requires.
  It owns the tickets' extra details, the custody chain, department shelves, gate passes, tagged units (S4),
  quotations (S5), the tower and the agents. It owns no stock quantity: every quantity change is a
  `stock_ledger` row posted by materials.
- **Materials changes are additive only.** New nullable columns, new functions and new optional fields are
  allowed. A changed signature, a changed status set or a changed refusal is not, because pharmacy is live on
  the same functions. Every slice keeps the pharmacy suites green, and S1–S2 carry an explicit regression check.
- **The anti-second-ledger rule.** This binds linen, laundry, housekeeping, canteen, maintenance and any later
  module:
  1. Anything purchased, stocked or charged to a department is an `items` row with a category. A module never
     keeps its own catalogue of purchasable things. The IPD train's `linen_items` map to `items` (class linen)
     by `item_id`.
  2. Every change in the quantity the hospital owns is a `stock_ledger` row. A companion module may keep an
     **operational log**: where a sheet is in the wash cycle, which ward borrowed a pillow, which floor a mop
     is on. That log never holds a balance that money, reorder or audit reads.
  3. Linen (if Q5 includes it) is bought and received through stores and issued once to the linen pool store.
     The linen module tracks the circulation. Its condemnation posts a write-off through materials. A monthly
     read checks that the linen module's pool count equals the ledger balance at the linen pool store.
  4. Housekeeping consumables per floor are a department shelf per floor (S1). This carries out the owner's
     ruling of 2026-10-26: "issued from the master inventory to each floor, tracked monthly". It feeds #974.
  5. Canteen raw materials (if Q5 includes them) are issued from a kitchen store. Recipe cost (#981) reads
     those issues; it never keeps its own stock figure.
  6. Maintenance tickets name an `items` row or a tagged unit (S4), never free text. A spare part used in a
     repair is a stores ticket with `refType: maintenance_ticket`.
  7. A service bill (laundry per piece #1012, AMC, an outsourced contractor) becomes a materials payable
     through S6. It is never paid from a module's own table.

## 4. Truth, Intents, Surfaces (the 2041 lens)

**Truth** (events with provenance, kept 15+ years):
- Items with category and tracking mode. Stores, department shelves, the night store, IN-TRANSIT and
  OUT-ON-PASS.
- The ledger: every quantity change and its cost centre.
- Tickets: the indent, its approval stamps and its stores details.
- Transfers, the custody hand-off log (append-only), gate passes, tagged units and their events (S4), and
  quotations and awards (S5).
- Every agent act, through the `copilot_acts` ledger.

Four invariants, each tested:
- **I1.** Stock is always in exactly one of three places: a store or department shelf; IN-TRANSIT with a named
  custodian; OUT-ON-PASS against a gate pass. Otherwise a ledger row says it is gone (used, returned to the
  supplier, written off). It is never "nowhere".
- **I2.** Every movement out of a store is signed by two different people: the issuer and the receiver. A
  porter's scan is an optional third signature. Nobody on the custody chain may sign the receipt.
- **I3.** Every rupee can be traced: ticket → PO → GRN → bill → payment → the department charged (the cost
  centre on the receipt into its shelf).
- **I4.** A ticket's lane, holder and clock are derived from rows, never stored. Nothing can disagree with the
  ledger.

**Intents.** There is one zod-contracted function per act, and the same function is the copilot tool. No rule
lives only in a screen, and the acceptance tests call intents. The S1–S3 intents are listed in their specs.

**Surfaces** (each is replaceable in 2–4 years):
1. **Control tower.** A 16:9 wall or desktop board with lanes Requested / Approved / Picking / In transit /
   Delivered / Stuck, a floor map and red cards (S3).
2. **Ticket timeline**, like courier tracking: every leg with who, from, to and minutes (S2).
3. **Department shelf** on a 390 px phone: on hand, par, Used, Check, one-tap Reorder, and use against workload
   (S1).
4. **Item passport** for a tagged unit (S4).
5. **Buying desk**: grouping, RFQ, comparative statement, award (S5).
6. **Paying desk**: bills, holds, release, payment runs (S6).
7. Working screens: the porter card (scan, hand on), the store pick list, the gate scan and the masters.

DECIDED: non-drug screens live under a new top-level `/stores`, not inside `/pharmacy/office`. The pharmacy office
keeps vendors and payables until Q4 is answered.

## 5. The ten principles, made testable here

1. **Ask only what the system cannot know.** The department, cost centre, supplying store and par come from the
   shelf; the requester types only quantities.
2. **Now cards** (`kernel/desk`): "Indents to approve" (HOD), "To pick" (store), "To receive" (department),
   "Stuck" (materials head, duty manager).
3. **Prepare the next step.** At the moment of approval the pick list is ready. At issue the label QR is ready.
   At delivery the receiver's lines are prefilled with the quantities issued.
4. **One identity header.** Every ticket screen opens with the same header: ticket number, department, priority,
   lane and clock.
5. **No dead ends.** Every refusal names the fix ("Not your department: ask the HOD of X"). An item missing from
   the master becomes a new-item request, never a free-text line.
6. **AI text never writes numbers.** Every count, minute and rupee in an agent's answer comes from an intent
   read and carries its source.
7. **Visible clocks.** Each lane shows its own clock, and "Stuck" says which clock broke.
8. **Time and tap budgets are measured from events** (§6).
9. **390 px, the 16:9 wall and paper.** The issue voucher and the gate pass print. Phone rows fit one line.
   Notices are a few words.
10. **Hindi and English, voice, night mode, and no meaning by colour alone.** Every status carries a word or a
    shape.

## 6. Budgets

| What | Budget | Measured from |
|---|---|---|
| HOD approval | ≤ 60 min, 90th percentile | raise → approval stamp |
| Routine delivery | same shift (≤ 4 h after approval in store hours) | approval → receipt |
| Urgent delivery | ≤ 60 min after approval | approval → receipt |
| Emergency delivery | ≤ 20 min from raise | raise → receipt |
| One porter leg | ≤ 30 min | hand-off → next hand-off or receipt |
| Double-signed movements | 100 % (structural) | transfers with issuer ≠ receiver |
| Central store count variance | ≤ 1 % of value per count | count review |
| Stock-out without warning | 0 (S7 sets the warning at ≥ 24 h before) | shelf at 0 with no prior warning |
| Department spend | monthly, per occupied bed-day (wards, once IPD is live) or per OPD visit | cost-centre charges |
| Taps | reorder ≤ 3, porter take or hand ≤ 2, receive ≤ 3, approve ≤ 2 from the notice | screen events |
| Tower | refresh ≤ 15 s; the owner sees "how many stuck, where" at a glance | — |
| Concierge | ≤ 2 s on the phrasebook path; works when the model is down or capped | ask ledger |

## 7. Autonomy ladder per agent

T0 shows. T1 nudges people inside the hospital. T2 drafts, and a person confirms. T3 acts in the safe direction,
and a person can undo it. T4 acts within rules and reports. Agents never sign money, approvals, payments,
write-offs or physical receipts, and never send a message to a supplier.

| Agent | Starts at | Can climb to | Gate for climbing | Never |
|---|---|---|---|---|
| Concierge ("where is…") | T0 reads; T2 for one act (reorder, propose → confirm) | stays | — | approve, receive, hand over, resolve, write off |
| Chaser | T1, internal nudges only | stays T1 | — | supplier or patient messages; more than one nudge per step |
| Stock planner (S7) | T0 warnings → T2 drafts top-up tickets and PO drafts | T3: department top-ups within par go out without a tap (the HOD still approves, a person still receives) | 4 weeks with ≥ 95 % of drafts accepted unchanged and no stock-out; the owner approves | submit or approve a PO |
| Buyer (S5) | T2: nightly grouping, RFQ drafts, comparative statement | stays T2 | — | send an RFQ or PO, award, negotiate |
| Auditor (S6) | T1 flags (leaks, duplicate bills, price drift, split POs) | T3: places a hold on a payment line (release is human) | 8 weeks with ≥ 90 % of flags upheld; the owner approves | release a hold, pay, accuse a named person |

Every agent obeys the copilot halt and the ₹5,000/day spend cap (decision 0064, spec 581). An agent has at most 3
open proposals per department; beyond that the harness halts it.

## 8. Edge cases

**Physical**
1. **Lost in transit.** The short quantity stays in IN-TRANSIT against the last custodian on the chain. The
   materials head resolves it: found, returned to the source, or a loss write-off through the existing
   stock-adjustment approver. Nothing is written off automatically. (S2)
2. **Partial receipt.** Receive 7 of 10: the 7 post, and 3 stay in IN-TRANSIT, named and visible (existing
   `receiveStock`). Resolution is as in case 1.
3. **Partial issue (the store is short).** The line goes short or to 0, and the remainder can be re-asked in one
   tap as a linked ticket. The planner sees the shortage.
4. **Porter shift change.** A porter-to-porter hand-off needs the incoming porter's scan. A porter still holding
   custody at the end of the shift is a red card. Nobody clocks out holding goods.
5. **Receiver absent.** Goods are never left unsigned. After 30 min the porter returns them to the source, the
   source keeper accepts them, and the ticket reads "returned undelivered".
6. **Item returned** (unused, wrong or defective). A return ticket runs from the department to the store; the
   store's receipt credits the department's cost centre. Defective items go to quarantine for a supplier
   return.
7. **Condemnation.** Durables leave only by return or condemnation: a committee, then disposal with a
   non-returnable gate pass (S4; the value rules wait for Q3).
8. **Recall of a non-drug batch.** The existing `recallBatch` freezes it everywhere, including department
   shelves and IN-TRANSIT. The tower lists every place that holds it (`batchLocations`).
9. **Store closed at night.** The night store (an emergency cabinet kept by the duty nursing supervisor or duty
   manager) serves emergency tickets. The central store refills it the next morning.
10. **Emergency indent at 2 am.** It may be issued before approval, with a typed reason. The HOD reviews it
    within 24 h; if nobody reviews it, it becomes a red card.
11. **Duplicate tagging.** A tag already bound to a unit is refused. A unit carrying two tags keeps one, and the
    other is voided with a reason (S4).
12. **Offline phone.** Scans queue with an idempotency key and the scan time. They post once, with
    `occurred_at` set to the scan time (the ledger's downtime convention) and marked "synced late".
13. **Two staff ask for the same item.** When a ticket is raised, an open ticket for the same item and shelf
    is offered: "add to it?".
14. **Item not in the master.** A new-item request goes to the materials head. The duplicate finder runs
    first.
15. **A department is merged or renamed.** The shelf moves in the registry and its history stays.
16. **Gate.** A non-returnable pass needs a supplier return, a write-off or a scrap sale behind it. A
    returnable pass past its due-back date is red.
17. **Dated consumables on a shelf** (gloves, test strips). The shelf flags them 30 days before expiry, and
    they are returned for a swap.
18. **The phone's clock is wrong.** Every stamp uses server time, except a queued offline scan, which keeps its
    scan time and is flagged.
19. **The HOD is on leave.** Any other holder of the department's approve grant can approve; formal delegation
    comes later (S5 approval upgrades).

**AI-era**
1. **An agent loops.** At most 3 open proposals per department per agent, then a halt.
2. **The model invents a number.** It cannot: tools return answer keys and parameters, and every number comes
   from an intent.
3. **A department asks about another department's stock or tickets.** The answer stays within the asker's
   grants.
4. **Prompt injection in item names, notes or quotation text.** Tool output is data. The model only routes to
   a tool name.
5. **The model is down or the spend cap is reached.** The phrasebook, the tower and every screen still work.
6. **The buyer's grouping delays an urgent request.** Urgent and emergency tickets are never grouped or
   delayed.
7. **A fake or duplicate supplier invoice.** The auditor flags it, and a human releases the hold (S6).
8. **A per-person consumption ranking.** Never: only department level (the anonymous-averages precedent,
   decision 0079).
9. **An agent drafts a PO to a suspended or blacklisted supplier.** `assertVendorPurchasable` refuses it.
10. **Voice or Hinglish**, such as "mera dustbin kahan hai". This routes to the asker's latest ticket. A spoken
    number is read back before any act.
11. **A ticket number in a question.** It is masked before routing and returns as the subject (S3).
12. **Clock gaming.** Cancelling and re-raising a ticket does not reset its clock: a linked ticket keeps the
    first raise time, and cancellations are counted on the tower.
13. **The state changes between propose and confirm.** The recheck at confirm answers "state changed" and
    writes nothing (spec 580).

## 9. Owner questions (money, procurement, law): RULED 2026-11-18, recommended option on each (decision 0099)

The owner accepted every recommended default below ("Go with your recommendation"):

| # | Question | Ruling | Blocks |
|---|---|---|---|
| Q1 | Pharmacy boundary for patient-billable non-drug items | Anything that can appear on a patient's bill stays with pharmacy (surgical items billed per piece, implants). Items never billed per piece (lab reagents, X-ray film, gas cylinders, housekeeping, stationery) come to stores. | Loading those groups in S1; recall scope; the gas cylinder exchange |
| Q2 | Approval ladder, quotation bands, capex approver, budgets | HOD only for indents. Monthly department budget that warns at 80 % and 100 % but never blocks. POs as pharmacy today (head ≤ ₹50,000, owner above). One quote ≤ ₹25,000; 3 quotes and a comparative statement up to ₹5 lakh; above that, and any capital item, 3 quotes plus the purchase committee plus the owner. | S5; hold-release in S6; the budget line in S3; the spend guard in S7 |
| Q3 | Asset tag threshold, AMC, depreciation | Tag all medical equipment at any value, and IT and furniture ≥ ₹5,000. Count low-value durables per department. Keep AMC, warranty and calibration dates in HMIS. Depreciation stays in Tally, and HMIS sends cost and put-to-use date. | S4 #1114 |
| Q4 | One finance book with pharmacy | One supplier list, payables list, payment run and Tally export, split by department and category | S5 supplier set-up; all of S6 |
| Q5 | Master scope (linen, canteen); pharmacy on the tower | Linen and uniforms and canteen dry provisions bought and stocked through stores; perishables used on receipt at the kitchen. Tower shows non-drug only. | Loading linen and kitchen groups (S1); the linen and canteen seams (#974, #981, #1012); a pharmacy tile on the tower (S3) |

## 10. Slices

| Slice | What | Depends on | Was blocked by (all ruled 2026-11-18, 0099) | Migration | New permissions (approx.) | Size |
|---|---|---|---|---|---|---|
| **S1 #1111** | Masters, stores, department shelves, use and shelf check, cost-centre charge, reorder draft | — | none (Q1/Q5 groups wait) | yes (categories, track mode, new-item requests) | 3 + roles `department_store_incharge`, `department_head` | L |
| **S2 #1112** | Tickets: approval, priority, picking, custody chain, porter scan, delivery, shorts, returns, gate passes, night store | S1 | none (Q2's extra levels add later) | yes (indent stamps, ticket details, hand-offs, passes, claims) | 3 + porter and security roles | XL (two PRs: tickets + custody; gate passes) |
| **S3 #1113** | Control tower, Now cards, concierge (7 intents, 1 act), chaser | S2 | none (Q5 pharmacy tile and Q2 budget line add later) | small (nudge log) | 2 | L |
| S4 #1114 | Item passport: QR per unit, holder and location, AMC and calibration, condemnation | S1, S2 | **Q3** | yes | ~2 | L |
| S5 #1115 | Buying desk and buyer agent: grouping, RFQ, comparative, award, scorecard, KYC, approval upgrades, non-drug GRN QC | S1 | **Q2, Q4** | yes | ~3 | XL |
| S6 #1116 | Paying desk and auditor: service bills, TDS and GST on bill, MSME clock, holds and release, UTR | S5 (or the existing GRN path) | **Q4**, Q2 | yes | ~2 | L |
| S7 #1117 | Stock planner: central reorder, par suggestions, warnings, top-up and PO drafts | S1, S2 (8+ weeks of use history), S5 | Q2 (budgets); data | maybe | ~1 | M |

S1–S3 are the first wave and can start on the owner's yes to their specs. S4–S7 are outlines until their
questions are answered.

## 11. Risks: shared files, migrations, permission counts, other lanes

- **Shared files every slice touches.** Each needs coordination before editing:
  - `kernel/modules/manifests.ts` (new manifest), `app.module.ts`, `worker.module.ts` (S3 chaser sweep, S7 planner
    job; read the worker pool sizing first) and `kernel/db/schema/index.ts`.
  - `scripts/seed-roles.ts` and `test/seed-roles.test.ts`. The permission and role counts are pinned, and every new
    permission owes README prose.
  - `test/caddyfile-parity.test.ts` (new `/stores` routes), `apps/web/src/router.tsx` and `apps/web/src/locales/*.json`
    (run the i18n-keys test).
  - `kernel/copilot/mask.ts`, `packages/contracts/src/copilot.ts` and a new eval items file (add only) in S3.
- **Migrations.** S1, S2 and S4–S6 each add tables. Take the number at merge, not at start. The IPD train
  (#967) renumbers a block of about 40 migrations, so whichever lands second renumbers. Additive only.
- **Materials is shared with live pharmacy.** Changes are additive only: approval stamps on `store_indents`
  (nullable, null means no approval, as every pharmacy indent has), an optional cost centre on receipt, and new
  functions for in-transit resolution and the night store. A change to the meaning of an existing status or
  refusal is out.
- **Roles.** The porter (`support_staff`), `security_guard` and `nursing_supervisor` exist only on the IPD
  train. If stores lands first, it adds them with the train's exact keys and titles, and the train drops its
  copies at rebase. `department_head` and `department_store_incharge` are new and department-scoped. Department
  roles hold no `materials.*` grant (§2, the scope-blind custodian check).
- **Porter dispatch.** S2 records custody only. When the tasks engine lands, choosing a porter becomes a
  `material_run` task kind there, never a second dispatcher.
- **Tagged units and `device`.** A unit links to a radiology `device` resource when one exists. Stores never
  declares `device` (S4).
- **Lanes to coordinate.** Housekeeping HK-2 #974 (consumables per floor = S1 floor shelves), canteen CN-2 #981
  (store issues = S1 kitchen store under Q5), ward WM-2 #983 (ward par and charging: patient charging is Q1's,
  department cost is S1's), laundry LD-2 follow-up #1012 (a service bill = S6), maintenance on #967 (unit ids =
  S4).
- **Production timing.** Every merge restarts the api (about 1 min). Offer to merge outside OPD hours.

## 12. DECIDED (standard Indian corporate-hospital practice; open to the owner's objection)

1. A new leaf module `stores` over the one materials ledger. Materials changes are additive only.
2. Stores refuses class `drug` and never lists pharmacy stores. The Q1 and Q5 groups wait.
3. A two-level category tree, seeded with 12 top categories, and every stores item has one. There are no
   free-text ticket lines; a new-item request goes to the materials head.
4. Three tracking modes: `expensed` (used on receipt), `shelf` (kept and counted), `durable` (counted units,
   never used). `tagged` arrives with S4.
5. The department shelf is a `store` resource under its floor. The cost centre is the department's code, and
   the department is charged at receipt into its shelf (charge at issue), at the batch's received cost.
6. Shelf check monthly (weekly if the HOD chooses). The difference posts as use. A count above book posts
   nothing and raises a card.
7. The HOD approves indents, through a department-scoped permission. Any one holder can approve. Nobody
   approves their own ticket. A decline needs a reason, and the notice says only "Not approved".
8. Three priorities: routine, urgent and emergency. Emergency needs a reason, may be issued before approval,
   and must be reviewed by the HOD within 24 h.
9. A night store kept by the duty nursing supervisor or duty manager. The central store refills it next
   morning.
10. One picker per ticket. The claim lapses after 30 idle minutes.
11. The porter is an optional third signature by QR scan. The custody chain is separate from the ledger.
    The label QR carries the ticket number only.
12. The issuer and anyone on the custody chain cannot receive. Goods are never left unsigned; after 30 min
    they return to the source.
13. Shorts stay in IN-TRANSIT against the last custodian. Resolution is found, returned, or written off through
    the existing approver.
14. Returns from a department credit its cost centre. Defective items go to quarantine.
15. Gate passes are returnable (stock moves to OUT-ON-PASS; the guard scans out and in) or non-returnable
    (needs a return, write-off or scrap sale reference).
16. Three notices per ticket to the requester, a few words each.
17. Tower: non-drug only, six lanes, and the clocks in S3. Spend is shown only to holders of
    `stores.spend.read`.
18. Concierge: cue-routed only, seven intents, one act (reorder). The chaser makes internal nudges only, once
    per step.
19. Use rates per OPD visit now, and per occupied bed-day once IPD is live.
20. Web first at 390 px and 16:9. The staff app's native screens follow as their own issue.


## Appendix: outlines of S4–S7 (each needs a full spec before its build)

### OUTLINE: Stores S4, the item passport for tagged units 

**Was blocked by Q3, now ruled (0099)** (the rupee threshold for a QR tag, and whether AMC and depreciation live here). It depends on
S1 (items, shelves) and S2 (tickets, custody, gate passes). It coordinates with the IPD train's `maintenance`
module (#967) and radiology's `device` kind.

#### Intent

Every durable unit at or above the Q3 threshold (and every medical device) carries one QR tag. Its passport
answers:
- what it is and who holds it;
- where it is and how it got there;
- what it cost and on which PO/GRN/bill;
- its warranty, AMC/CMC and calibration;
- every repair, and when it is due to be replaced.

Low-value durables below the threshold (dustbins, buckets, chairs) stay `durable` counts per department from S1.

#### Decided direction (subject to Q3)

- **Units.** `asset_units` (stores) keyed on an `items` row of class `asset` with `serial_tracked`. One row per
  physical unit, with make, model, serial, tag, put-to-use date, custodian department and holder. Tagging
  happens at GRN, or as a one-time sweep for existing stock.
- **Unit events.** Unit events are append-only: tagged, placed, moved (via an S2 ticket), out on a returnable
  pass, back, under repair, calibrated, condemned, disposed. Location and holder are derived from these events.
- **Not a second `device` kind.** Radiology owns `device` (`radiology/kinds.ts`). A unit that is also an
  imaging or lab device links to its `device` resource by id; device statuses stay radiology's.
- **Maintenance.** Tickets name a unit id, replacing the free-text tag on the IPD train. The third fault in 30
  days already flags replacement there; the passport shows it.
- **Duplicate tagging.** A tag already bound is refused. A second tag on a bound unit voids one with a reason.
  A lost tag is reprinted with a new number and the old one voided.
- **Annual physical verification.** A scan sweep per department lists units not seen (missing) and units seen
  in the wrong place.
- **Condemnation.** Standard committee: the user department, biomedical or engineering, accounts and the
  materials head. Condemnation leads to disposal (auction or scrap) with a non-returnable gate pass (S2). The
  write-off value follows Q3's book rule.
- **Surfaces.** The passport on phone (scan, then one screen), the department's asset list, and the tower's
  "AMC due" and "missing" cards.

#### Questions that block it

- **Q3.** The threshold: tag every durable, ≥ ₹5,000, or ≥ ₹25,000. AMC/CMC and calibration reminders in HMIS
  (recommended). Depreciation in Tally (recommended) or in HMIS.
- Q2, partly: who approves a condemnation write-off above a value.

#### Done means (sketch, ids assigned at spec time)

- A unit's holder and location answer from its events alone. The latest event wins, and a moved unit is never
  in two places.
- A tag bound to one unit is refused for a second.
- A unit out on a returnable pass shows "Out: repair, due <date>". It turns overdue after that date.
- A condemned unit cannot be issued, moved or tagged again.
- A device-linked unit's passport shows the radiology device status read-only.
- The verification sweep lists unseen units per department.

### OUTLINE: Stores S5, the buying desk and the buyer agent 

**Was blocked by Q2, now ruled (0099)** (quotation rule by value band, PO approval for non-drug, capex approver, budgets) and **Q4**
(one supplier master and finance book with pharmacy, or separate). It depends on S1. S7 feeds it later.

#### Intent

The procurement team turns the central store's shortfalls and approved purchase requests into orders:
grouped, quoted, compared and awarded. Every rupee stays traceable from the ticket to the PO. The agent drafts;
people send, award and approve.

#### Decided direction (subject to Q2/Q4)

- **Purchase requests (PR).** A PR is raised from the central store's shortfalls, from the stock planner (S7),
  or by a department for a non-stock or capital item. It goes through department approval as in S2.
- **Nightly grouping.** The buyer agent runs at T2. It groups open PRs by category and the supplier likely to
  supply them, and shows a preview the buyer edits. Urgent and emergency PRs are never held for grouping.
- **RFQ.** Drafted by the agent and sent by a person: email or print. Nothing goes to a supplier without a human
  tap. Quotes are captured by hand or from an uploaded PDF; the reading is shown with its source and checked by
  a person.
- **Comparative statement.** Lines are ranked L1/L2/L3 on landed cost (rate, GST, freight, payment terms) and
  marked for technical compliance. A person awards it. An award that is not L1 needs a typed reason.
- **POs.** These use the existing `createPurchaseOrder`, the approval tiers and `sendPurchaseOrder`. The source
  is `agent` when drafted. Rate contracts use the existing `vendor_item_rates`, and the 2% price check (0096)
  applies to non-drug GRN lines too.
- **Non-drug GRN QC.** The materials head, or the indenting department's nominee for technical items, signs QC.
  It is never required of a pharmacist. This changes no drug rule.
- **Approval upgrades.** "Any or all" per level, delegation with an end date (roster precedent), approve from
  the app, bulk approve, and "hold until GRN".
- **Supplier KYC and scorecard.** PAN, GSTIN and MSME documents use the existing `addVendorDocument`. The
  scorecard measures on time, short, rejected and price drift.
- **Surfaces.** The buying desk (16:9): PR queue, grouping preview, RFQs, comparisons, awards, POs. The owner
  approves from the phone.

#### Questions that block it

- **Q2.** Value bands for one quote versus three, the purchase committee, the capex approver, budgets.
- **Q4.** One supplier list and finance book with pharmacy (recommended) or separate.
- Q1, partly: whether surgical consumables bought for pharmacy share RFQs with stores.

#### Never (agent)

The buyer agent never sends an RFQ or a PO, never awards, and never negotiates with a supplier. It never
contacts a supplier at all. It never drafts to a suspended or blacklisted supplier (`assertVendorPurchasable`).

#### Done means (sketch)

- A grouping preview never contains an urgent or emergency PR.
- An award to a supplier that is not L1 without a reason is refused.
- A PO drafted by the agent cannot be sent until a person submits it and its tier approves it.
- Comparison totals equal the sum of the quote lines plus GST and freight.
- A non-drug GRN's QC can be signed without any pharmacist.

### OUTLINE: Stores S6, the paying desk and the auditor agent 

**Was blocked by Q4, now ruled (0099)** (one finance book with pharmacy or separate) and partly by Q2 (who may release a held
payment). It depends on S5, or on the existing GRN path for bills already flowing.

#### Intent

Every supplier bill is checked before anyone pays it: matched, taxed correctly, held when anything looks wrong,
and released only by a person. The auditor agent looks for leaks and duplicates. It flags; it never pays.

#### Decided direction (subject to Q4)

- **Bills.** These use the existing `createSupplierBill`, the 3-way `matchSupplierBill` and payables.
- **Service bills without a GRN.** Laundry per piece (#1012), AMC/CMC, outsourced housekeeping and security,
  canteen caterer net of rent. A **service entry sheet** (who confirmed the service, which month) stands in for
  the GRN, so a service bill matches against it.
- **Tax on the bill.**
  - GST input credit is marked eligible or blocked per line.
  - TDS is suggested by the section that fits the supplier and the line (contract, professional, purchase of
    goods), and confirmed by accounts.
  - The CA reviews the TDS rule table before go-live (law).
- **The MSME due clock.** The existing `MSME_MAX_PAYMENT_DAYS` = 45 and `dueDateFor`. Bills nearing day 45 are
  red on the paying desk.
- **Payment-run holds.** These are placed automatically and released by a person with a reason:
  - a duplicate bill: same supplier, same number, or same amount and date;
  - an amount out of pattern for that supplier;
  - a bank change still in its cooling-off period (existing 7 days);
  - missing KYC;
  - a bill above its PO.
- **Payment.** Runs use the existing `createPaymentRun`, which the owner authorises. The UTR is captured on NEFT
  or RTGS. The Tally export is shared with pharmacy if Q4 says one book.
- **Auditor.** It starts at T1 and can climb to an automatic hold at T3. It looks for:
  - consumption per bed-day or visit out of pattern by department;
  - price drift against contract;
  - POs split to stay under an approval limit;
  - one person on both ends of a chain;
  - shelf checks repeatedly "More than book".

  It names departments and documents, never accuses a person, and every flag cites its rows.

#### Questions that block it

- **Q4.** One supplier master, payables, payment run and Tally export with pharmacy (recommended), or separate.
- **Q2.** Who may release a held line above a value: the materials head, or finance plus the owner.
- Law, for the CA: the TDS section table and GST blocked-credit list.

#### Done means (sketch)

- A second bill with the same supplier and bill number is held, and it cannot be paid until a person releases it
  with a reason.
- A supplier in bank-change cooling-off cannot be in an authorised run.
- A laundry bill checked by the linen module becomes one payable, once, through a service entry sheet (#1012).
- An MSME bill's due date is no later than 45 days from acceptance.
- No auditor flag carries a person's name.

### OUTLINE: Stores S7, the stock planner agent 

It depends on S1 and S2, plus **at least 8 weeks of department use history** from them, and on S5, which turns
the central store's shortfalls into PO drafts. Budgets come from Q2.

#### Intent

No department runs out without an earlier warning. The planner watches use against workload and lead time,
warns early, and drafts the top-up tickets and purchase drafts. People submit and approve them.

#### Decided direction

- **Built in `stores`.** It reads materials' functions: `availableQtyByItem`, `consumedQtyByItem`, `onOrderAt`,
  `stockLevelsAt` and lead time on `items`. Pharmacy's `replenishment.ts` stays pharmacy's and untouched; no
  shared code moves in this slice.
- **Department shelves.** Days of cover = on hand ÷ use per day. Use is weighted by workload where known: OPD
  visits now, bed-days once IPD is live. There is a monsoon factor for housekeeping chemicals. Below the
  department's cover target, the planner warns at least 24 h before reorder and drafts the top-up ticket for the
  in-charge to send.
- **Central store.** Cover against lead time, ABC/VED (existing `abc_class` and `ved_class`) and expiry for
  dated consumables. The planner drafts PRs for S5.
- **Par suggestions.** Quarterly, from 90-day use. The materials head accepts or edits them.
- **The budget metric.** No stock-out without a prior warning. Every shelf at 0 is checked for a warning
  ≥ 24 h earlier.
- **Spend guard** (Q2). A draft that would push a department past its monthly budget is marked; it is never
  blocked for patient-care items.

#### Autonomy ladder

- T0 warnings, then T2 drafts.
- It may climb to T3, where department top-ups within par go without a tap; the HOD still approves and a person
  still receives. The gate is 4 weeks with ≥ 95 % of drafts accepted unchanged and no stock-out, and the owner
  approves the climb.
- Never: submit a PO, approve anything, or change a par.

#### Questions that block it

- **Q2.** Department budgets and their warning lines.
- Data: S1 and S2 must have run for 8 weeks.

#### Done means (sketch)

- A shelf item whose cover falls under target gets one warning and one draft, and never a second open draft for
  the same shelf and item.
- A stock-out with no warning ≥ 24 h earlier is counted on the tower.
- A draft never exceeds the shelf's max.
- The planner holds at most 3 open proposals per department, and halts beyond that.
