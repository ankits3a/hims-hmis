# HANDOFF — pharmacy stage D (medication safety), 2026-09-29

This is written for the next session, whether local or a GitHub-connected cloud session. It records what was done,
what is still in flight, and what is left. The design is in
`docs/superpowers/plans/2026-09-28-pharmacy-safety-stage-d.md`, and its As-built and DECIDED notes are the detailed
record. Read that doc and this one, and nothing bigger.

## Owner rulings, 2026-09-28 (verbatim where quoted)

- "IPD, Emergency, Insurance/TPA, Blood Bank, Dailysis, Immunisation, Ambulance, mortuary each will have individual
  brainstorm session. For now, let's only focus on Pharmacy department."
  - Ward issue and ward returns (D6), the IP bill, the OPD/IPD toggle and MAR all wait for the IPD brainstorm.
  - TPA credit waits for the Insurance/TPA brainstorm.
- Patient GSTIN on the pharmacy bill: **No**. Old MRP beside the new MRP: **No**. Home delivery or online orders: **No**.
- D5 approver: "I leave upon you to choose the right and logical role". **DECIDED:** a new role,
  `antimicrobial_steward`, per ICMR AMSP. It goes to the ID physician; if there is none, the clinical microbiologist;
  if there is none, the AMSP lead named by the MS. A steward never approves their own prescription.
- Build order D1 → D2 → D3 → D5 → D4: approved ("yes go ahead with build order").

## Done (merged to main)

| Stage | What | PR | Merge SHA | Migration | In prod? |
|---|---|---|---|---|---|
| D1 | ADR reporting (PvPI form; allergy written in the same tx) | #353 | f0071001 | 0141 | **yes** (prod 2194011e) |
| D2 | Medication error / near-miss log (NCC MERP, blame-free, errors per 1,000 lines) | #354 | a6b61bcd | 0142 | no |
| D3 | Fridge temperature log plus excursion hold at the counter and walk-in | #364 | f9f87500 | 0143 | no |
| D5 | Reserve/restricted antimicrobial gate (steward approval) | #365 | 3c969b8b | 0144 | no |

## In flight — do these in order

### 1. **#387 — PRODUCTION-SAFETY FIX. Must merge before ANY deploy of main.**

- **The problem.** `docker/prod/deploy.sh` (~l.836) runs `seed-pharmacy.js` on every deploy. D5 had put the WHO
  AWaRe classification into that seed, which would restrict 1,857 products (Reserve + carbapenems) in prod with no
  steward appointed. Meropenem and colistin would be refused at both counters.
- **The fix.** The classification moves to `scripts/classify-aware.ts` (`aware:classify`). It is run by hand, and it
  refuses until someone holds `antimicrobial_steward`.
- **Status at handoff.**
  - Auto-merge (squash) is armed.
  - The first pull_request run failed only on 15 s hook timeouts in unrelated suites; its push twin was green.
  - An empty commit (20db641d) was pushed to re-run CI.
- **If it goes red again:** read the failing test names. Hook timeouts = runner noise. This box's token cannot
  `gh run rerun`, so push another empty commit.

### 2. **D4 + wiring — branch `lane/pharmacy-safety-wire`** (this branch)

Its PR is open with auto-merge OFF, because it must wait its turn in the queue below. Four commits sit on main
fec21507:
- **D4, crash-cart and emergency-tray checks** (migration **0150**; generated as 0145, regenerated as 0149 and then 0150 at the 2026-09-29 merges of main because main took 0145–0149):
  - The daily seal check, monthly full check and after-use check.
  - The server decides whether a tray is deficient.
  - Restock issues exactly the deficit from `PHARM-OPD`.
- **Menu wiring:**
  - Office pages `law/adr`, `law/incidents`, `stock/cold` and `stock/trays`.
  - The Today rows deep-link to those pages.
  - The desk gets "Report a reaction".
- **The D5 HTTP e2e.**
- **ADR register phone-width fix.**

Tests, run locally after the last rebase:
- typecheck clean, lint 0 errors
- core 66/66 targeted, seed-roles 20/20
- web 245/245

