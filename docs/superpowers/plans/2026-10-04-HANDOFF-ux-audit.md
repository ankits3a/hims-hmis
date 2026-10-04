# HANDOFF — UX audit of the owner's screens (28-Sep → 04-Oct-2026)

Paste the "PROMPT FOR THE NEXT SESSION" block below into a fresh session started in a new lane. Everything else in this file is the context that block points at. Read this file and `CLAUDE.md`; nothing else is needed to start.

---

## PROMPT FOR THE NEXT SESSION

> You are continuing the UX-audit work on the HMIS (Indian hospital OS). Read `CLAUDE.md`, then
> `docs/superpowers/plans/2026-10-04-HANDOFF-ux-audit.md`, top to bottom.
>
> Start with §4 "Do first". Item 1 needs the owner's yes before you commit or push; ask once, plainly.
> Then work through §5 "Next set of work" in its order, one lane and one PR per item. Each item is
> already ruled or decided, so do not reopen a decision. A screen with no board gets a board first
> (§7), and is built only after the owner approves the board.
>
> Never run `deploy.sh` by hand: merged CI-green `main` deploys itself (cron `tools/auto-deploy.sh`).
> To show the owner work in progress, use staging (`tools/stage.sh <lane>`). Take the test lock
> around every jest/vitest run. Only PRs that carry a drizzle migration queue serially; bundle
> everything else into one train PR. Tell the other live sessions (find them with ListAgents) before
> you touch a shared file.

---

## 1. What this phase was

On 28-Sep the owner asked whether 11 screens matched the design assets and were user-friendly:
- /opd/desk
- /opd/slips
- /counter/instruments
- /counter/reconcile
- /merge
- /opd/appointments
- /pharmacy/retail
- /pharmacy/leakage
- /billing/office
- /billing/session
- /billing/dues

They did not. Every screen used the system font, and none followed the counter layout rule. Several had defects that could cause wrong records or wrong money.

