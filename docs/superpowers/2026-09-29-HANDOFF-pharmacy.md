# HANDOFF — Pharmacy module (session "pharmacy-feature-parity", 2026-09-22 → 2026-09-29)

Written for a fresh session, including a cloud session that sees only this GitHub repository. It has no server
memory notes and no `/opt/hmis-context`, and it cannot reach production. Everything that session needs is in this file or
in the repo paths it names.

State below was **measured on 2026-09-29**. Re-measure before acting on any of it; other sessions are active on pharmacy.

---

## 1. The owner's standing rulings for pharmacy (quote them; don't re-ask)

| Date | Ruling |
|---|---|
| 2026-09-22 | "I want the pharmacy module to be ready anyhow … full authority." Production held no live data then. **UX is non-negotiable: minimal, in flow**, at the level of the `/counter` board. Exceptions live behind ⋯ and sheets, never stacked in the row. |
| 2026-09-22 | Stock: **both** trial stock now AND an opening-stock import for the real shelf; trial stock is wiped when the real sheet goes in. |
| 2026-09-22 | Medicines: a ~350 starter list chosen by us: the catalogue's common OPD brands plus NLEM. |
| 2026-09-22 | Pharmacist registration: **TRIAL** for now (`TRIAL-KJ-0001` on `kavita.joshi`, filed by the owner; valid-until 2050, so it will never prompt a renewal). The real number is owed by the owner. |
| 2026-09-22 | **Loose-tablet MRP:** a full strip bills at exactly its printed MRP; a loose tablet bills at its per-tablet share **rounded DOWN** to the paisa. The patient never pays above MRP. |
| 2026-09-22 | GST sources (owner-supplied): busy.in, gimbooks, credlix (razorpay is stale). Effective **22 Sep 2025**: medicines **5%**; **36 notified life-saving drugs and contraceptives nil**; no 12% slab. *The CA must confirm; Notification 10/2025 lists 37 drugs against the code's 36.* |
| 2026-09-24 | "Everything Healthray does, in our way." Plan: `docs/superpowers/plans/2026-09-24-pharmacy-healthray-parity.md` (read its "as built" sections). **Our app is the payables book of record; export to Tally. The agent DRAFTS, a human confirms; nothing with money or stock posts without a person.** Do NOT copy Healthray's negative stock, live profit on the sale screen, or editable issued bills. |
| 2026-09-25 | Tally export = **TallyPrime XML**. |
| 2026-09-26 | The hospital **does stock NDPS narcotics and Schedule X**. Law brief: `docs/superpowers/plans/2026-09-26-pharmacy-p6-ndps-schedule-x-law.md`. |
| 2026-09-26 | SMS sender = **MSG91** ("token will be provided later"). The adapter is being built by another session (lane `abdm-msg91`) on `kernel/notify/providers.ts`. |

Defaults taken on silence are recorded in the plan doc and are named values in `apps/core/src/modules/materials/config.ts`:
- PO tiers: materials_head approves up to ₹50,000, the owner above.
- Receipt tolerance: +2%.
- Bill match: ±1% or ₹10.
- Supplier terms: 30 days; MSME: 45 days.
- Cash cap: ₹10,000 per day (§40A(3)).
- Expiry return window: 90 days.
- Write-offs: the MS approves, via `materials_stock_adjustment`.

## 2. What was built (all MERGED to main)

| Work | PR(s) | Migration |
|---|---|---|
| Desk: FEFO Batch & Shelf chip (key **B**), decluttered line, one scan box, strips + tablets, header pills | #293 | — |
| Starter shelf, schedule flags (61,748 set in prod), trial stock + wipe, opening-stock import | #294 | — |
| Loose-tablet MRP ruling, one visible row per drug on every bill | #295 | — |
| OPD: "Issue & complete" — Complete had silently dropped un-issued Rx rows | #296 | — |
| OPD: regimen fills real catalogue medicines — **closed a safety gap** where allergy/interaction checks were blind to regimen lines | #297 | — |
| Desk: a generic Rx auto-matches the stocked brand (same salt/strength/form); Save draft is visible | #298 | — |
| P1 counter: desk printing via the print relay (browser fallback), short book (**N** / F2 agent draft), your shift in the rail, `/pharmacy/counter` → desk | #311 | 0123 |
| P2 buy: min/max, **agent-drafted POs**, `kernel/approvals` tiers, GRN against the PO, SoD approver ≠ receiver | #314 | 0125 |
| P3 pay: supplier bill with 3-way match, payables and ageing, MSME 45-day, payment run **the owner authorises with the grid** | #316 | 0127 |
| P4 return: expiry report, return to supplier + debit note, vendor credit offsets the next payment, BMW write-off, recall with callback list | #319 | 0129 |
| P5 know: registers, margin (permissioned), valuation, non-moving, HSN, GSTR-2B, activity diff | #320 | — |
| P5 Tally: TallyPrime XML; B2C posts to ONE "Pharmacy Counter Sales" ledger with **no patient name/UHID/phone** | #322 | 0131 |
| P6 law: NDPS and Schedule X licences, double-lock custody, witnessed hand-over (witness PIN on the shared throttle, timing-safe), append-only Form 3H / X registers | #327, #328, #329 | 0135 |
| Item merge: stock and open work move, history stays; the MS approves | #334 | 0137 |
| Patient messages: bill SMS (transactional), refill reminder **opt-in only**, no drug names ever, DLT ids required | #336 | 0138 |

Production (measured 2026-09-29): running `hmis-prod/server:6b169640`, **145** applied migrations. All of the above is
**deployed**. Pharmacy data in production: 350 shelf items, **882 TRIAL batches still loaded** (vendor `TRIAL-STOCK`),
0 purchase orders.

