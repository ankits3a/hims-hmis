---
issue: 1117
status: built
approved: 2026-11-19
---
# SPEC: Stores S7, the stock planner agent: cover, early warnings, top-up and purchase drafts, par suggestions (#1117) — APPROVED by owner 2026-11-19 (decision 0101)

Slice S7 of the Stores & Procurement programme (`docs/specs/stores-programme.md`). The programme's budget row is
"stock-out without warning: 0, with the warning at least 24 h before". Decision 0099 Q2 gives the department
budgets (warn at 80 % and 100 %, never block a patient-care item). Needs S1 (#1111) and S2 (#1112), and **at least
8 weeks of their use history per item and shelf** before it forecasts that pair; S5 (#1115) to turn central
shortfalls into purchase requests. The agent drafts; people send, approve and receive.

## What exists (verified in `stores-s3` on 2026-11-19; file and symbol)

- Materials reads: `availableQtyByItem`, `consumedQtyByItem` (`materials/ledger.ts`), `onOrderAt`,
  `stockLevelsAt` (`materials/purchase-orders.ts`); `items.lead_time_days` (1–365), `items.abc_class`,
  `items.ved_class` (`kernel/db/schema/materials.ts`); par in `item_stock_levels` (min ≤ reorder < max).
- S1: `shelfReorderDraft` (par-based, rounded to the issue pack), `shelfView` use per day over 30 days and per OPD
  visit; use per bed-day null while IPD is off production (owner 2026-10-13). S1 use rates are net of reversals
  (`stores/MAP.md` §5).
- S2: `raiseTicket` with channel `agent` (`stores/types.ts` `TicketChannel`), linked tickets keeping the first clock; S3: `boardCards`, the red-card strip, the chaser on
  `sweepStaffNotices`, the `stores.reorder` act with recheck (580).
- Pharmacy's reorder logic (`pharmacy/replenishment.ts`, `purchase-drafts.ts`) is pharmacy's; nothing moves.
- No warning, forecast or planner table exists in stores.

## The flow (one journey per actor, end to end)

1. **Night (02:00 IST), and at every use.** At night the planner reads every Stores shelf item and every
   central-store item (on hand, on order, open tickets, use per day, workload, lead time) and writes forecasts,
   warnings and drafts. During the day each "Used" or receipt at a shelf re-checks that one item against its
   stored forecast, so a sudden run on gloves warns the same hour, not the next morning. It sends nothing.
2. **Department in-charge (phone), morning.** Now card "3 run out in 2 days / 3 सामान 2 दिन में खत्म". One tap
   opens the top-up draft with quantities filled and a one-line "why" per line ("uses 6 a day, 9 left / रोज़ 6,
   बचे 9"). Edit a number if needed; **Send / भेजें** raises the S2 ticket (third tap). If the department is past
   80 % or 100 % of its budget the draft says so; it is never stopped (S5 decision 15). "Not now / अभी नहीं" with
   a reason chip closes the card until the item is warned again.
3. **HOD.** Approves as any S2 ticket. Nothing new.
4. **Buyer (desk).** Central shortfalls arrive as `planner` purchase requests on S5's grouping, each line showing
   cover days, lead time, ABC/VED class and on order. The materials head approves them as any central PR.
5. **Materials head, quarterly.** "Par suggestions / पार सुझाव": per shelf item, today's min/reorder/max beside the
   suggested ones from 90 days of use, with the reason. **Accept / मानें**, edit, or **Keep / जैसा है**. Only a person
   changes a par.
6. **Owner and materials head, monthly.** One line: "Stock-outs without warning: 0 · drafts accepted unchanged:
   93 %". The tower shows any stock-out with no warning as a red card.
7. **Look back.** For any stock-out, `plannerTrail(shelf, item)` shows the forecasts, warnings, drafts and what
   people did with them, in order.

## Decisions

1. **Built in `stores`, reading materials only through `index.ts`.** Pharmacy's replenishment is untouched.
2. **Use per day.** Over the last 8 weeks, net of reversals, the last 4 weeks weighted 2 : 1 against the 4 before.
   A shelf item with < 8 weeks of history shows "Learning, 3 of 8 weeks / सीख रहा, 8 में 3 हफ़्ते" and the planner
   falls back to S1's par rule (warn at reorder, draft to max). The planner can therefore ship before 8 weeks of
   history exist and switches on per item as history accrues.
3. **Workload.** Where use correlates with workload, use per day = use per unit of workload × the expected workload
   (same weekday, last 4 weeks): OPD visits now, occupied bed-days once IPD is on production. The planner picks the
   workload form only when it beat plain use per day on the last 4 weeks' error (measured, stored with the
   forecast); otherwise plain use.
4. **Seasonality.** A month factor (for example housekeeping chemicals in the monsoon) is learned from the same
   months last year only when ≥ 12 months of history exist; until then there is none. Nobody types a factor.
5. **Shelf warning.** Hours to zero = on hand ÷ hourly use (on hand includes stock already on its way to the shelf
   on an open ticket). The planner warns when hours to zero ≤ 48, or when on hand ≤ reorder, whichever comes first;
   the 48 h is the 24 h budget plus the routine delivery window, so a warning is always ≥ 24 h before zero if a
   person acts within the shift. The check runs at night for every shelf item and, in the same transaction as
   each shelf use or receipt, for that one item against the stored forecast (plain arithmetic, no job, no model).
   One warning per shelf item until it recovers above reorder; urgent words if hours to zero ≤ 24.
6. **Top-up draft.** One draft per shelf, all warned lines, quantity = max − on hand − on its way, rounded up to
   the issue pack, never above max. **Never a second open draft for the same shelf**; a new warned line joins the
   open draft. A draft unsent for 24 h is re-checked (it may be withdrawn if stock arrived). A department's
   drafts for all its shelves are **one proposal** (one Now card with a section per shelf; each shelf's section
   is sent as its own ticket), so a department with many shelves never trips the limit in decision 12.
7. **Central store.** Reorder point = use per day × (lead time + safety days); order up to = reorder point + use per
   day × review period, less on order, rounded up to the purchase pack. Safety days and review period by ABC/VED
   class. Ruled (decision 0101 Q8): safety days on top of lead time Vital 15, Essential 7, Desirable 3; order to cover 30 days for C-class items, 15 for B and 7 for A. Dated consumables: never order more than is used before expiry − 30 days at the
   expected use. Lead time is the item's `lead_time_days`, else the median of the last 3 PO-to-GRN days, else 7
   (DECIDED). Output: one `planner` PR per category per night (S5).
8. **Par suggestions.** Quarterly, from 90 days of use: min = use per day × 1 day, reorder = use per day × (supply
   interval + 1 day), max = reorder + use per day × supply interval, where the supply interval is the shelf's
   median days between deliveries (DECIDED). Shown with the old par; accepted only by the materials head
   (`stores.masters.manage`); acceptance writes S1's par event.
9. **Slow and dead stock.** A shelf item with no use in 90 days: "Not used in 90 days, return? / 90 दिन से इस्तेमाल
   नहीं, लौटाएँ?" to the in-charge (a return ticket in one tap, S2). A central item with no issue in 180 days goes to
   the materials head's list. A dated batch that will pass its expiry before it is used at today's rate goes on
   the same list as "Will expire unused / बिना इस्तेमाल खत्म होगा". The planner never writes anything off.
10. **Spend guard.** A draft that would carry its department past 80 % or 100 % of the month's budget (S5) shows
    the word and is still sendable. DECIDED, the same rule as S5 decision 15: nothing is held for budget, patient
    care or not; over-budget tickets carry the mark and go on the monthly over-budget list to the owner.
11. **Autonomy.** T0 warnings and T2 drafts. **T3** (a top-up within par sent without the in-charge's tap; the HOD
    still approves and a person still receives) only after 4 weeks with ≥ 95 % of drafts sent unchanged and no
    stock-out without warning, measured by `plannerScore`, and the owner's yes (a config flag per department, every
    change an event). Never: submit or approve a PR or PO, change a par, write off, message a supplier.
12. **Limits.** At most 3 open proposals per department (programme §7): the top-up proposal, the slow-stock
    proposal and the par-suggestion set are one each. Beyond that the harness halts the planner for that
    department and tells the materials head. It obeys the copilot halt and the configured daily spend cap; the
    planner's math needs no model, so a halt of the model stops only its one-line "why" text, which falls back to
    a fixed template.
13. **The metric.** `stockOutsWithoutWarning(from, to)`: every time a shelf item reached 0 on the ledger, was there a
    planner or par warning for it ≥ 24 h earlier? Those without are counted on the tower and in the monthly line.
14. **Who.** No new grant for reading: warnings and drafts reach the shelf's grant holders and the buyer. One new
    grant `stores.planner.manage` (materials head): pause per department, the T3 switch (with the owner), and
    the safety-days table (ruled, decision 0101 Q8; the ruled figures are the defaults).

## Audit by construction

- Every forecast the planner acts on is stored with its inputs (history window, workload form, error, factor) in
  `stores_planner_forecasts`, append-only, so any warning or draft can be re-derived.
- Warnings, drafts, withdrawals, par suggestions and their outcomes are append-only rows and `copilot_acts`
  proposals with the person who sent, edited, accepted or declined; edits keep both numbers.
- Every number in the "why" text comes from the forecast row (programme principle 6); the model never writes a
  number.
- `storesAuditPack({item | store})` lists planner warnings and drafts beside the tickets they became; each export
  writes one event.

## Done means

Each id is one acceptance test that calls intents, passes `now` in and is red against `main`.

- **D1** A shelf item with 8 weeks of history, 9 on hand, using 6 a day, gets one warning and one draft line; the
  next night's run, unchanged, adds neither a second warning nor a second open draft for that shelf.
- **D2** A shelf item not warned at night whose on hand falls, by one `recordShelfUse` in the day, to under 48
  hours of its stored hourly use has one warning when that call returns, with no job run.
- **D3** A draft line never exceeds max − on hand − on its way, rounded up to the issue pack only when that stays at
  or below max; an `expensed` or `durable` item is never drafted.
- **D4** A shelf item with 3 weeks of history is marked "Learning, 3 of 8 weeks" and warned only at its reorder
  level (S1's par rule).
- **D5** `stockOutsWithoutWarning` counts a shelf item that hit 0 with no warning ≥ 24 h before, and does not count
  one warned 30 h before; the tower's red card count equals it.
- **D6** For a central item with lead time 10 days and on order covering the shortfall, no PR is drafted; without
  the order, one `planner` PR line is drafted at the computed quantity; a dated item's quantity never exceeds use
  before expiry − 30 days.
- **D7** Par suggestions for a shelf item with 90 days of use equal the decision 8 formula; nothing changes the par
  until the materials head accepts, and acceptance writes one par event with before and after.
- **D8** A department with five shelves, each with warned lines, has one open top-up proposal holding five draft
  sections and is not halted. A department already holding 3 open proposals gets no fourth; the materials head is
  told once.
- **D9** A draft that crosses 80 % of the department's budget carries "Budget 80% used" and is still sendable; one
  above 100 %, for any category, is sendable and its ticket carries "over budget".
- **D10** With the model unavailable or the copilot halted for text, warnings and drafts still appear with the
  template "why"; every number in it equals the forecast row's.
- **D11** Sending a draft section unchanged raises one S2 ticket with its lines and channel `agent`, and one
  `copilot_acts` row naming the sender; editing a line keeps the planner's and the person's numbers; "Not now"
  without a reason chip is refused.
- **D12** `plannerScore` over 4 weeks equals the share of drafts sent unchanged and the stock-outs without warning,
  recomputed by the test from rows; the T3 switch is refused unless the score passes and the owner's approval is on
  record.
- **D13** (audit) Every warning, draft, withdrawal and par suggestion is an append-only row (UPDATE and DELETE
  refused) with its forecast inputs; `storesAuditPack({item})` lists warning → draft → ticket in order, and
  `plannerTrail(shelf, item)` returns the same chain for one stock-out.
- **D14** (web, 390 px) From the Now card the in-charge sends the top-up in ≤ 3 taps; each line shows quantity and
  its one-line why on one line with no horizontal scroll.
- **D15** (web, 16:9) The par suggestions screen shows old and suggested par side by side for 50 items at
  1366 × 768 with Accept / Keep per row and every status a word.

## Screens

Phone 390 px, no horizontal scroll; par suggestions 16:9. Every status is a word. Notices are a few words on one
line. Strings verbatim, English / Hindi. Loading is grey rows with no text.

- **Now card (department).** "3 run out in 2 days / 3 सामान 2 दिन में खत्म"; urgent: "Runs out today / आज खत्म होगा".
- **Top-up draft (phone).** Rows: item · quantity (editable) · why ("uses 6 a day, 9 left / रोज़ 6, बचे 9").
  Words: Low / कम, Runs out soon / जल्द खत्म, Learning / सीख रहा. Budget line: "Budget 80% used / बजट 80% खर्च".
  Primary: **Send / भेजें**. Secondary: "Not now / अभी नहीं" (reason chips: Stock arrived / सामान आ गया, Use
  changed / खपत बदली, Other / अन्य). Done: "Sent / भेज दिया". Withdrawn: "No longer needed / अब ज़रूरत नहीं".
- **Par suggestions (16:9, materials head).** Rows: shelf · item · min/reorder/max now · suggested · why. Primary
  per row: **Accept / मानें**; secondary "Keep / जैसा है". Empty: "No suggestions / कोई सुझाव नहीं".
- **Slow stock card.** "Not used in 90 days, return? / 90 दिन से इस्तेमाल नहीं, लौटाएँ?" with **Return / लौटाएँ**.
- **Monthly line (owner, phone).** "Stock-outs without warning: 0 / बिना चेतावनी खत्म: 0 · Drafts unchanged: 93% /
  बिना बदले ड्राफ़्ट: 93%".
- **Halt notice (materials head).** "Planner paused: 3 open / प्लानर रुका: 3 खुले".

## Budgets

- Nightly run ≤ 10 min for 5,000 shelf items; Now card provider within the 250 ms desk budget.
- Stock-outs without warning: 0. Warning lead ≥ 24 h before zero. Top-up ≤ 3 taps from the card.
- Drafts sent unchanged ≥ 95 % (the T3 gate; shown, not enforced).

## Edge cases

1. **Use spikes** (an outbreak doubles glove use). The warning comes from hours to zero, re-checked at every use
   (decision 5), so it reacts the same hour; the 8-week average lags and the par suggestion waits for the quarter.
   A spike too sharp to warn 24 h ahead is counted honestly as a stock-out without warning.
2. **A ward closes for renovation.** Use 0; no warnings; slow-stock card after 90 days; the shelf can be paused.
3. **Item substituted** (new glove brand, new item code). History does not transfer automatically; the materials
   head links the old item when creating the new one (S1 merge), and history follows the link.
4. **A short delivery leaves the shelf low.** The S2 re-ask already exists; the planner counts it as on its way and
   does not draft twice.
5. **Stock-out in the central store.** The shelf warning still fires; the draft says "Store is short / स्टोर में कम"
   and the S5 "Buy now" gets the PR as urgent.
6. **Clock change, holidays.** Workload is per weekday from history; public holidays are weekdays with their own
   lower workload, learned only after a year.
7. **A department games the drafts** (always edits up). The score shows it; par suggestions bring par to use.
8. **Data gap from downtime.** Late-synced scans carry `occurred_at` (S2); the planner reads by `occurred_at`.

## Out of scope

- Pharmacy reorder. Supplier lead-time learning beyond the median of PO-to-GRN days. Multi-site balancing.
  Forecasting by an external model service. Sending POs or tickets without a person (until T3 is ruled per
  department).

## Build notes

- **Files.** Stores: `planner.ts` (forecast, warnings, drafts), `planner-central.ts`, `par-suggestions.ts`,
  `planner-score.ts`, desk provider, tower card kind (additive in `tower.ts`). Web: the top-up draft (reuses S1's
  reorder draft screen), par suggestions, the monthly line.
- **Migration** small, one: `stores_planner_forecasts`, `stores_planner_warnings`, `stores_planner_drafts`,
  `stores_par_suggestions`, `stores_planner_settings` (all append-only except settings, which are versioned).
  No materials or pharmacy file changes; the use-time re-check is called from stores' own `use.ts`.
- **Worker** a 02:00 IST planner job in `worker.module.ts` (SHARED; read the pool-sizing note; the run is batched
  per category so it holds one pool client at a time).
- **Permissions** `stores.planner.manage` (1). Seed-roles pins and README prose.
- **Shared files:** seed-roles + test, schema index, drizzle, worker module, locales (i18n-keys test), router.
- **Size** M, one PR. **Depends on** S1, S2 (built) and S5a (the PR table, for central PRs; without it the central
  half is read-only warnings). **Data:** forecasts switch on per item after 8 weeks of S1/S2 use on production; until then the par
  rule runs.
