---
name: run-tests
description: Exact commands for typecheck, lint, jest, vitest and the mobile suite under the HMIS test lock, and why the lock exists. Use before running any test or suite.
---

# Running tests

Take the lock around every pool — jest and vitest, targeted runs as well as full ones:

```
L=/opt/hmis-lanes/.orchestrator/bin/test-lock.sh          # `$L status` says who holds it
pnpm typecheck && pnpm lint                               # fast, always — no lock, not a pool
$L run <lane> pnpm --filter @hmis/core exec jest -w 2 <path…>   # the suites you touched
$L run <lane> pnpm --filter @hmis/core exec jest -w 2           # full core (~15 min) — normally CI's job
$L run <lane> pnpm --filter @hmis/web exec vitest run <paths>   # web
cd apps/mobile && npm ci && $L run <lane> npx jest --ci && npx tsc --noEmit   # phone app (not in the pnpm workspace)
node tools/arch/gen.mjs --check                           # map, module notes, decisions index
```

- Two jest pools plus vitest OOM a 15 GB host; `maxWorkers: 2` is an owner ruling; the full suite belongs to CI.
- `tools/lane.sh status` is a SNAPSHOT, not a lock: a peer can start between your look and your run. Only `$L run`
  closes that window. A suite killed for memory looks like a mysterious red on someone else's afternoon.
- Phone app CI installs only the app's own packages: a shared file it imports from `packages/contracts` must not import
  `zod` or anything else outside the app. Reproduce CI by hiding the root `node_modules` before `npx tsc --noEmit`.
- Tests that read the real clock must not pin dates (main went red twice on 2026-10-07 at a date boundary).