## 3. What is left

### 3a. Owner acts (no code; the census rows stay RED until they are done)
1. Real pharmacist **State Council registration**, filed at `/pharmacy/pharmacists` (it supersedes TRIAL-KJ-0001).
2. The **CA confirms GST** (5% / nil list; 36 vs 37).
3. The **accountant confirms the Tally ledger names** (office → Reports → Tally → L); export is refused until then.
4. **NDPS / Schedule X:**
   - record the Form 3G RMI recognition and the responsible doctor;
   - record the Form 20F licence;
   - list the trained doctors;
   - run `pnpm classify:ndps` (dry run, then `--apply`);
   - move controlled stock into `PHARM-NDPS`;
   - assign keepers and witnesses.

   Annual filings: Form 3J estimate by 30 Nov, Form 3-I return by 31 Mar.
5. **Real opening stock:**
   - the pharmacist fills `docs/runbooks/pharmacy-opening-stock-template.csv` (guide: `docs/runbooks/pharmacy-opening-stock.md`);
   - then run `wipe-trial-stock --apply`;
   - then run `import-opening-stock --apply`.
6. **MSG91:** IT sets the MSG91 key on the server; enter the DLT template ids and the pharmacy phone on the office Messages screen.
7. Optional: install `tools/print-relay` on the counter PC, mapping `pharmacy_thermal` to the thermal printer.

### 3b. Code deferred by the phases (each is listed in the plan doc's "as built" sections)
- **Short book:** rows are not closed automatically when the PO arrives.
- **Purchase orders:** no short-close for a part-received PO; the PO PDF is not e-mailed.
- **Owner approvals:** the owner can't open the PO sheet from `/approvals`; they decide from the total.
- **Payments:** no printed payment advice or NEFT bulk file.
- **Returns:** a draft return's lines can't be edited on screen. Possibly addressed by open PR #369 — check it.
- **Recall:** no "release as false alarm".
- **GSTR-2B:** credit/debit notes not matched; no .xlsx upload.
- **Tally:** no bill-wise allocation or cost centres.
- **NDPS:** low-strength codeine/morphine exemptions, Form 3E patient signature, r.52U cap / home care, walk-in Schedule X.
- **Item merge:** no unmerge; can't merge while controlled stock is on hand.
- **Patient messages:** SMS STOP replies need the gateway callback; no consent chip at the front desk; no delivery receipts.

### 3c. Other sessions are ACTIVE on pharmacy — check before starting anything
Open PRs on 2026-09-29: #369 (manual/damaged supplier return, gap A5), #370 (missing reports, gap C), #387 (AWaRe
antimicrobial gate). Server lanes: `pharmacy-gaps`, `pharmacy-office-v2`, `pharmacy-reports-c`, `pharmacy-safety-d4/d5/wire`,
`pharmacy-a5`, `pharmacy-aware-gate`. **Ownership is established by open work; don't duplicate it.** Read those PRs first.

## 4. How work was done here (keep doing it this way)

- **One lane per task:** `tools/lane.sh new <name>` (server only). Commit by pathspec. A new test must fail first.
- **The test lock wraps every jest/vitest run:** `/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run <lane> …`.
  A census or manifest change needs the FULL core suite.
- **The owner runs merges and deploys** with `! gh pr merge N --squash --auto` and the deploy command. The permission
  classifier refuses them from an agent even under "full authority". Take a pgBackRest full backup before any deploy that
  carries a migration. Verify the running image by DIGEST, not by tag.
- **Migration numbers race across sessions.** Take the next free number at rebase time. If main gained it, merge
  origin/main and **regenerate with drizzle-kit (never hand-rename)**, re-append any hand-written SQL, confirm the new
  `_journal.json` `when` is strictly greater than the previous one, and drop the lane test DBs. Coordinate with peer
  session `hmis-58`, which queues ABDM/WASA/doctor-desk work.
- **Stacked PRs after a squash:** if `main^{tree}` equals the lower branch's tip tree, then `git merge -s ours origin/main`
  is safe. Prove it: `diff(main, HEAD)` must equal `diff(tip, old head)` by `git patch-id`. Retarget the next PR to main.
  Never set auto-merge on a PR whose base is not main.
- **Always verify:** read the agent screenshots and check CI yourself before handing the owner a merge command.

## 5. If you are a cloud session (GitHub only)

You cannot reach production, the test lock, lanes, or `/opt/hmis-context`. You can:
- read and review PRs;
- write code on a branch and let CI (the gate) run the full suites;
- update docs.

Anything that needs production (loading data, deploys, census reads) must be handed back to the owner as exact commands
to run on the server.

The production pharmacy load used this wrapper, run on the server from any directory. It runs the loaders inside the
deployed image, as `deploy.sh` does:

```bash
docker compose -p hmis-prod -f /opt/hmis-prod/docker-compose.prod.yml --project-directory /opt/hmis-prod \
  run --rm -T -v /opt/hmis-context:/ctx:ro -v "$PWD:/load" api node dist/scripts/<script>.js <args>
# scripts: set-schedule-flags, build-pharmacy-starter-list, load-pharmacy-shelf, load-trial-stock,
#          wipe-trial-stock, import-opening-stock, standup-check pharmacy
```

Design reference: `docs/design/2026-09-18-pharmacy-desk/` (the Desk board with the FEFO chip; `build.mjs` renders it).
Healthray reference: the two docs and 17 screenshots in `/opt/hmis-context/reference/2026-09-19-healthray-pharmacy/`
(server only). Both docs are AI write-ups; only the screenshots are ground truth.
