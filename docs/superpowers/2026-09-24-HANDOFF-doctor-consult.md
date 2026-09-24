# HANDOFF: Doctor Desk / Consult Engine, 2026-09-24

This file hands work from one Claude Code session to the next. The owner pastes it into a new session.

## How to start

Start the new session in `/opt/hmis`, then say: **"Read /opt/hmis-context/handoffs/2026-09-24-HANDOFF-doctor-consult.md and continue."**

---

## 0. Read these first, in this order, and nothing more until a task needs it

1. `/opt/hmis/CLAUDE.md`: the lane rules, the test lock, the shared files, and the reading budget.
2. The design doc: `docs/superpowers/brainstorms/2026-09-18-doctor-desk/01-CONSULT-ENGINE.md` on branch `lane/doctor-consult`. The worktree is `/opt/hmis-lanes/doctor-consult/hmis`.
   - Every owner ruling is in §1, §1.1 items 1–9 and §11.
   - The DECIDED items are D1–D18.
   - The data review is in §5.1–5.2.
   - The proposed cut is in §12.
3. These memory notes:
   - `doctor-consult-engine-rulings` (every round of rulings, in brief)
   - `owner-top-five-priorities`: accuracy, speed, auditable, compliant, and dashboard UX
   - `verify-ui-against-the-board`: **MANDATORY before calling any screen done**
   - `clinical-master-class-templated`
   - `prod-deploy-state`, the entries of 2026-09-23 and 2026-09-24
   - `healthray-doctor-opd-reference`
4. The approved design canvas: https://claude.ai/artifact/QwHXwrRy2ofAr5XeqfZMYW. Sources are in `docs/design/2026-09-23-consult-engine/*.dc.html` on `lane/doctor-consult`.
   - `Main` = the brief
   - `Consult` = the consultation
   - `Summary`, `Ophthal`, `Profiles`, `Curator`, `Departments`, `PrintShare`

   The owner comments on the canvas, and comments sent to Claude arrive as threads. Read them with the ArtifactComments tool. Before any publish, read the live file first and merge: the owner edits the boards directly.

## 1. Who and why

- The owner is building an agentic-AI hospital OS for CRK Medical College & Hospital, in which AI agents are copilots to humans.
- He judged the doctor's desk "not good enough", behind Healthray. The Healthray screenshots are in `/opt/hmis-context/reference/2026-09-23-healthray-doctor-opd/`, together with his own brief image, `owner-doctor-opd-desk-brief.png`.
- **His top priorities:** accuracy, speed, auditable, compliant, and the user experience of the dashboard.

## 2. What is LIVE in production (https://hmis.crkmch.com)

Production runs `main` at `90e82c88`, with 122 migrations applied. It was deployed on 2026-09-24 at 08:35 UTC.

| PR | What |
|---|---|
| #297, #298 | Another session's fixes: regimen ids; pharmacy auto-match |
| #299 | The desk complaint reaches the doctor (migration 0119). NEW / REVISIT / RENEWAL badges |
| #300 | Consult v2 (migration 0120): examination, treatment, notes, provisional/final diagnosis, stock on the Rx, patient reminder, `GET /pharmacy/doctor/stock` |
| #303 | Parts two and three (migration 0121): recall to the display board, open in a new tab with a one-tab edit lease (D17), the Vitals tab, internal referral, history two ways (a modal plus per-tab "View history", D18), allergies add/delete only, inline suggestions when the copilot is folded, autocomplete in every clinical field |
| #305 | The UI rebuilt to match the approved boards: three full-height columns, responsive breakpoints, brief-first, ten tabs, IBM Plex, Rx cards with stock tags, a ⋯ menu on small screens |
| #306 | The side columns fold when an open window narrows (fold state kept per width band); the vitals tiles wrap |

**How production was verified:** Playwright with `/usr/local/bin/chromium`, logged in as the owner's test doctor `anand.rao`. Ask the owner for the password; never write it into a file. Checked at widths 1440, 1280, 1024, 768 and 390, plus a resize from 1440 to 1024 to 390. The screenshots are in `/opt/hmis-context/reference/2026-09-23-consult-ui-check/`. The stub-API walk harness is at `/tmp/claude-0/-opt-hmis/4c2e4ee8-…/scratchpad/uiwalk/` (`stub.ts`, `fixtures.ts`, `walk5.mjs`, `resize.mjs`). The scratchpad may be gone; if so, rebuild from memory `browser-walk-with-a-stub-api`.

## 3. How merge and deploy work here (learned the hard way)

- **The auto-mode classifier blocks this session from `gh pr merge` and from any production deploy step**, including the `git stash` / `git pull` preparation in `/opt/hmis`. The owner runs them with `!`.
  - Merge: ask for `! gh pr merge -s --auto <N> -R ankits3a/hims-hmis`. With `--auto`, GitHub merges once CI is green; without it, the merge is refused while CI runs.
  - Deploy: give the owner these three lines, one at a time. He types them by hand: pasting splits long lines.
    ```
    ! cd /opt/hmis && git stash push -m "settings during deploy" -- .claude/settings.json && git pull --ff-only
    ! /opt/hmis-lanes/.orchestrator/bin/test-lock.sh run prod-deploy bash /opt/hmis/docker/prod/deploy.sh
    ! cd /opt/hmis && git stash pop
    ```
  - The stash exists because `deploy.sh` refuses a dirty tree, and the owner's `/permissions` edits dirty `.claude/settings.json`. Untracked `docs/` files are exempt.
  - **Pop only once.** A second pop hits two old September stashes and errors harmlessly.