The work ran in four steps, then follow-ups the owner added:
1. **Shared app shell** (#351).
2. **Correctness fixes:**
   - #355 merge;
   - #356 cashier session states;
   - #357 appointment slots;
   - #358 back office: ids → names and rupees.
3. **Rebuilds on their existing boards:**
   - #361 /billing/session;
   - #362 /pharmacy/retail;
   - #363 /opd/desk, which became the OPD queue desk.
4. **New boards for the 5 screens with none.** The owner approved them, then they were built:
   - #375 slip desk;
   - #373 merge review;
   - #371 card recognition;
   - #372 card reconcile;
   - #380 billing back office.

**Follow-ups:**
- #366 blind count;
- #379 MS break-glass and no self-review;
- #411 patient profile, from a new approved board;
- #421 front-desk dues permission;
- #422 fixes for sideways scroll at 390 px;
- #425 desk-card test flake;
- #427 token-audit lessons.

Six no-migration PRs landed together as train **#418**.

**Production:** everything above is live. The last hand deploy by this session was b67e92ec. Since then main has moved, and production follows CI-green main automatically.

**Boards in the repo:**
- `docs/design/2026-09-28-ux-audit/`: the 5 boards plus a README with the 28-Sep rulings;
- `docs/design/2026-09-29-patient-profile/`.

**Owner-facing pages:**
- 5 boards: https://claude.ai/artifact/FrjmoLDKrGetNx7V7De6QD
- patient profile: https://claude.ai/artifact/NGo16XLKBEbzSDQa5npwbr

## 2. Owner rulings made in this phase (binding)

**Layout (25-Sep, still binding):**
- Menu in the HEADER.
- LEFT lane (~296 px) holds the person or item in hand. CENTRE is one numbered flow with a pinned single next act. RIGHT (~352 px) holds ONE unfiltered priority list with source chips, then "Clocks running" collapsed.
- No filter tabs or chips on lists. Light surfaces; dark only as accents. IBM Plex.

**Blind count (28-Sep):**
- A cashier or pharmacist never sees her own drawer's EXPECTED cash or "collected today" before she submits her count, on any screen, API or copilot answer.
- Supervisors (`billing.session.read`) do see them.
- Individual transaction lists (invoices, retail day list) stay visible. DECIDED: the blind count hides totals, not rows.

**Money (28-Sep):**
- The billing manager may write off a bank short-settlement up to ₹50.00 per receipt; above that, the owner decides.
- Refunds above ₹25,000.00 go to the owner.
- A card's rupee balance is never shown at the counter; it appears on the bill only.
- An expired card is never honoured.
- A benefit returned to an ended card is usable only after renewal.
- Credit is the owner's alone (earlier ruling).

**Law and privacy:**
- Aadhaar is never stored, not even the last 4 digits.
- The Medical Superintendent holds `auth.break_glass.use`; nobody reviews their own break-glass.
- Merging a sealed record needs the MS's break-glass first.
- "Record a death" requires the MCCD certificate number (Form 4 / 4A).

**Access (30-Sep):** the front desk reads ONE patient's dues via the narrow `billing.dues.patient.read`, never `billing.invoice.read`.

**Partners:** asked to send date of birth and sex in holder files. This is a request, not a contract term.

**Decided by the standard (owner may overrule):**
- A missing slip goes to MRD at day end.
- A torn slip QR can be filed via name or UHID search.
- Match strength is shown as words, never a score.
- Front desk sees dues.

## 3. Coordination facts

- **Other sessions on the box:** pharmacy (hmis-ee) and radiology (hmis-48) were active. Run ListAgents and message them before shared-file edits or migration PRs. hmis-10 (pharmacy stage D) closed; its handoff is `2026-09-29-HANDOFF-pharmacy-stage-d.md`.
- **Merge rules learned** (ledger §2.170–2.176, method 9.6c–9.6e):
  - Main's branch protection is strict.
  - Migration PRs take serial turns and renumber to the next free number at their turn.
  - No-migration PRs go into one train PR.
  - Before any deploy, diff the merged seeds against the seeds `deploy.sh` runs. Deploys are automatic now, but the check still matters for seeds.
  - A test that is red on the PR's own head belongs to the PR.
  - Judge sticky bars in the scrolled viewport, never a full-page screenshot.
- **Memory:** the box has 15 GB and fills up. Background shells get killed for memory, so poll merge turns in the agent's foreground. Use TMPDIR inside the lane; /tmp is a small RAM disk.
- **Process safety:** never `pkill` or kill by pattern; it once killed the prod container. Never touch `hmis-prod-*`.

## 4. Do first

1. **CI test-DB race fix, built and verified but NOT committed. Needs the owner's yes.** It is in lane `ci-shard-db` (`/opt/hmis-lanes/ci-shard-db/hmis`), uncommitted:
   - `apps/core/test/helpers/db.ts` runs migrate under `pg_advisory_lock`;
   - new `apps/core/test/helpers/global-setup.ts` pre-migrates `<db>_1..maxWorkers`;
   - `apps/core/jest.config.cjs` registers the globalSetup.

   **Why it exists:** on 30-Sep main went red in core shard 1 (run 36750365736). A cold 165-migration migrate timed out in `beforeAll(setupTestDb)` at 15 s. Jest moved on, the next suite migrated the same worker DB concurrently, and it failed with `duplicate key … pg_type_typname_nsp_index`, turning 115 tests red.

   **Verified:** racing two setups failed 3/3 on the old helper and passed 3/3 on the new one. The 4 failed suites pass 113/113. Typecheck and lint are clean.

   **Why it isn't pushed:** auto mode refused the commit and push because a peer, not the owner, asked for it.

   **Next:** ask the owner. On yes, commit by pathspec, push, open the PR, arm auto-merge. Main is green today (163c267e), so this is prevention, not an emergency. Check first that main hasn't fixed it another way: `git show origin/main:apps/core/test/helpers/db.ts | grep -i advisory`.
2. **Owner steps that only the owner can do.** Remind them once; never do these for them:
   - log in and walk the new screens (patient profile, slip desk, back office);
   - assign the `antimicrobial_steward` role in /admin/users, THEN run `aware:classify` by hand. Until both happen, no antibiotic is restricted.
3. **Drop finished lanes.** Their PRs merged or closed:
   - shell-ux, merge-guard, appt-slots, session-states, office-ids
   - opd-desk-board, retail-board, session-board, blind-count, ux-boards
   - cards-build, reconcile-build, merge-build, slips-build, office-build
   - ms-breakglass, profile-build, ux-train, me-desk-flake
   - token-audit-ux, token-audit-ux2, handoff-ux once this PR merges

   Use `tools/lane.sh drop <name>`. `me-desk-flake` needs `--force` because of an untracked `.tmp/`; that delete needs the owner's OK.

## 5. Next set of work (in this order; one lane and one PR each)

These are the pieces each build left unbuilt. Each is already ruled or decided; "needs server" means additive server work.

1. **Appointments:** Reschedule moves an appointment in one click. Give it the same confirm dialog as booking (#357's pattern). Web only.
2. **Merge review:**
   - **Refusal close:** a refused merge closes its request lazily, on the next read. Close it at refusal time instead (approvals → patients hook) and keep the lazy close as a backstop.
   - **Full mobile:** the comparison table shows full mobiles. Decide by the "job needs the number" rule: mask by default, with a logged "Show".
3. **Card reconcile:** 2 of 4 agreeing fields shows "Weak". Per the board it should read "Possible". Fix the band rule server-side, with a test.
4. **Billing back office:**
   - a printed refund voucher (server-side printing, owner ruling 2026-09-04);
   - the day-book line for accepted bank charges;
   - "someone else collects", recording the relation, never an Aadhaar number;
   - the GSTR-1 GSTIN count;
   - the refund form's credit-note field still takes a raw id; give it a picker.
   - **Review:** `payeeIdRef` became optional to honour the Aadhaar ruling; for non-Aadhaar IDs, decide whether to require it again.
5. **Cashier session:**
   - the close summary is lost on reload; the server returns closed sessions only in the close response, so add an additive read;
   - a cashier cannot see whether her variance approval was granted; add a narrow status read, not `approvals.requests.read`.
6. **Patient profile, needs server:**
   - membership card by patient;
   - "patient since · visit count";
   - an audited "Show" for full mobile;
   - an alias-only response for restricted records, plus a break-glass act for the MS;
   - queue position in the Today band.
7. **Card recognition:**
   - grace-honour request form;
   - `?coupon=` prefill on /billing;
   - "Clocks running".
   - **Watch:** `GET /membership/recognition` now writes an `instrument.recognised` event, a write on a GET. Keep it, or move it to an explicit POST.
8. **Slip desk:**
   - the doctor's "ask for retake" button (the route exists, no screen calls it);
   - MRD day-end hand-off;
   - reading the visit number from the photo (the owed OCR half; owner ruled the image half is still owed).
9. **Pharmacy retail:**
   - copilot dock;
   - manual batch and shelf choice;
   - the patient's allergies and current medicines in the lane;
   - "your day" figures, keeping the blind count.
10. **OPD desk:** a department-wide list, not one doctor's queue; copilot panel.

**Separate from this list, each in its own session and its own brainstorm** (owner ruling 2026-09-28):
- IPD with insurance/TPA (plan them together; money and law, so owner rulings first);
- an owner's "hospital today" dashboard;
- emergency and the MLC register;
- roster screens (boards exist in `docs/design/2026-09-20-roster`);
- enquiry / help desk (boards exist in `docs/design/2026-08-30-enquiry-counter`);
- MRD and the births/deaths register;
- pharmacy P2–P5.

Do not start these from this handoff.

## 6. How each build in this phase was run (reuse it)

- **Agent brief:** the approved board file plus CLAUDE.md plus the binding rulings, never the ledger. Pass the brief verbatim: process-safety lines, test lock with TMPDIR, red-first against origin/main, foreground polling.
- **Browser check:** real Chromium (`/opt/chromium/chrome-linux64/chrome` via the playwright at `/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`) against a small Node stub API plus vite with `VITE_API_TARGET`, and `localStorage["hmis.token"]="stub-token"`.
- **Widths:** 1920, 1440, 1280, 1024, 768 and 390. No horizontal page scroll. Read the PNGs yourself.
- **One more trap:** the unlayered `.pp button` reset in desk-one.css beats Tailwind utilities. Style with scoped classes.

## 7. Board process (for any screen without one)

1. Audit the live screen in Chromium (stub API, synthetic data).
2. Draw a standalone HTML board in the house style, using `paper-pine.css` tokens and the layout rule:
   - desktop 1440, key states, phone 390;
   - "what changes and why";
   - "needs server" tags;
   - questions for the owner only on money, procurement or law.
3. Publish it as an artifact for the owner.
4. Build only after approval.
5. Copy the board into `docs/design/<date>-<name>/` with a README recording the rulings.
