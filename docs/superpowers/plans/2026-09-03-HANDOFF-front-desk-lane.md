# HANDOFF — front-desk lane, 2026-09-03

**Read this file and `CLAUDE.md`. Nothing else, until a task below names something.**

You are picking up the front-desk lane at `/opt/hmis-lanes/front-desk/hmis` (branch
`lane/front-desk`). The previous session's work is **all merged to main**. What is left is a
**pending production deploy**, **three open owner questions**, and **a design that is approved in
shape but not yet built**.

---

## 1. State, in one table

| | |
|---|---|
| Lane | `/opt/hmis-lanes/front-desk/hmis`, branch `lane/front-desk`, tip `fda33db` |
| Merged to main | **FD-2 … FD-6, all of it** (PRs #36 and #42, both squash-merged) |
| Working tree | clean |
| **Production** | **56 migrations — ONE BEHIND.** main carries `0057_uhid_floor_11000.sql` |
| Preview environment | live: API `:3010`, web `:5180`, DB `hmis_fd_dev`, **10,000 patients** |
| Design canvas | https://claude.ai/code/artifact/d49d5608-76af-4579-bc81-ce14b0077202 |
| Design source | `docs/design/2026-09-03-front-desk-three-seats/` (6 `.dc.html` + `canvas.json`) |

**The deploy is the owner's hand.** The classifier blocks `deploy.sh` from a session. Ask them to
run `bash /opt/hmis/docker/prod/deploy.sh` from a clean `/opt/hmis` at `origin/main`. It is
idempotent. Afterwards **measure** the migration count, never remember it:

```
docker exec hmis-prod-db-1 psql -U hmis -d hmis -tAc "select count(*) from drizzle.__drizzle_migrations"   # expect 57
docker exec hmis-prod-db-1 psql -U hmis -d hmis -tAc "select last_value from uhid_seq"                     # expect 11001
```

---

## 2. What shipped, and the one thing about each worth keeping in your head

**FD-2 — the front desk rebuilt.** The owner deployed FD-1, called it broken in five ways, and was
right about all five. Every one was the *screen*, not the server. The lesson that generalises:
**117 tests passed on a search row that rendered `Ramesh KumarCRK123450139876543210same name`** —
three bare `<span>`s with no separator. `getByTestId` finds a thing whether or not a human can read
it. Assert node *separation* and *visible text*, not just presence.

Also: `components/counter-slip.tsx` and `components/invoice-print.tsx` were built, tested, shipped
— and the seat imported **neither**. "No printable bill" was a whole feature never wired, not one
that broke. Expect more of this; the codebase's characteristic defect is a rail with no consumer.

**FD-3 / FD-5 — the keyboard.** `Ctrl+N` + `Alt+N` = new patient, `Ctrl+K` or `/` = search,
`Ctrl+⏎` = confirm, `Esc` = release, `F2` reserved for the agent (unbound, with a test asserting it
goes nowhere). The seven `Alt+<letter>` navigation chords are **parked** — out of the map and
legend, full record kept in `keyboard.tsx`, a named test stopping them growing back. **§4 below
supersedes some of this.**

**FD-4 — the UHID floor.** 1,234,500 → 11,000, so the first card reads **`U00110012`** (`U` +
`0011001` + Verhoeff check digit `2`). Owner kept the check digit. Migration `0057`.

**FD-6 — found by loading 10,000 patients.** The counter could not find anyone by **surname**
(`Kumar` → 0 hits while Ctrl+K found five, same second); the row could not tell two people apart.
Both fixed. Also defused **two date bombs** that went off at 00:06 IST — `counter-figures.test.tsx`
hard-coded `"2026-09-03"` and `lab-reports.test.tsx` (LIMS lane's) dated a fixture to yesterday.

---

## 3. Deleted, by owner ruling — do not restore

- `apps/web/src/screens/counter-desk.tsx` — the seat serves `/counter`
- `apps/web/src/screens/opd-vitals.tsx` — Bay One serves `/opd/vitals`

Both were **deleted, not redirected**: a second name for one screen is how the owner ended up on the
wrong counter. `caddyfile-parity.test.ts` pins the route census — currently **48**. Move that number
only after re-running the parser, never by prediction.

---

## 4. THE THREE OPEN THINGS — this is your work

### 4a. `/registration` cannot be deleted yet — and this is a live gap

The owner ruled "keep the new design not the old one" for `/registration` too. **I did not do it,
deliberately**, and told them why: the counter's four-field inline form cannot replace it.

Proved against the live preview:

```
POST /opd/walk-in  {"register":{"name":"Child","sex":"female","ageYears":8}, …}
→ 400  a minor's registration must include a guardian (D-31, DPDP §9)
```

**No child can be registered from the counter today.** ~19% of the 10,000 seeded patients are
minors. `/registration` uniquely owns four things:

| only on `/registration` | cost of deleting it today |
|---|---|
| Guardian block | **no minor can be registered at all** |
| Photo capture + attach confirmation | no patient photos |
| ABHA address / number | no ABHA linkage |
| `isConfidential` / sensitive context | no way to flag a VIP at registration |

**The owner has ruled: carry all four over.** The design (§5) draws them. Build the new
`/registration` first, *then* delete the old screen and repoint the new-patient chord.

### 4b. A third defect, found and NOT fixed

The duplicate warning fires correctly (409 with candidates) but `WireDuplicateCandidate` is
`{id, uhid, name}` only — five rows reading "Ramesh Kumar" and nothing to choose between them, at
the exact moment the clerk decides whether to create a duplicate. Same blindness as FD-6's row
defect, on a worse surface. Needs phone/sex/age on the wire — a small server contract change.

### 4c. Three questions the owner has not answered

Left on the canvas as a sticky note and in the last two replies:

1. **Continuity scope.** I assumed *any* prior consultation in that department routes the patient
   back to that doctor. Should it be narrower — last 6 months? And a doctor on leave or fully
   booked presumably drops out to rule 2; assumed, not drawn.
2. **Package draw-down rule.** Drafted as "consult 3 of 8". Their bundle rules are unknown.
3. **Channel-partner slip** — drawn as attach-at-billing; may belong at registration, which is
   where the patient physically hands the slip over.

---

## 5. The design, and what it decided

**Canvas:** https://claude.ai/code/artifact/d49d5608-76af-4579-bc81-ce14b0077202 — six artboards,
two pages, all with working controls (the tweak chips above each frame drive them).

Identity is **Desk One's**, lifted from `docs/design/2026-08-31-registration-counter/desk-one.html`
rather than re-derived: paper `#f4f7f4`, pine `#0e6b4e`, gold `#dd8f1c`, red `#b23a30`, the dark
agent dock `#132420`/`#d9efe4`, IBM Plex Sans + Mono + Sans Devanagari, and the
`.pri`/`.sec`/`.in`/`.pill`/`.stamp`/`.kb` control ramp. **Read the tokens out of that file; do not
invent them.**

**The dashboard composes by permission.** "One dashboard or one staff each?" is answered *both* —
it renders the union of the cards the caller's permissions unlock (FD-1's DD1, already built), so a
clerk with all three grants sees three doors and a cashier sees one, from one piece of code.

**The walk-in has two doors** (Desk One's own shape): a doctor by name, or the complaint → a
department. When the department decides, three rules fire **in order**, and each proposal names
which one fired:

1. **Continuity** — a prior consultation in that department routes back to *that* doctor, **even
   when his line is longer**.
2. **Shortest wait** — only when nobody here has seen them.
3. **No doctor at all** — "join the department queue" names nobody.

It never seats silently: the clerk confirms, and can overrule. Wait shows as **minutes AND a clock
time**, both always. `waitEstimate(waitingCount, avgConsultMinutes, now)` in
`registration-counter.tsx` already computes this and `WireDoctorSummary` already carries
`waitingCount`, `avgConsultMinutes`, `nowServing`, `roomCode` — the model exists, it needs a
consumer.

### 4d. THE KEYBOARD RULING SUPERSEDES FD-3 — read this before touching `keyboard.tsx`

Owner, 03-Sep: *"no shortcut should overlap chrome browser or any browser internal shortcut keys."*
That rule **overturns two chords they themselves picked the day before**, and they were told so:

| was | now | why |
|---|---|---|
| `Ctrl+N` new patient | **`F4`** | Chrome's new window, **non-overridable** — the keydown never reaches the page |
| `Ctrl+K` search | **no chord** | Chrome's address-bar search. The box is focused on arrival; `Esc` returns to it |
| `F2` assistant | **`F2`** | survives — one of only five function keys no browser claims |

The only browser-free function keys are **F2, F4, F7, F8, F9**. (F1 help, F3 find, F5 reload,
F6 address bar, F10 menu, F11 fullscreen, F12 devtools.) Ctrl + most of the alphabet is a browser
command; `Ctrl+1…9` switches tabs. Hence the desk is **Tab, bare keys and F-keys**:

```
Tab / Shift+Tab   the next field — the instrument this desk is played on
⏎                 do the obvious next thing
Ctrl+⏎            commit (register, book, settle) — a chord because it is irreversible
Esc               back to search; again clears the desk
F2 assistant · F4 new patient · F7 the book · F8 take payment · F9 reprint
↑ ↓               move down a list
1 / 2 / 3         cash · UPI · card — bare digits, only when the cursor is not in a field
```

**The Tab order is part of the design**, per-seat, on the Keymap artboard. The guardian block
inserts itself at position 5 when it appears and pushes the doctor field to 9 — Tab must never stop
at a field that is not on screen nor skip one that is.

**`keyboard.tsx` still ships FD-3's `Ctrl+N`/`Ctrl+K`.** Bringing it in line with this ruling is
part of the build, not done.

---

## 6. The preview environment — how to get it back

It is running now, but if the box reboots:

```bash
# rebuild from nothing (scratchpad script from the last session is gone; the steps are these)
docker exec -e PGPASSWORD=hmis hmis-db-1 psql -U hmis -d postgres -c "DROP DATABASE IF EXISTS hmis_fd_dev WITH (FORCE);"
docker exec -e PGPASSWORD=hmis hmis-db-1 psql -U hmis -d postgres -c "CREATE DATABASE hmis_fd_dev;"
export DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_fd_dev"
pnpm --filter @hmis/contracts run build        # or every script dies on @hmis/contracts/dist
pnpm --filter @hmis/core exec tsx scripts/migrate.ts
for s in seed-ops seed-opd seed-patients seed-billing seed-tariff seed-membership seed-admin seed-roles; do
  pnpm --filter @hmis/core exec tsx "scripts/$s.ts"; done
UHID_PREFIX=U pnpm --filter @hmis/core exec tsx scripts/seed-registration.ts
pnpm --filter @hmis/core run build && (cd apps/core && PORT=3010 node dist/src/main.js &)
(cd apps/web && npx vite --config <a scratchpad config pointing /api at :3010> --port 5180 --host 127.0.0.1 &)
```

Credentials: `admin` / `DevAdmin!Pass2026` · `ramesh` / `FrontDesk!2026x` · `owner1` / `OwnerPass!2026z`

**Four things the seeds do NOT do, and the counter cannot transact without them:**

1. Assign roles to `admin` itself (`opd_admin`, `front_office`, `cashier`, `billing_manager`,
   `tariff_editor`, `medical_superintendent`) — the bootstrap admin holds only `auth.*`.
2. Doctors need login users first (`POST /admin/users`), then `POST /opd/doctors`, then a room and
   `PUT /opd/doctors/:id/schedules` (**roomId is required**).
3. The `opd_visit` workflow definition must be drafted, approved **and activated** — separation of
   duties means the drafter cannot activate, so you need a second user holding `owner`.
4. A tariff version must be created, priced, submitted, **approved** and activated. The
   `tariff_revision` approval routes to `owner`, which does **not** hold
   `approvals.requests.decide` — grant it locally. Without an active tariff every quote is 409
   `version_not_active`.

The owner reaches it over a tunnel: `ssh -N -L 5180:127.0.0.1:5180 root@62.238.106.231`, then
`localhost:5180`.

---

## 7. Tooling traps this session paid for

- **`terminal-browser` does not work on this box** (no GUI libs / no TTY split). Use
  **playwright chromium headless** — `npx playwright install chromium && npx playwright install-deps
  chromium` — drive it with a script and read the PNGs back with the Read tool. This is how every
  defect in FD-2 and FD-6 was found; static reading found none of them.
- **`pnpm start:dev` (tsx) CANNOT boot Nest.** esbuild emits no decorator metadata, so DI fails at
  the first constructor injection. Build first: `pnpm --filter @hmis/core run build && node
  dist/src/main.js`.
- **Never `pkill` in a Bash tool call.** It matches and kills the tool's own shell — cost two
  restarts. Use the background-task tool and `TaskStop`.
- **Vite's proxy target is hardcoded to `:3000`.** A peer lane may hold it, pointed at *their*
  database. Use a scratchpad vite config with the target moved, never edit the repo's.
- Billing tables have **append-only triggers** — `DELETE FROM allocations` is refused. To reset the
  preview, drop the database.

## 8. Known CI flakes — do not hunt these in your own diff

- `partners/accrual.test.ts` F11(a) pins `settleMs < 300`, a wall-clock budget on a loaded runner.
  Seen at 348 ms. **Re-run.** The same commit passed the shard two minutes earlier.
- Date-literal tests: two were fixed in FD-6, but the pattern recurs. Any fixture dated "today"
  should compute it (`new Date(Date.now() + 330*60_000).toISOString().slice(0,10)`), not write it
  down.
- PRs cycle **BEHIND** constantly (8 lanes, branch protection requires up-to-date, ~30 min CI).
  Merge `origin/main` in, resolve by hand, push, re-arm `gh pr merge <n> --squash --auto`. **Never
  `--ours` a shared file** — `router.tsx`, `caddyfile-parity.test.ts`, `locales/*.json`,
  `seed-roles.ts`. Every conflict in those this session needed both sides combined.

---

## 9. Your first three actions

1. **Ask the owner to deploy** (prod is one migration behind) and verify with the two queries in §1.
2. **Ask the three open questions in §4c** — they gate the `/registration` build.
3. **Author the phase doc for the three seats**, in the house pattern (`<15 KB`, one PR per task,
   rails grep-counted). Task order that respects the blocker: new `/registration` **with all four
   carried over** → delete the old screen and repoint the chord → `/appointment` → `/billing` +
   the scheme rail → the keymap brought in line with §4d.

Most of the scheme machinery already exists server-side — `modules/membership` (coupon-rules,
entitlements, redemptions, instruments), `modules/partners` (attribution, accrual, agreements),
`billing/benefit-sources`, and `couponCodes` / `attributionCode` already on the fee quote. Judging
by this codebase's pattern, **a good part of it has no web consumer** — check before estimating.
That is likely more wiring than inventing.
