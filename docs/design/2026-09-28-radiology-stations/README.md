# Radiology stations — the board (plan 18-S spec)

**This board is the spec for plan 18-S** (`docs/superpowers/plans/2026-09-28-18s-radiology-stations.md`). Where the
plan and the board disagree on what a screen shows or does, the board wins until the owner says otherwise.

- **Live artifact:** https://claude.ai/artifact/SF4wW61FajAk6hMfn2ShPw, **version 4** (28 Sep 2026; v3 content, corrected gallery count).
- **Copy in the repo:** `radiology.html` is the artifact's page body as published (the publish wrapper is the only
  difference). It is one self-contained file of vanilla JS with synthetic data and page-drawn images. Open it in any
  browser; there is no build step.
- **Built** on 28 Sep 2026 from the owner's brief: "brainstorm … the north star … every possible screen that a
  radiology must have in a single artifact link".
- **Then** the owner delegated every open decision to top-Indian-hospital practice and asked that every dot be joined
  before any plan. Version 3 is that pass.

## What is on it

The station switch sits at the top left. The menu of each station sits in the header.

| Station | Screens |
|---|---|
| Blueprint | North star · Every screen · Today → next · Journeys · Rules & clocks · How to read |
| Front desk | Counter · Diary · Report hand-over · Outside CDs · Hall display |
| Prep & safety bay | Prep bay · MRI screening · Contrast · Consents |
| Modality rooms | Room console · Portable round · IR suite · Dose log · Rejects & repeats · Downtime |
| Ultrasound & PCPNDT | Scan room · Form F · Registration · Monthly return |
| Reading room | Worklist · Report · Critical calls · Follow-ups · Amendments · Peer review · Night & outside |
| Radiation safety | Licences · People · TLD badges · QA tests · Patient dose · Incidents |
| Supervisor & HOD | Floor · Escalated · Approvals · Quality · Equipment · Roster · Money · Access log |
| Doctor's door | Order imaging · Results · Report · Ward |
| Patient's phone | Before the scan · The report · After the visit |
| Setup | Study catalogue · Protocols · Templates & criticals · Rooms & machines · Prices · Contrast & stock |

- **Build-status strip.** Every screen opens with a one-line strip saying what the code on main holds today:
  IN THE CODE, PARTLY BUILT, or NOT BUILT.
- **Counts in version 3.** There are 53 station screens plus 6 Blueprint screens. Across all 59, the statuses are 3 have,
  37 partly, and 19 new.

## The spine — why the dots join

`SPINE.md` is the contract.

- Every department fact lives in one store: studies and their gates, critical calls, follow-ups, bill decisions,
  approvals, release status, the access log, and machine state.
- Every seat changes those stores only through the spine functions (`orderStudy`, `bookStudy`, `checkIn`,
  `closeGate`, `startScan`, `acquire`, `signReport`, `releaseReport`, `raiseCritical`, `ackCritical`, `actedUpon`, …).
- A hand-off made at one seat therefore shows at the next seat with no extra wiring.

`UX.md` is the UX bar each screen was held to.

## Walks

| Script | Checks |
|---|---|
| `walks/journeys.cjs` | Eleven journeys (J1–J11) driven through the spine. After each hand-off it checks the next seat shows it, by a `data-*` hook. Version 3: **53 of 53 steps pass, 0 page errors.** |
| `walks/walk.cjs` | Every station and screen at 1440 / 1280 / 1024 / 768 / 390 px, plus up to 60 clicks per screen at 1440. Version 3: **ERRORS: none, 0 problems** — no page errors, no render errors, no unhandled actions, no sideways scroll. |

- **Tools needed.** Both scripts need `playwright-core` and a Chromium. Neither is a repo dependency. The defaults
  are this build host's:
  - `/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`
  - `/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`, run with `--no-sandbox`
- **Running them.** Run one at a time, for example `node docs/design/2026-09-28-radiology-stations/walks/journeys.cjs`.
- **Test lock.** They are Playwright, not jest or vitest, so the test lock does not apply.

## Decided on 28 Sep (owner's delegation)

The list lives in the plan's *Owner rulings* section and on the board's Rules & clocks screen. It is not repeated here.

## Relation to other boards

- The layout follows the owner's 25 Sep counter ruling (`docs/design/2026-09-25-lims-stations/README.md`, *Layout
  rules*) and uses the same Paper & Pine tokens.
- The board's station switch maps onto the lab's `StationShell`, which is on main.
