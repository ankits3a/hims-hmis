# HANDOFF — front-desk lane, after FD-23 · written 2026-09-04

Read `CLAUDE.md` first, then this. Nothing else. This file is the whole context.

Lane `/opt/hmis-lanes/front-desk/hmis`, branch `lane/front-desk-fd7-t9`.
**56 commits ahead of `origin/main`, 7 behind. Nothing is pushed and no PR is open.**

---

## 1 · START HERE — the state in one paragraph

Fourteen commits shipped this session (FD-11 → FD-23), all committed, all verified, tree clean.
Two migrations added: **0060** (registration demographics + `patient_coverages`) and **0061**
(department token series). Everything is live on the preview and on the owner's tunnel. **Nothing
is deployed to production and no PR exists** — item 1 in §6 is the rebase, and it is the biggest
open risk in the lane.

---

## 2 · HOW TO SEE IT

**Preview** — https://62.238.106.231:8443 · basic auth `preview` / `DeskOne!Preview2026`
**Owner's tunnel** — `ssh -N -L 5180:127.0.0.1:5180 root@62.238.106.231`, then http://localhost:5180
**App login** `ramesh` / `DeskOne!Live2026` · **Admin** `admin` / `DevAdmin!Pass2026`
Local: vite `:5180`, API `:3010`, DB `hmis_fd_dev`.

```bash
# after ANY core change — the API serves dist, not src
pnpm --filter @hmis/core exec tsc -p tsconfig.build.json
# then restart the API in ITS OWN invocation (never `pkill` in a compound command — exit 144)
pgrep -f "node dist/src/main.js"        # one call
kill <pids>                              # another call
cd apps/core && MEMBER_BENEFITS_ENABLED=true PORT=3010 \
  DATABASE_URL='postgres://hmis:hmis@localhost:5433/hmis_fd_dev' \
  TRIAGE_BASE_URL='https://api.groq.com/openai/v1' TRIAGE_MODEL='openai/gpt-oss-120b' \
  TRIAGE_API_KEY='<in apps/core/.env>' \
  nohup node dist/src/main.js > /tmp/api.log 2>&1 < /dev/null & disown

pnpm --filter @hmis/web build            # redeploys the preview (Caddy serves apps/web/dist)

# vite for the owner's tunnel — BOTH flags matter
VITE_API_TARGET=http://localhost:3010 pnpm --filter @hmis/web exec vite \
  --port 5180 --strictPort --host 127.0.0.1
```

**Routes at the origin have NO `/api` prefix** (Caddy strips it): health is `/health`, not
`/api/health`. A 404 on `/api/...` locally means you added the prefix, not that the route is missing.

---

## 3 · WHAT SHIPPED (14 commits)

| commit | what |
|---|---|
| `7579e3a` | FD-11 · the audited cash re-count (server + UI); a mistyped closing count can be withdrawn |
| `52407f0` | FD-12 · registration takes a real record; **migration 0060**; a child can finally be registered |
| `f491d1a` | the vite dev proxy targets the lane's own API |
| `1d02614` | FD-13 · walk-in routing rules reach the screen (rule 1 + the 20-minute rule were dead code) |
| `f094585` | FD-14 · left column carries the patient; billing gets the schemes rail |
| `e080c11` | FD-15 · the photo is read back; a typo no longer mints a second UHID; change the doctor |
| `c6c0fa5` | FD-16 · Their History, a readable diary, the day's book |
| `09b5ad8` | FD-17 · visit type said before seating; the duplicate-booking guard is called |
| `ed5ae72` | FD-18 · the billing override CORRECTS THE VISIT TYPE, not the price |
| `db8a927` | FD-19/20 · bookings can be moved; seating card; **migration 0061** department token series |
| `d620f9c` | FD-21 · a photo on file says nothing in the rail; Retake moved to the correction sheet |
| `c0df9c1` | FD-22 · refusals inline; cancel with confirmation; every doctor bookable |
| `b48100b` | FD-23 · `/opd/appointments` + `/patients/:id` redesigned to the counter; agent dock extracted |

**Verified at the tip:** typecheck 0 · lint 0 errors (2 pre-existing warnings in
`scheduler.test.ts`) · web `vitest run` **86 files / 637 tests** · core `opd`+`billing`+`test/`
**120 suites / 1007 tests**. The last FULL core run was 373/3741 at FD-12; core has changed since
(FD-17/18/20), so **a full core run is owed before the PR** — see §6.1.

---

## 4 · OWNER RULINGS GIVEN THIS SESSION (do not re-ask)

- Registration takes the full record **including payer/TPA** — built as patient-level *coverage*
  (`patient_coverages`), with billing still owning tariffs and claims.
- **ABHA**: fields + buttons now, ABDM gateway *seamed*. Creating/verifying needs credentials the
  hospital must obtain (procurement — still open).
- National ID stores **last 4 digits only**, following `patient_guardians.id_number_masked`.
- The billing override **re-classifies the visit, not the price**, and the **cashier acts alone,
  fully audited** — no approval gate, deliberately, because one supervisor would recreate FD-11's trap.
- Tokens are **per department per day** (`MED-4`, `CAR-3`), not per doctor.
- The patient photo lives in the **44px square**; Retake belongs in the correction sheet.
- `/opd/appointments` and `/patients/:id` wear the counter's design and carry the agent.

