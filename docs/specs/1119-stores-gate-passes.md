---
issue: 1119
status: built
approved: 2026-11-18
---
# SPEC: Stores S2c, gate passes and the guard scan (#1119) — APPROVED by owner 2026-11-18

Owner answered Q1–Q5 with the recommended options on 2026-11-18 (decision 0099). This is slice S2c of the Stores &
Procurement programme (`docs/specs/stores-programme.md`). It was decision 11 of #1112 and moved here so S2 can
close on its own; it needs S2b (the custody chain and the quarantine store).

## What exists

- **No gate pass anywhere.** Stock leaves the hospital only as a dispatched supplier return
  (`createSupplierReturn`, `materials/supplier-returns.ts`) or a posted write-off (`materials/write-offs.ts`,
  reasons expiry, damage and recall). Neither records the gate.
- `IN-TRANSIT` is a real store made by `ensureTransitStore` (`materials/stores.ts`); no `OUT-ON-PASS` store exists.
- **Roles.** `security_guard` exists only on the unmerged IPD train (#967).
- There is no scrap-sale record; condemnation and disposal arrive with S4 (#1114).

## Decisions

1. **Returnable pass** (repair, calibration, refill, loan) names the items and quantities, the party it goes to,
   and a due-back date. The guard's exit scan moves the stock to a per-site `OUT-ON-PASS` store; the entry scan
   moves it back to the source store. A partial return leaves the rest out and the pass open. A returnable pass
   past its due-back date is overdue (a red card in S3).
2. **Non-returnable pass** only against a dispatched supplier return or a posted write-off; a scrap-sale record
   joins the list when S4 creates it. It moves no stock (the return or write-off already did); the exit scan
   records the gate.
3. **Who.** The storekeeper or materials head raises a pass (`stores.gatepass.raise`). The guard scans it
   (`stores.gatepass.scan`). The person who raised a pass cannot scan it.
4. **Scan.** The pass prints with a QR carrying the pass number only. A typed fallback takes its last four
   digits. Scans carry a client idempotency key and the scan time, as in #1112 decision 14 (a scan older than
   12 h is accepted and flagged; the web app needs a connection).
5. **Audit.** Raise, exit scan, entry scan and close each append one domain event with actor, time, store, item,
   quantity and reason. Pass scans are append-only (the database refuses UPDATE and DELETE). `storesAuditPack`
   (#1112) lists passes and scans with everything else.
6. **Both passes print** (the gate pass, with the QR).

## Done means

- **D1** A returnable pass moves stock to `OUT-ON-PASS` on the guard's exit scan and back to the source on the
  entry scan; the item's total across stores is equal before and after.
- **D2** An entry scan of 1 of 2 units leaves 1 in `OUT-ON-PASS` and the pass open. After its due-back date an
  open pass is listed in `overdueGatePasses`.
- **D3** A non-returnable pass with no supplier return or write-off reference is refused. With a dispatched
  supplier return it is accepted, and its exit scan posts no ledger row.
- **D4** An exit scan sent twice with one idempotency key records once. A second exit scan of a pass already out
  is refused. The person who raised the pass is refused as scanner, and so is anyone without
  `stores.gatepass.scan`.
- **D5** Every pass act appends one domain event. UPDATE and DELETE on `stores_gate_pass_scans` are refused by the
  database. `storesAuditPack({store: OUT-ON-PASS})` lists each pass's raise and scans in order.
- **D6** (web, 390 px) The guard screen opens on the scanner; the typed last four digits find the pass; "Let
  out" or "Let in" is reachable in ≤ 2 taps with no horizontal scroll; every status shows a word.

## Screens

Phone 390 px, no horizontal scroll. Every status is a word. Notices are a few words on one line. Strings are
verbatim, English / Hindi. Loading is grey rows with no text.

- **Gate (guard, phone).** Opens on the camera. Fallback "Type last 4 / आख़िरी 4 अंक लिखें". After a scan: pass
  number · returnable or not (Returnable / वापसी वाला, Non-returnable / बिना वापसी) · items and quantities ·
  due back. Primary: **Let out / बाहर जाने दें** or **Let in / अंदर आने दें**. Refused: "Pass not valid / पास
  मान्य नहीं", "Already out / पहले ही बाहर", "You raised this pass / यह पास आपका है". Done: "Recorded / दर्ज हुआ".
- **Passes (store, web).** Rows: pass · kind · party · items · due back · status word (Out / बाहर, Back / वापस,
  Overdue / समय निकला, Closed / बंद). Primary: **New pass / नया पास** (then **Print pass / पास प्रिंट करें**).
  Empty: "No passes / कोई पास नहीं". Refused: "Return or write-off needed / वापसी या राइट-ऑफ़ ज़रूरी".
- **Notices.** To the raiser when a returnable pass goes overdue: "Pass overdue / पास का समय निकला".

## Budgets

- A guard scan takes ≤ 2 taps. A pass is raised in one screen.

## Out of scope

- Scrap sale and condemnation (S4, #1114). Vehicle and visitor passes. The native staff-app guard screen and its
  offline queue (its own follow-up).

## Build notes

- **Files.** Stores: `gate-pass.ts`, the guard screen, the passes tab, the gate-pass print. Materials, additive
  only: an `ensureTransitStore`-style creation of the per-site `OUT-ON-PASS` store.
- **Migration** yes, one: `stores_gate_passes`, `stores_gate_pass_scans` (append-only by trigger).
- **Permissions** `stores.gatepass.raise` (`storekeeper`, `materials_head`) and `stores.gatepass.scan`
  (`security_guard`). These touch the seed-roles pins and README prose.
- **Roles.** `security_guard` comes from the IPD train with identical key and title if stores lands first
  (`docs/specs/stores-programme.md` §11).
- **Size** M. **Depends on** #1112 (S2b). **Blocked by** nothing.
