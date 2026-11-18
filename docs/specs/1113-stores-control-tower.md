---
issue: 1113
status: approved
approved: 2026-11-18
---
# SPEC: Stores S3, the control tower, Now cards, concierge and chaser (#1113) — APPROVED by owner 2026-11-18

Owner answered Q1–Q5 with the recommended options on 2026-11-18 (decision 0099). This is slice S3 of the Stores & Procurement programme (`docs/specs/stores-programme.md`) and needs
S2. Owner, 2026-11-18: "This master stock/inventory register needs to be like a control tower of materials under
procurement department … a true agentic AI and assisted co-pilot."

## What exists

- **No stores board and no stores copilot tools.** Copilot tools exist in billing, opd, doctor-desk, roster,
  radiology and pharmacy. #1082 (radiology) is the shape this spec follows.
- **The masker** (`kernel/copilot/mask.ts`) reads `[A-Za-z]{1,5}\d{10}` as an identifier. An indent number
  (`MIN` + yymmdd + 4 digits) is caught by it today.
- **Now cards** come from module desk providers (`kernel/desk/registry.ts` `collectDeskProviders`, with a
  250 ms budget per provider).
- **Copilot rules already in force:** the ask ledger (575), propose → confirm → act (580), and halt plus the
  ₹5,000/day cap (581, decision 0064). A copilot proposal confirmed by the person's own tap is the person's act
  (decision 0069).

## Decisions

1. **One read: `towerView(site, now)`.** It is derived from S1 and S2 rows; nothing about a lane is stored. It
   has six lanes:
   - Requested: awaiting approval.
   - Approved: waiting to be picked.
   - Picking.
   - In transit: holder and minutes since the last hand-off.
   - Delivered: today.
   - Stuck: past any clock.

   A card sits in exactly one lane, and Stuck wins.
2. **Clocks.**
   - Approval: 60 min.
   - Picking, from approval: routine 4 h, urgent 30 min, emergency 10 min (emergency counts from raise).
   - Transit leg: 30 min.
   - An open short: 24 h. An emergency review: 24 h.
   - A returnable pass past due.
   - A porter holding custody for more than 2 h, or holding at the end of a shift once attendance knows it.

   Stuck names the clock that broke.