---

## 5 · TRAPS THIS LANE HAS ALREADY PAID FOR

- **A "surviving" mutant may never have been applied.** Verify the mutation is in the file before
  concluding anything. Cost me a false negative in FD-14.
- **A surviving mutant is usually a too-generous FIXTURE.** Three times this session: the restricted
  patient whose name the server nulls anyway; the doctor who was on today's board *and* in the
  master; the assertion that ran before `quote.data` existed. Fix the fixture, not the assertion.
- **`stubFetch` returns whatever the handler returns AS THE BODY.** A `{status, body}` wrapper makes
  `res.patient` undefined and the success path throws silently. Handlers get `(init, url)` — the key
  drops the query string, so two reads of one path must branch on the url.
- **A fixture narrower than its wire type proves nothing and fails elsewhere.** The fee-quote stub
  omitted `draft`, so `billOf` walked into `undefined.lines` and the desk threw "Something went wrong!".
- **Locale parity is blind to a key missing from BOTH files.** `photo.onFile` rendered as a raw key
  at a counter. There is now a test that sweeps the rendered rail for dotted i18n paths.
- **Restyling silently drops ARIA.** `role="table"`/`role="tab"` went in FD-23's first pass; only the
  existing tests noticed.
- **Freeze the tree for a full measurement**; the unit of staleness is the worker process.
- Modules may only import another module's `index.ts` — do not widen a hub's public interface to
  make a test convenient.

---

## 6 · OPEN, IN PRIORITY ORDER

**1 · REBASE AND OPEN THE PR — the biggest risk in the lane.**
56 ahead / 7 behind. The branch still carries FD-7 T6 commits that `origin/main` already has as
**squash-merges under different SHAs** (`f42818b` here ↔ `81aadf7` there), so a naive rebase will
conflict on work that is already upstream. Read memory `stacked-prs-under-branch-protection` first.
Shared files that will collide: `apps/web/src/router.tsx`, `locales/*.json`, `seed-roles`,
`caddyfile-parity`. **Never `--ours` a shared file.** Run a FULL core suite before the PR — core
changed in FD-17/18/20 and the last full green was 373/3741 at FD-12. Migrations are numbered at
rebase time: **0060 and 0061 may need renumbering** if main took 0060.

**2 · Owner ruling owed: the stale `billing_variance` approval (from FD-11).**
A retracted count leaves its approval `pending` for ever. The kernel has `pending|granted|rejected`
and no cancel; `rejectRequest` runs the same requester≠approver check. It is INERT — `confirmClose`
reads the session's current approval id, which the re-count clears — but the owner's own session
accumulated five stale rows from one typo. Adding a `superseded` status is a change to the SHARED
approvals kernel: do not do it without the ruling.

**3 · Procurement: ABDM credentials.** `ABDM_BASE_URL/CLIENT_ID/CLIENT_SECRET` are wired and inert.
Until the hospital registers with ABDM the counter can RECORD an ABHA but not create or verify one.
The screen says so honestly; nothing fakes a verification.

**4 · Rotate the credentials in this file and the transcripts** — Groq key, `DevAdmin!Pass2026`,
`DeskOne!Preview2026`.

**5 · Config the owner may want changed.** `follow_up_extension_days` is `[15, 21, 30]` with a
default of 7. The owner mentioned **10 days**, which is NOT configured. One row in `opd_config`.

**6 · Still-unwired rails found by the sweep** (362 routes, 56 with no web caller; 270 lib exports,
30 called by no screen). Front-desk-relevant leftovers: `POST /membership/instruments/enrol`
(matches the "no enrolment" gap in memory `fd9-desk-one-open-items`) and `GET /billing/worklist`.
Everything else belongs to other lanes (tariff admin, OT, lab, radiology, materials, PC-PNDT).

**7 · Desk One's money writes are outside the single-submit census.** `submit-button.test.tsx`
pins 14 write lanes across four billing screens; `screens/desk-one/*` is not among them, and it
settles money. Adding it would require converting its `onClick={() => void …}` idiom to
`SubmitButton` throughout — a real change, deliberately not started.

**8 · The dev database is thin.** Three active doctors, ALL in Cardiology; every other department
has zero. The department picker works but has one usable option, and that is data, not code.

---

## 7 · WHERE THINGS LIVE

- **`/counter`** — Desk One, the whole front desk: find → register → appointment → bill → done.
  Left rail = the patient session (photo, history, account, live bill). Agent along the bottom.
- **`/opd/appointments`** — the standalone book: day list, reschedule, cancel, needs-rebooking.
- **`/patients/:id`** — the record: demographics, allergies, guardians, card.
- `apps/web/src/screens/desk-one/` — `stages.tsx` (the five stages), `dossier.tsx` (left rail),
  `overlays.tsx` (the correction sheet), `photo.tsx`, `session.ts` (DeskApi), `model.ts` (pure fns).
- `apps/web/src/components/agent-dock.tsx` — the reusable agent bar (props, not `useDesk`).
- `apps/web/src/screens/desk-one/desk-one.css` — the design system. Primitives carry `.d1` AND
  `.pp`; layout rules keep `.d1` alone. **One definition — do not fork it.**
