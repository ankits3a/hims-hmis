---
type: decision
id: "0085"
title: "IPD and ER merge to main dark, behind a module switch; production stays off until the owner switches them on"
description: "Owner 2026-10-24: the IPD/ER stack (#742–#894) lands on main instead of waiting for every module to be built. It ships dark: ten modules answer no route and show nothing unless HMIS_MODULES_ON names them, which production leaves empty. Supersedes only 0073's 'not deployed to production until all modules are built'; 0073's money rules stand."
generated: { by: agent:claude, at: 2026-10-24 }
verified: []
status: stable
ruling: ruled
tags: [ipd, emergency, planning, deploy]
supersedes: ["0073"]
superseded_by: []
sources:
  - { id: issue-776, resource: "https://github.com/ankits3a/hims-hmis/issues/776", title: "IPD staging integration branch" }
  - { id: issue-806, resource: "https://github.com/ankits3a/hims-hmis/issues/806", title: "IPD merge to main: carry the staging-only work" }
  - { id: issue-833, resource: "https://github.com/ankits3a/hims-hmis/issues/833", title: "IPD and ER worker jobs need alert rules before the stack merges" }
---
# 0085 — IPD and ER merge to main dark, behind a module switch

- **Date:** 2026-10-24   **Status:** Ruled. Supersedes 0073's "IPD is not deployed to production until all other
  modules are built", and nothing else in 0073.
- **Area:** IPD, emergency department, the services modules they need; deploy

## What is ruled

**Owner, 2026-10-24:** the IPD/ER stack goes to main now rather than at the end of the build, and production stays
dark. Merging to main is the production push, so the code ships switched off.

- **The switch.** `HMIS_MODULES_ON` (API and worker env) is a comma list of the ten keys `tasks`, `ipd`, `bmw`,
  `linen`, `housekeeping`, `maintenance`, `passes`, `transport`, `diet`, `emergency`. Empty, which is production,
  means all ten are off. Any other key fails the boot.
- **Off means off.** An off module answers no route, adds no menu item, Now card, search hit or copilot answer,
  sends no message, and its worker jobs and consumers change nothing. Its jobs still register and heartbeat, so the
  missing-job alert stays quiet.
- **What exists anyway.** Its tables migrate and its permissions are declared and seeded whatever the switch says,
  so switching a module on is an env change and a restart, never a migration.
- **Who switches.** The owner, per deployment: staging first, after the screens are walked; production only on the
  owner's word.

## What stands
0073's money rules, unchanged. 0072, 0074, 0075 and 0076 are untouched.

## Where it lives
`apps/core/src/kernel/modules/switch.ts` (the keys, `isModuleOn`, `liveModules`, `runIfModuleOn`);
`ModuleRegistry.live()` in `kernel/modules/loader.ts`, which every collector reads; `/auth/me` drops an off module's
permissions from the projection the shell draws from.