3. **Floor map.** Departments sit under their floor (the shelf's parent). A department shows "Out" if any shelf
   item is at 0 and "Low" if any is under reorder. It always shows a word, never colour alone.
4. **Red cards.** A top strip of at most 8 cards, oldest first: stuck tickets, open shorts, shelves that are out,
   overdue passes, emergency reviews due, "More than book" checks. Clicking a card opens the ticket timeline.
5. **Numbers strip.**
   - Today's tickets, the median approval minutes, the median raise-to-deliver minutes, the double-signed share
     and the open shorts.
   - **Spend** this month per department at cost (charges minus credits) shows only to holders of
     `stores.spend.read`: the owner, the materials head and the medical superintendent. Doctors never see it
     (decision 0058).
   - Spend is per OPD visit for OPD departments, and per occupied bed-day once IPD is live.
   - A budget line arrives with S5's department budgets (#1115).
6. **Non-drug only.** Ruled (0099 Q5): no pharmacy tile. The tower carries
   no patient data at all.
7. **Wall and screen.** The design is 1920 × 1080, with no vertical scroll at 1366 × 768. It refreshes every
   15 s and shows "Offline" when the heartbeat is lost. The layout shifts slightly each hour so nothing burns
   into the wall screen.
8. **Concierge.**
   - Seven intents under `stores.*`, cue-routed by the phrasebook only. There are no chooser menu entries, so the
     frozen eval set is untouched; adding menu entries later is its own issue.
   - Cues in English, Hindi (Devanagari) and Hinglish.
   - Each tool returns an answer key and parameters read from intents, so the model never writes a number. New
     keys go into the contracts list and both locales, in short words.

| Intent | Kind | Permission | Wraps |
|---|---|---|---|
| `stores.where_is_ticket` | read, needs ticket | `stores.shelf.read` (own department) or `stores.tower.read` | `ticketTimeline`: lane, holder, minutes, next step |
| `stores.my_tickets` | read | `stores.shelf.read` | the asker's department's open tickets by lane |
| `stores.waiting_for_me` | read | any stores grant | approvals, picks, carries or receipts waiting on the asker |
| `stores.where_is_item` | read | `stores.shelf.read`, also `stores.tower.read` | on hand per visible place: stores, the asker's shelves, IN-TRANSIT |
| `stores.shelf_low` | read | `stores.shelf.read` | the asker's shelves' Low and Out items |
| `stores.stuck` | read | `stores.tower.read` | red cards by kind |
| `stores.reorder` | act | `stores.shelf.work` | S1 `shelfReorderDraft` → S2 `raiseTicket` |

9. **`stores.reorder` follows propose → confirm (580).**
   - `recheck` re-reads the shelf, and also whether a reorder ticket for that shelf is already open.
   - `apply` raises the ticket.
   - `verify` reads it back.
10. **Never a tool:** approve, decline, review, claim, issue, carry, hand over, receive, resolve a short, write
    off, gate pass, any supplier message, any money.
11. **The masker learns the indent number shape,** as it learned the accession for radiology. "MIN… kahan hai?"
    routes with the ticket as its subject and no identifier leak.
12. **Chaser.** It sits at T1, makes internal nudges only, and is run by a worker sweep every minute.
    - An approval waiting 45 min sends one bell to the department's approvers. At 60 min it is Stuck and on the
      duty manager's Now card.
    - Picking past its clock goes to the store's Now card. A transit leg past 30 min goes to the porter's phone
      and the store.
    - At most one nudge per ticket per step, recorded. Never to a supplier or a patient.
13. **Now cards.** "Indents to approve" (HOD), "To pick" (store), "To receive" (department), "Stuck" (materials
    head, duty manager).
14. **The station shell's `copilot` slot** is passed on the tower and the department shelf.

## Done means

- **D1** `towerView` puts each open ticket in exactly one lane. A ticket waiting 61 min for approval is in Stuck
  with the clock "approval, 61 min".
- **D2** An in-transit card shows the current holder and the minutes since the last hand-off, equal to the
  custody chain's.
- **D3** In the floor map, a department with a shelf item at 0 shows "Out" under its floor. One with every item
  above reorder shows "OK".
- **D4** Given one stuck ticket, one open short and one overdue pass, the red-card strip lists three cards,
  oldest first. It never lists more than 8.
- **D5** The spend tile is present for a holder of `stores.spend.read` and absent (the key is not in the
  response) for a storekeeper. A department's value equals the month's cost-centre charges minus credits.
- **D6** `towerView` never lists a drug item or a pharmacy store, and has no patient field (the key set is
  asserted).
- **D7** The boot collector lists the seven stores intents, each with a declared permission. The intents
  declared `act` are exactly `stores.reorder`.
- **D8** Thirty phrases (ten each in English, Hindi and Hinglish) route to their intents by the phrasebook
  alone.
- **D9** A question containing an indent number is masked before routing, and the ticket returns as the subject.
  `stores.where_is_ticket` answers the same lane, holder and minutes as `towerView`'s card.
- **D10** `stores.where_is_item` answers per-place quantities whose sum equals the ledger balances of that item
  over the asker's visible places.
- **D11** `stores.waiting_for_me` for an HOD lists exactly their department's pending approvals; for a porter,
  only the tickets the porter holds. Another department's tickets never appear.
- **D12** `stores.reorder`: propose then confirm raises one ticket with the draft's lines and writes one act row.
  If a reorder ticket for that shelf is raised between propose and confirm, confirm answers "state changed" and
  raises nothing.
- **D13** The chaser sends one bell to the approvers when an approval has waited 45 min, and none on the next
  sweep at 50 min. At 60 min the duty manager's Now card lists the ticket.
- **D14** With the copilot halted for reads, or the model unavailable, `towerView`, the Now cards and the
  timeline still answer.
- **D15** (web) The tower at 1920 × 1080 renders six lanes and the red-card strip, and its Stuck count equals
  `towerView`'s.
- **D16** Every concierge proposal and every confirmed act appears in the copilot ledger with the confirming
  person. `storesAuditPack` for an item and a date range lists every movement, store, person and reason in order,
  and its totals equal the ledger's.

## Budgets

- The tower refreshes every 15 s. A Now card provider stays within the 250 ms desk budget.
- The concierge answers in ≤ 2 s on the phrasebook path.
- The owner can read "how many stuck, and where" at a glance from across the room.

## Out of scope

- Chooser menu entries and model text; supplier chasing (S5); forecasting and warnings (S7).
- A pharmacy tile (ruled out, 0099 Q5); the budget line (S5); the native phone app.

## Build notes

- **Files.**
  - Stores: `tower.ts`, `copilot-tools.ts`, `copilot-intents.ts`, `copilot-acts.ts`, `chaser.ts`, the desk
    providers and `manifest.ts`.
  - Kernel and shared: `kernel/copilot/mask.ts` (SHARED, kernel), `packages/contracts/src/copilot.ts`, the
    locales (SHARED), and a new eval items file under `kernel/copilot/acceptance/eval/` (add only; existing items
    are locked).
  - `worker.module.ts` for the chaser sweep (SHARED; read the worker-pool sizing note first).
  - Web: `/stores/tower` (16:9) and the copilot slot on the shelf.
- **Migration** small: `stores_nudges` (one row per ticket and step).
- **Permissions** `stores.tower.read` and `stores.spend.read`.
- **Size** L. **Depends on** S2. **Blocked by** nothing.