- After every deploy, verify all of these:
  - the migration count: `docker exec hmis-prod-db-1 psql -U hmis -d hmis -t -c "select count(*) from drizzle.__drizzle_migrations;"`
  - the images: `docker images | grep hmis-prod/`
  - `https://hmis.crkmch.com/api/health`
  - **a real Playwright login check of the screen at each width**
- **Deploy one session at a time.** Another session (`e7c78c98…`) also deploys. A deploy ships everything on `main`. Tell the owner before merging anything that would ride along with someone else's deploy.
- **Squash merges break stacked PRs.** Cherry-pick the lane's own commits forward onto `origin/main` into a new branch and open a new PR; do not force-push. See memory `stacked-prs-under-branch-protection`.

## 4. Owner rulings NOT yet built (do these)

1. **Referral fee (RULED 2026-09-24, money).** If the patient consults the referred doctor or department **within 7 days**, **no fee**, using the existing follow-up-days method.
   - Today `referral.ts` opens the visit through `openVisit`, and `visit-type.ts` `classifyVisit` returns `revisit`, which is free, only against the SAME department's anchor.
   - Make a referral carry a 7-day free window for the referred department or doctor: the referral itself becomes a revisit anchor with `followUpDays = 7`. Any schema change must be additive.
   - Test that a fee is charged after 7 days, and that a non-referral visit is unchanged.
   - This touches `billing`/`tariff` indirectly. Those modules are imported everywhere, so keep the change inside `opd`.
2. **The line being written is still the old Drug / Dose / Route form.** Only finished lines become cards. The board wants the add-row in the card style too.
3. **The brief is missing lab/radiology "results since last visit" and the pharmacy refill record.** No patient-scoped reader exists in the consult yet. Add read-only readers through the lab/radiology/pharmacy `index.ts` files, respecting sealed/PHI rules.
4. **ICD-11 shown beside ICD-10** (ICD-10 stays the one stored). This needs the official WHO ICD-10 to ICD-11 mapping table loaded as data. Find it and cite its source.
5. **Department screens, chosen automatically by the doctor's registered department** (the visit's department if a doctor sits in two; D11). The order is **ophthalmology, then paediatrics, then gynaecology** (then dental and ortho).
   - Specs are in doc §6.
   - Ophthalmology: per-eye grids, refraction, slit lamp, a glasses-Rx print, eye-drop lines with eye and taper.
   - Paediatrics: age in Y-M-D, weight-based dosing (needs SIGNED dose rules; see item 7), WHO/IAP growth charts, the IAP vaccine schedule.
   - Gynaecology: G P L A, LMP → EDD/POG, the antenatal sheet, the PCPNDT Form F link to the `pcpndt` module.
   - The underlying engine is doc §3, D1–D6: section definitions and layout profiles as data, the admin default plus a doctor overlay, and mandatory sections that can't be hidden.
6. **Curator screen (D4).** A doctor's own entries stay private until the department head, the MRD officer or the admin promotes them.
7. **The 350 drug-dose drafts** are at `/opt/hmis-context/drug-review-2026-09-23/drafts/all-350.json`. They are UNSIGNED.
   - A doctor or the P&T committee signs each one in the curator before any default pre-fills an Rx (D10).
   - Sources rank IAP / national programme above US labels for children; for example, ethambutol is used in children under the NTEP.
   - Open questions: one hospital-wide rule for the paracetamol maximum per day (60 vs 75 mg/kg), and a doctor must confirm the telemedicine lists.
   - `rematch.py` is the strict matcher. Use it, never a loose substring match.
8. **Print and share (doc §9).** English and Hindi only. Hide header/footer. WhatsApp/SMS/email with DPDP consent recorded. Send to the referring doctor. Prescription law items: NMC generic name, registration number, Schedule H/H1/X marks, and the telemedicine lists O/A/B/prohibited on teleconsult.
9. **Teleconsult is in scope (§11.2).** Mode recorded, consent recorded, drug lists enforced on the Rx grid.

## 5. Housekeeping owed

- `lane/doctor-consult` holds the design doc and board sources. It is **not pushed**: 22 commits ahead and 6 behind. The owner said "push" earlier only in passing. Rebase onto `origin/main` (docs only, no conflicts expected), push, and open a docs PR; its merge is the owner's.
- Merged lane branches kept locally can be deleted: `lane/desk-complaint`, `lane/consult-v2`, `lane/consult-v2-pr2`, `lane/consult-v2-pr3`, `lane/consult-v2-part2`, `lane/consult-v2-part3`, `lane/consult-ui`, `lane/consult-resize`.
- **The open question on the hospital crest:** the owner may send a crest image to replace the app's diamond mark. `docs/design/2026-08-29-opd-counter-flow*/crk-logo.png` exists in the repo. Ask the owner whether that is the crest before using it.

## 6. Rules that bit this work (don't repeat them)

- **No screen is "done" until it is rendered in Chromium at six widths and compared with the approved board.** Consult v2 shipped once looking like v1, and the owner rejected it.
- When an approved design conflicts with old tests, **the tests change, not the design**. Never weaken a guard, permission or audit assertion.
- Build forks hit their 200-turn limit on big scopes. Split the work, and have them commit and push before the limit.
- The complaint suggester is IDF token scoring, not a vector embedding. The owner calls it "embedded vector"; don't claim embeddings exist.
- Don't `pkill -f <pattern>` inside a Bash call whose own command line contains that pattern: it kills its own shell.
- **Suggested order:**
  1. Push the design docs PR.
  2. Referral fee (item 1). Small; it's money, and it's ruled.
  3. The brief's results and refill readers (item 3).
  4. Rx add-row cards (item 2).
  5. Engine plus ophthalmology screen (item 5), with boards first if the engine shape needs owner review.
  6. ICD-11 map.
  7. Curator plus drug sign-off.
  8. Paediatrics, then gynaecology.
  9. Print/share and teleconsult.