**When it is this PR's turn:**
1. Merge main in. Do NOT force-push: the branch is pushed, so merge, never rebase.
2. Re-read the seed-roles pins **from a run**. Other PRs (#379 break-glass, #380 billing, and A3b's descendants) also
   move them. The pinned values are in `apps/core/test/seed-roles.test.ts`: `modelPairs`, `NON_TABLE_PAIRS`, the
   per-role map and the two bare `granted/already` arrays. Read the numbers off the failing run; never predict them.
3. If main has taken 0145, REGENERATE the migration with drizzle-kit and re-append the hand-written trigger SQL.
   Never rename it.
4. Arm auto-merge.

### 3. The agreed merge queue

Strict branch protection means one PR at a time. Whoever merges pings the next owner.

1. **#387 (fix)**
2. #370 (C reports, lane owner hmis-ee)
3. #361 (hmis-b7)
4. **D4+wiring (this branch)**
5. #369 (A5, hmis-ee; regenerates its migration to the next free number, 0146)
6. #363
7. #366
8. #367
9. #371
10. #372 and #375 (hmis-b7; migrations renumbered at their turn)
11. #373
12. #379 (MS break-glass, seed-roles)
13. #380 (billing back office, migration)

The peer sessions hmis-ee (the `pharmacy-gaps` plan: A3b/A5/C) and hmis-b7 (the UX audit) coordinate over local
cross-session messages. **A cloud session cannot message them.** Coordinate through PR comments, or check PR states
with `gh pr view` before merging, and never merge a PR out of its queue slot.

### 4. Deploy

hmis-b7 plans ONE production deploy after the whole queue lands, and it waits for #387. Nothing in stage D is unsafe
to deploy once #387 is in, because every stage stays dormant until a person enters data:
- no fridges registered;
- no trays created;
- nothing restricted until `aware:classify` runs.

## Owner steps after the deploy (tell the owner; do not do them without a person)

1. Appoint an **antimicrobial steward** at `/admin/users`.
2. **Then** run `compose run --rm api node dist/scripts/classify-aware.js` once. It refuses before step 1.
   - After it runs, Reserve antibiotics and carbapenems need the steward's approval.
   - The walk-in counter refuses them outright.
3. Register each pharmacy fridge (office → Stock → Cold chain). Readings are due at 09:00 and 17:00 IST.
4. Set up each emergency tray with its contents and par quantities (office → Stock → Trays).
5. A pharmacist runs a full real day on the live system. This is still the real test against Healthray, and it is
   still owed.

## Deferred (small; none blocks go-live)

- D1: pre-filling from the consult note (copilot draft).
- D3: gating a TRANSFER of a held batch. The dispense of that batch is already refused in any store.
- D4:
  - a patient picker on the after-use sheet (the API accepts `patientId`);
  - returning replaced near-expiry units;
  - renaming or retiring a tray;
  - charging tray drugs to the patient (that belongs to the ER/IPD brainstorms).
- D5: pre-filling the ask from the CDS card's `micro_order`.
- D2: the indicator sits on the D2 screen, not yet on office Reports.
- Browser walk: the final re-check at every width was cut by low memory. Widths ≥1024 were clean before the
  phone-width fix, and 390/768 were re-checked after it.

## Rest of the pharmacy plan (not this lane)

The gap-closure phase doc `docs/superpowers/plans/2026-09-28-pharmacy-gap-closure.md` is owned by lane
`pharmacy-gaps` (hmis-ee):
- A5 is #369.
- C is #370.
- A6 (labels + indent), B1/B4/B5 (screens) and the remaining C items are still open there.

## Lessons (also in the local auto-memory)

- `deploy.sh` runs EVERY config seed on every deploy. A seed must never flip clinical or money behaviour. A go-live
  act gets its own script that refuses until its precondition holds.
- `test/ist-clock-parity.test.ts` refuses a new copy of the IST offset. Use the helpers in
  `apps/core/src/modules/pharmacy/config.ts`.
- `test/seed-staff.test.ts` pins `KNOWN_ROLE_KEYS`. A new role moves it: it only shows up on CI's shard, not in
  seed-roles.
- CI runs every commit twice (push + pull_request). A red on one twin that is only hook timeouts is runner noise.
- Strict protection plus many sessions means a green PR goes stale. Agree a queue and take turns.
